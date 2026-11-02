import { createServerFn } from "@tanstack/react-start";
import { eq, and, asc, desc, count, gte, lte, ilike, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { checkBudgetAlertsForTransaction } from "#/server/budgets.server";
import { getLogger } from "#/server/logger";
import { ownedEntityExists } from "#/server/ownership.server";
import { requireUserId } from "#/server/session";


// --- Schemas ---

const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

const filterSchema = z.object({
  dateFrom: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)").optional(),
  dateTo: z.string().regex(dateRegex, "Invalid date format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)").optional(),
  accountId: z.string().optional(),
  categoryId: z.string().optional(),
  // Integer minor units (grosze/cents)
  amountMinMinor: z.number().int().optional(),
  amountMaxMinor: z.number().int().optional(),
  search: z.string().optional(),
  hasReceipt: z.boolean().optional(),
});

const sortSchema = z.object({
  field: z.enum(["date", "amount", "category"]).default("date"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

const paginationSchema = z.object({
  page: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(20),
});

const createTransactionSchema = z.object({
  accountId: z.string().min(1, "Account is required"),
  date: z.string().regex(dateRegex, "Date must be in YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss format"),
  // Integer minor units (grosze/cents)
  amountMinor: z
    .number()
    .int()
    .refine((v) => v !== 0, "Amount cannot be zero"),
  description: z.string().max(256).optional().or(z.literal("")),
  categoryId: z.string().optional().or(z.null()),
  source: z.enum(["manual", "import"]).default("manual"),
  sourceRef: z.string().optional().or(z.literal("")),
});

const updateTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string().min(1, "Account is required").optional(),
  date: z.string().regex(dateRegex, "Date must be in YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss format").optional(),
  // Integer minor units (grosze/cents)
  amountMinor: z
    .number()
    .int()
    .refine((v) => v !== 0, "Amount cannot be zero")
    .optional(),
  description: z.string().max(256).optional().or(z.literal("")),
  categoryId: z.string().optional().or(z.null()),
  source: z.enum(["manual", "import"]).optional(),
  sourceRef: z.string().optional().or(z.literal("")),
});

const deleteTransactionSchema = z.object({
  id: z.string(),
});

const getTransactionByIdSchema = z.object({
  id: z.string(),
});

type SortField = z.infer<typeof sortSchema>["field"];

function sortColumn(field: SortField) {
  switch (field) {
    case "date":
      return schema.transactions.date;
    case "amount":
      return schema.transactions.amount_minor;
    case "category":
      return schema.transactions.category_id;
  }
}

// --- Server Functions ---

export const getTransactions = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      filter: filterSchema.optional(),
      sort: sortSchema.optional(),
      pagination: paginationSchema.optional(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const filter = data.filter ?? {};
    const sort = data.sort ?? { field: "date", direction: "desc" };
    const pagination = data.pagination ?? { page: 0, limit: 20 };

    const conditions = [eq(schema.transactions.user_id, userId)];

    // Date range filter — `date` is a proper DATE column in Postgres.
    if (filter.dateFrom) {
      conditions.push(gte(schema.transactions.date, filter.dateFrom));
    }
    if (filter.dateTo) {
      conditions.push(lte(schema.transactions.date, filter.dateTo));
    }

    // Account filter
    if (filter.accountId) {
      conditions.push(
        eq(schema.transactions.account_id, filter.accountId),
      );
    }

    // Category filter — sentinel "__uncategorized__" selects rows with NULL category.
    if (filter.categoryId === "__uncategorized__") {
      conditions.push(isNull(schema.transactions.category_id));
    } else if (filter.categoryId) {
      conditions.push(
        eq(schema.transactions.category_id, filter.categoryId),
      );
    }

    // Amount range filter (compare against absolute value since expenses are negative)
    if (filter.amountMinMinor !== undefined) {
      conditions.push(
        sql`ABS(${schema.transactions.amount_minor}) >= ${filter.amountMinMinor}`,
      );
    }
    if (filter.amountMaxMinor !== undefined) {
      conditions.push(
        sql`ABS(${schema.transactions.amount_minor}) <= ${filter.amountMaxMinor}`,
      );
    }

    // Text search on description — ILIKE keeps the case-insensitive
    // behavior SQLite's LIKE had by default.
    if (filter.search) {
      conditions.push(
        ilike(schema.transactions.description, "%" + filter.search + "%"),
      );
    }

    // Receipt filter
    if (filter.hasReceipt === true) {
      conditions.push(isNotNull(schema.receipts.id));
    } else if (filter.hasReceipt === false) {
      conditions.push(isNull(schema.receipts.id));
    }

    const whereClause = and(...conditions);

    const transactions = await db
      .select({
        id: schema.transactions.id,
        account_id: schema.transactions.account_id,
        date: schema.transactions.date,
        amount_minor: schema.transactions.amount_minor,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
        source: schema.transactions.source,
        source_ref: schema.transactions.source_ref,
        created_at: schema.transactions.created_at,
        account_name: schema.accounts.name,
        account_currency: schema.accounts.currency,
        category_name: schema.categories.name,
        category_color: schema.categories.color,
        has_receipt: schema.receipts.id,
      })
      .from(schema.transactions)
      .leftJoin(
        schema.accounts,
        eq(schema.transactions.account_id, schema.accounts.id),
      )
      .leftJoin(
        schema.categories,
        eq(schema.transactions.category_id, schema.categories.id),
      )
      .leftJoin(
        schema.receipts,
        eq(schema.transactions.id, schema.receipts.transaction_id),
      )
      .where(whereClause)
      .orderBy(
        (sort.direction === "asc" ? asc : desc)(sortColumn(sort.field)),
        sql`${schema.transactions.created_at} DESC`,
        sql`${schema.transactions.id} DESC`,
      )
      .limit(pagination.limit)
      .offset(pagination.page * pagination.limit);

    // Count total matching records
    const countResult = await db
      .select({ count: count() })
      .from(schema.transactions)
      .leftJoin(
        schema.accounts,
        eq(schema.transactions.account_id, schema.accounts.id),
      )
      .leftJoin(
        schema.categories,
        eq(schema.transactions.category_id, schema.categories.id),
      )
      .leftJoin(
        schema.receipts,
        eq(schema.transactions.id, schema.receipts.transaction_id),
      )
      .where(whereClause);

    const totalCount = countResult[0]?.count ?? 0;

    return {
      transactions,
      totalCount,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(totalCount / pagination.limit),
    };
  });

