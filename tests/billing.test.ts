// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  checkAccountLimit,
  entitlementsForPlan,
  getEntitlements,
  getSubscription,
  processStripeEvent,
  type StripeEvent,
} from "../src/server/billing.server.ts";
import {
  checkScanAllowed,
  getMonthlyUsageSummary,
} from "../src/server/ai-usage.server.ts";
import {
  encodeStripeParams,
  signStripePayload,
  verifyStripeSignature,
} from "../src/server/stripe.server.ts";
import { env } from "../src/server/env.ts";

describe("billing entitlements and webhook processing", () => {
  const userId = "billing-test-user";

  const setSubscription = (
    plan: "free" | "pro",
    status: string,
    extra: Partial<typeof schema.subscriptions.$inferInsert> = {},
  ) =>
    db.insert(schema.subscriptions).values({
      user_id: userId,
      stripe_customer_id: `cus_${userId}`,
      stripe_subscription_id: `sub_${userId}`,
      plan,
      status,
      ...extra,
    });

  beforeEach(async () => {
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: "x",
    });
  });

  afterEach(async () => {
    await db.delete(schema.subscriptions);
    await db.delete(schema.stripe_events);
    await db.delete(schema.ai_usage);
    await db.delete(schema.accounts).where(eq(schema.accounts.user_id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("maps plans to entitlements: free is limited, pro is not", () => {
    expect(entitlementsForPlan("free")).toEqual({
      plan: "free",
      maxAccounts: env.billing.freeMaxAccounts,
      scansPerMonth: env.ai.freeScansPerMonth,
      maxBudgets: 3,
    });
    expect(entitlementsForPlan("pro")).toEqual({
      plan: "pro",
      maxAccounts: null,
      scansPerMonth: env.billing.proScansPerMonth,
      maxBudgets: null,
    });
  });

  it("derives the effective plan from the mirrored Stripe status", async () => {
    // No subscription row → free.
    expect((await getEntitlements(userId, db)).plan).toBe("free");

    // Entitled statuses keep Pro — past_due is the payment-failure grace.
    for (const status of ["active", "trialing", "past_due"]) {
      await setSubscription("pro", status);
      expect((await getEntitlements(userId, db)).plan).toBe("pro");
      await db.delete(schema.subscriptions);
    }

    // Terminal statuses drop to free without touching any data.
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      await setSubscription("pro", status);
      expect((await getEntitlements(userId, db)).plan).toBe("free");
      await db.delete(schema.subscriptions);
    }
  });

  it("blocks account creation at the free limit and never for pro", async () => {
    for (let i = 0; i < env.billing.freeMaxAccounts; i++) {
      await db.insert(schema.accounts).values({
        id: `billing-acc-${i}`,
        user_id: userId,
        name: `Account ${i}`,
      });
    }
    const blocked = await checkAccountLimit(userId, db);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.code).toBe("account_limit_reached");
      expect(blocked.limit).toBe(env.billing.freeMaxAccounts);
    }

    // The same user with a pro subscription is unlimited — existing
    // accounts above the free limit stay usable after any downgrade.
    await setSubscription("pro", "active");
    expect((await checkAccountLimit(userId, db)).allowed).toBe(true);
  });

  it("scan quota and usage summary follow the plan", async () => {
    const now = new Date("2026-07-15T12:00:00Z");
    // Exhaust the free quota.
    await db.insert(schema.ai_usage).values(
      Array.from({ length: env.ai.freeScansPerMonth }, () => ({
        id: crypto.randomUUID(),
        user_id: userId,
        kind: "receipt_scan" as const,
        provider: "fake",
        model: "fake",
        created_at: now,
      })),
    );
    const freeGate = await checkScanAllowed(userId, db, now);
    expect(freeGate.allowed).toBe(false);

    await setSubscription("pro", "active");
    expect((await checkScanAllowed(userId, db, now)).allowed).toBe(true);
    expect(await getMonthlyUsageSummary(userId, db, now)).toEqual({
      scansUsed: env.ai.freeScansPerMonth,
      scansLimit: env.billing.proScansPerMonth,
      plan: "pro",
    });
  });

  const checkoutEvent = (id = "evt_checkout_1"): StripeEvent => ({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        client_reference_id: userId,
        customer: "cus_stripe_1",
        subscription: "sub_stripe_1",
      },
    },
  });

  it("checkout.session.completed activates the pro plan for the referenced user", async () => {
    expect(await processStripeEvent(checkoutEvent(), db)).toBe("processed");
    const sub = await getSubscription(userId, db);
    expect(sub).toMatchObject({
      plan: "pro",
      status: "active",
      stripe_customer_id: "cus_stripe_1",
      stripe_subscription_id: "sub_stripe_1",
    });
    expect((await getEntitlements(userId, db)).plan).toBe("pro");
  });

  it("replayed and duplicated webhook deliveries are no-ops", async () => {
    expect(await processStripeEvent(checkoutEvent(), db)).toBe("processed");

    // Same event id again — even with tampered content it must not apply.
    const replay = checkoutEvent();
    replay.data.object.customer = "cus_evil";
    expect(await processStripeEvent(replay, db)).toBe("duplicate");
    const sub = await getSubscription(userId, db);
    expect(sub?.stripe_customer_id).toBe("cus_stripe_1");
  });

  it("mirrors subscription updates, payment failure grace, and final cancellation", async () => {
    await processStripeEvent(checkoutEvent(), db);

    // Renewal update carries the new period end (item-level field).
    expect(
      await processStripeEvent(
        {
          id: "evt_update_1",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_stripe_1",
              customer: "cus_stripe_1",
              status: "active",
              metadata: { userId },
              items: { data: [{ current_period_end: 1_800_000_000 }] },
            },
          },
        },
        db,
      ),
    ).toBe("processed");
    let sub = await getSubscription(userId, db);
    expect(sub?.current_period_end?.toISOString()).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );

    // Payment failure → past_due, but entitlements stay pro (grace period).
    expect(
      await processStripeEvent(
        {
          id: "evt_fail_1",
          type: "invoice.payment_failed",
          data: { object: { id: "in_1", customer: "cus_stripe_1" } },
        },
        db,
      ),
    ).toBe("processed");
    sub = await getSubscription(userId, db);
    expect(sub?.status).toBe("past_due");
    expect((await getEntitlements(userId, db)).plan).toBe("pro");

    // Final cancellation → free; the row (and all user data) is kept.
    expect(
      await processStripeEvent(
        {
          id: "evt_delete_1",
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_stripe_1",
              customer: "cus_stripe_1",
              metadata: { userId },
            },
          },
        },
        db,
      ),
    ).toBe("processed");
    sub = await getSubscription(userId, db);
    expect(sub).toMatchObject({ plan: "free", status: "canceled" });
    expect((await getEntitlements(userId, db)).plan).toBe("free");
  });

  it("ignores unhandled event types and flags unattributable ones", async () => {
    expect(
      await processStripeEvent(
        {
          id: "evt_other_1",
          type: "invoice.finalized",
          data: { object: { id: "in_2" } },
        },
        db,
      ),
    ).toBe("ignored");

    // A subscription event for an unknown customer with no metadata cannot
    // be attributed — it must not create or modify any row.
    expect(
      await processStripeEvent(
        {
          id: "evt_orphan_1",
          type: "customer.subscription.updated",
          data: {
            object: { id: "sub_x", customer: "cus_unknown", status: "active" },
          },
        },
        db,
      ),
    ).toBe("unmatched");
    expect(await db.select().from(schema.subscriptions)).toEqual([]);
  });
});

