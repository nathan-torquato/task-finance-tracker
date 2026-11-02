import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "./fixtures";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  path.join(__dirname, "fixtures", "csv", name);

async function createAccount(page: Page, name: string) {
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Add Account" }).click();
  await page.getByLabel("Account Name").fill(name);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(
    page.getByRole("heading", { name: "New Account" }),
  ).toBeHidden();
}

async function importCsv(
  page: Page,
  fileName: string,
  accountLabel: string,
) {
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await page.getByRole("link", { name: "Import" }).click();

  // Upload step — click the "Choose File" label to open the native file chooser
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("main").getByText("Choose File").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(fixturePath(fileName));

  // Wait for the mapping step to render (previewImport server call completes)
  // The "Map columns" heading appears after the file is processed
  await expect(page.getByRole("heading", { name: "Map columns" })).toBeVisible();

  // Mapping step — click Continue to go to account selection
  await page.getByRole("button", { name: "Continue" }).click();

  // Account step — select account and proceed to preview
  await page
    .getByRole("combobox", { name: "Account" })
    .selectOption({ label: accountLabel });
  await page.getByRole("button", { name: "Continue" }).click();

  // Preview step — confirm the import
  await page.getByRole("button", { name: "Confirm Import" }).click();
  await expect(
    page.getByRole("heading", { name: "Import complete" }),
  ).toBeVisible();
}

test.describe("Import summary details", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/dashboard");
  });

  test("summary lists each duplicate row", async ({ page }) => {
    await createAccount(page, "Main");

    await importCsv(page, "generic-3rows.csv", "Main (PLN)");
    await importCsv(page, "generic-3rows.csv", "Main (PLN)");

    // Second import → all 3 rows are duplicates.
    await expect(page.getByRole("main").getByText(/3 duplicates/)).toBeVisible();

    // Duplicate list section is visible
    await expect(
      page.getByRole("main").getByText(/duplicate\(s\) skipped/),
    ).toBeVisible();

    // Each duplicate row's description appears in the list
    const items = page.getByRole("listitem");
    await expect(items.filter({ hasText: "Coffee shop" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Grocery shopping" })).toHaveCount(1);
    await expect(items.filter({ hasText: "January salary" })).toHaveCount(1);
  });

  test("summary lists each error row with its message", async ({ page }) => {
    await createAccount(page, "Main");
    await importCsv(page, "generic-with-errors.csv", "Main (PLN)");

    // Summary shows 1 imported and 3 errors
    await expect(page.getByRole("main").getByText(/3 errors/)).toBeVisible();

    const errorSection = page
      .getByRole("main")
      .getByText(/row\(s\) could not be imported/);
    await expect(errorSection).toBeVisible();

    // Each error type is present
    await expect(page.getByRole("main").getByText("invalid date")).toBeVisible();
    await expect(
      page.getByRole("main").getByText("invalid amount"),
    ).toBeVisible();
    await expect(
      page.getByRole("main").getByText("amount cannot be zero"),
    ).toBeVisible();

    // Each error item carries the original raw values for context.
    await expect(page.getByRole("main").getByText("not-a-date")).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Bad amount row"),
    ).toBeVisible();
  });

  test("no duplicate or error sections when counts are zero", async ({
    page,
  }) => {
    await createAccount(page, "Main");
    await importCsv(page, "generic-3rows.csv", "Main (PLN)");

    await expect(page.getByRole("main").getByText(/0 duplicates/)).toBeVisible();
    await expect(
      page.getByRole("main").getByText(/duplicate\(s\) skipped/),
    ).not.toBeVisible();
    await expect(
      page.getByRole("main").getByText(/row\(s\) could not be imported/),
    ).not.toBeVisible();
  });
});
