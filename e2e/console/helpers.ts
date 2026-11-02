/**
 * Shared helpers for the console browser tests.
 *
 * Screenshots go to `TAA_SHOT_DIR` when it is set (the output folder when capturing evidence)
 * and to `test-results/console-screenshots` otherwise, so the suite stays
 * portable and leaves no untracked files in the repository.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures.ts";

export const SHOT_DIR = process.env.TAA_SHOT_DIR ?? "test-results/console-screenshots";

mkdirSync(SHOT_DIR, { recursive: true });

export interface PageDefinition {
  name: string;
  path: string;
  heading: string;
}

export const PAGES: PageDefinition[] = [
  { name: "overview", path: "/", heading: "Overview" },
  { name: "requests-inbox", path: "/requests", heading: "Requests" },
  { name: "request-detail", path: "/requests/req_0001", heading: "Requests" },
  { name: "requests-history", path: "/requests?view=history", heading: "Requests" },
  { name: "usage", path: "/usage", heading: "Usage" },
  { name: "member", path: "/members/mem_lena", heading: "Lena" },
  { name: "models", path: "/models", heading: "Models" },
  { name: "rules", path: "/rules", heading: "Rules" },
  { name: "audit", path: "/audit", heading: "Audit" },
  { name: "setup", path: "/setup", heading: "Setup" },
  { name: "my-allowance", path: "/me", heading: "My allowance" },
  { name: "login", path: "/login", heading: "Sign in" },
];

export const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 1280, height: 900 },
] as const;

export async function scanA11y(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) =>
        `${violation.impact}: ${violation.id} — ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(" | ")}`,
    );
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, `page scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
}

export async function expectColourScheme(page: Page, scheme: "light" | "dark"): Promise<void> {
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe(scheme === "light" ? "rgb(247, 248, 250)" : "rgb(15, 18, 22)");
}

export function screenshotPath(name: string, width: number, theme: string): string {
  return join(SHOT_DIR, `${name}-${width}-${theme}.png`);
}
