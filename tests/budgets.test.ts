// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { db, schema } from "../src/db/index.ts";
import {
  budgetStatus,
  checkBudgetAlertsForTransaction,
  currentMonths,
  deleteBudgetsForCategories,
  getBudgetsWithSpend,
  isValidMonth,
  monthRange,
} from "../src/server/budgets.server.ts";
import { checkBudgetLimit } from "../src/server/billing.server.ts";
import { buildExportZip, hardDeleteUser } from "../src/server/compliance.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";

describe("budget month helpers", () => {
  it("builds calendar-string month ranges, including December rollover", () => {
    expect(monthRange("2026-11")).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(() => monthRange("2026-13")).toThrow();
  });

  it("validates YYYY-MM months", () => {
    expect(isValidMonth("2026-01")).toBe(true);
    expect(isValidMonth("2026-1")).toBe(false);
    expect(isValidMonth("2026-00")).toBe(false);
    expect(isValidMonth("2026-11-01")).toBe(false);
  });

  it("treats both months as current around a month boundary (any timezone)", () => {
    // 2026-11-30 20:00Z: already December in UTC+14, still November in UTC-12.
    expect(currentMonths(new Date("2026-11-30T20:00:00Z"))).toEqual(
      new Set(["2026-11", "2026-12"]),
    );
    expect(currentMonths(new Date("2026-11-15T12:00:00Z"))).toEqual(
      new Set(["2026-11"]),
    );
  });

  it("classifies status: ok < 80% <= warning <= limit < over", () => {
    expect(budgetStatus(7999, 10000)).toBe("ok");
    expect(budgetStatus(8000, 10000)).toBe("warning");
    expect(budgetStatus(10000, 10000)).toBe("warning"); // exactly at limit
    expect(budgetStatus(10001, 10000)).toBe("over");
  });
});

