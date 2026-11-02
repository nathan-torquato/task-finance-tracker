import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { format } from "date-fns";
import { m } from "#/paraglide/messages";
import { formatMinor, minorToInputValue, parseAmountToMinor } from "#/lib/money";
import { useHydrated } from "#/lib/use-hydrated";
import { cn } from "#/lib/utils";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { getCategories } from "#/server/categories.functions";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

const BUDGETS_QUERY_KEY = ["budgets"] as const;
// Shared with the categories page so its mutations refresh this list too.
const CATEGORIES_QUERY_KEY = ["categories"] as const;

type BudgetsOverview = Awaited<ReturnType<typeof getBudgets>>;
type Budget = BudgetsOverview["budgets"][number];
type CategoryRow = Awaited<ReturnType<typeof getCategories>>[number];

/** Server error → localized message (codes mirror the accounts page). */
function errorMessage(result: { error?: string; code?: string; limit?: number }) {
  switch (result.code) {
    case "budget_limit_reached":
      return m.budget_limit_reached({ limit: result.limit ?? 0 });
    case "budget_exists":
      return m.budget_already_exists();
    default:
      return result.error ?? null;
  }
}

/** "Food › Restaurants" — disambiguates sub-categories in the picker. */
function categoryLabel(cat: CategoryRow, byId: Map<string, CategoryRow>) {
  const parent = cat.parent_id ? byId.get(cat.parent_id) : undefined;
  return parent ? `${parent.name} › ${cat.name}` : cat.name;
}

// --- Budget row ---

