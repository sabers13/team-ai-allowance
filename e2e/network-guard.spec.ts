import { createServer, type Server } from "node:http";
import { expect, test } from "./fixtures.ts";

let server: Server;
let origin = "";

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>local</title><h1>local page</h1>");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("the guard allows a localhost page", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "local page" })).toBeVisible();
});

test("the guard blocks a non-localhost request", async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/never");
      return "reached";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(result).not.toBe("reached");
  expect(result.toLowerCase()).toContain("failed to fetch");
});

test("the guard blocks a non-localhost navigation", async ({ page }) => {
  await page.goto(origin);
  const failed = await page
    .goto("https://example.com/never")
    .then(() => false)
    .catch(() => true);
  expect(failed).toBe(true);
});