export const getTransactionById = createServerFn({ method: "GET" })
  .inputValidator(getTransactionByIdSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const transaction = await db
      .select({
        id: schema.transactions.id,
        account_id: schema.transactions.account_id,
        date: schema.transactions.date,
        amount_minor: schema.transactions.amount_minor,
        description: schema.transactions.description,
        category_id: schema.transactions.category_id,
        source: schema.transactions.source,
        source_ref: schema.transactions.source_ref,
        created_at: schema.transactions.created_at,
        account_name: schema.accounts.name,
        account_currency: schema.accounts.currency,
        account_bank: schema.accounts.bank,
        category_name: schema.categories.name,
        category_color: schema.categories.color,
        has_receipt: schema.receipts.id,
      })
      .from(schema.transactions)
      .leftJoin(
        schema.accounts,
        eq(schema.transactions.account_id, schema.accounts.id),
      )
      .leftJoin(
        schema.categories,
        eq(schema.transactions.category_id, schema.categories.id),
      )
      .leftJoin(
        schema.receipts,
        eq(schema.transactions.id, schema.receipts.transaction_id),
      )
      .where(
        and(
          eq(schema.transactions.id, data.id),
          eq(schema.transactions.user_id, userId),
        ),
      )
      .limit(1);

    if (transaction.length === 0) {
      return { error: "Transaction not found" };
    }

    return transaction[0];
  });

