import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { checkBudgetLimit, getEntitlements } from "#/server/billing.server";
import {
  getBudgetsWithSpend,
  isValidMonth,
  type BudgetWithSpend,
} from "#/server/budgets.server";
import { ownedEntityExists } from "#/server/ownership.server";
import { requireUserId } from "#/server/session";

//
// Client-callable budgets surface. Spend computation and alerting live in
// budgets.server.ts; plan gating in billing.server.ts. Every query is scoped
// by the session user — cross-tenant ids behave exactly like missing ones.

// Postgres integer upper bound — limit_minor is an integer column.
const MAX_LIMIT_MINOR = 2_147_483_647;

const limitMinorSchema = z
  .number()
  .int()
  .positive("Limit must be greater than 0")
  .max(MAX_LIMIT_MINOR);

const getBudgetsSchema = z.object({
  // The calendar month in the *browser's* timezone ("YYYY-MM") — same
  // convention as the dashboard's "this month".
  month: z.string().refine(isValidMonth, "Month must be YYYY-MM"),
});

const createBudgetSchema = z.object({
  categoryId: z.string().min(1, "Category is required"),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export interface BudgetsOverview {
  month: string;
  budgets: BudgetWithSpend[];
  /** null = unlimited (pro). */
  maxBudgets: number | null;
}

export const getBudgets = createServerFn({ method: "GET" })
  .inputValidator(getBudgetsSchema)
  .handler(async ({ data }): Promise<BudgetsOverview> => {
    const userId = await requireUserId();
    const [budgets, entitlements] = await Promise.all([
      getBudgetsWithSpend(userId, data.month),
      getEntitlements(userId),
    ]);
    return {
      month: data.month,
      budgets,
      maxBudgets: entitlements.maxBudgets,
    };
  });

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    if (!(await ownedEntityExists("category", userId, data.categoryId))) {
      return { error: "Category does not exist", code: "category_not_found" as const };
    }

    const limit = await checkBudgetLimit(userId);
    if (!limit.allowed) {
      return { error: limit.error, code: limit.code, limit: limit.limit };
    }

    // The unique (user_id, category_id) index is the source of truth for
    // "one budget per category"; ON CONFLICT turns a race into a clean error.
    const id = crypto.randomUUID();
    const inserted = await db
      .insert(schema.budgets)
      .values({
        id,
        user_id: userId,
        category_id: data.categoryId,
        limit_minor: data.limitMinor,
      })
      .onConflictDoNothing()
      .returning({ id: schema.budgets.id });
    if (inserted.length === 0) {
      return {
        error: "This category already has a budget",
        code: "budget_exists" as const,
      };
    }

    return { success: true as const, id };
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const updated = await db
      .update(schema.budgets)
      .set({ limit_minor: data.limitMinor, updated_at: new Date() })
      .where(
        and(
          eq(schema.budgets.id, data.id),
          eq(schema.budgets.user_id, userId),
        ),
      )
      .returning({ id: schema.budgets.id });
    if (updated.length === 0) {
      return { error: "Budget not found", code: "budget_not_found" as const };
    }
    return { success: true as const };
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    if (!(await ownedEntityExists("budget", userId, data.id))) {
      return { error: "Budget not found", code: "budget_not_found" as const };
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.budget_alerts)
        .where(eq(schema.budget_alerts.budget_id, data.id));
      await tx
        .delete(schema.budgets)
        .where(
          and(
            eq(schema.budgets.id, data.id),
            eq(schema.budgets.user_id, userId),
          ),
        );
    });
    return { success: true as const };
  });

