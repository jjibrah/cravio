// Menu configuration: "Leave without publishing?" only for changes made during this visit (real, read-only:
// nothing is published; the draft only lives in this test browser's storage, cleared at the end).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

test('prompt only when something changed during this visit', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('manager@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/branch\/[0-9a-f-]{36}$/);
  const base = page.url();
  const nav = page.getByRole('navigation', { name: 'Branch navigation' });
  const status = page.getByText(/^(Published|Unsaved changes)$/).first();

  // 1. Untouched: leave silently.
  await page.goto(`${base}/menu`);
  await expect(status).toHaveText('Published');
  await nav.getByRole('link', { name: 'Orders' }).click();
  await expect(page).toHaveURL(/\/orders$/);

  // 2. A change this visit: leaving asks first; "Keep editing" stays.
  await page.goto(`${base}/menu`);
  await expect(status).toHaveText('Published');
  await page.getByRole('button', { name: /^Hide / }).first().click();
  await expect(status).toHaveText('Unsaved changes');
  await page.waitForTimeout(600); // the draft autosaves on this device
  await nav.getByRole('link', { name: 'Orders' }).click();
  await expect(page.getByText('Leave without publishing?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/menu$/);

  // 3. Reopened with that draft restored, untouched: leaving no longer asks (the draft stays saved).
  await page.reload();
  await expect(status).toHaveText('Unsaved changes');
  await nav.getByRole('link', { name: 'Orders' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByText('Leave without publishing?')).toBeHidden();

  // Clean up the test browser's draft.
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cravio-studio-draft:')).forEach((k) => localStorage.removeItem(k)));
});
