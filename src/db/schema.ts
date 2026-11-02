import {
  pgTable,
  pgEnum,
  bigint,
  integer,
  text,
  date,
  timestamp,
  doublePrecision,
  serial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const auth_token_type = pgEnum("auth_token_type", [
  "verify_email",
  "password_reset",
]);
export const rule_match_type = pgEnum("rule_match_type", [
  "substring",
  "exact",
]);
export const rule_source = pgEnum("rule_source", ["user", "ai"]);
export const ai_usage_kind = pgEnum("ai_usage_kind", [
  "receipt_scan",
  "categorize",
]);
export const subscription_plan = pgEnum("subscription_plan", ["free", "pro"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  // Nullable for legacy pre-email accounts; always stored lowercased.
  email: text("email").unique(),
  email_verified_at: timestamp("email_verified_at", {
    withTimezone: true,
    mode: "date",
  }),
  password_hash: text("password_hash").notNull(),
  // Bumped to revoke every outstanding session ("log out everywhere",
  // password reset). Session cookies carry the version they were issued
  // with; a mismatch invalidates the session.
  session_version: integer("session_version").notNull().default(0),
  // GDPR account deletion: set when the user requests deletion, cleared on
  // cancel. The compliance sweep hard-deletes the account once the grace
  // period has elapsed.
  deletion_requested_at: timestamp("deletion_requested_at", {
    withTimezone: true,
    mode: "date",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

// Single-use, time-limited tokens for email verification and password reset.
// Only the SHA-256 hash of the token is stored; the raw token exists solely
// in the email link.
export const auth_tokens = pgTable("auth_tokens", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  type: auth_token_type("type").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  expires_at: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  used_at: timestamp("used_at", { withTimezone: true, mode: "date" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  expires_at: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  bank: text("bank"),
  currency: text("currency").default("PLN"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  parent_id: text("parent_id"),
  color: text("color").default("#6b7280"),
  sort_order: integer("sort_order").default(0),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

export const import_batches = pgTable("import_batches", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  account_id: text("account_id")
    .notNull()
    .references(() => accounts.id),
  filename: text("filename").notNull(),
  row_count: integer("row_count").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id),
    // Calendar date (no time component) — legacy SQLite rows that carried a
    // time suffix are truncated by the data migration.
    date: date("date", { mode: "string" }).notNull(),
    // Integer minor units (grosze/cents) — never store money as floats.
    amount_minor: integer("amount_minor").notNull(),
    description: text("description"),
    category_id: text("category_id").references(() => categories.id),
    source: text("source").default("manual"),
    source_ref: text("source_ref"),
    import_batch_id: text("import_batch_id").references(() => import_batches.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow(),
  },
  (t) => [
    // Hot paths: dashboard aggregations and the transactions list filter by
    // user + date; imports look rows up per account.
    index("transactions_user_date_idx").on(t.user_id, t.date),
    index("transactions_account_idx").on(t.account_id),
  ],
);

export const receipts = pgTable("receipts", {
  id: text("id").primaryKey(),
  // Direct ownership — receipts are scoped by user_id, not transitively via
  // the nullable transaction_id.
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  transaction_id: text("transaction_id").references(() => transactions.id),
  // Storage key (e.g. "receipts/{userId}/{uuid}.jpg"), resolved by the
  // storage driver — not a filesystem path.
  image_path: text("image_path"),
  ai_raw_response: text("ai_raw_response"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});

export const receipt_items = pgTable(
  "receipt_items",
  {
    id: text("id").primaryKey(),
    receipt_id: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    name: text("name").notNull(),
    quantity: doublePrecision("quantity"),
    // Integer minor units (grosze/cents) — never store money as floats.
    unit_price_minor: integer("unit_price_minor"),
    total_price_minor: integer("total_price_minor").notNull(),
    category_id: text("category_id").references(() => categories.id),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow(),
  },
  (t) => [index("receipt_items_receipt_idx").on(t.receipt_id)],
);

export const categorization_rules = pgTable(
  "categorization_rules",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    pattern: text("pattern").notNull(),
    match_type: rule_match_type("match_type").notNull().default("substring"),
    category_id: text("category_id")
      .notNull()
      .references(() => categories.id),
    priority: integer("priority").notNull().default(100),
    source: rule_source("source").notNull().default("user"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow(),
  },
  (t) => [
    index("categorization_rules_user_priority_idx").on(t.user_id, t.priority),
  ],
);

// One row per AI call (including fake-mode and failed calls) — the raw input
// for per-user quotas, the "usage this month" display, and the global daily
// spend circuit breaker. Cost is integer micro-USD; the self-hosted and fake
// backends record 0 but still count toward the scan quota.
export const ai_usage = pgTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: ai_usage_kind("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cost_estimate_microusd: bigint("cost_estimate_microusd", {
      mode: "number",
    })
      .notNull()
      .default(0),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Quota checks scan by user + month; the spend cap sums by day globally.
    index("ai_usage_user_created_idx").on(t.user_id, t.created_at),
    index("ai_usage_created_idx").on(t.created_at),
  ],
);

// Local mirror of Stripe subscription state, one row per user (no row =
// free plan). Written exclusively by the verified Stripe webhook handler and
// the TEST_MODE plan-override route — never by user-facing server functions.
export const subscriptions = pgTable("subscriptions", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  stripe_customer_id: text("stripe_customer_id").unique(),
  stripe_subscription_id: text("stripe_subscription_id").unique(),
  plan: subscription_plan("plan").notNull().default("free"),
  // Raw Stripe subscription status (active, trialing, past_due, canceled,
  // unpaid, ...). Entitlement mapping happens in billing.server.ts.
  status: text("status").notNull().default("active"),
  current_period_end: timestamp("current_period_end", {
    withTimezone: true,
    mode: "date",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// Processed Stripe webhook event ids — the idempotency ledger. Inserting the
// event id first (ON CONFLICT DO NOTHING) makes replayed/duplicated webhook
// deliveries no-ops.
export const stripe_events = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// Monthly spending limit per category. Spend is never stored: it is computed
// on read from transactions for the requested calendar month (so budgets
// "reset" every month with no job), rolling a parent's limit up over all of
// its descendant categories. One budget per category.
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    category_id: text("category_id")
      .notNull()
      .references(() => categories.id),
    // Integer minor units (grosze/cents) — never store money as floats.
    limit_minor: integer("limit_minor").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("budgets_user_category_idx").on(t.user_id, t.category_id)],
);

// One row per budget per calendar month ("YYYY-MM") in which the user went
// over budget — the idempotency ledger for the over-budget email. Inserting
// first (ON CONFLICT DO NOTHING) guarantees at most one email per budget per
// month, even under concurrent writes.
export const budget_alerts = pgTable(
  "budget_alerts",
  {
    id: text("id").primaryKey(),
    budget_id: text("budget_id")
      .notNull()
      .references(() => budgets.id),
    month: text("month").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("budget_alerts_budget_month_idx").on(t.budget_id, t.month)],
);

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow(),
});