export const createTransaction = createServerFn({ method: "POST" })
  .inputValidator(createTransactionSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Validate account exists and belongs to user
    if (!(await ownedEntityExists("account", userId, data.accountId))) {
      return { error: "Account does not exist" };
    }

    // Validate category exists and belongs to user (if provided)
    if (
      data.categoryId &&
      !(await ownedEntityExists("category", userId, data.categoryId))
    ) {
      return { error: "Category does not exist" };
    }

    const id = crypto.randomUUID();
    await db.insert(schema.transactions).values({
      id,
      user_id: userId,
      account_id: data.accountId,
      date: data.date,
      amount_minor: data.amountMinor,
      description: data.description || null,
      category_id: data.categoryId || null,
      source: data.source,
      source_ref: data.sourceRef || null,
    });

    notifyBudgets(userId, id);

    return {
      id,
      account_id: data.accountId,
      date: data.date,
      amount_minor: data.amountMinor,
      description: data.description || null,
      category_id: data.categoryId || null,
      source: data.source,
      source_ref: data.sourceRef || null,
    };
  });

export const updateTransaction = createServerFn({ method: "POST" })
  .inputValidator(updateTransactionSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Check transaction exists and belongs to user
    if (!(await ownedEntityExists("transaction", userId, data.id))) {
      return { error: "Transaction not found" };
    }

    // Validate account exists and belongs to user (if changing)
    if (
      data.accountId &&
      !(await ownedEntityExists("account", userId, data.accountId))
    ) {
      return { error: "Account does not exist" };
    }

    // Validate category exists and belongs to user (if changing to a non-null value)
    if (
      data.categoryId &&
      !(await ownedEntityExists("category", userId, data.categoryId))
    ) {
      return { error: "Category does not exist" };
    }

    const updateData: Record<string, unknown> = {};

    if (data.accountId !== undefined) {
      updateData.account_id = data.accountId;
    }
    if (data.date !== undefined) {
      updateData.date = data.date;
    }
    if (data.amountMinor !== undefined) {
      updateData.amount_minor = data.amountMinor;
    }
    if (data.description !== undefined) {
      updateData.description = data.description || null;
    }
    if (data.categoryId !== undefined) {
      updateData.category_id = data.categoryId || null;
    }
    if (data.source !== undefined) {
      updateData.source = data.source;
    }
    if (data.sourceRef !== undefined) {
      updateData.source_ref = data.sourceRef || null;
    }

    if (Object.keys(updateData).length === 0) {
      return { success: true };
    }

    await db
      .update(schema.transactions)
      .set(updateData)
      .where(
        and(
          eq(schema.transactions.id, data.id),
          eq(schema.transactions.user_id, userId),
        ),
      );

    notifyBudgets(userId, data.id);

    return { success: true };
  });

/** Over-budget email check after a manual write — fire-and-forget (same as
 * the account-deleted notice): it must never fail or slow the request. */
function notifyBudgets(userId: string, transactionId: string): void {
  void checkBudgetAlertsForTransaction(userId, transactionId).catch((error) =>
    getLogger().error(
      { err: error, userId, transactionId },
      "budget alert check failed",
    ),
  );
}

export const deleteTransaction = createServerFn({ method: "POST" })
  .inputValidator(deleteTransactionSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Check transaction exists and belongs to user
    if (!(await ownedEntityExists("transaction", userId, data.id))) {
      return { error: "Transaction not found" };
    }

    // Find receipts for this transaction, then delete their items, then receipts
    const associatedReceipts = await db
      .select({ id: schema.receipts.id })
      .from(schema.receipts)
      .where(eq(schema.receipts.transaction_id, data.id));

    for (const r of associatedReceipts) {
      await db
        .delete(schema.receipt_items)
        .where(eq(schema.receipt_items.receipt_id, r.id));
    }

    await db
      .delete(schema.receipts)
      .where(eq(schema.receipts.transaction_id, data.id));

    await db
      .delete(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, data.id),
          eq(schema.transactions.user_id, userId),
        ),
      );

    return { success: true };
  });
