import { createServerFn } from "@tanstack/react-start";
import { eq, count } from "drizzle-orm";
import { db, schema } from "#/db";
import { getMonthlyScanCount } from "#/server/ai-usage.server";
import { getEntitlements, getSubscription } from "#/server/billing.server";
import { countBudgets } from "#/server/budgets.server";
import { env } from "#/server/env";
import { requireUserId } from "#/server/session";
import {
  createStripeCheckoutSession,
  createStripePortalSession,
} from "#/server/stripe.server";

//
// Client-callable billing surface: current plan + entitlements + usage for
// the billing page, and Checkout/Portal session creation. Stripe calls live
// in stripe.server.ts; state reads in billing.server.ts.

export interface BillingStatus {
  billingEnabled: boolean;
  plan: "free" | "pro";
  /** Raw Stripe status of the mirrored subscription, if any. */
  subscriptionStatus: string | null;
  /** ISO date the current paid period ends (renews or expires), if known. */
  currentPeriodEnd: string | null;
  /** True when a Stripe customer exists, i.e. the portal is reachable. */
  hasStripeCustomer: boolean;
  entitlements: {
    maxAccounts: number | null;
    scansPerMonth: number;
    maxBudgets: number | null;
  };
  usage: {
    scansUsed: number;
    accountsUsed: number;
    budgetsUsed: number;
  };
}

export const getBillingStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<BillingStatus> => {
    const userId = await requireUserId();
    const [entitlements, subscription, scansUsed, accountRows, budgetsUsed] =
      await Promise.all([
        getEntitlements(userId),
        getSubscription(userId),
        getMonthlyScanCount(userId),
        db
          .select({ count: count() })
          .from(schema.accounts)
          .where(eq(schema.accounts.user_id, userId)),
        countBudgets(userId),
      ]);

    return {
      billingEnabled: env.billing.enabled,
      plan: entitlements.plan,
      subscriptionStatus: subscription?.status ?? null,
      currentPeriodEnd: subscription?.current_period_end?.toISOString() ?? null,
      hasStripeCustomer: Boolean(subscription?.stripe_customer_id),
      entitlements: {
        maxAccounts: entitlements.maxAccounts,
        scansPerMonth: entitlements.scansPerMonth,
        maxBudgets: entitlements.maxBudgets,
      },
      usage: {
        scansUsed,
        accountsUsed: accountRows[0]?.count ?? 0,
        budgetsUsed,
      },
    };
  },
);

export const createCheckoutSession = createServerFn({
  method: "POST",
}).handler(async (): Promise<{ url: string } | { error: string }> => {
  if (!env.billing.enabled) {
    return { error: "Billing is not available on this deployment." };
  }
  const userId = await requireUserId();
  const users = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const base = env.email.baseUrl;
  return createStripeCheckoutSession({
    userId,
    email: users[0]?.email ?? null,
    successUrl: `${base}/billing?checkout=success`,
    cancelUrl: `${base}/billing?checkout=cancelled`,
  });
});

export const createPortalSession = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ url: string } | { error: string }> => {
    if (!env.billing.enabled) {
      return { error: "Billing is not available on this deployment." };
    }
    const userId = await requireUserId();
    const subscription = await getSubscription(userId);
    if (!subscription?.stripe_customer_id) {
      return { error: "No billing profile yet — upgrade first." };
    }
    return createStripePortalSession(
      subscription.stripe_customer_id,
      `${env.email.baseUrl}/billing`,
    );
  },
);
