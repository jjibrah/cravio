// Platform admin sign-in (real, read-only).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('admin@gmail.com lands in the admin workspace and cannot open owner or branch areas', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText('Cravio internal · Admin workspace')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath('admin.png') });
  await page.goto('/admin/users');
  await expect(page.getByText('admin@gmail.com').first()).toBeVisible();
  await page.goto('/owner');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/branch/106fe2fb-94bb-4f5d-bd0d-bd694004424c');
  await expect(page).toHaveURL(/\/admin$/);
});
