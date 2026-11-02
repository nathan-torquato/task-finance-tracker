import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";
import { deleteStripeCustomer } from "#/server/stripe.server";
import { storage } from "#/server/storage";

//
// GDPR data-rights implementation: full data export, account deletion with a
// grace period, and the retention sweep. Server-only — imported by
// compliance.functions.ts handlers, the export route, and the maintenance
// loop. Log lines here carry ids and counts only, never financial content.

import {
  AI_RAW_RESPONSE_RETENTION_DAYS,
  DELETION_GRACE_DAYS,
} from "#/lib/compliance-constants";

export { AI_RAW_RESPONSE_RETENTION_DAYS, DELETION_GRACE_DAYS };

const DAY_MS = 24 * 60 * 60 * 1000;

export function deletionEffectiveAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS);
}

// --- Data export -----------------------------------------------------------

/** Minimal CSV writer — quotes every field, escapes embedded quotes. */
export function toCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const escape = (value: string | number | null | undefined) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\n");
}

/**
 * Collect everything the app stores about a user. The receipt image BYTES are
 * returned separately from the JSON document so the zip builder can store
 * them as files.
 */
export async function collectUserExport(userId: string) {
  const [user] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      email_verified_at: schema.users.email_verified_at,
      created_at: schema.users.created_at,
      deletion_requested_at: schema.users.deletion_requested_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw new Error(`export: user not found`);

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.user_id, userId));
  const categories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const transactions = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.user_id, userId));
  const rules = await db
    .select()
    .from(schema.categorization_rules)
    .where(eq(schema.categorization_rules.user_id, userId));
  const importBatches = await db
    .select()
    .from(schema.import_batches)
    .where(eq(schema.import_batches.user_id, userId));
  const receipts = await db
    .select()
    .from(schema.receipts)
    .where(eq(schema.receipts.user_id, userId));
  const receiptItems = await db
    .select()
    .from(schema.receipt_items)
    .where(
      inArray(
        schema.receipt_items.receipt_id,
        db
          .select({ id: schema.receipts.id })
          .from(schema.receipts)
          .where(eq(schema.receipts.user_id, userId)),
      ),
    );
  const aiUsage = await db
    .select()
    .from(schema.ai_usage)
    .where(eq(schema.ai_usage.user_id, userId));
  const budgets = await db
    .select()
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  const budgetAlerts = await db
    .select()
    .from(schema.budget_alerts)
    .where(
      inArray(
        schema.budget_alerts.budget_id,
        db
          .select({ id: schema.budgets.id })
          .from(schema.budgets)
          .where(eq(schema.budgets.user_id, userId)),
      ),
    );
  const [subscription] = await db
    .select({
      plan: schema.subscriptions.plan,
      status: schema.subscriptions.status,
      current_period_end: schema.subscriptions.current_period_end,
    })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, userId))
    .limit(1);

  return {
    user,
    accounts,
    categories,
    transactions,
    rules,
    importBatches,
    receipts,
    receiptItems,
    aiUsage,
    budgets,
    budgetAlerts,
    subscription: subscription ?? null,
  };
}

/**
 * Build the export zip: export.json (everything), per-table CSVs for the
 * tabular data, and the original receipt images under receipts/.
 */
