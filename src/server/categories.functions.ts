import { createServerFn } from "@tanstack/react-start";
import { eq, and, asc, count, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import { deleteBudgetsForCategories } from "#/server/budgets.server";
import { requireUserId } from "#/server/session";


const colorRegex = /^#[0-9A-Fa-f]{6}$/;

const createCategorySchema = z.object({
  name: z.string().min(1).max(128),
  parentId: z.string().nullish(),
  color: z
    .string()
    .regex(colorRegex, "Invalid color format")
    .default("#6b7280"),
});

const updateCategorySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  parentId: z.string().nullish(),
  color: z.string().regex(colorRegex, "Invalid color format"),
});

const deleteCategorySchema = z.object({
  id: z.string(),
  reassignToCategoryId: z.string().nullish(),
});

export const getCategories = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();

    // Fetch categories with transaction counts
    const rows = await db
      .select({
        id: schema.categories.id,
        user_id: schema.categories.user_id,
        name: schema.categories.name,
        parent_id: schema.categories.parent_id,
        color: schema.categories.color,
        sort_order: schema.categories.sort_order,
        created_at: schema.categories.created_at,
        transaction_count: sql<number>`COALESCE(count(${schema.transactions.id}), 0)`.mapWith(Number),
      })
      .from(schema.categories)
      .leftJoin(
        schema.transactions,
        and(
          eq(schema.categories.id, schema.transactions.category_id),
          eq(schema.transactions.user_id, userId),
        ),
      )
      .where(eq(schema.categories.user_id, userId))
      .groupBy(
        schema.categories.id,
        schema.categories.user_id,
        schema.categories.name,
        schema.categories.parent_id,
        schema.categories.color,
        schema.categories.sort_order,
        schema.categories.created_at,
      )
      .orderBy(asc(schema.categories.sort_order));

    // Fetch child counts separately to avoid correlated subquery issues
    const childCounts = await db
      .select({
        parent_id: schema.categories.parent_id,
        child_count: sql<number>`count(${schema.categories.id})`.mapWith(Number),
      })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.user_id, userId),
          sql`${schema.categories.parent_id} IS NOT NULL`,
        ),
      )
      .groupBy(schema.categories.parent_id);

    const childCountMap = new Map<string, number>();
    for (const c of childCounts) {
      if (c.parent_id) {
        childCountMap.set(c.parent_id, Number(c.child_count));
      }
    }

    return rows.map((row) => ({
      ...row,
      child_count: childCountMap.get(row.id) ?? 0,
    }));
  },
);

export const createCategory = createServerFn({ method: "POST" })
  .inputValidator(createCategorySchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Validate parent exists and belongs to current user
    if (data.parentId) {
      const parent = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, data.parentId),
            eq(schema.categories.user_id, userId),
          ),
        )
        .limit(1);
      if (parent.length === 0) {
        return { error: "Parent category does not exist" };
      }
    }

    // Calculate sort_order: append after existing siblings within this user's tree
    const countResult = await db
      .select({ count: count() })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.user_id, userId),
          data.parentId
            ? eq(schema.categories.parent_id, data.parentId)
            : sql`${schema.categories.parent_id} IS NULL`,
        ),
      );
    const sortOrder = countResult[0]?.count ?? 0;

    const id = crypto.randomUUID();
    await db.insert(schema.categories).values({
      id,
      user_id: userId,
      name: data.name,
      parent_id: data.parentId || null,
      color: data.color,
      sort_order: sortOrder,
    });

    return {
      id,
      name: data.name,
      parent_id: data.parentId || null,
      color: data.color,
      sort_order: sortOrder,
    };
  });

export const updateCategory = createServerFn({ method: "POST" })
  .inputValidator(updateCategorySchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // A category can't be its own parent
    if (data.parentId === data.id) {
      return { error: "A category cannot be its own parent" };
    }

    // Validate parent exists and belongs to user (if different from self)
    if (data.parentId && data.parentId !== data.id) {
      const parent = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, data.parentId),
            eq(schema.categories.user_id, userId),
          ),
        )
        .limit(1);
      if (parent.length === 0) {
        return { error: "Parent category does not exist" };
      }

      // Prevent circular references: walk up the proposed parent's ancestry
      // and ensure we never encounter `data.id`.
      const userCategories = await db
        .select({
          id: schema.categories.id,
          parent_id: schema.categories.parent_id,
        })
        .from(schema.categories)
        .where(eq(schema.categories.user_id, userId));
      const parentMap = new Map<string, string | null>(
        userCategories.map((c) => [c.id, c.parent_id]),
      );
      let cursor: string | null | undefined = data.parentId;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === data.id) {
          return {
            error:
              "Cannot set parent: would create a circular category reference",
          };
        }
        if (visited.has(cursor)) break;
        visited.add(cursor);
        cursor = parentMap.get(cursor) ?? null;
      }
    }

    await db
      .update(schema.categories)
      .set({
        name: data.name,
        parent_id: data.parentId || null,
        color: data.color,
      })
      .where(
        and(
          eq(schema.categories.id, data.id),
          eq(schema.categories.user_id, userId),
        ),
      );

    return { success: true };
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .inputValidator(deleteCategorySchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    // Collect all descendant category IDs (children, grandchildren, etc.)
    const allDescendantIds: string[] = [];

    async function collectChildren(parentId: string): Promise<void> {
      const children = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.parent_id, parentId),
            eq(schema.categories.user_id, userId),
          ),
        );
      for (const child of children) {
        allDescendantIds.push(child.id);
        await collectChildren(child.id);
      }
    }

    await collectChildren(data.id);

    // All category IDs that will be deleted (descendants + target)
    const allIdsToDelete = [...allDescendantIds, data.id];

    if (allIdsToDelete.length === 0) {
      return { error: "Category not found" };
    }

    if (data.reassignToCategoryId) {
      if (data.reassignToCategoryId === data.id) {
        return {
          error: "Cannot reassign transactions to the category being deleted",
        };
      }
      const target = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, data.reassignToCategoryId),
            eq(schema.categories.user_id, userId),
          ),
        )
        .limit(1);
      if (target.length === 0) {
        return { error: "Reassignment target category does not exist" };
      }

      // Reassign transactions from deleted categories to the target
      await db
        .update(schema.transactions)
        .set({ category_id: data.reassignToCategoryId })
        .where(
          and(
            inArray(schema.transactions.category_id, allIdsToDelete),
            eq(schema.transactions.user_id, userId),
          ),
        );
    } else {
      // Reset category_id on transactions that reference any of these categories
      await db
        .update(schema.transactions)
        .set({ category_id: null })
        .where(
          and(
            inArray(schema.transactions.category_id, allIdsToDelete),
            eq(schema.transactions.user_id, userId),
          ),
        );
    }

    // Reset category_id on receipt_items that reference any of these categories
    await db
      .update(schema.receipt_items)
      .set({ category_id: null })
      .where(inArray(schema.receipt_items.category_id, allIdsToDelete));

    // Delete categorization_rules that reference any of these categories
    await db
      .delete(schema.categorization_rules)
      .where(inArray(schema.categorization_rules.category_id, allIdsToDelete));

    // Budgets on any of these categories go with them (and their alerts).
    await deleteBudgetsForCategories(userId, allIdsToDelete);

    // Delete all descendant categories first, then the target
    await db
      .delete(schema.categories)
      .where(inArray(schema.categories.id, allIdsToDelete));

    return { success: true };
  });
