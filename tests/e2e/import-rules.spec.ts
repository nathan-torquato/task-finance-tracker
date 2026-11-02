import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "./fixtures";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) =>
  path.join(__dirname, "fixtures", "csv", name);

async function seededUser(page: Page) {
  const res = await page.request.post("/test-create-user?seed=defaults");
  if (!res.ok()) {
    throw new Error(
      `/test-create-user?seed=defaults failed (${res.status()}). Is NODE_ENV=test on the server?`,
    );
  }
}

async function createAccount(page: Page, name: string) {
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Add Account" }).click();
  await page.getByLabel("Account Name").fill(name);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(
    page.getByRole("heading", { name: "New Account" }),
  ).toBeHidden();
}

async function importFile(page: Page, fileName: string, accountLabel: string) {
  await page.getByRole("link", { name: "Import" }).click();
  await page.getByTestId("file-input").setInputFiles(fixturePath(fileName));
  await expect(page.getByRole("combobox", { name: "Date" })).toBeVisible();
  await page.getByTestId("continue-to-account").click();
  await page.getByRole("combobox", { name: "Account" }).selectOption({
    label: accountLabel,
  });
  await page.getByTestId("continue-to-preview").click();
  await page.getByRole("button", { name: "Confirm Import" }).click();
  await expect(page.getByTestId("import-summary")).toBeVisible();
}

async function gotoCategorization(page: Page) {
  await page.getByRole("link", { name: "Categorization" }).click();
  await expect(
    page.getByRole("heading", { name: "Categorization Rules" }),
  ).toBeVisible();
}

async function createRule(
  page: Page,
  pattern: string,
  categoryName: string,
) {
  await page.getByTestId("add-rule").click();
  await page.getByTestId("rule-pattern").fill(pattern);
  await page
    .getByRole("combobox", { name: "Category" })
    .selectOption({ label: categoryName });
  await page.getByTestId("rule-save").click();
}

