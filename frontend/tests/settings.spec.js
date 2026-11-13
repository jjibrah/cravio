import { test, expect } from '@playwright/test';

async function ownerLogin(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByLabel('Password', { exact: true }).fill('12344321');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}

test('owner settings: every section opens, remembers the tab in the URL, and fits a phone', async ({ page }) => {
  await ownerLogin(page);
  await page.goto('/owner/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.getByRole('heading', { name: 'Restaurant details' })).toBeVisible();
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Demo Restaurant');

  for (const [tab, heading, query] of [
    ['Opening hours', 'Opening hours', 'hours'],
    ['Tables & QR codes', 'QR codes and menu link', 'floor'],
    ['Team', 'People on your team', 'team'],
    ['Your account', 'Your profile', 'account'],
  ]) {
    await nav.getByRole('button', { name: new RegExp(tab) }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${query}`));
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();

  // Editing shows the save bar; discarding puts the saved value back without a request.
  await nav.getByRole('button', { name: /Restaurant/ }).click();
  await page.getByLabel('Restaurant name').fill('Demo Restaurant changed');
  await expect(page.getByText('You have unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Demo Restaurant');

  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
