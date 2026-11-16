// Team "Add person" pop-up and the menu studio's leave dialog (real, read-only: opens and cancels, saves nothing).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');
const ABDIS = '106fe2fb-94bb-4f5d-bd0d-bd694004424c';

test('add person opens as a compact pop-up; studio leave dialog stays closed', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/owner$/);
  await page.goto(`/branch/${ABDIS}/settings?tab=team`);
  await expect(page.getByRole('heading', { name: 'Add someone to your team' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add someone to your team' });
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await expect(dialog.getByRole('radio', { name: /Waiter/ })).toBeChecked();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('team-modal.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  // After Settings' styles have loaded, the studio's "Leave without publishing?" must not show on its own.
  await page.goto(`/branch/${ABDIS}/menu`);
  await page.waitForTimeout(1500);
  await expect(page.getByText('Leave without publishing?')).toBeHidden();
});
