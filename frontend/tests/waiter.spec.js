import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });

async function login(page, email = 'waiter@gmail.com') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('12344321');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('waiter has three protected, reloadable mobile tabs and fixed navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/waiter/services');
  await expect(page).toHaveURL(/\/login$/);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
  // Seeded: waiter@gmail.com works at the owner's live Demo Restaurant (backend/scripts/seed-users.js).
  await expect(page.getByText('Demo Restaurant', { exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Waiter navigation' });
  await expect(nav.getByRole('link')).toHaveText(['Tables', 'Services', 'Menu']);
  for (const [label, path] of [['Services', 'services'], ['Menu', 'menu'], ['Tables', '']]) {
    const link = nav.getByRole('link', { name: label, exact: true });
    await link.tap();
    await expect(page).toHaveURL(`http://localhost:5173/waiter${path ? `/${path}` : ''}`);
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(nav).toBeVisible();
    const bounds = await nav.boundingBox();
    expect(Math.abs(bounds.y + bounds.height - 844)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await nav.getByRole('link').first().evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.waiter-content').evaluate((element) => {
    const filler = document.createElement('div');
    filler.style.minHeight = '1500px';
    element.appendChild(filler);
    element.scrollTop = element.scrollHeight;
  });
  expect((await nav.boundingBox()).y + (await nav.boundingBox()).height).toBe(844);
  await page.goto('/admin/restaurants');
  await expect(page).toHaveURL(/\/waiter$/);
  await page.getByRole('button', { name: 'Open profile' }).tap();
  await page.getByRole('dialog', { name: 'Profile', exact: true }).getByRole('button', { name: 'Log out', exact: true }).tap();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('waiter profile and notifications use keyboard-accessible bottom sheets', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await login(page);
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await bell.click();
  const notifications = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(notifications).toBeVisible();
  await expect(notifications.getByText('Login successful', { exact: true })).toBeVisible();
  await notifications.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell).toHaveAttribute('aria-label', 'Notifications');
  await notifications.getByRole('button', { name: 'Clear all' }).click();
  await expect(notifications.getByText('No notifications yet.')).toBeVisible();
  const sheetBounds = await notifications.boundingBox();
  expect(Math.abs(sheetBounds.y + sheetBounds.height - 740)).toBeLessThan(1);
  await page.keyboard.press('Escape');
  await expect(notifications).not.toBeVisible();
  await expect(bell).toBeFocused();
  const profile = page.getByRole('button', { name: 'Open profile' });
  await profile.click();
  const sheet = page.getByRole('dialog', { name: 'Profile', exact: true });
  await expect(sheet.getByText('waiter@gmail.com', { exact: true })).toBeVisible();
  const close = sheet.getByRole('button', { name: 'Close profile', exact: true });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(sheet.getByRole('button', { name: 'Log out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).not.toBeVisible();
  await expect(profile).toBeFocused();
  await profile.click();
  await sheet.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('account loading shows the centered CRAVIO logo and motion respects preferences', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/me', async (route) => { await gate; await route.continue(); });
  try {
    await login(page);
    const loader = page.getByRole('status', { name: 'Loading CRAVIO', exact: true });
    await expect(loader).toBeVisible();
    await expect(page.getByText('Loading your account…', { exact: true })).toHaveCount(0);
    const bounds = await loader.boundingBox();
    expect(Math.abs(bounds.x + bounds.width / 2 - 195)).toBeLessThan(1);
    expect(Math.abs(bounds.y + bounds.height / 2 - 422)).toBeLessThan(1);
    const dots = loader.locator('.loading-dots span');
    await expect(dots).toHaveCount(3);
    expect(await dots.first().evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(dots.first()).toHaveCSS('animation-name', 'none');
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open profile' }).click();
  await page.getByRole('dialog', { name: 'Profile', exact: true }).getByRole('button', { name: 'Log out', exact: true }).click();
});

test('owners cannot open waiter tabs', async ({ page }) => {
  await login(page, 'owner@gmail.com');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.goto('/waiter/menu');
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('navigation', { name: 'Waiter navigation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Profile options' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
});
