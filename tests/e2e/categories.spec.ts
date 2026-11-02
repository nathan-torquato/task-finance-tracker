import { test, expect } from "./fixtures";


test.describe("Categories CRUD", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/categories");
    await expect(page).toHaveURL("/categories");
  });

  test("creates a new top-level category", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Category" }),
    ).toBeVisible();

    await page.getByLabel("Name").fill("Test Category");
    await page.getByLabel("Color").fill("#ff5733");
    await page.getByRole("button", { name: "Create Category" }).click();

    await expect(
      page.getByRole("heading", { name: "Create Category" }),
    ).toBeHidden();
    await expect(page.getByText("Test Category")).toBeVisible();
  });

  test("creates a sub-category under an existing parent", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Parent Category");
    await page.getByLabel("Color").fill("#3f51b5");
    await page.getByRole("button", { name: "Create Category" }).click();
    await expect(page.getByText("Parent Category")).toBeVisible();

    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Test Sub-Category");
    await page.getByLabel("Parent Category").selectOption("Parent Category");
    await page.getByRole("button", { name: "Create Category" }).click();

    await expect(
      page.getByRole("heading", { name: "Create Category" }),
    ).toBeHidden();
    await expect(page.getByText("Test Sub-Category")).toBeVisible();
  });

  test("shows validation error when name is empty", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Category" }),
    ).toBeVisible();

    await page.locator("form").press("Enter");

    await expect(page.getByText("Name is required")).toBeVisible();
  });

  test("edits an existing category", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Edit Me");
    await page.getByRole("button", { name: "Create Category" }).click();
    await expect(page.getByText("Edit Me")).toBeVisible();

    const row = page.getByTestId("category-row").filter({ hasText: "Edit Me" });
    await row.getByTestId("edit-category").click();

    await expect(page.getByRole("heading", { name: "Edit" })).toBeVisible();

    await page.getByLabel("Name").fill("Edit Me Updated");
    await page.getByRole("button", { name: "Save Changes" }).click();

    // Wait for the dialog itself: its title flips from "Edit" as soon as the
    // edit state is cleared, while the dialog (whose Parent Category options
    // also list the renamed category) can still be mounted.
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      page.getByTestId("category-row").filter({ hasText: "Edit Me Updated" }),
    ).toBeVisible();
  });

  test("changes a category's parent", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Target Parent");
    await page.getByRole("button", { name: "Create Category" }).click();

    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Move Me");
    await page.getByRole("button", { name: "Create Category" }).click();

    const moveMeRow = page
      .getByTestId("category-row")
      .filter({ hasText: "Move Me" });
    await moveMeRow.getByTestId("edit-category").click();
    await page.getByLabel("Parent Category").selectOption("Target Parent");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(
      page.getByTestId("category-row").filter({ hasText: "Move Me" }),
    ).toBeVisible();
  });

  test("deletes a category with no children", async ({ page }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Delete Me");
    await page.getByRole("button", { name: "Create Category" }).click();

    const deleteMeRow = page.getByRole("row").filter({ hasText: "Delete Me" });
    await deleteMeRow.getByRole("button", { name: "Delete" }).click();

    await expect(
      page.getByRole("heading", { name: "Delete Category" }),
    ).toBeVisible();
    await page
      .getByRole("alertdialog", { name: "Delete Category" })
      .getByRole("button", { name: "Delete" })
      .click();

    await expect(page.locator("main").getByText("Delete Me")).toBeHidden();
  });

  test("reassigns transactions when deleting a category in use", async ({
    page,
  }) => {
    // Create source and target categories
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Old Category");
    await page.getByRole("button", { name: "Create Category" }).click();
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("New Category");
    await page.getByRole("button", { name: "Create Category" }).click();

    // Create an account and a transaction in "Old Category"
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByLabel("Account Name").fill("Wallet");
    await page.getByRole("button", { name: "Create Account" }).click();
    await page.getByRole("link", { name: "Transactions" }).click();
    // Wait for the transactions page to load (either table or empty state)
    await expect(
      page.getByRole("table").or(page.getByText("No transactions yet")),
    ).toBeVisible();
    // Give categories query time to fetch
    await page.waitForTimeout(500);
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Add Transaction" })
      .click();
    const modal = page
      .getByRole("dialog", { name: "New Transaction" });
    await modal.getByLabel("Date").fill("2025-01-15T00:00");
    await modal.getByLabel("Description").fill("Old txn");
    await modal
      .getByRole("spinbutton", { name: "Amount", exact: true })
      .fill("50");
    await modal.getByLabel("Account").selectOption("Wallet (PLN)");
    await modal.getByLabel("Category").selectOption("Old Category");
    // Verify the correct category was selected by checking the selected option text
    await expect(modal.getByLabel("Category")).toHaveValue(/^[0-9a-f-]+$/); // UUID format
    await modal.getByRole("button", { name: "Create Transaction" }).click();

    // Wait for the modal to close and transaction to appear in the table
    await expect(modal).toBeHidden();
    await expect(page.getByText("Old txn")).toBeVisible();
    // Verify the transaction has the correct category
    const transactionRow = page.getByRole("row").filter({ hasText: "Old txn" });
    await expect(transactionRow.getByText("Old Category")).toBeVisible();

    // Go back to Categories — confirm count shows 1
    await page.getByRole("link", { name: "Categories" }).click();
    // Wait for navigation to complete
    await expect(page).toHaveURL("/categories");
    // Wait for the categories to refetch (with staleTime: 0, this should trigger a refetch)
    await expect(
      page.getByRole("button", { name: "Add Category" }),
    ).toBeVisible();
    // Wait for the transaction count to update
    await page.waitForSelector("text=1 transaction(s)", { timeout: 5000 });
    // The transaction count should update automatically via the query
    // Wait for the "1 transaction(s)" text to appear next to "Old Category"
    const oldRow = page
      .locator("main")
      .getByText("Old Category", { exact: true })
      .locator("..");
    await expect(oldRow.getByText("1 transaction(s)")).toBeVisible();

    // Delete with reassignment
    await oldRow.getByTestId("delete-category").click();
    await expect(
      page.getByRole("heading", { name: "Delete Category" }),
    ).toBeVisible();
    await expect(page.getByText(/1 transaction\(s\)\. Choose/)).toBeVisible();
    await page
      .getByLabel("Reassign transactions to")
      .selectOption("New Category");
    await page
      .getByRole("alertdialog", { name: "Delete Category" })
      .getByRole("button", { name: "Delete" })
      .click();

    // "Old Category" is gone, "New Category" now shows 1 txn
    await expect(page.locator("main").getByText("Old Category")).toBeHidden();
    // Force a full page reload to ensure fresh data after mutation
    await page.reload();
    await expect(page).toHaveURL("/categories");
    const newRow = page
      .locator("main")
      .getByText("New Category", { exact: true })
      .locator("..");
    await expect(newRow.getByText("1 transaction(s)")).toBeVisible();
  });

  test("cascades delete to child categories when deleting parent", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Parent With Child");
    await page.getByRole("button", { name: "Create Category" }).click();

    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Child Category");
    await page.getByLabel("Parent Category").selectOption("Parent With Child");
    await page.getByRole("button", { name: "Create Category" }).click();

    // Verify child appears indented under parent
    await expect(page.getByText("Child Category")).toBeVisible();

    const parentRow = page
      .getByTestId("category-row")
      .filter({ hasText: "Parent With Child" });
    await parentRow.getByTestId("delete-category").click();

    await expect(
      page.getByRole("heading", { name: "Delete Category" }),
    ).toBeVisible();
    // Should show warning about removing children
    await expect(page.getByText(/sub-category/)).toBeVisible();
    await page
      .getByRole("alertdialog", { name: "Delete Category" })
      .getByRole("button", { name: "Delete" })
      .click();

    // Both parent and child should be gone
    await expect(
      page.locator("main").getByText("Parent With Child"),
    ).toBeHidden();
    await expect(page.getByText("Child Category")).toBeHidden();
  });
});