export async function buildExportZip(userId: string): Promise<Uint8Array> {
  const data = await collectUserExport(userId);

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};

  files["export.json"] = strToU8(
    JSON.stringify(
      {
        format: "finance-tracker-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        user: data.user,
        accounts: data.accounts,
        categories: data.categories,
        transactions: data.transactions,
        categorizationRules: data.rules,
        importBatches: data.importBatches,
        receipts: data.receipts.map(({ image_path, ...receipt }) => ({
          ...receipt,
          image_file: image_path
            ? `receipts/${receipt.id}${imageExt(image_path)}`
            : null,
          items: data.receiptItems.filter(
            (item) => item.receipt_id === receipt.id,
          ),
        })),
        aiUsage: data.aiUsage,
        budgets: data.budgets.map((budget) => ({
          ...budget,
          alerts: data.budgetAlerts.filter(
            (alert) => alert.budget_id === budget.id,
          ),
        })),
        subscription: data.subscription,
      },
      null,
      2,
    ),
  );

  files["transactions.csv"] = strToU8(
    toCsv(
      [
        "id",
        "date",
        "amount",
        "amount_minor",
        "description",
        "account",
        "category",
        "source",
        "created_at",
      ],
      data.transactions.map((t) => [
        t.id,
        t.date,
        formatMinor(t.amount_minor),
        t.amount_minor,
        t.description,
        data.accounts.find((a) => a.id === t.account_id)?.name,
        data.categories.find((c) => c.id === t.category_id)?.name,
        t.source,
        t.created_at?.toISOString(),
      ]),
    ),
  );
  files["accounts.csv"] = strToU8(
    toCsv(
      ["id", "name", "bank", "currency", "created_at"],
      data.accounts.map((a) => [
        a.id,
        a.name,
        a.bank,
        a.currency,
        a.created_at?.toISOString(),
      ]),
    ),
  );
  files["categories.csv"] = strToU8(
    toCsv(
      ["id", "name", "parent", "color", "sort_order"],
      data.categories.map((c) => [
        c.id,
        c.name,
        data.categories.find((p) => p.id === c.parent_id)?.name,
        c.color,
        c.sort_order,
      ]),
    ),
  );
  files["categorization_rules.csv"] = strToU8(
    toCsv(
      ["id", "pattern", "match_type", "category", "priority", "source"],
      data.rules.map((r) => [
        r.id,
        r.pattern,
        r.match_type,
        data.categories.find((c) => c.id === r.category_id)?.name,
        r.priority,
        r.source,
      ]),
    ),
  );
  files["budgets.csv"] = strToU8(
    toCsv(
      ["id", "category", "monthly_limit", "limit_minor", "created_at"],
      data.budgets.map((b) => [
        b.id,
        data.categories.find((c) => c.id === b.category_id)?.name,
        formatMinor(b.limit_minor),
        b.limit_minor,
        b.created_at?.toISOString(),
      ]),
    ),
  );
  files["receipt_items.csv"] = strToU8(
    toCsv(
      [
        "id",
        "receipt_id",
        "name",
        "quantity",
        "unit_price",
        "total_price",
        "category",
      ],
      data.receiptItems.map((item) => [
        item.id,
        item.receipt_id,
        item.name,
        item.quantity,
        item.unit_price_minor == null
          ? null
          : formatMinor(item.unit_price_minor),
        formatMinor(item.total_price_minor),
        data.categories.find((c) => c.id === item.category_id)?.name,
      ]),
    ),
  );

  // Receipt images: stored uncompressed (JPEG/PNG don't compress further).
  for (const receipt of data.receipts) {
    if (!receipt.image_path) continue;
    const bytes = await storage.get(receipt.image_path);
    if (!bytes) continue;
    files[`receipts/${receipt.id}${imageExt(receipt.image_path)}`] = [
      new Uint8Array(bytes),
      { level: 0 },
    ];
  }

  return zipSync(files);
}

function imageExt(imagePath: string): string {
  const dot = imagePath.lastIndexOf(".");
  return dot >= 0 ? imagePath.slice(dot) : "";
}

// --- Account deletion ------------------------------------------------------

/**
 * Irreversibly delete a user: every DB row (children first — there are no
 * cascade clauses), receipt objects in storage, and the Stripe customer.
 * Storage and Stripe cleanup run after the DB transaction commits and are
 * best-effort with loud logging — a transient failure there must not leave
 * the DB half-deleted.
 */
