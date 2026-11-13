import { test, expect } from '@playwright/test';
import { createAdmin } from '../../backend/scripts/clients.js';

// Needs migration 002 applied and `npm run db:seed` run once (creates onboarding@gmail.com).
const admin = createAdmin();
const EMAIL = 'onboarding@gmail.com';

/** Puts onboarding@gmail.com's restaurant back to a fresh 'onboarding' state, like the seed script. */
async function resetOnboardingOwner() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 100) break;
  }
  const user = users.find((u) => u.email?.toLowerCase() === EMAIL);
  if (!user) throw new Error(`Run npm run db:seed first: ${EMAIL} is missing.`);
  const { data: restaurant, error } = await admin.from('restaurants').select('id').eq('owner_id', user.id).single();
  if (error) throw new Error(`Run npm run db:seed first: ${EMAIL} has no restaurant (${error.message}).`);
  for (const table of ['menu_items', 'menu_categories', 'restaurant_tables', 'restaurant_sections', 'staff_invites']) {
    const { error: deleteError } = await admin.from(table).delete().eq('restaurant_id', restaurant.id);
    if (deleteError) throw deleteError;
  }
  const { error: updateError } = await admin.from('restaurants').update({
    name: 'Mama Oliech’s', kind: null, area: null, address: null, lat: null, lng: null, opening_hours: null, phone: null,
    logo_url: null, cover_url: null, theme: 'classic', status: 'onboarding', went_live_at: null,
  }).eq('id', restaurant.id);
  if (updateError) throw updateError;
  const { error: progressError } = await admin.from('onboarding_progress').upsert({
    restaurant_id: restaurant.id, current_step: null, completed_steps: [], skipped_steps: [], data: {},
  }, { onConflict: 'restaurant_id' });
  if (progressError) throw progressError;
  return restaurant.id;
}

async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('12344321');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const question = (page, name) => page.getByRole('heading', { level: 1, name });
const continueButton = (page) => page.getByRole('button', { name: /^Continue/ });

test.describe.configure({ mode: 'serial' });

