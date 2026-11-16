// Admin platform: businesses, business detail, activity and users' access (real, read-only: opens and cancels).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('admin sees businesses, a business, activity and real access', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);

  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Businesses' }).click();
  await expect(page.getByRole('heading', { name: 'Businesses', level: 1 })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Abdis Test Restaurant' }).first();
  await expect(row).toContainText('Owner');
  await expect(page.getByRole('row').filter({ hasText: 'Mama Oliech' }).first()).toContainText('No owner');
  await page.waitForTimeout(500);
  await page.screenshot({ path: info.outputPath('admin-businesses.png'), fullPage: true });

  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/admin\/businesses\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Abdis Test Restaurant/, level: 1 })).toBeVisible();
  await expect(page.getByText('owner@gmail.com · Business owner')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inventory health' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: info.outputPath('admin-business.png'), fullPage: true });
  await page.getByRole('button', { name: 'Add owner' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a business owner' });
  await expect(dialog.getByLabel('Email')).toBeFocused();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('admin-add-owner.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/admin/activity');
  await expect(page.getByText(/applied a reviewed access mapping/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('admin-activity.png'), fullPage: true });

  await page.goto('/admin/users');
  await expect(page.getByRole('row').filter({ hasText: 'owner@gmail.com' }).first()).toContainText('Business owner');
  await expect(page.getByRole('row').filter({ hasText: 'manager@gmail.com' }).first()).toContainText('Branch manager');
  await page.screenshot({ path: info.outputPath('admin-users.png'), fullPage: true });

  await page.goto('/admin/restaurants');
  await expect(page).toHaveURL(/\/admin\/businesses$/);
});