function BudgetRow({
  budget,
  hasSubcategories,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  hasSubcategories: boolean;
  onEdit: (budget: Budget) => void;
  onDelete: (budget: Budget) => void;
}) {
  const currency = m.analytics_currency();
  const percent =
    budget.limitMinor > 0
      ? Math.round((budget.spentMinor / budget.limitMinor) * 100)
      : 0;
  const barColor = {
    ok: "bg-emerald-500",
    warning: "bg-amber-500",
    over: "bg-destructive",
  }[budget.status];

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3 px-3 py-3 hover:bg-accent/50 transition-colors"
      role="row"
      data-testid="budget-row"
      data-status={budget.status}
    >
      {/* Category */}
      <div className="flex items-center gap-3 sm:w-56 min-w-0">
        <span
          className="size-4 shrink-0 rounded-full border border-border/50 shadow-sm"
          style={{ backgroundColor: budget.categoryColor ?? "#6b7280" }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{budget.categoryName}</div>
          {hasSubcategories && (
            <div className="text-xs text-muted-foreground">
              {m.budget_includes_subcategories()}
            </div>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
          <span className="tabular-nums" data-testid="budget-spent">
            {m.budget_spent_of_limit({
              spent: formatMinor(budget.spentMinor),
              limit: formatMinor(budget.limitMinor),
              currency,
            })}
          </span>
          <span className="flex items-center gap-2">
            {budget.status === "over" && (
              <Badge variant="destructive">{m.budget_over_badge()}</Badge>
            )}
            {budget.status === "warning" && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-600 dark:text-amber-400"
              >
                {m.budget_warning_badge()}
              </Badge>
            )}
            <span
              className={cn(
                "tabular-nums font-medium",
                budget.status === "over" && "text-destructive",
              )}
              data-testid="budget-remaining"
            >
              {budget.remainingMinor < 0
                ? m.budget_over_by({
                    amount: formatMinor(-budget.remainingMinor),
                    currency,
                  })
                : m.budget_left({
                    amount: formatMinor(budget.remainingMinor),
                    currency,
                  })}
            </span>
          </span>
        </div>
        <div
          className="h-2 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-label={budget.categoryName}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent, 100)}
        >
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 sm:w-32 justify-end">
        <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
        <DeleteButton
          onClick={() => onDelete(budget)}
          data-testid="delete-budget"
        />
      </div>
    </div>
  );
}

// --- Add / Edit form ---

function BudgetForm({
  isOpen,
  editingBudget,
  availableCategories,
  categoriesById,
  error,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  editingBudget: Budget | null;
  availableCategories: CategoryRow[];
  categoriesById: Map<string, CategoryRow>;
  error: string | null;
  onClose: () => void;
  onSubmit: (data: { categoryId: string; limitMinor: number }) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editingBudget?.categoryId ?? "");
      setLimit(
        editingBudget ? String(minorToInputValue(editingBudget.limitMinor)) : "",
      );
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingBudget]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setValidationError(m.budget_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budget_limit_invalid());
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      await onSubmit({ categoryId, limitMinor });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.edit_budget_title() : m.create_budget_title()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.budget_category_label()}
            </Label>
            {editingBudget ? (
              <Input
                id="budget-category"
                value={editingBudget.categoryName}
                disabled
                readOnly
              />
            ) : (
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <SelectItem value="">{m.budget_category_required()}</SelectItem>
                {availableCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {categoryLabel(cat, categoriesById)}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budget_limit_label()} ({m.analytics_currency()})
            </Label>
            <Input
              id="budget-limit"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              autoFocus={!!editingBudget}
              placeholder="500.00"
            />
          </div>

          {(validationError || error) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.create_budget_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Main page ---

function BudgetsPage() {
  const queryClient = useQueryClient();
  const hydrated = useHydrated();

  // "This month" in the browser's timezone (same convention as the
  // dashboard). Computed only after hydration so SSR never uses the
  // server's clock/timezone.
  const month = hydrated ? format(new Date(), "yyyy-MM") : null;

  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data: overview, isLoading } = useQuery({
    queryKey: [...BUDGETS_QUERY_KEY, month],
    queryFn: () => getBudgetsFn({ data: { month: month! } }),
    enabled: month !== null,
  });
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }) =>
      createBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: (data: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteBudgetFn({ data }),
    onSuccess: invalidate,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const budgets = overview?.budgets ?? [];
  const maxBudgets = overview?.maxBudgets ?? null;
  const atLimit = maxBudgets !== null && budgets.length >= maxBudgets;

  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const budgetedCategoryIds = new Set(budgets.map((b) => b.categoryId));
  const availableCategories = categories
    .filter((c) => !budgetedCategoryIds.has(c.id))
    .sort((a, b) =>
      categoryLabel(a, categoriesById).localeCompare(
        categoryLabel(b, categoriesById),
      ),
    );
  const parentIds = new Set(
    categories.map((c) => c.parent_id).filter((id): id is string => !!id),
  );

  const loading = !month || isLoading || categoriesLoading;

  const handleAdd = () => {
    setEditingBudget(null);
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleEdit = (budget: Budget) => {
    setEditingBudget(budget);
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
    setFormError(null);
  };

  const handleFormSubmit = async (data: {
    categoryId: string;
    limitMinor: number;
  }) => {
    setFormError(null);
    const result = editingBudget
      ? await updateMutation.mutateAsync({
          id: editingBudget.id,
          limitMinor: data.limitMinor,
        })
      : await createMutation.mutateAsync(data);
    if (result && "error" in result) {
      setFormError(errorMessage(result));
      return;
    }
    closeForm();
  };

  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setDeleteError(null);
    const result = await deleteMutation.mutateAsync({ id: deleting.id });
    if (result && "error" in result) {
      setDeleteError(errorMessage(result));
      return;
    }
    setDeleting(null);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle()}
            </p>
          </div>
          <Button
            onClick={handleAdd}
            disabled={loading || atLimit || availableCategories.length === 0}
          >
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {m.add_budget()}
          </Button>
        </div>
      </header>

      <main className="page-wrap py-8">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">{m.loading()}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4 text-sm">
              <h2 className="font-medium" data-testid="budgets-month">
                {m.budgets_month({
                  month: format(new Date(`${month}-01T00:00:00`), "MMMM yyyy"),
                })}
              </h2>
              {maxBudgets !== null && (
                <span className="text-muted-foreground" data-testid="budgets-usage">
                  {m.budgets_usage({ used: budgets.length, limit: maxBudgets })}
                </span>
              )}
            </div>

            {atLimit && (
              <div
                className="mb-4 p-3 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm flex flex-wrap items-center gap-x-2"
                data-testid="budget-limit-notice"
              >
                <span>{m.budget_limit_reached({ limit: maxBudgets })}</span>
                <Link to="/billing" className="font-medium underline">
                  {m.budget_upgrade_link()}
                </Link>
              </div>
            )}

            {budgets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <h3 className="text-base font-medium mb-1">{m.no_budgets_yet()}</h3>
                <p className="text-sm text-muted-foreground mb-4 max-w-sm">
                  {categories.length === 0
                    ? m.budgets_need_categories()
                    : m.create_first_budget()}
                </p>
                {categories.length === 0 && (
                  <Link to="/categories" className="text-sm font-medium underline">
                    {m.nav_categories()}
                  </Link>
                )}
              </div>
            ) : (
              <div className="island-shell rounded-xl overflow-hidden">
                <div className="hidden sm:flex items-center gap-3 px-3 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <span className="w-56">{m.budget_category_column()}</span>
                  <span className="flex-1">{m.budget_progress_column()}</span>
                  <span className="w-32 text-right">{m.actions_column()}</span>
                </div>
                <div className="divide-y divide-line/30">
                  {budgets.map((budget) => (
                    <BudgetRow
                      key={budget.id}
                      budget={budget}
                      hasSubcategories={parentIds.has(budget.categoryId)}
                      onEdit={handleEdit}
                      onDelete={(b) => {
                        setDeleteError(null);
                        setDeleting(b);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        availableCategories={availableCategories}
        categoriesById={categoriesById}
        error={formError}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
      />

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.delete_budget_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.delete_budget_confirm({ name: deleting?.categoryName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div
              className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
              role="alert"
            >
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleting(null)}>
              {m.cancel()}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteConfirm}>
              {m.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