test('a new owner onboards, resumes after reload, goes live, and sees the checklist and QR pack', async ({ page }) => {
  test.setTimeout(120000);
  const restaurantId = await resetOnboardingOwner();

  await signIn(page);
  await expect(page).toHaveURL(/\/onboarding\/name$/);
  const progress = page.getByRole('progressbar', { name: 'Setup progress' });
  await expect(progress).toHaveAttribute('aria-valuenow', '1');
  await expect(question(page, 'What’s your restaurant called?')).toBeFocused();

  // Required basics
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Mama Oliech’s');
  await page.getByLabel('Restaurant name').fill('Mama Oliech’s Test Kitchen');
  await page.getByLabel('Restaurant name').press('Enter');
  await expect(question(page, /What kind of place is Mama Oliech’s Test Kitchen/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0);
  await page.getByRole('radio', { name: /^Restaurant/ }).click();
  await continueButton(page).click();

  await expect(question(page, 'Where are you?')).toBeVisible();
  await expect(continueButton(page)).toBeDisabled();
  await page.getByLabel('Area').fill('Westlands, Nairobi');
  await continueButton(page).click();

  await expect(question(page, 'When are you open?')).toBeVisible();
  await page.getByRole('radio', { name: /Every day/ }).click();
  await continueButton(page).click();

  // Skippable step
  await expect(question(page, 'Add your logo')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(question(page, /What number can guests call/)).toBeVisible();
  await page.getByLabel('Phone number').fill('+254 7');
  await continueButton(page).click();
  await expect(page.getByText('Enter a number like +254 712 345 678.')).toBeVisible();
  await page.getByLabel('Phone number').fill('0712 345 678');
  await continueButton(page).click();

  // Tables, with encouragement after the basics
  await expect(question(page, 'How many tables do you have?')).toBeVisible();
  await expect(page.getByText(/Mama Oliech’s Test Kitchen is taking shape/)).toBeVisible();
  await page.getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: 'More tables' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Tables' })).toHaveValue('6');
  await continueButton(page).click();

  await expect(question(page, 'Do you have sections?')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(question(page, 'Who takes orders?')).toBeVisible();
  await page.getByRole('button', { name: 'I’ll add staff later' }).click();

  // Menu: template, categories, one item
  await expect(question(page, 'How do you want to add your menu?')).toBeVisible();
  await page.getByRole('radio', { name: /Start from a template/ }).click();
  await continueButton(page).click();
  await expect(question(page, /menu organised/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mains' })).toHaveAttribute('aria-checked', 'true');
  await continueButton(page).click();

  await expect(question(page, 'Add your dishes')).toBeVisible();
  await expect(continueButton(page)).toBeDisabled();
  await page.getByRole('checkbox', { name: /Pilau/ }).click();
  await page.getByLabel('Your price for Pilau').fill('480');
  await page.getByRole('button', { name: /Add 1 dish at these prices/ }).click();
  await expect(page.getByRole('list', { name: 'Mains items' }).getByText('Pilau', { exact: true })).toBeVisible();

  // Reload resumes the exact screen
  await page.reload();
  await expect(question(page, 'Add your dishes')).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\/items$/);
  await expect(page.getByRole('list', { name: 'Mains items' }).getByText('Ksh 480')).toBeVisible();
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/onboarding\/items$/);
  await continueButton(page).click();

  // Photos: cover banner and every dish laid out like the guest menu; skippable
  await expect(question(page, 'Make it look delicious')).toBeVisible();
  await expect(page.getByLabel('Add a cover photo')).toBeAttached();
  const dishes = page.getByRole('list', { name: 'Mains dishes' });
  await expect(dishes.getByText('Pilau', { exact: true })).toBeVisible();
  await expect(dishes.getByText('Ksh 480')).toBeVisible();
  await expect(dishes.getByLabel('Add a photo or video of Pilau')).toBeAttached();
  await expect(page.getByText('0 of 1 dish has a photo or video')).toBeVisible();
  await expect(continueButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Add photos later' }).click();

  await expect(question(page, 'Pick a look')).toBeVisible();
  await expect(page.getByText(/Looking delicious/)).toBeVisible();
  await expect(page.getByRole('radio', { name: /Classic/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: /Garden/ }).click();
  await continueButton(page).click();

  await expect(question(page, 'This is what guests see.')).toBeVisible();
  await page.getByRole('button', { name: /^Go live/ }).click();

  // Finish
  await expect(page).toHaveURL(/\/onboarding\/done$/);
  await expect(page.getByRole('heading', { name: /You’re live/ })).toBeVisible();
  await expect(page.getByText('No one invited yet.', { exact: false })).toBeVisible();

  const { data: live } = await admin.from('restaurants').select('status, theme').eq('id', restaurantId).single();
  expect(live).toEqual({ status: 'live', theme: 'garden' });

  // QR pack: one card per table, each encoding the guest menu URL
  await page.getByRole('link', { name: /Open QR pack/ }).click();
  await expect(page).toHaveURL(/\/onboarding\/qr$/);
  await expect(page.locator('.qr-card')).toHaveCount(6);
  await expect(page.getByRole('img', { name: 'QR code for table 6' })).toBeVisible();
  await expect(page.locator('.qr-card').first()).toContainText(`guest-menu?r=${restaurantId}&t=1`);
  await expect(page.getByRole('button', { name: /Print or save as PDF/ })).toBeEnabled();
  await page.goBack();

  // Dashboard: tour, then the checklist links back to skipped steps
  await page.getByRole('button', { name: /Take a quick tour/ }).click();
  await expect(page).toHaveURL(/\/owner\?tour=1$/);
  await expect(page.getByRole('dialog', { name: 'Everything lives here' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.getByRole('dialog', { name: 'Everything lives here' })).toHaveCount(0);

  // One call to action (dish photos come first), with the rest as a pipeline in the recommended order
  const setup = page.getByRole('region', { name: 'Finish setting up' });
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('heading', { level: 2, name: 'Add photos of your dishes' })).toBeVisible();
  await expect(setup.getByText('0 of 1 dish has a photo.')).toBeVisible();
  const pipeline = setup.getByRole('list', { name: 'Setup steps, 1 of 7 done' });
  await expect(pipeline.getByRole('listitem')).toHaveCount(7);
  await expect(pipeline.getByRole('listitem')).toContainText(['Dish photos', 'Cover photo', 'Logo', 'Contact', 'Staff', 'Sections', 'Tour']);
  await expect(pipeline.locator('[aria-current="step"]')).toContainText('Dish photos');
  await expect(pipeline.getByRole('listitem').nth(3)).toContainText('done');
  await expect(setup.getByRole('link', { name: /^Add dish photos/ })).toHaveCount(1);

  await setup.getByRole('link', { name: /^Add dish photos/ }).click();
  await expect(page).toHaveURL(/\/onboarding\/photos$/);
  await expect(question(page, 'Make it look delicious')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Done/ })).toBeEnabled();
  await page.getByRole('link', { name: 'Save & exit' }).click();
  await expect(page).toHaveURL(/\/owner$/);

  await setup.getByRole('link', { name: /^Logo/ }).click();
  await expect(page).toHaveURL(/\/onboarding\/logo$/);
  await expect(question(page, 'Add your logo')).toBeVisible();
  await page.getByRole('link', { name: 'Save & exit' }).click();
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});

test('when everything is done, the overview shows a dismissible success note that stays dismissed', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/owner/);
  // Pretend every setup task is done; progress (incl. the dismissal) still comes from the real server.
  await page.route('**/api/restaurant/onboarding', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    const photo = 'https://example.invalid/p.jpg';
    state.restaurant = { ...state.restaurant, logoUrl: photo, coverUrl: photo, phone: '+254712345678' };
    state.items = state.items.map((item) => ({ ...item, photoUrl: photo }));
    state.sections = [{ id: 's', name: 'Indoor', position: 0 }];
    state.invites = [{ id: 'v', name: 'Amina', email: 'amina@example.com', status: 'sent' }];
    state.progress = { ...state.progress, data: { ...state.progress.data, tourCompleted: true } };
    await route.fulfill({ response, json: state });
  });
  await page.goto('/owner');
  const setup = page.getByRole('region', { name: 'Setup complete' });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('7 of 7 done');
  const saved = page.waitForRequest((request) => request.url().endsWith('/api/restaurant/onboarding/progress') && request.method() === 'PUT');
  await setup.getByRole('button', { name: 'Dismiss setup complete' }).click();
  expect((await saved).postDataJSON()).toEqual({ data: { checklistDismissed: true } });
  await expect(setup).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.locator('#finish-setup')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('an owner saved on the old cover step resumes on the photos step', async ({ page }) => {
  const restaurantId = await resetOnboardingOwner();
  const { error } = await admin.from('onboarding_progress').update({ current_step: 'cover' }).eq('restaurant_id', restaurantId);
  if (error) throw error;
  await signIn(page);
  await expect(page).toHaveURL(/\/onboarding\/photos$/);
  await expect(question(page, 'Make it look delicious')).toBeVisible();
  await page.goto('/onboarding/cover');
  await expect(page).toHaveURL(/\/onboarding\/photos$/);
});

test('the API rejects skipping a required step and going live early', async ({ page }) => {
  await resetOnboardingOwner();
  await signIn(page);
  await expect(page).toHaveURL(/\/onboarding\/name$/);
  const result = await page.evaluate(async () => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'));
    const token = JSON.parse(localStorage.getItem(key)).access_token;
    const call = (path, body) => fetch(path, { method: body ? 'PUT' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    return {
      skip: await call('/api/restaurant/onboarding/progress', { skip: 'tables' }),
      skipPhotos: await call('/api/restaurant/onboarding/progress', { skip: 'photos', currentStep: 'theme' }),
      unknown: await call('/api/restaurant/onboarding/progress', { currentStep: 'nope' }),
      live: await call('/api/restaurant/go-live'),
    };
  });
  expect(result.skip.status).toBe(400);
  expect(result.skipPhotos.status).toBe(200);
  expect(result.skipPhotos.body.progress.skippedSteps).toContain('photos');
  expect(result.unknown.status).toBe(400);
  expect(result.live.status).toBe(400);
  expect(result.live.body.details.missing.map((m) => m.step)).toEqual(expect.arrayContaining(['location', 'hours', 'tables', 'items']));
});