export async function hardDeleteUser(userId: string): Promise<void> {
  const log = getLogger();

  const receiptImages = await db
    .select({ image_path: schema.receipts.image_path })
    .from(schema.receipts)
    .where(eq(schema.receipts.user_id, userId));
  const imageKeys = receiptImages
    .map((r) => r.image_path)
    .filter((key): key is string => key != null);

  const [subscription] = await db
    .select({ stripe_customer_id: schema.subscriptions.stripe_customer_id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, userId))
    .limit(1);

  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return;

  await db.transaction(async (tx) => {
    const userReceiptIds = tx
      .select({ id: schema.receipts.id })
      .from(schema.receipts)
      .where(eq(schema.receipts.user_id, userId));
    await tx
      .delete(schema.receipt_items)
      .where(inArray(schema.receipt_items.receipt_id, userReceiptIds));
    await tx
      .delete(schema.receipts)
      .where(eq(schema.receipts.user_id, userId));
    await tx
      .delete(schema.transactions)
      .where(eq(schema.transactions.user_id, userId));
    await tx
      .delete(schema.import_batches)
      .where(eq(schema.import_batches.user_id, userId));
    await tx
      .delete(schema.categorization_rules)
      .where(eq(schema.categorization_rules.user_id, userId));
    await tx.delete(schema.ai_usage).where(eq(schema.ai_usage.user_id, userId));
    // Budgets reference categories — delete them (and their alerts) first.
    await tx.delete(schema.budget_alerts).where(
      inArray(
        schema.budget_alerts.budget_id,
        tx
          .select({ id: schema.budgets.id })
          .from(schema.budgets)
          .where(eq(schema.budgets.user_id, userId)),
      ),
    );
    await tx.delete(schema.budgets).where(eq(schema.budgets.user_id, userId));
    await tx
      .delete(schema.subscriptions)
      .where(eq(schema.subscriptions.user_id, userId));
    await tx.delete(schema.accounts).where(eq(schema.accounts.user_id, userId));
    await tx
      .delete(schema.categories)
      .where(eq(schema.categories.user_id, userId));
    await tx
      .delete(schema.auth_tokens)
      .where(eq(schema.auth_tokens.user_id, userId));
    await tx.delete(schema.sessions).where(eq(schema.sessions.user_id, userId));
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
  });

  // Deleting the user row kills every session (resolveSessionUser finds no
  // user). Everything below is external cleanup.
  for (const key of imageKeys) {
    await storage.delete(key);
  }

  if (subscription?.stripe_customer_id && env.billing.enabled) {
    try {
      await deleteStripeCustomer(subscription.stripe_customer_id);
    } catch (error) {
      // Must be reconciled manually — the runbook covers orphaned customers.
      log.error(
        { err: error, userId, customerId: subscription.stripe_customer_id },
        "failed to delete Stripe customer during account deletion",
      );
    }
  }

  if (user.email) {
    void sendEmail({
      to: user.email,
      subject: m.email_account_deleted_subject(),
      text: m.email_account_deleted_body(),
    }).catch((error) =>
      log.error({ err: error }, "failed to send account-deleted notice"),
    );
  }

  log.info(
    { userId, receiptObjects: imageKeys.length },
    "account hard-deleted",
  );
}

// --- Retention & grace-period sweep ----------------------------------------

/**
 * Null out raw AI model output older than the retention window. The
 * structured data extracted from it (receipt items) is the user's and stays.
 */
export async function purgeExpiredAiRawResponses(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - AI_RAW_RESPONSE_RETENTION_DAYS * DAY_MS,
  );
  const purged = await db
    .update(schema.receipts)
    .set({ ai_raw_response: null })
    .where(
      and(
        isNotNull(schema.receipts.ai_raw_response),
        lt(schema.receipts.created_at, cutoff),
      ),
    )
    .returning({ id: schema.receipts.id });
  if (purged.length > 0) {
    getLogger().info(
      { count: purged.length },
      "purged expired ai_raw_response payloads",
    );
  }
  return purged.length;
}

/** Hard-delete every account whose deletion grace period has elapsed. */
export async function sweepExpiredDeletions(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * DAY_MS);
  const expired = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        isNotNull(schema.users.deletion_requested_at),
        lt(schema.users.deletion_requested_at, cutoff),
      ),
    );
  for (const user of expired) {
    await hardDeleteUser(user.id);
  }
  return expired.length;
}

/** One compliance pass: expired deletions, then expired AI raw responses. */
export async function runComplianceSweep(now: Date = new Date()): Promise<{
  deletedUsers: number;
  purgedAiResponses: number;
}> {
  const deletedUsers = await sweepExpiredDeletions(now);
  const purgedAiResponses = await purgeExpiredAiRawResponses(now);
  return { deletedUsers, purgedAiResponses };
}
