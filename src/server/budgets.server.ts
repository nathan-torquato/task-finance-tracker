import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Monthly category budgets. Server-only — imported by budgets.functions.ts,
// transactions.functions.ts (over-budget alerts), categories.functions.ts and
// compliance.server.ts.
//
// Design:
// - Spend is never stored. It is computed on read for one calendar month from
//   `transactions` (served by transactions_user_date_idx), so every write
//   path (manual, import, receipt, recategorize, ...) is reflected with no
//   counter to keep in sync, and budgets "reset" every month with no job.
// - Months are plain "YYYY-MM" strings and transaction dates plain calendar
//   dates: comparisons never go through Date/UTC, so the user's timezone
//   can't shift a transaction into the wrong month.
// - Only spending counts: SUM of negative amounts. Positive rows (income and
//   refunds alike) are ignored, never netted.
// - A budget covers its category and all descendants.

type Db = typeof defaultDb;

export type BudgetStatus = "ok" | "warning" | "over";

export interface BudgetWithSpend {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  /** All money values are integer minor units (grosze/cents). */
  limitMinor: number;
  spentMinor: number;
  /** limit - spent; negative when over budget. */
  remainingMinor: number;
  status: BudgetStatus;
}

// --- Month helpers (calendar strings only) ---------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

/** "2026-11" → { from: "2026-11-01", to: "2026-12-01" } (to is exclusive). */
export function monthRange(month: string): { from: string; to: string } {
  if (!isValidMonth(month)) throw new Error(`invalid month: ${month}`);
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  return {
    from: `${month}-01`,
    to: `${nextYear}-${String(nextMon).padStart(2, "0")}-01`,
  };
}

/** Calendar month of a stored transaction date ("2026-11-30" → "2026-11"). */
export function monthOfDate(date: string): string {
  return date.slice(0, 7);
}

function utcMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The calendar month(s) it currently is *somewhere on Earth* (UTC-12 …
 * UTC+14). We don't store user timezones, so around a month boundary both
 * the old and the new month count as "current" for alerting purposes.
 */
export function currentMonths(now: Date = new Date()): Set<string> {
  const HOUR = 60 * 60 * 1000;
  return new Set([
    utcMonth(new Date(now.getTime() - 12 * HOUR)),
    utcMonth(new Date(now.getTime() + 14 * HOUR)),
  ]);
}

export function budgetStatus(spentMinor: number, limitMinor: number): BudgetStatus {
  if (spentMinor > limitMinor) return "over";
  // >= 80% of the limit, in integer arithmetic.
  if (spentMinor * 5 >= limitMinor * 4) return "warning";
  return "ok";
}

// --- Category tree ---------------------------------------------------------

/** Category id → itself plus every descendant id (cycle-safe). */
function descendantsOf(
  rootId: string,
  childrenByParent: Map<string, string[]>,
): Set<string> {
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  return result;
}

async function loadChildrenByParent(
  userId: string,
  db: Db,
): Promise<{ childrenByParent: Map<string, string[]>; parentOf: Map<string, string | null> }> {
  const rows = await db
    .select({ id: schema.categories.id, parent_id: schema.categories.parent_id })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const childrenByParent = new Map<string, string[]>();
  const parentOf = new Map<string, string | null>();
  for (const row of rows) {
    parentOf.set(row.id, row.parent_id);
    if (row.parent_id) {
      const list = childrenByParent.get(row.parent_id) ?? [];
      list.push(row.id);
      childrenByParent.set(row.parent_id, list);
    }
  }
  return { childrenByParent, parentOf };
}

// --- Reads -----------------------------------------------------------------

/**
 * Every budget of `userId` with its spend for `month` ("YYYY-MM"): the sum of
 * spending (negative amounts only) in the budget's category and all of its
 * descendants.
 */
