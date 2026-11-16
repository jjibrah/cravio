// Terms and conditions. First test real and read-only (010 applied, nothing published); the editor test MOCKS the admin legal API
// and aborts writes.
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('migration 010 applied, nothing published yet: nobody is blocked (real, read-only)', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.getByText('Cravio hasn’t published terms yet.')).toBeVisible();
  await signIn(page, 'admin@gmail.com');
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Terms & conditions' }).click();
  await expect(page.getByText('Nothing published yet. Until you publish, new accounts aren’t asked to accept any terms.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
});

test('admin writes terms with a live preview and a publish confirmation (mocked)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/admin/legal/terms**', (route) => {
    if (route.request().method() !== 'GET') return route.abort();
    return route.fulfill({ json: { kind: 'terms', draft: { title: 'Terms and conditions', body: '', updatedAt: null }, current: null, versions: [], accountHolders: 6 } });
  });
  await signIn(page, 'admin@gmail.com');
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin/terms');
  await page.getByLabel('Text').fill('# Using Cravio\nThese terms cover restaurants using Cravio.\n\n## Your account\n- Keep your password private\n- Tell us if your phone is lost');
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('heading', { name: 'Using Cravio' })).toBeVisible();
  await expect(preview.getByRole('listitem').first()).toHaveText('Keep your password private');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish the terms?' });
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('publish.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.screenshot({ path: info.outputPath('editor.png'), fullPage: true });
});
