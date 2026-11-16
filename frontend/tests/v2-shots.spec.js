// Screenshots of branch Settings and Insights for design review (real, read-only: navigation only).
import { test, expect } from '@playwright/test';
const password = process.env.V2_TEST_PASSWORD;
test.skip(!password, 'Set V2_TEST_PASSWORD to the shared test accounts’ password.');
test('settings and insights screens', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('manager@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/branch\/[0-9a-f-]{36}$/);
  const base = page.url();
  for (const [name, path] of [['settings', '/settings'], ['settings-hours', '/settings?tab=hours'], ['settings-team', '/settings?tab=team'], ['settings-account', '/settings?tab=account'], ['insights', '/insights']]) {
    await page.goto(base + path);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/settings');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath('settings-phone.png'), fullPage: true });
});
