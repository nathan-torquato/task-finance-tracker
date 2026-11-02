import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useCallback, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { formatMinor, parseAmountToMinor } from "#/lib/money";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { CategoryBadge } from "#/components/ui/category-badge";
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
import {
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  getTransactionById,
} from "#/server/transactions.functions";
import { getAccounts } from "#/server/accounts.functions";
import { getCategories } from "#/server/categories.functions";


const TRANSACTIONS_QUERY_KEY = ["transactions"] as const;
const ACCOUNTS_QUERY_KEY = ["accounts"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;

// --- Filter / Sort / Pagination State ---

interface TransactionFilters {
  dateFrom: string;
  dateTo: string;
  accountId: string;
  categoryId: string;
  amountMin: string;
  amountMax: string;
  search: string;
  hasReceipt: boolean | null;
}

interface TransactionSort {
  field: "date" | "amount" | "category";
  direction: "asc" | "desc";
}

const defaultFilters: TransactionFilters = {
  dateFrom: "",
  dateTo: "",
  accountId: "",
  categoryId: "",
  amountMin: "",
  amountMax: "",
  search: "",
  hasReceipt: null,
};

const defaultSort: TransactionSort = {
  field: "date",
  direction: "desc",
};

// --- Transaction Row ---

type TransactionRow = Awaited<ReturnType<typeof getTransactions>>["transactions"][number];

function TransactionRow({
  transaction,
  onEdit,
  onDelete,
}: {
  transaction: TransactionRow;
  onEdit: (tx: TransactionRow) => void;
  onDelete: (id: string) => void;
}) {
  const isExpense = transaction.amount_minor < 0;
  const amountStr = isExpense
    ? `− ${formatMinor(Math.abs(transaction.amount_minor))}`
    : `+ ${formatMinor(transaction.amount_minor)}`;
  const hasReceipt = !!transaction.has_receipt;

  return (
    <div
      data-testid="transaction-row"
      role="row"
      data-source={transaction.source ?? "manual"}
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors group/row"
    >
      {/* Date */}
      <span role="cell" className="w-28 text-sm text-muted-foreground tabular-nums shrink-0">
        {formatTxDate(transaction.date)}
      </span>

      {/* Description */}
      <span role="cell" className="flex-1 text-sm truncate min-w-0">
        {transaction.description || (
          <span className="text-muted-foreground/50 italic">{m.no_description()}</span>
        )}
      </span>

      {/* Amount */}
      <span
        role="cell"
        className={`w-28 text-sm font-mono text-right shrink-0 ${
          isExpense ? "text-red-500" : "text-emerald-500"
        }`}
      >
        {amountStr}
      </span>

      {/* Category */}
      <span role="cell" className="w-32 truncate shrink-0">
        <CategoryBadge name={transaction.category_name} color={transaction.category_color} />
      </span>

      {/* Account */}
      <span role="cell" className="w-32 text-sm text-muted-foreground truncate shrink-0">
        {transaction.account_name || "—"}
      </span>

      {/* Actions */}
      <span role="cell" className="w-32 text-right shrink-0">
        <div className="flex items-center justify-end gap-1">
          {hasReceipt && (
            <Link
              to="/receipts/view/$transactionId"
              params={{ transactionId: transaction.id }}
              data-testid="view-receipt"
              title={m.receipt_view_indicator()}
              className="inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                />
              </svg>
            </Link>
          )}
          <EditButton onClick={() => onEdit(transaction)} data-testid="edit-transaction" />
          <DeleteButton onClick={() => onDelete(transaction.id)} data-testid="delete-transaction" />
        </div>
      </span>
    </div>
  );
}

// --- Mobile Transaction Card ---

function TransactionCard({
  transaction,
  onEdit,
  onDelete,
}: {
  transaction: TransactionRow;
  onEdit: (tx: TransactionRow) => void;
  onDelete: (id: string) => void;
}) {
  const isExpense = transaction.amount_minor < 0;
  const hasReceipt = !!transaction.has_receipt;

  return (
    <div className="p-4 border-b border-line/30 last:border-b-0">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {transaction.description || (
              <span className="text-muted-foreground/50 italic">
                {m.no_description()}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {transaction.account_name}
            {transaction.category_name && (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: transaction.category_color ?? "#6b7280" }} />
                  {transaction.category_name}
                </span>
              </>
            )}
          </p>
        </div>
        <span
          className={`text-sm font-mono font-semibold ml-3 shrink-0 ${
            isExpense ? "text-red-500" : "text-emerald-500"
          }`}
        >
          {isExpense
            ? `− ${formatMinor(Math.abs(transaction.amount_minor))}`
            : `+ ${formatMinor(transaction.amount_minor)}`}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{formatTxDate(transaction.date)}</span>
        <div className="flex gap-1">
          {hasReceipt && (
            <Link
              to="/receipts/view/$transactionId"
              params={{ transactionId: transaction.id }}
              data-testid="view-receipt"
              title={m.receipt_view_indicator()}
              className="inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                />
              </svg>
            </Link>
          )}
          <EditButton onClick={() => onEdit(transaction)} data-testid="edit-transaction" />
          <DeleteButton onClick={() => onDelete(transaction.id)} data-testid="delete-transaction" />
        </div>
      </div>
    </div>
  );
}

// --- Filter Bar ---

function FilterBar({
  filters,
  sort,
  accounts,
  categories,
  onFilterChange,
  onSortChange,
  onReset,
}: {
  filters: TransactionFilters;
  sort: TransactionSort;
  accounts: { id: string; name: string; currency: string | null }[];
  categories: { id: string; name: string }[];
  onFilterChange: (filters: TransactionFilters) => void;
  onSortChange: (sort: TransactionSort) => void;
  onReset: () => void;
}) {
  const handleChange =
    (field: keyof TransactionFilters) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      onFilterChange({ ...filters, [field]: e.target.value });
    };

  const handleSort = (field: TransactionSort["field"]) => {
    onSortChange({
      field,
      direction:
        sort.field === field && sort.direction === "desc" ? "asc" : "desc",
    });
  };

  const SortIcon = ({ field }: { field: TransactionSort["field"] }) => {
    if (sort.field !== field) return null;
    return sort.direction === "asc" ? " ▲" : " ▼";
  };

  return (
    <div className="mb-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end mb-2">
        {/* Date From */}
        <div>
          <Label
            htmlFor="filter-date-from"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.from_label()}
          </Label>
          <Input
            id="filter-date-from"
            type="date"
            value={filters.dateFrom}
            onChange={handleChange("dateFrom")}
            className="h-8 w-36 px-2"
          />
        </div>

        {/* Date To */}
        <div>
          <Label
            htmlFor="filter-date-to"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.to_label()}
          </Label>
          <Input
            id="filter-date-to"
            type="date"
            value={filters.dateTo}
            onChange={handleChange("dateTo")}
            className="h-8 w-36 px-2"
          />
        </div>

        {/* Account */}
        <div>
          <Label
            htmlFor="filter-account"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.account_filter()}
          </Label>
          <Select
            id="filter-account"
            value={filters.accountId}
            onChange={handleChange("accountId")}
            className="h-8 w-40 px-2"
          >
            <SelectItem value="">{m.all_accounts()}</SelectItem>
            {accounts.map((acc) => (
              <SelectItem key={acc.id} value={acc.id}>
                {acc.name} ({acc.currency})
              </SelectItem>
            ))}
          </Select>
        </div>

        {/* Category */}
        <div>
          <Label
            htmlFor="filter-category"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.category_filter()}
          </Label>
          <Select
            id="filter-category"
            aria-label="Category"
            value={filters.categoryId}
            onChange={handleChange("categoryId")}
            className="h-8 w-40 px-2"
          >
            <SelectItem value="">{m.all_categories()}</SelectItem>
            <SelectItem value="__uncategorized__">{m.uncategorized()}</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </Select>
        </div>

        {/* Amount Min */}
        <div>
          <Label
            htmlFor="filter-amount-min"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.min_amount_label()}
          </Label>
          <Input
            id="filter-amount-min"
            type="number"
            step="0.01"
            min="0"
            value={filters.amountMin}
            onChange={handleChange("amountMin")}
            placeholder="0"
            className="h-8 w-24 px-2"
          />
        </div>

        {/* Amount Max */}
        <div>
          <Label
            htmlFor="filter-amount-max"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            {m.max_amount_label()}
          </Label>
          <Input
            id="filter-amount-max"
            type="number"
            step="0.01"
            min="0"
            value={filters.amountMax}
            onChange={handleChange("amountMax")}
            placeholder="∞"
            className="h-8 w-24 px-2"
          />
        </div>

        {/* Search */}
        <div className="flex-1 min-w-[150px]">
          <Label
            htmlFor="filter-search"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            Search
          </Label>
          <Input
            id="filter-search"
            type="text"
            value={filters.search}
            onChange={handleChange("search")}
            placeholder={m.search_placeholder()}
            className="h-8 w-full px-2"
          />
        </div>

        {/* Receipt filter */}
        <div>
          <Label
            htmlFor="filter-receipt"
            className="block text-xs text-muted-foreground mb-0.5"
          >
            Receipt
          </Label>
          <Select
            id="filter-receipt"
            value={filters.hasReceipt === true ? "yes" : filters.hasReceipt === false ? "no" : ""}
            onChange={(e) => {
              const val = e.target.value;
              onFilterChange({
                ...filters,
                hasReceipt: val === "yes" ? true : val === "no" ? false : null,
              });
            }}
            className="h-8 w-28 px-2"
          >
            <SelectItem value="">All</SelectItem>
            <SelectItem value="yes">Has receipt</SelectItem>
            <SelectItem value="no">No receipt</SelectItem>
          </Select>
        </div>

        {/* Reset */}
        <div>
          <Button variant="outline" size="sm" className="text-muted-foreground"
            onClick={onReset}
          >
            {m.reset()}
          </Button>
        </div>
      </div>

      {/* Sort indicators */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <button
          onClick={() => handleSort("date")}
          className={`hover:text-foreground transition-colors ${
            sort.field === "date" ? "text-foreground font-medium" : ""
          }`}
        >
          {m.sort_date()}{<SortIcon field="date" />}
        </button>
        <button
          onClick={() => handleSort("amount")}
          className={`hover:text-foreground transition-colors ${
            sort.field === "amount" ? "text-foreground font-medium" : ""
          }`}
        >
          {m.sort_amount()}{<SortIcon field="amount" />}
        </button>
        <button
          onClick={() => handleSort("category")}
          className={`hover:text-foreground transition-colors ${
            sort.field === "category" ? "text-foreground font-medium" : ""
          }`}
        >
          {m.sort_category()}{<SortIcon field="category" />}
        </button>
      </div>
    </div>
  );
}

