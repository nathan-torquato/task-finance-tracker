import { and, eq } from "drizzle-orm";
import { db, schema } from "#/db";

//
// Shared ownership checks for every user-scoped entity type. The rule for all
// server functions: any handler taking an entity id must verify `user_id`
// ownership in the same query (`WHERE id = ? AND user_id = ?`), never after
// fetching. Cross-tenant access must be indistinguishable from "not found".

export const OWNED_TABLES = {
  transaction: schema.transactions,
  account: schema.accounts,
  category: schema.categories,
  rule: schema.categorization_rules,
  receipt: schema.receipts,
  importBatch: schema.import_batches,
  budget: schema.budgets,
} as const;

export type OwnedEntity = keyof typeof OWNED_TABLES;

/**
 * True when the entity row exists AND belongs to `userId` — a single query,
 * so a foreign row is indistinguishable from a missing one.
 */
export async function ownedEntityExists(
  entity: OwnedEntity,
  userId: string,
  id: string,
): Promise<boolean> {
  const table = OWNED_TABLES[entity];
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.user_id, userId)))
    .limit(1);
  return rows.length > 0;
}
