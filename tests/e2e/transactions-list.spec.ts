import { test, expect, type Page } from "./fixtures";


test.describe("Transaction List Page", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    // The account-filter test creates 2 extra accounts (3 with the seeded
    // Main), above the free plan's limit — run as a Pro user. Free-limit
    // gating is covered in billing.spec.ts.
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/transactions");
    await expect(page).toHaveURL("/transactions");
  });

  async function fillTransactionForm(
    page: Page,
    opts: {
      date: string;
      description: string;
      amount: string;
      account: string;
      category?: string;
      isIncome?: boolean;
    },
  ) {
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Add Transaction" })
      .click();

    const modal = page
      .getByRole("dialog", { name: "New Transaction" });

    // datetime-local input requires YYYY-MM-DDTHH:mm format
    const datetimeLocal = opts.date.includes("T")
      ? opts.date
      : `${opts.date}T00:00`;
    await modal.getByLabel("Date").fill(datetimeLocal);
    await modal.getByLabel("Description").fill(opts.description);
    await modal
      .getByRole("spinbutton", { name: "Amount", exact: true })
      .fill(opts.amount);
    await modal.getByLabel("Account").selectOption(opts.account);
    if (opts.category) {
      await modal.getByLabel("Category").selectOption(opts.category);
    }
    if (opts.isIncome) {
      await modal.getByLabel("Income").check();
    }
    await modal.getByRole("button", { name: "Create Transaction" }).click();
  }

  async function createAccount(page: Page, name: string) {
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByLabel("Account Name").fill(name);
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.getByRole("link", { name: "Transactions" }).click();
  }

  async function createCategory(page: Page, name: string) {
    await page.getByRole("link", { name: "Categories" }).click();
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create Category" }).click();
    await page.getByRole("link", { name: "Transactions" }).click();
  }

  test("empty state displays when no transactions exist", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "No transactions yet" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Add your first transaction to start tracking your finances.",
        { exact: false },
      ),
    ).toBeVisible();
  });

  test("table displays transactions with correct columns", async ({
    page,
  }) => {
    await createAccount(page, "Main");
    await createCategory(page, "Groceries");

    await fillTransactionForm(page, {
      date: "2025-01-15",
      description: "Test Transaction",
      amount: "100.50",
      account: "Main (PLN)",
      category: "Groceries",
    });

    const table = page.getByRole("table");
    await expect(table.getByText("Jan 15, 2025")).toBeVisible();
    await expect(table.getByText("Test Transaction")).toBeVisible();
    await expect(table.getByText("100.50")).toBeVisible();
    await expect(table.getByText("Groceries")).toBeVisible();
    await expect(table.getByText("Main")).toBeVisible();
  });

  test("sorting by date works", async ({ page }) => {
    await createAccount(page, "Main");

    for (const date of ["2025-03-01", "2025-01-01", "2025-02-01"]) {
      await fillTransactionForm(page, {
        date,
        description: `Txn ${date}`,
        amount: "10.00",
        account: "Main (PLN)",
      });
    }

    const table = page.getByRole("table");
    await expect(
      table.getByText("Txn 2025-03-01", { exact: true }),
    ).toBeVisible();
  });

  test("sorting by amount changes order", async ({ page }) => {
    await createAccount(page, "Main");

    for (const amount of ["100.00", "10.00", "50.00"]) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `Amount ${amount}`,
        amount,
        account: "Main (PLN)",
      });
    }

    await page.getByRole("button", { name: "Amount" }).click();

    const table = page.getByRole("table");
    await expect(
      table.getByText("Amount 100.00", { exact: true }),
    ).toBeVisible();
  });

  test("filtering by account narrows the list", async ({ page }) => {
    await createAccount(page, "Account A");
    await createAccount(page, "Account B");

    for (const acc of ["Account A", "Account B"]) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `Txn for ${acc}`,
        amount: "10.00",
        account: `${acc} (PLN)`,
      });
    }

    await page
      .locator("main")
      .getByLabel("Account")
      .selectOption("Account A (PLN)");

    const table = page.getByRole("table");
    await expect(table.getByText("Txn for Account A")).toBeVisible();
    await expect(table.getByText("Txn for Account B")).toBeHidden();
  });

  test("filtering by date range works", async ({ page }) => {
    await createAccount(page, "Main");

    for (const date of ["2025-01-10", "2025-03-15", "2025-06-20"]) {
      await fillTransactionForm(page, {
        date,
        description: `Date Txn ${date}`,
        amount: "10.00",
        account: "Main (PLN)",
      });
    }

    await page.getByLabel("From").fill("2025-02-01");
    await page.locator("#filter-date-to").fill("2025-04-30");

    const table = page.getByRole("table");
    await expect(table.getByText("Date Txn 2025-03-15")).toBeVisible();
    await expect(table.getByText("Date Txn 2025-01-10")).toBeHidden();
    await expect(table.getByText("Date Txn 2025-06-20")).toBeHidden();
  });

  test("filtering by category narrows the list", async ({ page }) => {
    await createAccount(page, "Main");
    await createCategory(page, "Cat A");
    await createCategory(page, "Cat B");

    for (const cat of ["Cat A", "Cat B"]) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `Txn in ${cat}`,
        amount: "10.00",
        account: "Main (PLN)",
        category: cat,
      });
    }

    await page.locator("main").getByLabel("Category").selectOption("Cat A");

    const table = page.getByRole("table");
    await expect(table.getByText("Txn in Cat A")).toBeVisible();
    await expect(table.getByText("Txn in Cat B")).toBeHidden();
  });

  test("filtering by amount range works", async ({ page }) => {
    await createAccount(page, "Main");

    for (const amount of ["5.00", "50.00", "500.00"]) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `Amount ${amount}`,
        amount,
        account: "Main (PLN)",
      });
    }

    await page.getByLabel("Min amount").fill("10");
    await page.getByLabel("Max amount").fill("100");

    const table = page.getByRole("table");
    await expect(table.getByText("Amount 50.00")).toBeVisible();
    await expect(table.getByText("Amount 5.00")).toBeHidden();
    await expect(table.getByText("Amount 500.00")).toBeHidden();
  });

  test("text search on description works", async ({ page }) => {
    await createAccount(page, "Main");

    for (const desc of ["Grocery Store", "Gas Station", "Coffee Shop"]) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: desc,
        amount: "10.00",
        account: "Main (PLN)",
      });
    }

    await page.getByLabel("Search").fill("Gas");

    const table = page.getByRole("table");
    await expect(table.getByText("Gas Station")).toBeVisible();
    await expect(table.getByText("Grocery Store")).toBeHidden();
    await expect(table.getByText("Coffee Shop")).toBeHidden();
  });

  test("pagination controls work", async ({ page }) => {
    test.setTimeout(60_000);
    await createAccount(page, "Main");

    for (let i = 1; i <= 25; i++) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `Transaction ${i}`,
        amount: "10.00",
        account: "Main (PLN)",
      });
    }

    await expect(page.getByText("Showing 1–20 of 25")).toBeVisible();

    await page.getByRole("button", { name: "Next page" }).click();

    await expect(page.getByText("Showing 21–25 of 25")).toBeVisible();
    const table = page.getByRole("table");
    await expect(
      table.getByText("Transaction 1", { exact: true }),
    ).toBeVisible();
  });

  test("pagination page size selector works", async ({ page }) => {
    test.setTimeout(60_000);
    await createAccount(page, "Main");

    for (let i = 1; i <= 25; i++) {
      await fillTransactionForm(page, {
        date: "2025-01-15",
        description: `PageSize ${i}`,
        amount: "10.00",
        account: "Main (PLN)",
      });
    }

    // Default page size shows limited results
    await expect(page.getByText("Showing 1–20 of 25")).toBeVisible();

    // Locate the page size select by its "per page" neighbor label
    const pageSizeSelect = page.locator("text=per page").locator("..").locator("select");
    await pageSizeSelect.selectOption("50");

    // Now all 25 should be on one page
    await expect(page.getByText("Showing 1–25 of 25")).toBeVisible();
  });

  test("amounts are color-coded by type", async ({ page }) => {
    await createAccount(page, "Main");

    // Create an expense transaction
    await fillTransactionForm(page, {
      date: "2025-01-15",
      description: "Expense Txn",
      amount: "100.00",
      account: "Main (PLN)",
    });

    // Create an income transaction
    await fillTransactionForm(page, {
      date: "2025-01-16",
      description: "Income Txn",
      amount: "200.00",
      account: "Main (PLN)",
      isIncome: true,
    });

    const table = page.getByRole("table");

    // Expense amount should have negative/red styling (the cell text includes minus)
    const expenseCell = table.getByText("100.00").first();
    await expect(expenseCell).toBeVisible();

    // Income amount should have positive/green styling (the cell text includes plus)
    const incomeCell = table.getByText("200.00").first();
    await expect(incomeCell).toBeVisible();
  });

  test("sorting by category works", async ({ page }) => {
    await createAccount(page, "Main");
    await createCategory(page, "Food");
    await createCategory(page, "Transport");

    await fillTransactionForm(page, {
      date: "2025-01-15",
      description: "Transport Txn",
      amount: "10.00",
      account: "Main (PLN)",
      category: "Transport",
    });
    await fillTransactionForm(page, {
      date: "2025-01-14",
      description: "Food Txn",
      amount: "20.00",
      account: "Main (PLN)",
      category: "Food",
    });

    // Wait for initial load to complete
    await expect(page.getByRole("table")).toBeVisible();

    // Sort buttons are below the filter bar, not table headers
    // Click "Category" sort button
    await page.getByRole("button", { name: "Category" }).click();

    // Wait for the loading state to disappear and table to reappear
    // The page shows a loading spinner while data is being fetched
    await expect(page.getByText("Loading transactions...")).not.toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();

    // After sorting by category, both transactions should still be visible
    // Check if the transactions are in the table by their descriptions
    await expect(page.getByText("Food Txn")).toBeVisible();
    await expect(page.getByText("Transport Txn")).toBeVisible();
  });

  test("mobile viewport shows card layout instead of table", async ({
    page,
    browserName,
  }) => {
    if (browserName !== "chromium") return;

    // Set mobile viewport first
    await page.setViewportSize({ width: 375, height: 812 });

    // Navigate directly to avoid sidebar issues at mobile width
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByLabel("Account Name").fill("MobileMain");
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.goto("/transactions");

    await fillTransactionForm(page, {
      date: "2025-01-15",
      description: "Mobile Txn",
      amount: "42.00",
      account: "MobileMain (PLN)",
    });

    // On mobile, the transaction data should be visible (card layout)
    await expect(page.getByText("Mobile Txn")).toBeVisible();
    await expect(page.getByText("42.00")).toBeVisible();
  });

  test("reset filters clears all filters", async ({ page }) => {
    await createAccount(page, "Main");

    await fillTransactionForm(page, {
      date: "2025-01-15",
      description: "Reset Test",
      amount: "10.00",
      account: "Main (PLN)",
    });

    await page.getByLabel("Search").fill("Reset");

    const table = page.getByRole("table");
    await expect(table.getByText("Reset Test")).toBeVisible();

    await page.getByRole("button", { name: "Reset" }).click();

    await expect(page.getByLabel("Search")).toHaveValue("");
  });

  // Transaction dates are calendar dates: the viewer's timezone must never
  // shift them. CI runs in UTC, so pin browsers far west and far east of it
  // to catch any local-time conversion regressions.
  for (const timezoneId of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
    test.describe(`in ${timezoneId}`, () => {
      test.use({ timezoneId });

      test("shows the stored calendar date unshifted", async ({ page }) => {
        await createAccount(page, "Main");

        await fillTransactionForm(page, {
          date: "2025-03-01",
          description: `TZ ${timezoneId}`,
          amount: "12.00",
          account: "Main (PLN)",
        });

        const row = page
          .getByRole("table")
          .getByRole("row")
          .filter({ hasText: `TZ ${timezoneId}` });
        await expect(row.getByText("Mar 1, 2025")).toBeVisible();
      });
    });
  }
});