describe("budgets with spend, alerts and limits", () => {
  const userId = "budget-test-user";
  const otherUserId = "budget-test-other";
  // Unique per test: captured emails are a process-wide buffer.
  let email = "";
  let emailSeq = 0;
  const now = new Date("2026-11-15T12:00:00Z");
  const month = "2026-11";
  let txSeq = 0;

  const tx = async (
    categoryId: string | null,
    date: string,
    amountMinor: number,
    owner = userId,
  ) => {
    const id = `budget-tx-${++txSeq}`;
    await db.insert(schema.transactions).values({
      id,
      user_id: owner,
      account_id: owner === userId ? "budget-acc" : "budget-acc-other",
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });
    return id;
  };

  const budget = (id: string, categoryId: string, limitMinor: number) =>
    db.insert(schema.budgets).values({
      id,
      user_id: userId,
      category_id: categoryId,
      limit_minor: limitMinor,
    });

  const emailsForBudget = (category: string) =>
    getCapturedEmails(email).filter((e) => e.subject.includes(category));

  beforeEach(async () => {
    email = `budget-test-${++emailSeq}@example.com`;
    await db.insert(schema.users).values([
      { id: userId, username: userId, email, password_hash: "x" },
      { id: otherUserId, username: otherUserId, password_hash: "x" },
    ]);
    await db.insert(schema.accounts).values([
      { id: "budget-acc", user_id: userId, name: "Main" },
      { id: "budget-acc-other", user_id: otherUserId, name: "Other" },
    ]);
    // Food > Restaurants > Fast food (3 levels), plus a sibling Transport.
    await db.insert(schema.categories).values([
      { id: "cat-food", user_id: userId, name: "BT Food" },
      { id: "cat-rest", user_id: userId, name: "BT Restaurants", parent_id: "cat-food" },
      { id: "cat-fast", user_id: userId, name: "BT Fast food", parent_id: "cat-rest" },
      { id: "cat-transport", user_id: userId, name: "BT Transport" },
      { id: "cat-other-user", user_id: otherUserId, name: "Other's" },
    ]);
  });

  afterEach(async () => {
    // Other user first: the cross-tenant test gives them a transaction that
    // references one of userId's categories.
    await hardDeleteUser(otherUserId);
    await hardDeleteUser(userId);
  });

  it("sums only spending in the category and all its descendants for the month", async () => {
    await budget("b-food", "cat-food", 100000);
    await budget("b-rest", "cat-rest", 30000);

    await tx("cat-food", "2026-11-01", -10000); // first day counts
    await tx("cat-rest", "2026-11-15", -20000);
    await tx("cat-fast", "2026-11-30", -5000); // grandchild, last day counts
    await tx("cat-rest", "2026-11-16", 3000); // refund: ignored, not netted
    await tx("cat-food", "2026-11-02", 500000); // income: ignored
    await tx("cat-food", "2026-10-31", -99999); // previous month
    await tx("cat-food", "2026-12-01", -99999); // next month
    await tx("cat-transport", "2026-11-03", -7000); // unrelated category
    await tx(null, "2026-11-03", -7000); // uncategorized

    const budgets = await getBudgetsWithSpend(userId, month);
    const food = budgets.find((b) => b.id === "b-food")!;
    const rest = budgets.find((b) => b.id === "b-rest")!;

    expect(food.spentMinor).toBe(35000);
    expect(food.remainingMinor).toBe(65000);
    expect(food.status).toBe("ok");
    // Restaurants includes Fast food; refund does not reduce it.
    expect(rest.spentMinor).toBe(25000);
    expect(rest.status).toBe("warning");
  });

  it("resets every month — the same budget shows each month's own spend", async () => {
    await budget("b-food", "cat-food", 10000);
    await tx("cat-food", "2026-10-10", -15000);
    await tx("cat-food", "2026-11-10", -2000);

    expect((await getBudgetsWithSpend(userId, "2026-10"))[0].status).toBe("over");
    const nov = (await getBudgetsWithSpend(userId, "2026-11"))[0];
    expect(nov.spentMinor).toBe(2000);
    expect(nov.status).toBe("ok");
  });

  it("never counts another user's transactions", async () => {
    await budget("b-food", "cat-food", 10000);
    await tx("cat-food", "2026-11-10", -99999, otherUserId);
    expect((await getBudgetsWithSpend(userId, month))[0].spentMinor).toBe(0);
  });

  it("emails once when a spend pushes a budget (or its ancestor) over, then never again that month", async () => {
    await budget("b-food", "cat-food", 10000);
    await budget("b-transport", "cat-transport", 10000);

    // Under the limit: no alert.
    const t1 = await tx("cat-fast", "2026-11-05", -6000);
    expect(await checkBudgetAlertsForTransaction(userId, t1, { now })).toEqual([]);

    // Grandchild spend pushes the parent budget over.
    const t2 = await tx("cat-fast", "2026-11-06", -5000);
    expect(await checkBudgetAlertsForTransaction(userId, t2, { now })).toEqual(["b-food"]);
    const sent = emailsForBudget("BT Food");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("110.00");
    expect(sent[0].text).toContain("100.00");
    expect(sent[0].text).toContain("/budgets");

    // Further spending the same month: no second email.
    const t3 = await tx("cat-food", "2026-11-07", -5000);
    expect(await checkBudgetAlertsForTransaction(userId, t3, { now })).toEqual([]);
    expect(emailsForBudget("BT Food")).toHaveLength(1);

    // An unrelated budget is untouched.
    expect(emailsForBudget("BT Transport")).toHaveLength(0);
  });

  it("sends exactly one email under concurrent checks", async () => {
    await budget("b-food", "cat-food", 1000);
    const a = await tx("cat-food", "2026-11-05", -800);
    const b = await tx("cat-food", "2026-11-05", -800);

    const results = await Promise.all([
      checkBudgetAlertsForTransaction(userId, a, { now }),
      checkBudgetAlertsForTransaction(userId, b, { now }),
    ]);
    expect(results.flat()).toEqual(["b-food"]);
    expect(emailsForBudget("BT Food")).toHaveLength(1);
  });

  it("does not alert for income, refunds, uncategorized or past-month entries", async () => {
    await budget("b-food", "cat-food", 1000);
    await tx("cat-food", "2026-11-01", -5000); // already over (e.g. via import)

    const income = await tx("cat-food", "2026-11-05", 2000);
    const uncategorized = await tx(null, "2026-11-05", -2000);
    const backdated = await tx("cat-food", "2026-10-05", -2000);
    for (const id of [income, uncategorized, backdated]) {
      expect(await checkBudgetAlertsForTransaction(userId, id, { now })).toEqual([]);
    }
    expect(emailsForBudget("BT Food")).toHaveLength(0);
  });

  it("limits free users to 3 budgets and lifts the limit on pro", async () => {
    await budget("b1", "cat-food", 1);
    await budget("b2", "cat-rest", 1);
    expect(await checkBudgetLimit(userId)).toEqual({ allowed: true });
    await budget("b3", "cat-fast", 1);
    expect(await checkBudgetLimit(userId)).toMatchObject({
      allowed: false,
      code: "budget_limit_reached",
      limit: 3,
    });

    await db.insert(schema.subscriptions).values({ user_id: userId, plan: "pro" });
    expect(await checkBudgetLimit(userId)).toEqual({ allowed: true });
  });

  it("deletes budgets and their alerts with their categories", async () => {
    await budget("b-food", "cat-food", 1000);
    await budget("b-transport", "cat-transport", 1000);
    await db
      .insert(schema.budget_alerts)
      .values({ id: "alert-1", budget_id: "b-food", month });

    await deleteBudgetsForCategories(userId, ["cat-food", "cat-rest"]);

    const remaining = await db
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(eq(schema.budgets.user_id, userId));
    expect(remaining).toEqual([{ id: "b-transport" }]);
    expect(
      await db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.id, "alert-1")),
    ).toEqual([]);
  });

  it("includes budgets in the GDPR export and removes them on account deletion", async () => {
    await budget("b-food", "cat-food", 12345);
    await db
      .insert(schema.budget_alerts)
      .values({ id: "alert-export", budget_id: "b-food", month });

    const files = unzipSync(await buildExportZip(userId));
    const json = JSON.parse(strFromU8(files["export.json"]));
    expect(json.budgets).toHaveLength(1);
    expect(json.budgets[0]).toMatchObject({ id: "b-food", limit_minor: 12345 });
    expect(json.budgets[0].alerts).toHaveLength(1);
    expect(strFromU8(files["budgets.csv"])).toContain('"BT Food","123.45"');

    await hardDeleteUser(userId);
    expect(
      await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.id, "alert-export")),
    ).toEqual([]);
  });
});
