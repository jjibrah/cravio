// Admin Settings (real, read-only: opens sections, saves nothing).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('admin settings: profile, security, Cravio team, platform', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('admin@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin/settings');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.getByText('Your name appears in the activity log and on support replies.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Contact Cravio', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('profile.png') });
  await nav.getByRole('button', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Password' })).toBeVisible();
  await nav.getByRole('button', { name: 'Cravio team' }).click();
  await expect(page.getByText('admin@gmail.com').first()).toBeVisible();
  await expect(page.getByText(/primary admin, can’t be removed/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('team.png') });
  await nav.getByRole('button', { name: 'Platform' }).click();
  await expect(page.getByText('009_inventory')).toBeVisible();
  await expect(page.getByText('AI assistant (OpenRouter)')).toBeVisible();
  await page.screenshot({ path: info.outputPath('platform.png'), fullPage: true });
});