export async function getBudgetsWithSpend(
  userId: string,
  month: string,
  db: Db = defaultDb,
): Promise<BudgetWithSpend[]> {
  const { from, to } = monthRange(month);

  const budgets = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      categoryName: schema.categories.name,
      categoryColor: schema.categories.color,
      limitMinor: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .innerJoin(
      schema.categories,
      and(
        eq(schema.categories.id, schema.budgets.category_id),
        eq(schema.categories.user_id, userId),
      ),
    )
    .where(eq(schema.budgets.user_id, userId))
    .orderBy(schema.categories.name);
  if (budgets.length === 0) return [];

  const { childrenByParent } = await loadChildrenByParent(userId, db);

  // One aggregate for the whole month: spend per category.
  const spendRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      spent: sql<number>`COALESCE(SUM(-${schema.transactions.amount_minor}), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        gte(schema.transactions.date, from),
        lt(schema.transactions.date, to),
        lt(schema.transactions.amount_minor, 0),
        sql`${schema.transactions.category_id} IS NOT NULL`,
      ),
    )
    .groupBy(schema.transactions.category_id);
  const spendByCategory = new Map<string, number>();
  for (const row of spendRows) {
    if (row.categoryId) spendByCategory.set(row.categoryId, row.spent);
  }

  return budgets.map((budget) => {
    let spentMinor = 0;
    for (const id of descendantsOf(budget.categoryId, childrenByParent)) {
      spentMinor += spendByCategory.get(id) ?? 0;
    }
    return {
      ...budget,
      spentMinor,
      remainingMinor: budget.limitMinor - spentMinor,
      status: budgetStatus(spentMinor, budget.limitMinor),
    };
  });
}

/** Number of budgets the user has (billing page usage line). */
export async function countBudgets(
  userId: string,
  db: Db = defaultDb,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  return rows[0]?.count ?? 0;
}

// --- Over-budget alerts ----------------------------------------------------

/**
 * Called (fire-and-forget) after a manual transaction is created or updated.
 * When the transaction is spending in the current month, every budget on its
 * category or an ancestor that is now over its limit gets an alert claim in
 * `budget_alerts` (unique per budget + month); only the insert that wins the
 * claim sends the email, so the user gets at most one email per budget per
 * month even under concurrent writes. A failed send is logged, not retried.
 *
 * Returns the ids of budgets for which an email was attempted.
 */
export async function checkBudgetAlertsForTransaction(
  userId: string,
  transactionId: string,
  options: { db?: Db; now?: Date } = {},
): Promise<string[]> {
  const db = options.db ?? defaultDb;
  const log = getLogger();

  const [tx] = await db
    .select({
      date: schema.transactions.date,
      amountMinor: schema.transactions.amount_minor,
      categoryId: schema.transactions.category_id,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.id, transactionId),
        eq(schema.transactions.user_id, userId),
      ),
    )
    .limit(1);
  if (!tx || tx.amountMinor >= 0 || !tx.categoryId) return [];

  const month = monthOfDate(tx.date);
  if (!currentMonths(options.now).has(month)) return [];

  // The transaction's category and all of its ancestors.
  const { parentOf } = await loadChildrenByParent(userId, db);
  const affected = new Set<string>();
  let cursor: string | null | undefined = tx.categoryId;
  while (cursor && !affected.has(cursor)) {
    affected.add(cursor);
    cursor = parentOf.get(cursor);
  }

  const overBudgets = (await getBudgetsWithSpend(userId, month, db)).filter(
    (b) => b.status === "over" && affected.has(b.categoryId),
  );
  if (overBudgets.length === 0) return [];

  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const alerted: string[] = [];
  for (const budget of overBudgets) {
    const claimed = await db
      .insert(schema.budget_alerts)
      .values({ id: crypto.randomUUID(), budget_id: budget.id, month })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    if (claimed.length === 0) continue; // already alerted this month

    // The claim is kept even without an email: "user went over budget" is a
    // domain event worth recording on its own.
    log.info({ userId, budgetId: budget.id, month }, "budget exceeded");
    if (!user?.email) {
      // Legacy accounts may have no email — never attempt a send to nowhere.
      log.warn(
        { userId, budgetId: budget.id, month },
        "over-budget email skipped: user has no email",
      );
      continue;
    }

    alerted.push(budget.id);
    try {
      await sendEmail({
        to: user.email,
        subject: m.email_budget_over_subject({ category: budget.categoryName }),
        text: m.email_budget_over_body({
          category: budget.categoryName,
          month,
          // Same single-currency labelling as the dashboard.
          spent: `${formatMinor(budget.spentMinor)} ${m.analytics_currency()}`,
          limit: `${formatMinor(budget.limitMinor)} ${m.analytics_currency()}`,
          url: `${env.email.baseUrl}/budgets`,
        }),
      });
    } catch (error) {
      log.error(
        { err: error, userId, budgetId: budget.id, month },
        "failed to send over-budget email",
      );
    }
  }
  return alerted;
}

// --- Deletion helpers ------------------------------------------------------

/** Delete the user's budgets (and their alert rows) on the given categories. */
export async function deleteBudgetsForCategories(
  userId: string,
  categoryIds: string[],
  db: Pick<Db, "select" | "delete"> = defaultDb,
): Promise<void> {
  if (categoryIds.length === 0) return;
  const budgetIds = db
    .select({ id: schema.budgets.id })
    .from(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    );
  await db
    .delete(schema.budget_alerts)
    .where(inArray(schema.budget_alerts.budget_id, budgetIds));
  await db
    .delete(schema.budgets)
    .where(
      and(
        eq(schema.budgets.user_id, userId),
        inArray(schema.budgets.category_id, categoryIds),
      ),
    );
}
