import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "#/db";
import { normalizeStorageKey } from "#/server/storage";
import {
  OWNED_TABLES,
  ownedEntityExists,
  type OwnedEntity,
} from "#/server/ownership.server";

// Two tenants; every entity type gets one row owned by user A. Cross-tenant
// lookups must behave exactly like "not found".

const userA = "auth-user-a";
const userB = "auth-user-b";
const ids: Record<OwnedEntity, string> = {
  transaction: "authz-txn-a",
  account: "authz-acc-a",
  category: "authz-cat-a",
  rule: "authz-rule-a",
  receipt: "authz-rcpt-a",
  importBatch: "authz-batch-a",
  budget: "authz-budget-a",
};

beforeAll(async () => {
  for (const [i, userId] of [userA, userB].entries()) {
    await db.insert(schema.users).values({
      id: userId,
      username: `authz-user-${i}`,
      password_hash: "x",
    });
  }
  await db.insert(schema.accounts).values({
    id: ids.account,
    user_id: userA,
    name: "A's account",
  });
  await db.insert(schema.categories).values({
    id: ids.category,
    user_id: userA,
    name: "A's category",
  });
  await db.insert(schema.import_batches).values({
    id: ids.importBatch,
    user_id: userA,
    account_id: ids.account,
    filename: "a.csv",
  });
  await db.insert(schema.transactions).values({
    id: ids.transaction,
    user_id: userA,
    account_id: ids.account,
    date: "2025-01-15",
    amount_minor: -1999,
  });
  await db.insert(schema.categorization_rules).values({
    id: ids.rule,
    user_id: userA,
    pattern: "COFFEE",
    category_id: ids.category,
  });
  await db.insert(schema.receipts).values({
    id: ids.receipt,
    user_id: userA,
    transaction_id: ids.transaction,
  });
  await db.insert(schema.budgets).values({
    id: ids.budget,
    user_id: userA,
    category_id: ids.category,
    limit_minor: 50000,
  });
});

describe("cross-tenant authorization", () => {
  const entities = Object.keys(OWNED_TABLES) as OwnedEntity[];

  it("owner sees their own row for every entity type", async () => {
    for (const entity of entities) {
      expect
        .soft(await ownedEntityExists(entity, userA, ids[entity]), entity)
        .toBe(true);
    }
  });

  it("another user's rows are indistinguishable from missing", async () => {
    for (const entity of entities) {
      expect
        .soft(await ownedEntityExists(entity, userB, ids[entity]), entity)
        .toBe(false);
      expect
        .soft(await ownedEntityExists(entity, userB, "no-such-id"), entity)
        .toBe(false);
    }
  });
});

describe("receipt image path traversal guard", () => {
  it("rejects storage keys that escape the storage root", () => {
    expect(normalizeStorageKey("../../etc/passwd")).toBeNull();
    expect(normalizeStorageKey("data/receipts/../../.env")).toBeNull();
    expect(normalizeStorageKey("/etc/passwd")).toBeNull();
    expect(normalizeStorageKey("receipts//img.png")).toBeNull();

    // Legacy pre-migration keys keep working: the "data/" prefix is stripped.
    expect(normalizeStorageKey("data/receipts/user-1/img.png")).toBe(
      "receipts/user-1/img.png",
    );
    expect(normalizeStorageKey("receipts/user-1/img.png")).toBe(
      "receipts/user-1/img.png",
    );
  });
});