describe("stripe webhook signature verification", () => {
  const secret = "whsec_test_secret";
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';

  it("accepts a correctly signed payload and rejects everything else", () => {
    const now = 1_750_000_000;
    const header = signStripePayload(body, secret, now);

    expect(verifyStripeSignature(body, header, secret, now)).toBe(true);
    // Wrong secret, tampered body, missing header
    expect(verifyStripeSignature(body, header, "whsec_other", now)).toBe(false);
    expect(verifyStripeSignature(body + " ", header, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, null, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, "garbage", secret, now)).toBe(false);
    expect(verifyStripeSignature(body, "t=abc,v1=zz", secret, now)).toBe(false);
  });

  it("rejects signatures outside the timestamp tolerance", () => {
    const signedAt = 1_750_000_000;
    const header = signStripePayload(body, secret, signedAt);
    // Within tolerance (default 300s) passes; beyond it fails.
    expect(verifyStripeSignature(body, header, secret, signedAt + 299)).toBe(true);
    expect(verifyStripeSignature(body, header, secret, signedAt + 301)).toBe(false);
  });

  it("encodes nested params in Stripe's form style", () => {
    const params = encodeStripeParams({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      subscription_data: { metadata: { userId: "u1" } },
      skipped: undefined,
    });
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("line_items[0][price]")).toBe("price_1");
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("subscription_data[metadata][userId]")).toBe("u1");
    expect(params.has("skipped")).toBe(false);
  });
});
