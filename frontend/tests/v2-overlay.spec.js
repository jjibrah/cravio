// The side-sheet overlay on the branch Inventory page (real, read-only: opens and closes a sheet, saves nothing).
import { test, expect } from '@playwright/test';

const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('side sheet dims the page lightly and slides in solid', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('manager@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/branch\/[0-9a-f-]{36}$/);
  await page.goto(`${page.url()}/inventory`);
  await page.getByRole('button', { name: 'New item' }).click();
  const sheet = page.getByRole('dialog', { name: 'New stock item' });
  await expect(sheet).toBeVisible();
  // Mid-animation the panel is already fully opaque.
  expect(await sheet.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const scrim = await sheet.evaluate((el) => { const s = getComputedStyle(el, '::backdrop'); return { color: s.backgroundColor, filter: s.backdropFilter }; });
  expect(scrim.color).toBe('rgba(26, 24, 20, 0.1)');
  expect(scrim.filter).toContain('blur');
  await page.waitForTimeout(350);
  await page.screenshot({ path: info.outputPath('overlay.png') });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
