import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
} from "#/server/billing.functions";
import { m } from "#/paraglide/messages";
import { Button } from "#/components/ui/button";


const BILLING_QUERY_KEY = ["billing"] as const;

type BillingSearch = { checkout?: "success" | "cancelled" };

export const Route = createFileRoute("/_authed/billing")({
  validateSearch: (search: Record<string, unknown>): BillingSearch => ({
    checkout:
      search.checkout === "success" || search.checkout === "cancelled"
        ? search.checkout
        : undefined,
  }),
  component: BillingPage,
});

function BillingPage() {
  const { checkout } = Route.useSearch();
  const getBillingStatusFn = useServerFn(getBillingStatus);
  const createCheckoutSessionFn = useServerFn(createCheckoutSession);
  const createPortalSessionFn = useServerFn(createPortalSession);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: billing, isLoading } = useQuery({
    queryKey: BILLING_QUERY_KEY,
    queryFn: () => getBillingStatusFn(),
    // The plan flips via webhook shortly after checkout — poll briefly so
    // the "Pro" badge appears without a manual reload.
    refetchInterval: checkout === "success" ? 3000 : false,
  });

  const checkoutMutation = useMutation({
    mutationFn: () => createCheckoutSessionFn(),
    onSuccess: (result) => {
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      window.location.href = result.url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => createPortalSessionFn(),
    onSuccess: (result) => {
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      window.location.href = result.url;
    },
  });

  const isPro = billing?.plan === "pro";

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4">
          <h1 className="text-xl font-bold display-title">
            {m.billing_title()}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {m.billing_subtitle()}
          </p>
        </div>
      </header>

      <main className="page-wrap py-6 space-y-4 max-w-2xl">
        {checkout === "success" && (
          <div
            className="rounded-md border border-green-600/30 bg-green-600/10 px-4 py-3 text-sm"
            role="status"
          >
            {m.billing_checkout_success()}
          </div>
        )}
        {checkout === "cancelled" && (
          <div
            className="rounded-md border border-line bg-muted/40 px-4 py-3 text-sm"
            role="status"
          >
            {m.billing_checkout_cancelled()}
          </div>
        )}
        {actionError && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {actionError}
          </div>
        )}

        {isLoading || !billing ? (
          <p className="text-sm text-muted-foreground">...</p>
        ) : (
          <>
            {/* Current plan */}
            <section className="rounded-lg border border-line bg-card p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm text-muted-foreground">
                    {m.billing_current_plan()}
                  </h2>
                  <p
                    className="text-2xl font-bold mt-0.5"
                    data-testid="billing-plan"
                  >
                    {isPro ? m.billing_plan_pro() : m.billing_plan_free()}
                  </p>
                </div>
                {billing.billingEnabled && !isPro && (
                  <Button
                    onClick={() => {
                      setActionError(null);
                      checkoutMutation.mutate();
                    }}
                    disabled={checkoutMutation.isPending}
                    
                  >
                    {checkoutMutation.isPending
                      ? m.billing_upgrading()
                      : m.billing_upgrade()}
                  </Button>
                )}
                {billing.billingEnabled && billing.hasStripeCustomer && (
                  <Button
                    onClick={() => {
                      setActionError(null);
                      portalMutation.mutate();
                    }}
                    disabled={portalMutation.isPending}
                    variant="outline"
                  >
                    {portalMutation.isPending
                      ? m.billing_manage_opening()
                      : m.billing_manage()}
                  </Button>
                )}
              </div>

              <p className="text-sm text-muted-foreground mt-3">
                {isPro ? m.billing_pro_blurb() : m.billing_free_blurb()}
              </p>

              {billing.subscriptionStatus === "past_due" && (
                <p
                  className="text-sm text-destructive mt-3"
                  data-testid="billing-past-due"
                >
                  {m.billing_past_due()}
                </p>
              )}
              {billing.currentPeriodEnd && isPro && (
                <p className="text-sm text-muted-foreground mt-1">
                  {m.billing_renews({
                    date: new Date(
                      billing.currentPeriodEnd,
                    ).toLocaleDateString(),
                  })}
                </p>
              )}
              {!billing.billingEnabled && !isPro && (
                <p className="text-sm text-muted-foreground mt-3">
                  {m.billing_not_configured()}
                </p>
              )}
            </section>

            {/* Usage */}
            <section className="rounded-lg border border-line bg-card p-5">
              <h2 className="text-sm font-medium mb-3">
                {m.billing_usage_title()}
              </h2>
              <ul className="space-y-2 text-sm">
                <li data-testid="billing-scans-usage">
                  {m.billing_scans_usage({
                    used: billing.usage.scansUsed,
                    limit: billing.entitlements.scansPerMonth,
                  })}
                </li>
                <li data-testid="billing-accounts-usage">
                  {billing.entitlements.maxAccounts === null
                    ? m.billing_accounts_unlimited({
                        used: billing.usage.accountsUsed,
                      })
                    : m.billing_accounts_usage({
                        used: billing.usage.accountsUsed,
                        limit: billing.entitlements.maxAccounts,
                      })}
                </li>
                <li data-testid="billing-budgets-usage">
                  {billing.entitlements.maxBudgets === null
                    ? m.billing_budgets_unlimited({
                        used: billing.usage.budgetsUsed,
                      })
                    : m.billing_budgets_usage({
                        used: billing.usage.budgetsUsed,
                        limit: billing.entitlements.maxBudgets,
                      })}
                </li>
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
