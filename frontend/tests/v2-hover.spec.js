// Hovering a product card must not paint a dark box behind its name (real, read-only).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('product card name stays transparent on hover', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('manager@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/branch\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/products`);
  const name = page.locator('.pc-open').first();
  await name.hover();
  expect(await name.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: info.outputPath('products-hover.png') });
});
