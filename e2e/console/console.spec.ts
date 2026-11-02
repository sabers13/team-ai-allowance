import { type FixtureServer, startFixtureServer } from "../../test/console/fixture-server.ts";
import { expect, installNetworkGuard, test } from "../fixtures.ts";
import {
  expectColourScheme,
  expectNoHorizontalScroll,
  PAGES,
  scanA11y,
  screenshotPath,
  VIEWPORTS,
} from "./helpers.ts";

let server: FixtureServer;

test.beforeEach(async () => {
  server = await startFixtureServer();
});

test.afterEach(async () => {
  await server.close();
});

test.describe("every console page", () => {
  for (const definition of PAGES) {
    test(`${definition.name}: 360 and 1280, light and dark, axe clean`, async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      const failures: string[] = [];
      for (const viewport of VIEWPORTS) {
        for (const theme of ["light", "dark"] as const) {
          await context.clearCookies();
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.emulateMedia({ colorScheme: theme });
          const response = await page.goto(`${server.origin}${definition.path}`);
          expect(response?.status(), definition.path).toBe(200);
          await expect(page.locator("h1")).toHaveText(definition.heading);
          await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
          await expectColourScheme(page, theme);
          await expectNoHorizontalScroll(page);
          const violations = await scanA11y(page);
          failures.push(
            ...violations.map(
              (violation) => `${definition.name} ${viewport.width} ${theme}: ${violation}`,
            ),
          );
          await page.screenshot({
            path: screenshotPath(definition.name, viewport.width, theme),
            fullPage: true,
          });
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

test("the theme cookie wins over the system setting and the toggle works without a reload", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await context.addCookies([{ name: "taa_theme", value: "dark", url: server.origin }]);
  await page.goto(`${server.origin}/`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectColourScheme(page, "dark");
  await page.screenshot({
    path: screenshotPath("overview-cookie-dark", 1280, "dark"),
    fullPage: true,
  });

  await page.goto(`${server.origin}/models`);
  await page.locator('summary[aria-label="Theme: Dark"]').click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("the theme form works with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    javaScriptEnabled: false,
    colorScheme: "light",
  });
  await installNetworkGuard(context);
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  await page.locator('summary[aria-label="Theme: System"]').click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectColourScheme(page, "dark");
  await context.close();
});

test("approve and deny work with the keyboard and without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: false,
  });
  await installNetworkGuard(context);
  const page = await context.newPage();

  await page.goto(`${server.origin}/requests/req_0001`);
  await page.getByRole("button", { name: "Approve request", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForLoadState("load");
  await expect(page.locator(".request-detail .card__header .pill")).toHaveText("Approved");
  await expect(
    page.getByRole("status").filter({ hasText: "Request approved" }).first(),
  ).toBeVisible();

  await page.goto(`${server.origin}/requests/req_0002`);
  await page.getByRole("button", { name: "Deny request", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForLoadState("load");
  await expect(page.locator(".request-detail .card__header .pill")).toHaveText("Denied");

  await context.close();
});

test("the skip link is the first focusable element and lands on the main region", async ({
  page,
}) => {
  await page.goto(`${server.origin}/`);
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(focused).toContain("skip-link");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  const mainFocused = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(mainFocused).toBe("main");
});

test("a table sort is reachable and changes the order", async ({ page }) => {
  await page.goto(`${server.origin}/`);
  const firstBefore = await page.locator("table tbody tr").first().textContent();
  await page.getByRole("link", { name: /Sorted .*; sort by Member|Sort by Member/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("th[aria-sort='ascending']")).toHaveCount(1);
  const firstAfter = await page.locator("table tbody tr").first().textContent();
  expect(firstAfter).not.toBe(firstBefore);
});

test("an enhanced approve removes the card, updates the counter and can be dismissed", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${server.origin}/requests`);
  const counter = page.locator(".bottomnav [data-open-count]").first();
  await expect(counter).toHaveText("4");

  await page.route("**/requests/req_0001/decide", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page
    .locator("#request-req_0001")
    .getByRole("button", { name: "Approve this request" })
    .click();
  await expect(page.getByText("Working…")).toBeVisible();
  await expect(page.getByText(/Request approved for USD 10\.00/)).toBeVisible();
  await expect(counter).toHaveText("3");
  await expect(page.locator("#request-req_0001")).toHaveCount(0);

  const dismiss = page.getByRole("button", { name: "Dismiss notification" }).first();
  await dismiss.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Request approved for USD 10\.00/)).toHaveCount(0);
});

test("the sign-in form posts and lands on the overview", async ({ page }) => {
  await page.goto(`${server.origin}/login`);
  await page.getByLabel("E-mail").fill("priya@example.com");
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${server.origin}/`);
  await expect(page.locator("h1")).toHaveText("Overview");
});

test("usage sorts, stacks by model, accepts custom dates and exports the same rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${server.origin}/usage?period=30`);
  await expect(page.locator(".usage-table tbody tr")).not.toHaveCount(0);
  await expect(page.locator(".usage-table caption")).toContainText("CLI is inferred");

  const before = await page.locator(".usage-table tbody tr").first().textContent();
  await page.getByRole("link", { name: /sort by Cost/i }).click();
  await expect(page.locator("th[aria-sort='ascending']")).toHaveCount(1);
  const after = await page.locator(".usage-table tbody tr").first().textContent();
  expect(after).not.toBe(before);

  await page.getByRole("link", { name: "By model", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Usage");
  await expect(page.locator(".usage-chart title").first()).toContainText("stacked by model");
  await page.screenshot({
    path: screenshotPath("usage-model", 1280, "light"),
    fullPage: true,
  });

  await page.locator("#usage-from").fill("2026-10-29");
  await page.locator("#usage-to").fill("2026-10-30");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page).toHaveURL(/from=2026-10-29/);
  await expect(page).toHaveURL(/to=2026-10-30/);
  await expect(page.locator(".page__subtitle")).toContainText("2026-10-29 to 2026-10-30");
  await page.screenshot({
    path: screenshotPath("usage-custom", 1280, "light"),
    fullPage: true,
  });

  const csv = await page.request.get(
    `${server.origin}/usage.csv?period=30&series=member&sort=cost&dir=desc`,
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  const body = await csv.text();
  expect(body.split("\n")[0]).toBe(
    "member,member_id,status,requests,input_tokens,output_tokens,cost_usd,limit_usd,percent_of_limit,top_model,cli,cli_inferred,api_format",
  );
  expect(body).toContain("Lena");
  expect(body).toContain("Claude Code");
});

test("the empty, loading and error states are visible", async ({ page }) => {
  await page.goto(`${server.origin}/?simulate=empty`);
  await expect(page.getByText("No members yet")).toBeVisible();
  await expect(page.getByText("No open requests")).toBeVisible();

  await page.goto(`${server.origin}/models?simulate=loading`);
  await expect(page.getByText("Loading models…")).toBeVisible();

  await page.goto(`${server.origin}/audit?simulate=error`);
  await expect(page.getByText("This list could not be loaded")).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
});

test("the request detail is one thumb away on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${server.origin}/requests/req_0001`);
  await expect(page.locator(".request-list-card")).toBeHidden();
  const approve = page.locator(".actionbar").getByRole("button", { name: "Approve" });
  await expect(approve).toBeVisible();
  const box = await approve.boundingBox();
  expect(box === null ? 0 : box.y).toBeGreaterThan(400);
  await expect(page.getByText("← Back to inbox")).toBeVisible();
});
