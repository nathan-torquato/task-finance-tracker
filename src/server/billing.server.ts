import { count, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Plan entitlements and Stripe webhook state mirroring. getEntitlements is
// the single source of truth every gated feature consults — no plan checks
// scattered in UI code. The subscriptions table is written only here (from
// verified webhook events) and by the TEST_MODE plan-override route.

type Db = typeof defaultDb;

export type Plan = "free" | "pro";

export interface Entitlements {
  plan: Plan;
  /** null = unlimited. */
  maxAccounts: number | null;
  scansPerMonth: number;
  /** null = unlimited. */
  maxBudgets: number | null;
}

/** Monthly category budgets allowed on the free plan (product requirement). */
export const FREE_MAX_BUDGETS = 3;

/**
 * Stripe statuses that keep Pro entitlements. `past_due` is the grace
 * period: Stripe Smart Retries run for days before the subscription is
 * finally canceled (`customer.subscription.deleted` → free, data kept).
 */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export function entitlementsForPlan(plan: Plan): Entitlements {
  if (plan === "pro") {
    return {
      plan,
      maxAccounts: null,
      scansPerMonth: env.billing.proScansPerMonth,
      maxBudgets: null,
    };
  }
  return {
    plan: "free",
    maxAccounts: env.billing.freeMaxAccounts,
    scansPerMonth: env.ai.freeScansPerMonth,
    maxBudgets: FREE_MAX_BUDGETS,
  };
}

export async function getSubscription(
  userId: string,
  db: Db = defaultDb,
): Promise<typeof schema.subscriptions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Effective plan for a user: pro only while the mirrored Stripe status is
 * entitled. No subscription row means free. */
export async function getEffectivePlan(
  userId: string,
  db: Db = defaultDb,
): Promise<Plan> {
  const sub = await getSubscription(userId, db);
  if (sub && sub.plan === "pro" && ENTITLED_STATUSES.has(sub.status)) {
    return "pro";
  }
  return "free";
}

export async function getEntitlements(
  userId: string,
  db: Db = defaultDb,
): Promise<Entitlements> {
  return entitlementsForPlan(await getEffectivePlan(userId, db));
}

export type AccountLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "account_limit_reached";
      /** Echoed to the client so the UI can localize the message. */
      limit: number;
      error: string;
    };

/** Gate for account creation: free plan allows up to freeMaxAccounts.
 * Existing accounts above the limit (e.g. after a downgrade) are never
 * deleted or locked — only creating new ones is blocked. */
export async function checkAccountLimit(
  userId: string,
  db: Db = defaultDb,
): Promise<AccountLimitResult> {
  const entitlements = await getEntitlements(userId, db);
  if (entitlements.maxAccounts === null) return { allowed: true };
  const rows = await db
    .select({ count: count() })
    .from(schema.accounts)
    .where(eq(schema.accounts.user_id, userId));
  if ((rows[0]?.count ?? 0) >= entitlements.maxAccounts) {
    return {
      allowed: false,
      code: "account_limit_reached",
      limit: entitlements.maxAccounts,
      error: `Free plan is limited to ${entitlements.maxAccounts} accounts. Upgrade to Pro for unlimited accounts.`,
    };
  }
  return { allowed: true };
}

export type BudgetLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "budget_limit_reached";
      /** Echoed to the client so the UI can localize the message. */
      limit: number;
      error: string;
    };

/** Gate for budget creation: free plan allows up to FREE_MAX_BUDGETS. Same
 * downgrade semantics as accounts — existing budgets above the limit stay
 * active; only creating new ones is blocked. */
export async function checkBudgetLimit(
  userId: string,
  db: Db = defaultDb,
): Promise<BudgetLimitResult> {
  const entitlements = await getEntitlements(userId, db);
  if (entitlements.maxBudgets === null) return { allowed: true };
  const rows = await db
    .select({ count: count() })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  if ((rows[0]?.count ?? 0) >= entitlements.maxBudgets) {
    return {
      allowed: false,
      code: "budget_limit_reached",
      limit: entitlements.maxBudgets,
      error: `Free plan is limited to ${entitlements.maxBudgets} budgets. Upgrade to Pro for unlimited budgets.`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Webhook processing

/** Minimal shape of a Stripe webhook event — only what the handlers read.
 * Typed structurally (not via an SDK) so unit tests can feed synthetic
 * events. */
export interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id?: string;
      customer?: string | null;
      subscription?: string | null;
      client_reference_id?: string | null;
      status?: string;
      current_period_end?: number | null;
      metadata?: Record<string, string> | null;
      items?: {
        data?: Array<{ current_period_end?: number | null }>;
      };
    };
  };
}