// --- Pagination ---

function Pagination({
  page,
  totalPages,
  limit,
  totalCount,
  onPageChange,
  onLimitChange,
}: {
  page: number;
  totalPages: number;
  limit: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
}) {
  const start = page * limit + 1;
  const end = Math.min((page + 1) * limit, totalCount);

  // Build page number buttons (max 5 visible)
  const pageButtons = useMemo(() => {
    const buttons: number[] = [];
    const maxVisible = 5;
    let startPage = Math.max(0, page - Math.floor(maxVisible / 2));
    const endPage = Math.min(totalPages - 1, startPage + maxVisible - 1);

    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(0, endPage - maxVisible + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      buttons.push(i);
    }

    return buttons;
  }, [page, totalPages]);

  if (totalCount === 0) return null;

  return (
    <div className="flex items-center justify-between mt-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{m.showing_range({ start, end, total: totalCount })}</span>
        <Select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="h-8 w-16 px-1"
        >
          <SelectItem value={10}>10</SelectItem>
          <SelectItem value={20}>20</SelectItem>
          <SelectItem value={50}>50</SelectItem>
          <SelectItem value={100}>100</SelectItem>
        </Select>
        <span>{m.per_page()}</span>
      </div>

      <div className="flex items-center gap-1" hidden={totalPages <= 1}>
        <button
          onClick={() => onPageChange(0)}
          disabled={page === 0}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={m.first_page()}
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
            />
          </svg>
        </button>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={m.previous_page()}
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        {pageButtons.map((p) => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`h-8 w-8 flex items-center justify-center rounded-md text-sm transition-colors ${
              p === page
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            {p + 1}
          </button>
        ))}

        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages - 1}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={m.next_page()}
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
        <button
          onClick={() => onPageChange(totalPages - 1)}
          disabled={page >= totalPages - 1}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={m.last_page()}
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 5l7 7-7 7M5 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// --- Transaction Form Modal ---

interface TransactionFormData {
  date: string;
  description: string;
  /** Integer minor units (grosze/cents), always positive; sign from isIncome. */
  amountMinor: number;
  isIncome: boolean;
  accountId: string;
  categoryId: string | undefined;
}

function todayYmd(): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const hh = String(today.getHours()).padStart(2, "0");
  const mi = String(today.getMinutes()).padStart(2, "0");
  const ss = String(today.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

// Converts a stored date to the datetime-local format required by
// <input type="datetime-local"> (YYYY-MM-DDTHH:mm). The DB stores a
// date-only DATE column, so pad midnight onto bare dates; strip seconds
// from full datetimes.
function toDatetimeLocal(iso: string): string {
  if (!iso) return "";
  if (iso.length === 10) return `${iso}T00:00`;
  if (iso.length >= 16) return iso.slice(0, 16);
  return iso;
}

// Converts a datetime-local value (YYYY-MM-DDTHH:mm) to the stored
// ISO format (YYYY-MM-DDTHH:mm:ss) by appending ":00".
// If already in ISO format, returns as-is.
function toIsoDatetime(dtLocal: string): string {
  if (!dtLocal) return "";
  if (dtLocal.length === 16) return `${dtLocal}:00`;
  if (dtLocal.length >= 19) return dtLocal.slice(0, 19);
  return dtLocal;
}

// Formats an ISO datetime for display in the transaction list.
// Shows "May 8, 2026 14:30" if time is non-midnight, or "May 8, 2026" if midnight.
//
// Transaction dates are calendar dates (wall-clock, no timezone). They are
// parsed as UTC and formatted in UTC so the viewer's offset never shifts
// them — formatting in local time showed every date one day early for users
// west of UTC.
function formatTxDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? `${iso}Z` : `${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  const hasTime = iso.includes("T") && iso.slice(11) !== "00:00:00";
  const datePart = d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (!hasTime) return datePart;
  const timePart = d.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${datePart} ${timePart}`;
}

function TransactionForm({
  editingTransaction,
  accounts,
  categories,
  onClose,
  onSubmit,
  error,
}: {
  editingTransaction: TransactionRow | null;
  accounts: { id: string; name: string; currency: string | null }[];
  categories: { id: string; name: string; parent_id: string | null }[];
  onClose: () => void;
  onSubmit: (data: TransactionFormData) => void;
  error: string | null;
}) {
  type CategoryTreeNode = {
    id: string;
    name: string;
    parent_id: string | null;
    children: CategoryTreeNode[];
  };
  const [date, setDate] = useState(() =>
    editingTransaction ? editingTransaction.date : todayYmd(),
  );
  const [description, setDescription] = useState(
    () => editingTransaction?.description ?? "",
  );
  const [amount, setAmount] = useState(() =>
    editingTransaction
      ? formatMinor(Math.abs(editingTransaction.amount_minor))
      : "",
  );
  const [isIncome, setIsIncome] = useState(
    () => (editingTransaction?.amount_minor ?? 0) > 0,
  );
  const [accountId, setAccountId] = useState(
    () => editingTransaction?.account_id ?? "",
  );
  const [categoryId, setCategoryId] = useState<string | undefined>(
    () => editingTransaction?.category_id ?? undefined,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Build category tree for indentation
  const categoryTree = useMemo(() => {
    const map = new Map<string, CategoryTreeNode>();
    for (const cat of categories) {
      map.set(cat.id, { ...cat, children: [] });
    }
    const roots: CategoryTreeNode[] = [];
    for (const cat of categories) {
      const node = map.get(cat.id)!;
      if (cat.parent_id) {
        const parent = map.get(cat.parent_id);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }
    return roots;
  }, [categories]);

  function renderCategoryOptions(
    cats: CategoryTreeNode[],
    depth: number,
  ): React.ReactNode[] {
    return cats.flatMap((cat) => [
      <SelectItem key={cat.id} value={cat.id}>
        {"—".repeat(depth)} {cat.name}
      </SelectItem>,
      ...renderCategoryOptions(cat.children, depth + 1),
    ]);
  }


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) {
      setValidationError(m.account_required());
      return;
    }
    const parsedAmountMinor = parseAmountToMinor(amount);
    if (parsedAmountMinor === null || parsedAmountMinor === 0) {
      setValidationError(m.amount_must_be_nonzero());
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    onSubmit({
      date,
      description: description.trim(),
      amountMinor: parsedAmountMinor,
      isIncome,
      accountId,
      categoryId: categoryId || undefined,
    });
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingTransaction ? "Edit Transaction" : "New Transaction"}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Date */}
          <div>
            <Label htmlFor="tx-date" className="mb-1">
              {m.date_label()}
            </Label>
            <Input
              id="tx-date"
              type="datetime-local"
              value={toDatetimeLocal(date)}
              onChange={(e) => setDate(toIsoDatetime(e.target.value))}
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="tx-desc" className="mb-1">
              {m.description_label()}
            </Label>
            <Input
              id="tx-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              placeholder={m.example_grocery()}
            />
          </div>

          {/* Amount + Income/Expense toggle */}
          <div className="flex gap-3 items-start">
            <div className="flex-1">
              <Label htmlFor="tx-amount" className="mb-1">
                {m.amount_label()}
              </Label>
              <Input
                id="tx-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={m.zero_amount()}
              />
            </div>
            <div className="pt-6">
              <Label className="cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isIncome}
                  onChange={(e) => setIsIncome(e.target.checked)}
                  className="size-4 rounded border-input bg-transparent"
                />
                <span className="text-muted-foreground">{m.income_label()}</span>
              </Label>
            </div>
          </div>

          {/* Account */}
          <div>
            <Label htmlFor="tx-account" className="mb-1">
              {m.account_filter()}
            </Label>
            <Select
              id="tx-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <SelectItem value="">Select account...</SelectItem>
              {accounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name} ({acc.currency})
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Category */}
          <div>
            <Label htmlFor="tx-category" className="mb-1">
              {m.category_filter()}
            </Label>
            <Select
              id="tx-category"
              value={categoryId || ""}
              onChange={(e) => setCategoryId(e.target.value || undefined)}
            >
              <SelectItem value="">None</SelectItem>
              {renderCategoryOptions(categoryTree, 0)}
            </Select>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm" role="alert">
              {error}
            </div>
          )}
          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          {/* Actions */}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingTransaction
                  ? m.saving()
                  : m.creating()
                : editingTransaction
                  ? m.save_changes()
                  : m.create_transaction_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete Confirmation ---

function DeleteConfirm({
  isOpen,
  transaction,
  error,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  transaction: TransactionRow | null;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!transaction) return null;

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Transaction</AlertDialogTitle>
          <AlertDialogDescription>
            {m.delete_transaction_confirm()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm font-medium">
          {transaction.description || m.no_description()}
        </p>
        <p className="text-sm font-mono">
          {transaction.amount_minor < 0 ? "−" : "+"}{" "}
          {formatMinor(Math.abs(transaction.amount_minor))}
        </p>
        <p className="text-xs text-muted-foreground">
          {m.delete_account_unsaved()}
        </p>
        {error && (
          <div
            className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
            role="alert"
          >
            {error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{m.cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {m.delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- Main Page ---

export const Route = createFileRoute("/_authed/transactions")({
  component: TransactionsPage,
});

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

function TransactionsPage() {
  const isDesktop = useIsDesktop();
  const queryClient = useQueryClient();
  const getTransactionsFn = useServerFn(getTransactions);
  const createTransactionFn = useServerFn(createTransaction);
  const updateTransactionFn = useServerFn(updateTransaction);
  const deleteTransactionFn = useServerFn(deleteTransaction);
  const getTransactionByIdFn = useServerFn(getTransactionById);
  const getAccountsFn = useServerFn(getAccounts);
  const getCategoriesFn = useServerFn(getCategories);

  // Transaction list query
  const [filters, setFilters] = useState<TransactionFilters>(defaultFilters);
  const [sort, setSort] = useState<TransactionSort>(defaultSort);
  const [pagination, setPagination] = useState({ page: 0, limit: 20 });

  const { data: txData, isLoading } = useQuery({
    queryKey: [...TRANSACTIONS_QUERY_KEY, filters, sort, pagination],
    queryFn: async () => {
      const filterParams: Record<string, unknown> = {};
      if (filters.dateFrom) filterParams.dateFrom = filters.dateFrom;
      if (filters.dateTo) filterParams.dateTo = filters.dateTo;
      if (filters.accountId) filterParams.accountId = filters.accountId;
      if (filters.categoryId) filterParams.categoryId = filters.categoryId;
      const amountMinMinor = parseAmountToMinor(filters.amountMin);
      if (amountMinMinor !== null) filterParams.amountMinMinor = amountMinMinor;
      const amountMaxMinor = parseAmountToMinor(filters.amountMax);
      if (amountMaxMinor !== null) filterParams.amountMaxMinor = amountMaxMinor;
      if (filters.search) filterParams.search = filters.search;
      if (filters.hasReceipt !== null)
        filterParams.hasReceipt = filters.hasReceipt;

      return getTransactionsFn({
        data: {
          filter: Object.keys(filterParams).length > 0 ? filterParams : undefined,
          sort: sort,
          pagination: pagination,
        },
      });
    },
  });

  const transactions = txData?.transactions ?? [];
  const totalCount = txData?.totalCount ?? 0;
  const totalPages = txData?.totalPages ?? 0;

  // Accounts & categories for forms and filters
  const { data: accounts = [] } = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => getAccountsFn(),
  });

  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: TransactionFormData) =>
      createTransactionFn({
        data: {
          date: data.date,
          description: data.description || undefined,
          amountMinor: data.isIncome ? data.amountMinor : -data.amountMinor,
          accountId: data.accountId,
          categoryId: data.categoryId || null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRANSACTIONS_QUERY_KEY });
      queryClient.refetchQueries({ queryKey: CATEGORIES_QUERY_KEY });
      setIsFormOpen(false);
      setEditingTransaction(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: {
      id: string;
      formData: TransactionFormData;
    }) =>
      updateTransactionFn({
        data: {
          id: data.id,
          date: data.formData.date,
          description: data.formData.description || undefined,
          amountMinor: data.formData.isIncome
            ? data.formData.amountMinor
            : -data.formData.amountMinor,
          accountId: data.formData.accountId,
          categoryId: data.formData.categoryId || null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRANSACTIONS_QUERY_KEY });
      queryClient.refetchQueries({ queryKey: CATEGORIES_QUERY_KEY });
      setIsFormOpen(false);
      setEditingTransaction(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteTransactionFn({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRANSACTIONS_QUERY_KEY });
      queryClient.refetchQueries({ queryKey: CATEGORIES_QUERY_KEY });
      setDeleteConfirmId(null);
    },
  });

  // Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] =
    useState<TransactionRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Handle add
  const handleAdd = () => {
    setEditingTransaction(null);
    setIsFormOpen(true);
    setFormError(null);
  };

  // Handle edit
  const handleEdit = useCallback(async (tx: TransactionRow) => {
    // Fetch full details for editing (includes all fields)
    const result = await getTransactionByIdFn({ data: { id: tx.id } });
    if (result && "error" in result) {
      setFormError(result.error ?? null);
      return;
    }
    setEditingTransaction(result);
    setIsFormOpen(true);
    setFormError(null);
  }, []);

  // Handle form submit (create or update)
  const handleFormSubmit = async (data: TransactionFormData) => {
    setFormError(null);
    if (editingTransaction) {
      // Update
      const result = await updateMutation.mutateAsync({
        id: editingTransaction.id,
        formData: data,
      });
      if (result && "error" in result) {
        setFormError(result.error ?? null);
        return;
      }
    } else {
      // Create
      const result = await createMutation.mutateAsync(data);
      if (result && "error" in result) {
        setFormError(result.error ?? null);
        return;
      }
    }
  };

  // Handle delete confirm
  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId) return;
    setDeleteError(null);

    const result = await deleteMutation.mutateAsync({ id: deleteConfirmId });
    if (result && "error" in result) {
      setDeleteError(result.error ?? null);
      return;
    }
  };

  // Handle delete click
  const handleDeleteClick = (id: string) => {
    setDeleteConfirmId(id);
    setDeleteError(null);
  };

  // Get the transaction being deleted
  const deletingTransaction = transactions.find(
    (t) => t.id === deleteConfirmId,
  );

  // Reset filters
  const handleReset = () => {
    setFilters(defaultFilters);
    setSort(defaultSort);
    setPagination({ page: 0, limit: 20 });
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold display-title">Transactions</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Track and manage your financial transactions.
            </p>
          </div>
          <Button
            onClick={handleAdd}
          >
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.add_transaction()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8">
        {formError && (
          <div
            className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
            role="alert"
          >
            {formError}
          </div>
        )}

        {/* Filter bar — always visible */}
        <FilterBar
          filters={filters}
          sort={sort}
          accounts={accounts}
          categories={categories}
          onFilterChange={setFilters}
          onSortChange={setSort}
          onReset={handleReset}
        />

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              className="size-12 text-muted-foreground/40 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"
              />
            </svg>
            <h3 className="text-base font-medium mb-1">{m.no_transactions_yet()}</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              {m.add_first_transaction()}
            </p>
            <Button
              onClick={handleAdd}
            >
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {m.add_transaction()}
            </Button>
          </div>
        ) : (
          <>
            {isDesktop ? (
              /* Desktop Table */
              <div role="table" className="island-shell rounded-xl overflow-hidden">
                {/* Table header */}
                <div role="row" className="flex items-center gap-3 px-3 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <span role="columnheader" className="w-24">{m.date_column()}</span>
                  <span role="columnheader" className="flex-1">{m.description_column()}</span>
                  <span role="columnheader" className="w-28 text-right">{m.amount_column()}</span>
                  <span role="columnheader" className="w-32">{m.category_column()}</span>
                  <span role="columnheader" className="w-32">{m.account_column_txns()}</span>
                  <span role="columnheader" className="w-20 text-right">Actions</span>
                </div>

                {/* Rows */}
                <div className="divide-y divide-line/30">
                  {transactions.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      transaction={tx}
                      onEdit={handleEdit}
                      onDelete={handleDeleteClick}
                    />
                  ))}
                </div>
              </div>
            ) : (
              /* Mobile Cards */
              <div className="island-shell rounded-xl overflow-hidden">
                {transactions.map((tx) => (
                  <TransactionCard
                    key={tx.id}
                    transaction={tx}
                    onEdit={handleEdit}
                    onDelete={handleDeleteClick}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            <Pagination
              page={pagination.page}
              totalPages={totalPages}
              limit={pagination.limit}
              totalCount={totalCount}
              onPageChange={(page) => setPagination((p) => ({ ...p, page }))}
              onLimitChange={(limit) =>
                setPagination((p) => ({ ...p, page: 0, limit }))
              }
            />
          </>
        )}
      </main>

      {/* Add/Edit Form */}
      {isFormOpen && (
        <TransactionForm
          key={editingTransaction?.id ?? "new"}
          editingTransaction={editingTransaction}
          accounts={accounts}
          categories={categories}
          onClose={() => {
            setIsFormOpen(false);
            setEditingTransaction(null);
            setFormError(null);
          }}
          onSubmit={handleFormSubmit}
          error={formError}
        />
      )}

      {/* Delete Confirmation */}
      <DeleteConfirm
        isOpen={!!deleteConfirmId}
        transaction={deletingTransaction ?? null}
        error={deleteError}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setDeleteConfirmId(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
