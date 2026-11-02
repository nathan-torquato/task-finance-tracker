import { test, expect, type Page } from "./fixtures";

//
// Monthly category budgets. Fixture users are seeded with default categories
// (e.g. Groceries > Vegetables) and a "Main" account. Transactions are dated
// today in the browser's local timezone, so they always fall in the month the
// budgets page shows.

function todayLocal(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T12:00`;
}

async function addTransaction(
  page: Page,
  opts: { description: string; amount: string; category: string; isIncome?: boolean },
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(todayLocal());
  await modal.getByLabel("Description").fill(opts.description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption({ label: opts.category });
  if (opts.isIncome) await modal.getByLabel("Income").check();
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "New Budget" });
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel(/Monthly limit/).fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
}

const budgetRow = (page: Page, category: string) =>
  page.getByTestId("budget-row").filter({ hasText: category });

test.describe("Budgets", () => {
  test("is in the main navigation and starts empty", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/dashboard");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Budgets" })
      .click();

    await expect(page).toHaveURL("/budgets");
    await expect(page.getByRole("heading", { name: "Budgets", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No budgets yet" })).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText("0 of 3 budgets used");
  });

  test("adds, edits and removes a budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "500");

    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toHaveText("0.00 of 500.00 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("500.00 PLN left");
    await expect(row.getByText("Includes subcategories")).toBeVisible();

    // A category with a budget is no longer offered.
    await page.getByRole("button", { name: "Add Budget" }).click();
    const newDialog = page.getByRole("dialog", { name: "New Budget" });
    await expect(
      newDialog.getByLabel("Category").locator("option", { hasText: /^Groceries$/ }),
    ).toHaveCount(0);
    await newDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(newDialog).toBeHidden();

    // Change the limit.
    await row.getByTestId("edit-budget").click();
    const editDialog = page.getByRole("dialog", { name: "Edit Budget" });
    await expect(editDialog.getByLabel(/Monthly limit/)).toHaveValue("500");
    await editDialog.getByLabel(/Monthly limit/).fill("750.50");
    await editDialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(editDialog).toBeHidden();
    await expect(row.getByTestId("budget-spent")).toHaveText("0.00 of 750.50 PLN");

    // Remove it.
    await row.getByTestId("delete-budget").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("budget-row")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No budgets yet" })).toBeVisible();
  });

  test("validates the category and the monthly limit", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "New Budget" });

    await dialog.getByLabel(/Monthly limit/).fill("100");
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose a category.");

    await dialog.getByLabel("Category").selectOption({ label: "Housing" });
    await dialog.getByLabel(/Monthly limit/).fill("0");
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a monthly limit greater than 0.",
    );
    await expect(dialog).toBeVisible();
  });

  test("a parent budget counts subcategory spending only, flags overspending and emails once", async ({
    page,
    signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "100");

    await addTransaction(page, { description: "Veg market", amount: "60", category: "— Vegetables" });
    // A refund (money in) must not reduce the spent amount.
    await addTransaction(page, {
      description: "Veg refund",
      amount: "30",
      category: "— Vegetables",
      isIncome: true,
    });
    await addTransaction(page, { description: "Big shop", amount: "50", category: "Groceries" });

    await page.goto("/budgets");
    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toHaveText("110.00 of 100.00 PLN");
    await expect(row.getByTestId("budget-remaining")).toHaveText("Over by 10.00 PLN");
    await expect(row.getByText("Over budget")).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "over");

    // Exactly one over-budget email (sent asynchronously after the write).
    const email = `${signedInUser.username}@example.com`;
    await expect
      .poll(async () => {
        const res = await page.request.get(`/test-emails?to=${encodeURIComponent(email)}`);
        const { emails } = (await res.json()) as { emails: { subject: string; text: string }[] };
        return emails.filter((e) => e.subject.includes("Groceries budget"));
      })
      .toHaveLength(1);
  });

  test("free plan allows 3 budgets; pro is unlimited", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "100");
    await addBudget(page, "Housing", "100");
    await addBudget(page, "Transport", "100");

    await expect(page.getByTestId("budgets-usage")).toHaveText("3 of 3 budgets used");
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
    const notice = page.getByTestId("budget-limit-notice");
    await expect(notice).toContainText("The free plan is limited to 3 budgets");
    await expect(notice.getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute(
      "href",
      "/billing",
    );

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText("3 of 3 budgets");

    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);

    await page.goto("/budgets");
    await expect(page.getByTestId("budget-row")).toHaveCount(3);
    await expect(page.getByTestId("budget-limit-notice")).toBeHidden();
    await expect(page.getByTestId("budgets-usage")).toBeHidden();
    await addBudget(page, "Health", "100");
    await expect(page.getByTestId("budget-row")).toHaveCount(4);

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText(
      "4 budgets (unlimited)",
    );
  });
});