export type StripeEventOutcome =
  | "processed"
  | "duplicate"
  | "ignored"
  | "unmatched";

/**
 * Apply one verified Stripe event to the subscriptions mirror. Idempotent:
 * the event id is inserted into stripe_events first with ON CONFLICT DO
 * NOTHING — a replayed delivery inserts nothing and is skipped, so replays
 * and duplicates can never corrupt subscription state.
 */
export async function processStripeEvent(
  event: StripeEvent,
  db: Db = defaultDb,
): Promise<StripeEventOutcome> {
  const inserted = await db
    .insert(schema.stripe_events)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: schema.stripe_events.id });
  if (inserted.length === 0) return "duplicate";

  const log = getLogger().child({ stripeEventId: event.id, type: event.type });
  const object = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const userId = object.client_reference_id;
      if (!userId) {
        log.warn("checkout session without client_reference_id");
        return "unmatched";
      }
      await db
        .insert(schema.subscriptions)
        .values({
          user_id: userId,
          stripe_customer_id: object.customer ?? null,
          stripe_subscription_id: object.subscription ?? null,
          plan: "pro",
          status: "active",
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.subscriptions.user_id,
          set: {
            stripe_customer_id: object.customer ?? null,
            stripe_subscription_id: object.subscription ?? null,
            plan: "pro",
            status: "active",
            updated_at: new Date(),
          },
        });
      log.info({ userId }, "subscription activated via checkout");
      return "processed";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const userId = await resolveUserId(object, db);
      if (!userId) {
        log.warn("subscription event could not be attributed to a user");
        return "unmatched";
      }
      // Older API versions carry current_period_end on the subscription,
      // newer ones on the subscription item.
      const periodEnd =
        object.current_period_end ??
        object.items?.data?.[0]?.current_period_end ??
        null;
      await db
        .insert(schema.subscriptions)
        .values({
          user_id: userId,
          stripe_customer_id: object.customer ?? null,
          stripe_subscription_id: object.id ?? null,
          plan: "pro",
          status: object.status ?? "active",
          current_period_end: periodEnd ? new Date(periodEnd * 1000) : null,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.subscriptions.user_id,
          set: {
            stripe_customer_id: object.customer ?? null,
            stripe_subscription_id: object.id ?? null,
            plan: "pro",
            status: object.status ?? "active",
            current_period_end: periodEnd ? new Date(periodEnd * 1000) : null,
            updated_at: new Date(),
          },
        });
      log.info({ userId, status: object.status }, "subscription state mirrored");
      return "processed";
    }

    case "customer.subscription.deleted": {
      const userId = await resolveUserId(object, db);
      if (!userId) {
        log.warn("subscription deletion could not be attributed to a user");
        return "unmatched";
      }
      await db
        .update(schema.subscriptions)
        .set({ plan: "free", status: "canceled", updated_at: new Date() })
        .where(eq(schema.subscriptions.user_id, userId));
      log.info({ userId }, "subscription canceled — downgraded to free");
      return "processed";
    }

    case "invoice.payment_failed": {
      // Grace period: mark past_due (still entitled) and let Stripe Smart
      // Retries run; the final downgrade arrives as subscription.deleted.
      if (!object.customer) return "unmatched";
      await db
        .update(schema.subscriptions)
        .set({ status: "past_due", updated_at: new Date() })
        .where(eq(schema.subscriptions.stripe_customer_id, object.customer));
      log.info({ customer: object.customer }, "payment failed — past_due");
      return "processed";
    }

    default:
      return "ignored";
  }
}

/** Attribute a subscription object to a user: metadata.userId (set at
 * checkout) first, then the existing row for the Stripe customer. */
async function resolveUserId(
  object: StripeEvent["data"]["object"],
  db: Db,
): Promise<string | null> {
  const fromMetadata = object.metadata?.userId;
  if (fromMetadata) return fromMetadata;
  if (!object.customer) return null;
  const rows = await db
    .select({ user_id: schema.subscriptions.user_id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripe_customer_id, object.customer))
    .limit(1);
  return rows[0]?.user_id ?? null;
}
