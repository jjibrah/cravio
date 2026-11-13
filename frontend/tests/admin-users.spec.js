import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, env } from '../../backend/scripts/clients.js';

// Admin Users page against the real backend. Requires migration 001 (multi-admin)
// and the seeded owner and waiter (npm run db:seed). Throwaway users are created
// with unique example.com emails and always deleted in `finally`.

const service = createAdmin();
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const throwawayEmail = () => `cravio-test-${stamp()}@${process.env.CRAVIO_TEST_INVITE_DOMAIN || 'example.com'}`;
const rowButton = (page, name, email) => page.getByRole('button', { name: `${name}, ${email}. View details`, exact: true });

async function adminSession(page) {
  const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: 'magiclink', email: env.SUPER_ADMIN_EMAIL });
  if (linkError) throw new Error('The reserved admin account must exist before this test.');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  expect(error).toBeNull();
  const key = `sb-${new URL(env.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  await page.addInitScript(({ key, session }) => {
    if (!sessionStorage.getItem('admin-users-test-session')) {
      localStorage.setItem(key, JSON.stringify(session));
      sessionStorage.setItem('admin-users-test-session', 'true');
    }
  }, { key, session: data.session });
  return { session: data.session, end: () => client.auth.signOut({ scope: 'local' }) };
}

async function findUserByEmail(email) {
  for (let page = 1; page < 100; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((item) => item.email?.toLowerCase() === email.toLowerCase());
    if (user || data.users.length < 1000) return user || null;
  }
  return null;
}

/** Deletes throwaway users (and any restaurant rows created for them). Never touches seeded accounts. */
async function cleanup(emails) {
  for (const email of emails) {
    if (!/^cravio-test-.+@example\.com$/.test(email)) continue;
    const user = await findUserByEmail(email).catch(() => null);
    if (!user) continue;
    await service.from('restaurant_members').delete().eq('user_id', user.id).then(() => {}, () => {});
    await service.from('restaurants').delete().eq('owner_id', user.id).then(() => {}, () => {});
    const { error } = await service.auth.admin.deleteUser(user.id);
    if (error) console.warn(`Could not delete ${email}: ${error.message}`);
  }
}

/** Creates a confirmed throwaway user directly (no invite email), so role and suspension tests don't hit email limits. */
async function createThrowaway(role, name) {
  const email = throwawayEmail();
  const { data, error } = await service.auth.admin.createUser({
    email, email_confirm: true, user_metadata: { name }, app_metadata: { role },
  });
  if (error) throw new Error(`Could not create throwaway user: ${error.message}`);
  await service.from('profiles').upsert({ id: data.user.id, name, role });
  return { id: data.user.id, email, name };
}

async function openUsers(page) {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.locator('.u-row.is-skeleton')).toHaveCount(0);
}

test('lists every user with the seeded owner and waiter, and filters by tab and search', async ({ page }) => {
  const { end } = await adminSession(page);
  try {
    await openUsers(page);
    const nav = page.getByRole('navigation', { name: 'Admin navigation' });
    await expect(nav.getByRole('link', { name: 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toBeVisible();
    await expect(rowButton(page, 'Waiter', 'waiter@gmail.com')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: env.SUPER_ADMIN_EMAIL.toLowerCase() }).getByText('Primary admin')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: env.SUPER_ADMIN_EMAIL.toLowerCase() }).getByText('You', { exact: true })).toBeVisible();

    // Tabs filter by role, with keyboard support.
    await page.getByRole('tab', { name: /^Owners/ }).click();
    await expect(page).toHaveURL(/tab=owner/);
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toBeVisible();
    await expect(rowButton(page, 'Waiter', 'waiter@gmail.com')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /^Waiters/ })).toHaveAttribute('aria-selected', 'true');
    await expect(rowButton(page, 'Waiter', 'waiter@gmail.com')).toBeVisible();
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toHaveCount(0);
    await page.getByRole('tab', { name: /^All/ }).click();

    // Search by email and by name; counts follow the search.
    const search = page.getByRole('searchbox', { name: 'Search users by name or email' });
    await search.fill('waiter@gmail');
    await expect(rowButton(page, 'Waiter', 'waiter@gmail.com')).toBeVisible();
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^All/ })).toContainText('1');
    await search.fill('no-such-user-zz');
    await expect(page.getByText('No users match “no-such-user-zz”')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toBeVisible();

    // Details drawer opens from the row and closes with Escape.
    await rowButton(page, 'Owner', 'owner@gmail.com').click();
    const drawer = page.getByRole('dialog', { name: 'Owner' });
    await expect(drawer.getByRole('radio', { name: 'Owner' })).toHaveAttribute('aria-checked', 'true');
    await expect(drawer.getByText('owner@gmail.com').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  } finally { await end(); }
});

test('invites a throwaway admin and a waiter, who appear as invited', async ({ page }) => {
  const adminEmail = throwawayEmail();
  const waiterEmail = throwawayEmail();
  const { end } = await adminSession(page);
  try {
    await openUsers(page);
    // Inline validation before anything is sent.
    await page.getByRole('button', { name: 'Invite user' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite user' });
    await expect(dialog.getByLabel('Email', { exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(dialog.getByText('Enter an email address.')).toBeVisible();
    await expect(dialog.getByText('Enter their name.')).toBeVisible();

    // Duplicate email is rejected by the server and shown on the field.
    await dialog.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
    await dialog.getByLabel('Name', { exact: true }).fill('Duplicate');
    await dialog.getByRole('radio', { name: /^Admin/ }).check();
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(dialog.getByText('Someone with this email already has a Cravio account.')).toBeVisible();

    // Sending a real invite needs custom SMTP in Supabase and a deliverable domain
    // (Supabase rejects example.com). Set CRAVIO_TEST_INVITE_DOMAIN to run the rest.
    test.skip(!process.env.CRAVIO_TEST_INVITE_DOMAIN, 'Set CRAVIO_TEST_INVITE_DOMAIN (with custom SMTP) to test sending invites.');

    // Admin invite.
    await dialog.getByLabel('Email', { exact: true }).fill(adminEmail);
    await dialog.getByLabel('Name', { exact: true }).fill('Test Admin');
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Invite sent to ${adminEmail}.` })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    const adminRow = page.getByRole('row').filter({ has: rowButton(page, 'Test Admin', adminEmail) });
    await expect(adminRow.getByText('Invited', { exact: true })).toBeVisible();
    await expect(adminRow.getByText('Admin', { exact: true })).toBeVisible();
    const invitedAdmin = await findUserByEmail(adminEmail);
    expect(invitedAdmin.app_metadata.role).toBe('admin');
    const { data: adminProfile } = await service.from('profiles').select('role, name').eq('id', invitedAdmin.id).single();
    expect(adminProfile).toEqual({ role: 'admin', name: 'Test Admin' });

    // Waiter invite needs a restaurant.
    await page.getByRole('button', { name: 'Invite user' }).click();
    await dialog.getByRole('radio', { name: /^Waiter/ }).check();
    const select = dialog.getByLabel('Restaurant', { exact: true });
    const none = dialog.getByText('No restaurants yet.');
    await expect(select.or(none)).toBeVisible();
    test.skip(await none.isVisible(), 'No restaurants exist yet, so a waiter cannot be invited.');
    await dialog.getByLabel('Email', { exact: true }).fill(waiterEmail);
    await dialog.getByLabel('Name', { exact: true }).fill('Test Waiter');
    await select.selectOption({ index: 1 });
    const restaurantName = (await select.locator('option:checked').textContent()).replace(/ \(setting up\)$/, '');
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Invite sent to ${waiterEmail}.` })).toBeVisible();
    const waiterRow = page.getByRole('row').filter({ has: rowButton(page, 'Test Waiter', waiterEmail) });
    await expect(waiterRow.getByText('Invited', { exact: true })).toBeVisible();
    await expect(waiterRow.getByText(restaurantName, { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Invited/ }).click();
    await expect(rowButton(page, 'Test Waiter', waiterEmail)).toBeVisible();
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toHaveCount(0);
  } finally {
    await cleanup([adminEmail, waiterEmail]);
    await end();
  }
});

test('changes a role from the row menu and the details drawer', async ({ page }) => {
  const person = await createThrowaway('owner', 'Riley Tester');
  const { end } = await adminSession(page);
  try {
    await openUsers(page);
    const menuButton = page.getByRole('button', { name: 'Actions for Riley Tester' });
    await menuButton.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Actions for Riley Tester' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Owner' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(menuButton).toBeFocused();

    // Owner -> waiter needs no confirmation.
    await menuButton.click();
    await menu.getByRole('menuitemradio', { name: 'Waiter' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Riley is now a waiter.' })).toBeVisible();
    await expect.poll(async () => (await service.from('profiles').select('role').eq('id', person.id).single()).data.role).toBe('waiter');

    // Promotion to admin asks first, inline.
    await rowButton(page, person.name, person.email).click();
    const drawer = page.getByRole('dialog', { name: person.name });
    await drawer.getByRole('radio', { name: 'Admin' }).click();
    await expect(drawer.getByText('Make Riley an admin?')).toBeVisible();
    await drawer.getByRole('button', { name: 'Make admin' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Riley is now an admin.' })).toBeVisible();
    await expect(drawer.getByRole('radio', { name: 'Admin' })).toHaveAttribute('aria-checked', 'true');
    const { data: { user } } = await service.auth.admin.getUserById(person.id);
    expect(user.app_metadata.role).toBe('admin');

    // Demotion asks for confirmation too.
    await drawer.getByRole('radio', { name: 'Owner' }).click();
    await expect(drawer.getByText('Remove admin access from Riley?')).toBeVisible();
    await drawer.getByRole('button', { name: 'Make owner' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Riley is now an owner.' })).toBeVisible();
    await expect.poll(async () => (await service.from('profiles').select('role').eq('id', person.id).single()).data.role).toBe('owner');
  } finally {
    await cleanup([person.email]);
    await end();
  }
});

test('suspends and reactivates a user with an inline confirmation', async ({ page }) => {
  const person = await createThrowaway('waiter', 'Sam Tester');
  const { end } = await adminSession(page);
  try {
    await openUsers(page);
    await page.getByRole('button', { name: 'Actions for Sam Tester' }).click();
    await page.getByRole('menuitem', { name: /Suspend/ }).click();
    const drawer = page.getByRole('dialog', { name: person.name });
    const confirm = drawer.getByRole('alertdialog', { name: 'Suspend Sam?' });
    await expect(confirm).toContainText('will be signed out and can’t sign in until you reactivate the account');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).not.toBeVisible();
    await drawer.getByRole('button', { name: 'Suspend', exact: true }).click();
    await drawer.getByRole('button', { name: 'Suspend Sam' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sam is suspended and can’t sign in.' })).toBeVisible();
    await expect(drawer.getByText('Suspended', { exact: true }).first()).toBeVisible();
    let { data: { user } } = await service.auth.admin.getUserById(person.id);
    expect(Date.parse(user.banned_until)).toBeGreaterThan(Date.now());

    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /^Suspended/ }).click();
    await expect(rowButton(page, person.name, person.email)).toBeVisible();

    await rowButton(page, person.name, person.email).click();
    await drawer.getByRole('button', { name: 'Reactivate' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sam can sign in again.' })).toBeVisible();
    ({ data: { user } } = await service.auth.admin.getUserById(person.id));
    expect(!user.banned_until || Date.parse(user.banned_until) <= Date.now()).toBe(true);
  } finally {
    await cleanup([person.email]);
    await end();
  }
});

test('protects the primary admin in the UI and the API', async ({ page, request }) => {
  const { session, end } = await adminSession(page);
  try {
    await openUsers(page);
    const self = page.getByRole('row').filter({ hasText: env.SUPER_ADMIN_EMAIL.toLowerCase() });
    await self.getByRole('button', { name: /^Actions for/ }).click();
    const changeRole = page.getByRole('menuitem', { name: /Change role/ });
    await expect(changeRole).toHaveAttribute('aria-disabled', 'true');
    await expect(changeRole).toContainText('The primary admin always keeps admin access.');
    await expect(page.getByRole('menuitem', { name: /Suspend/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await self.getByRole('button', { name: /View details$/ }).click();
    const drawer = page.getByRole('dialog').filter({ hasText: 'You’re the primary admin.' });
    await expect(drawer.getByRole('button', { name: 'Suspend', exact: true })).toBeDisabled();
    await expect(drawer.getByRole('radio', { name: 'Owner' })).toBeDisabled();

    // The backend enforces the same rules.
    const me = await findUserByEmail(env.SUPER_ADMIN_EMAIL);
    const headers = { Authorization: `Bearer ${session.access_token}` };
    const demote = await request.patch(`/api/admin/users/${me.id}`, { headers, data: { role: 'owner' } });
    expect(demote.status()).toBe(403);
    const suspend = await request.post(`/api/admin/users/${me.id}/suspend`, { headers });
    expect(suspend.status()).toBe(403);
    expect((await suspend.json()).error).toMatch(/primary admin|your own account/i);
    const bad = await request.post('/api/admin/users/invite', { headers, data: { email: 'not-an-email', name: 'X', role: 'admin' } });
    expect(bad.status()).toBe(400);
  } finally { await end(); }
});

test('mobile shows stacked cards without horizontal scroll', async ({ page }) => {
  const { end } = await adminSession(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.locator('.u-cards')).toBeVisible();
    await expect(page.locator('table.u-table')).toHaveCount(0);
    await expect(rowButton(page, 'Owner', 'owner@gmail.com')).toBeVisible();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await rowButton(page, 'Owner', 'owner@gmail.com').click();
    const drawer = page.getByRole('dialog', { name: 'Owner' });
    const box = await drawer.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840);
  } finally { await end(); }
});
