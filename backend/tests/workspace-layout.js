import { chromium, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { env } from "../scripts/clients.js";
const auth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false } },
);
const { data, error } = await auth.auth.signInWithPassword({
  email: "owner@gmail.com",
  password: "12344321",
});
if (error) throw error;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1000 },
  });
  await context.addInitScript(
    ({ key, session }) => localStorage.setItem(key, JSON.stringify(session)),
    {
      key: `sb-${new URL(env.SUPABASE_URL).hostname.split(".")[0]}-auth-token`,
      session: data.session,
    },
  );
  let writes = 0;
  await context.route("**/api/inventory", async (route) => {
    if (route.request().method() === "POST") writes++;
    await route.fulfill({ json: { business: null } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:5174/owner/inventory");
  await expect(
    page.getByRole("heading", { name: "Start tracking your stock" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Location overview" }),
  ).toBeVisible();
  const box = await page
    .getByLabel("Business name", { exact: true })
    .boundingBox();
  expect(box.height).toBeLessThan(60);
  expect(box.width).toBeGreaterThan(260);
  await page.screenshot({
    path: ".artifacts/workspace-empty-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Explore example" }).click();
  await expect(
    page.getByText("Read-only example workspace", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await expect(
    page.getByText("Chocolate pastry is low at Town outlet"),
  ).toBeVisible();
  await page.screenshot({
    path: ".artifacts/workspace-example-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await page.getByLabel("Search stock", { exact: true }).fill("Vanilla");
  const table = page.locator(".iv-table tbody");
  await expect(table.locator("tr")).toHaveCount(3);
  await page
    .getByLabel("Filter location", { exact: true })
    .selectOption("park");
  await expect(table.locator("tr")).toHaveCount(1);
  await expect(table).toContainText("Vanilla cake");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Post movement" }),
  ).toBeDisabled();
  await page.goto("http://localhost:5174/owner/management?example=1");
  await expect(
    page.getByRole("heading", { name: "Daily checklist" }),
  ).toBeVisible();
  await page.getByLabel("Task status", { exact: true }).selectOption("open");
  await expect(page.locator(".iv-table tbody tr")).toHaveCount(2);
  await page
    .getByLabel("Filter task location", { exact: true })
    .selectOption("town");
  await expect(page.locator(".iv-table tbody tr")).toHaveCount(1);
  await page.screenshot({
    path: ".artifacts/workspace-management-desktop.png",
    fullPage: true,
  });
  await page.goto("http://localhost:5174/owner/assistant?example=1");
  await page
    .getByRole("button", { name: "Where is stock running low?", exact: true })
    .click();
  await expect(page.locator(".iv-answer")).toContainText(
    "2 location/product lines",
  );
  await page.screenshot({
    path: ".artifacts/workspace-assistant-desktop.png",
    fullPage: true,
  });
  for (const route of ["inventory", "management", "assistant"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://localhost:5174/owner/${route}?example=1`);
    await expect(
      page.getByText("Read-only example workspace", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.artifacts/workspace-${route}-mobile.png`,
      fullPage: true,
    });
  }
  expect(writes).toBe(0);
  expect(errors).toEqual([]);
  console.log(
    "Workspace layout passed: empty-state structure, normal input height, read-only examples, stock search/location filters, task filters, factual Q&A and three mobile layouts. Zero database writes.",
  );
} finally {
  await browser.close();
  await auth.auth.signOut({ scope: "local" });
}
