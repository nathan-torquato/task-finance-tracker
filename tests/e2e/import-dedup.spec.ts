import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "./fixtures";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  path.join(__dirname, "fixtures", "csv", name);

async function createAccount(page: Page, name: string) {
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Add Account" }).click();
  await expect(page.getByRole("textbox", { name: /Account Name/i })).toBeVisible();
  await page.getByRole("textbox", { name: /Account Name/i }).fill(name);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(
    page.getByRole("heading", { name: "Add Account" }),
  ).toBeHidden();
}

async function importCsv(page: Page, fileName: string, accountLabel: string) {
  // Round-trip via Dashboard so the Import component unmounts and resets between calls.
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL("/dashboard");
  await page.getByRole("link", { name: "Import" }).click();

  // Upload step — click the "Choose File" label to open the native file chooser
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("main").getByText("Choose File").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(fixturePath(fileName));

  // Wait for the mapping step to render (previewImport server call completes)
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

test.describe("CSV import duplicate detection", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    // The cross-account dedup test needs 3 accounts (seeded Main + 2
    // created), above the free plan's limit — run as a Pro user. Free-limit
    // gating is covered in billing.spec.ts.
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/dashboard");
  });

  test("re-importing the same file imports zero new rows", async ({
    page,
  }) => {
    await createAccount(page, "Main");

    await importCsv(page, "generic-3rows.csv", "Main (PLN)");
    await expect(
      page.getByRole("main").getByText(/3 new transactions imported/),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText(/0 duplicates/)).toBeVisible();

    // Re-import the same file into the same account.
    await importCsv(page, "generic-3rows.csv", "Main (PLN)");
    await expect(
      page.getByRole("main").getByText(/0 new transactions imported/),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText(/3 duplicates/)).toBeVisible();

    // Transactions page still shows exactly 3 rows.
    await page.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(
      3 + 1, // 3 data rows + 1 header
    );
  });

  test("partial overlap imports only the new rows", async ({ page }) => {
    await createAccount(page, "Main");

    await importCsv(page, "generic-3rows.csv", "Main (PLN)");
    await importCsv(page, "generic-overlap.csv", "Main (PLN)");

    await expect(
      page.getByRole("main").getByText(/2 new transactions imported/),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText(/2 duplicates/)).toBeVisible();

    await page.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(5 + 1);
    const table = page.getByRole("table");
    await expect(table.getByText("Coffee shop")).toBeVisible();
    await expect(table.getByText("Grocery shopping")).toBeVisible();
    await expect(table.getByText("January salary")).toBeVisible();
    await expect(table.getByText("Lunch")).toBeVisible();
    await expect(table.getByText("Dinner")).toBeVisible();
  });

  test("same row in a different account is not a duplicate", async ({
    page,
  }) => {
    await createAccount(page, "Main");
    await createAccount(page, "Backup");

    await importCsv(page, "generic-3rows.csv", "Main (PLN)");
    await importCsv(page, "generic-3rows.csv", "Backup (PLN)");

    // Second import into a different account creates the rows again.
    await expect(
      page.getByRole("main").getByText(/3 new transactions imported/),
    ).toBeVisible();
    await expect(page.getByRole("main").getByText(/0 duplicates/)).toBeVisible();

    await page.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(6 + 1);
  });

  test("preview marks duplicates before confirm", async ({ page }) => {
    await createAccount(page, "Main");

    // First import to seed duplicates.
    await importCsv(page, "generic-3rows.csv", "Main (PLN)");

    // Start a second import; stop on the preview step and check badges.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL("/dashboard");
    await page.getByRole("link", { name: "Import" }).click();

    // Upload step — click the "Choose File" label to open the native file chooser
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("main").getByText("Choose File").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(fixturePath("generic-overlap.csv"));

    // Wait for the mapping step to render
    await expect(page.getByRole("heading", { name: "Map columns" })).toBeVisible();

    // Mapping step — click Continue to go to account selection
    await page.getByRole("button", { name: "Continue" }).click();

    // Account step — select account and proceed to preview
    await page
      .getByRole("combobox", { name: "Account" })
      .selectOption({ label: "Main (PLN)" });
    await page.getByRole("button", { name: "Continue" }).click();

    // Preview step — 4 data rows + 1 header in the preview table
    const previewTable = page
      .getByRole("table", { name: "Preview" })
      .getByRole("row");
    await expect(previewTable).toHaveCount(5); // 1 header + 4 data rows

    // 2 duplicates among the 4 preview rows (rows with "Duplicate" badge)
    const duplicateRows = previewTable.filter({ hasText: "Duplicate" });
    await expect(duplicateRows).toHaveCount(2);

    // The badged rows correspond to the two descriptions shared with the first file.
    await expect(duplicateRows.filter({ hasText: "Coffee shop" })).toHaveCount(
      1,
    );
    await expect(
      duplicateRows.filter({ hasText: "Grocery shopping" }),
    ).toHaveCount(1);
  });
});