test.describe("Categorization rule management", () => {
  test.beforeEach(async ({ page }) => {
    await seededUser(page);
    await page.goto("/dashboard");
  });

  test("creating a rule applies it to existing uncategorized transactions", async ({
    page,
  }) => {
    // Import a CSV with an unmatched description so we have an uncategorized
    // transaction to apply a fresh rule against.
    await createAccount(page, "Main");
    await importFile(page, "autocat-3rows.csv", "Main (PLN)");

    // Sanity-check: the "unknown merchant" row is uncategorized after import.
    await page.goto("/transactions");
    const unknownRow = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "Some unknown merchant" });
    await expect(unknownRow).toBeVisible();
    await expect(unknownRow).not.toContainText("Hobbies");

    // Create a rule that matches the previously-uncategorized row.
    await page.goto("/categorization");
    await createRule(page, "unknown merchant", "Hobbies");
    // With AI enabled, the row may already be categorized, triggering the impact dialog.
    // Click "Overwrite all" if the dialog appears; otherwise the form is already closed.
    await page.waitForFunction(
      () => {
        const form = document.querySelector('[data-testid="rule-form"]');
        const dialog = document.querySelector('[data-testid="impact-confirm"]');
        return !form || form.classList.contains('hidden')
          || (dialog && !dialog.classList.contains('hidden'));
      },
      { timeout: 10000 },
    );
    const impactVisible = await page.getByTestId("impact-confirm").isVisible();
    if (impactVisible) {
      await page.getByTestId("impact-overwrite").click();
    }
    await expect(page.getByTestId("rule-form")).toBeHidden();

    // The existing row now has the new category.
    await page.goto("/transactions");
    const refreshed = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "Some unknown merchant" });
    await expect(refreshed).toContainText("Hobbies");
  });

  test("override warning blocks accidental overwrites", async ({ page }) => {
    // Import the standard CSV; BIEDRONKA gets Groceries via the seeded rule.
    await createAccount(page, "Main");
    await importFile(page, "autocat-3rows.csv", "Main (PLN)");

    // Create a new rule matching BIEDRONKA but pointing to a different
    // category. The impact dialog should warn that 1 row would be overwritten.
    await gotoCategorization(page);
    await page.getByTestId("add-rule").click();
    await page.getByTestId("rule-pattern").fill("BIEDRONKA");
    await page
      .getByRole("combobox", { name: "Category" })
      .selectOption({ label: "Snacks & Sweets" });
    await page.getByTestId("rule-save").click();

    await expect(page.getByTestId("impact-confirm")).toBeVisible();
    await expect(page.getByTestId("impact-confirm")).toContainText(/0 uncategorized and 1 already-categorized/);

    // Choosing "only uncategorized" leaves the BIEDRONKA row's category alone.
    await page.getByTestId("impact-only-uncat").click();
    await expect(page.getByTestId("impact-confirm")).toBeHidden();

    await page.goto("/transactions");
    const biedronkaRow = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "BIEDRONKA" });
    await expect(biedronkaRow).toContainText("Groceries");
    await expect(biedronkaRow).not.toContainText("Snacks & Sweets");
  });

  test("reordering rules changes which one wins on a fresh import", async ({
    page,
  }) => {
    await createAccount(page, "Main");

    // Add a competing rule for Biedronka → Snacks & Sweets at priority 100
    // (same as the seeded Biedronka → Groceries rule). Order in the table
    // determines priority via reorder.
    await gotoCategorization(page);
    await createRule(page, "Biedronka", "Snacks & Sweets");
    await page.waitForFunction(
      () => {
        const form = document.querySelector('[data-testid="rule-form"]');
        const dialog = document.querySelector('[data-testid="impact-confirm"]');
        return !form || form.classList.contains('hidden')
          || (dialog && !dialog.classList.contains('hidden'));
      },
      { timeout: 10000 },
    );
    const impactVisible = await page.getByTestId("impact-confirm").isVisible();
    if (impactVisible) {
      await page.getByTestId("impact-only-uncat").click();
    }
    await expect(page.getByTestId("rule-form")).toBeHidden();

    // Find the new rule's row and move it up until it sits above the seeded
    // Biedronka rule. The two share match prefix; we identify ours by
    // category text.
    const snacksRow = page
      .getByTestId("rule-row")
      .filter({ hasText: "Snacks & Sweets" })
      .filter({ hasText: "Biedronka" });
    await expect(snacksRow).toBeVisible();

    // Move the Snacks rule to the top by repeatedly clicking "up" until it
    // becomes the first rule row. After each click we wait for the snacks
    // row's position to advance before issuing the next click.
    const snacksIndex = async () => {
      const ids = await page
        .getByTestId("rule-row")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.textContent ?? ""),
        );
      return ids.findIndex(
        (t) => t.includes("Snacks & Sweets") && t.includes("Biedronka"),
      );
    };
    for (let i = 0; i < 30; i++) {
      const before = await snacksIndex();
      if (before <= 0) break;
      await snacksRow.getByTestId("rule-move-up").click();
      await expect
        .poll(snacksIndex, { timeout: 5000 })
        .toBeLessThan(before);
    }

    // Import a Biedronka-only CSV. The reordered rule should win.
    await importFile(page, "autocat-biedronka.csv", "Main (PLN)");

    await page.goto("/transactions");
    const biedronkaRow = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "BIEDRONKA" });
    await expect(biedronkaRow).toContainText("Snacks & Sweets");
    await expect(biedronkaRow).not.toContainText("Groceries");
  });

  test("deleting a rule does not retroactively recategorize", async ({
    page,
  }) => {
    await createAccount(page, "Main");
    await importFile(page, "autocat-3rows.csv", "Main (PLN)");

    // BIEDRONKA was categorized as Groceries via the seeded rule. Now delete
    // every rule that contains "Biedronka" or "BIEDRONKA".
    await page.goto("/categorization");
    while (true) {
      const targets = page
        .getByTestId("rule-row")
        .filter({ has: page.locator('[data-field="pattern"]', { hasText: /^(BIEDRONKA|Biedronka)$/ }) });
      const count = await targets.count();
      if (count === 0) break;
      await targets.first().getByTestId("delete-rule").click();
      await page.getByTestId("delete-rule-confirm").click();
      await expect(page.getByTestId("delete-rule-dialog")).toBeHidden();
      // Wait for the refetched list to drop the row before re-counting —
      // otherwise the next iteration targets a row that is about to vanish.
      await expect(targets).toHaveCount(count - 1);
    }

    // The previously-imported BIEDRONKA row keeps its Groceries category.
    await page.goto("/transactions");
    const biedronkaRow = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: "BIEDRONKA" });
    await expect(biedronkaRow).toContainText("Groceries");
  });
});
