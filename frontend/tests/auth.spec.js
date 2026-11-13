import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createAdmin, createDatabase, env } from '../../backend/scripts/clients.js';

const admin = createAdmin();
const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
const publicClient = () => createClient(env.SUPABASE_URL, publicKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function signIn(page, email, password = '12344321') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('private pages require sign-in and wrong passwords show an error', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, 'owner@gmail.com', 'wrong-password');
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  const email = page.getByLabel('Email', { exact: true });
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAttribute('aria-describedby', await page.getByRole('alert').getAttribute('id'));
  await email.fill('owner@example.com');
  await expect(page.getByRole('alert')).not.toBeVisible();
  await expect(email).not.toHaveAttribute('aria-invalid', 'true');
});

for (const [role, name, color] of [
  ['owner', 'Owner', 'rgb(247, 247, 245)'],
  ['waiter', 'Waiter', 'rgb(247, 247, 245)'],
]) {
  test(`${role} login, route protection, refresh, and logout`, async ({ page }) => {
    await signIn(page, `${role}@gmail.com`);
    await expect(page).toHaveURL(new RegExp(`/${role}$`));
    const heading = role === 'owner' ? 'Overview' : 'Tables';
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (role === 'owner') await expect(page.getByText(`${role}@gmail.com`, { exact: true })).toBeVisible();
    await expect(page.locator('.page')).toHaveCSS('background-color', color);
    await page.goto('/admin');
    await expect(page).toHaveURL(new RegExp(`/${role}$`));
    await page.reload();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (role === 'owner') await page.getByRole('button', { name: 'Profile options' }).click();
    if (role === 'waiter') {
      await page.getByRole('button', { name: 'Open profile' }).click();
      await expect(page.getByRole('dialog', { name: 'Profile', exact: true }).getByText(`${role}@gmail.com`, { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto(`/${role}`);
    await expect(page).toHaveURL(/\/login$/);
  });
}

test('manually created reserved admin reaches the admin page', async ({ page }) => {
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: env.SUPER_ADMIN_EMAIL });
  if (linkError) throw new Error('Create and confirm the reserved admin account in Supabase Auth before running this test.');
  const client = publicClient();
  const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  expect(error).toBeNull();
  const storageKey = `sb-${new URL(env.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
  try {
    await page.addInitScript(({ key, session }) => { if (!sessionStorage.getItem('test-session-set')) {
      localStorage.setItem(key, JSON.stringify(session));
      sessionStorage.setItem('test-session-set', 'true');
    } }, { key: storageKey, session: data.session });
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(page.getByText(env.SUPER_ADMIN_EMAIL, { exact: true })).toBeVisible();
    await expect(page.locator('.page')).toHaveCSS('background-color', 'rgb(247, 247, 245)');
    await page.getByRole('button', { name: 'Profile options' }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally { await client.auth.signOut({ scope: 'local' }); }
});

test('profiles are private and users cannot grant themselves admin', async () => {
  const client = publicClient();
  expect((await client.from('profiles').select('*')).error).not.toBeNull();
  const { data: login, error } = await client.auth.signInWithPassword({ email: 'owner@gmail.com', password: '12344321' });
  expect(error).toBeNull();
  const original = login.user.user_metadata;
  try {
    const { data: profiles, error: readError } = await client.from('profiles').select('id, role');
    expect(readError).toBeNull();
    expect(profiles).toEqual([{ id: login.user.id, role: 'owner' }]);
    expect((await client.from('profiles').update({ role: 'admin' }).eq('id', login.user.id)).error).not.toBeNull();
    const { error: metadataError } = await client.auth.updateUser({ data: { ...original, role: 'admin' } });
    expect(metadataError).toBeNull();
    const { data: profile } = await client.from('profiles').select('role').single();
    expect(profile.role).toBe('owner');
  } finally {
    await client.auth.updateUser({ data: { ...original, role: original.role ?? null } });
    await client.auth.signOut({ scope: 'local' });
  }
});

test('API rejects missing and invalid tokens', async ({ request }) => {
  expect((await request.get('/api/me')).status()).toBe(401);
  expect((await request.get('/api/me', { headers: { Authorization: 'Bearer invalid' } })).status()).toBe(401);
});

test('forgot-password requests the right redirect and handles send failures', async ({ page }) => {
  let body;
  let redirect;
  await page.route('**/auth/v1/recover**', async (route) => {
    body = route.request().postDataJSON();
    redirect = new URL(route.request().url()).searchParams.get('redirect_to');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/forgot-password');
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
  expect(body.email).toBe('owner@gmail.com');
  expect(redirect).toBe('http://localhost:5173/reset-password');
  await page.unroute('**/auth/v1/recover**');
  await page.route('**/auth/v1/recover**', (route) => route.fulfill({
    status: 429, contentType: 'application/json', body: JSON.stringify({ msg: 'Rate limit exceeded', code: 'over_email_send_rate_limit' }),
  }));
  await page.reload();
  await page.getByLabel('Email', { exact: true }).fill('owner@gmail.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not send a reset link');
});

test('missing recovery links offer a new link', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: 'Request a new link' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Send a new reset link' })).toHaveAttribute('href', '/forgot-password');
});

test('real recovery session changes the password and signs out', async ({ page }) => {
  const { data: users } = await admin.auth.admin.listUsers();
  const waiter = users.users.find((user) => user.email === 'waiter@gmail.com');
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: waiter.email,
    options: { redirectTo: 'http://localhost:5173/reset-password' } });
  expect(error).toBeNull();
  const verified = await fetch(data.properties.action_link, { redirect: 'manual' });
  const location = new URL(verified.headers.get('location'));
  expect(location.origin + location.pathname).toBe('http://localhost:5173/reset-password');
  // Inject via the page so failures never print a recovery token in a goto log.
  try {
    await page.goto('/login');
    await page.evaluate((hash) => { window.location.href = `/reset-password${hash}`; }, location.hash);
    await expect(page.getByRole('heading', { name: 'Reset password', exact: true })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('UpdatedPassword123!');
    await page.getByLabel('Confirm password', { exact: true }).fill('DifferentPassword123!');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
    await page.getByLabel('Confirm password', { exact: true }).fill('UpdatedPassword123!');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('heading', { name: 'Password updated', exact: true })).toBeVisible();
    await signIn(page, 'waiter@gmail.com', 'UpdatedPassword123!');
    await expect(page).toHaveURL(/\/waiter$/);
    await page.getByRole('button', { name: 'Open profile' }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    const { error: restoreError } = await admin.auth.admin.updateUserById(waiter.id, { password: '12344321' });
    if (restoreError) throw new Error('Could not restore the seeded waiter password.');
  }
});

test('database roles, private trigger, and reserved admin are protected', async () => {
  const db = createDatabase();
  try {
    await db.connect();
    const { rows: [state] } = await db.query(`select
      (select p.role from public.profiles p join auth.users u on u.id = p.id
        where lower(u.email) = (select email from private.admin_account where singleton)) as primary_admin_role,
      (select email from private.admin_account where singleton) as admin_email,
      has_table_privilege('authenticated','public.profiles','UPDATE') as can_update_roles,
      has_table_privilege('authenticated','private.admin_account','SELECT') as can_read_admin_account,
      has_function_privilege('authenticated','private.handle_new_auth_user()','EXECUTE') as can_call_trigger,
      has_function_privilege('authenticated','public.primary_admin_email()','EXECUTE') as can_read_primary_admin,
      (select relrowsecurity from pg_class where oid='public.profiles'::regclass) as rls`);
    // Several admins are allowed (migration 001); the reserved primary admin always stays admin.
    // Authenticated users may use the private schema only for RLS membership helpers (migration 002).
    expect(state).toEqual({ primary_admin_role: 'admin', admin_email: env.SUPER_ADMIN_EMAIL, can_update_roles: false,
      can_read_admin_account: false, can_call_trigger: false, can_read_primary_admin: false, rls: true });
    // The pooler terminates TLS; pg_stat_ssl describes its internal DB hop.
    expect(db.connection.stream.encrypted).toBe(true);
    expect(db.connection.stream.authorized).toBe(true);
  } finally { await db.end(); }
});

test('mobile forms fit the screen and labels remain readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/login', '/forgot-password', '/reset-password']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
