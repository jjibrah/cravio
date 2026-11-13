import { createAdmin } from './clients.js';
import { createRestaurantForOwner, isMissingSchema } from '../src/lib/restaurants.js';
import { seedDemoActivity } from './demo-activity.js';

const supabase = createAdmin();
const accounts = [
  { email: 'owner@gmail.com', name: 'Owner', role: 'owner' },
  { email: 'waiter@gmail.com', name: 'Waiter', role: 'waiter' },
  { email: 'onboarding@gmail.com', name: 'New Owner', role: 'owner' },
];

const existing = [];
for (let page = 1; ; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  existing.push(...data.users);
  if (data.users.length < 100) break;
}

const ids = {};
for (const account of accounts) {
  const attributes = {
    email: account.email,
    password: '12344321',
    email_confirm: true,
    user_metadata: { name: account.name },
    app_metadata: { role: account.role },
  };
  const user = existing.find((user) => user.email?.toLowerCase() === account.email);
  const { data, error } = user
    ? await supabase.auth.admin.updateUserById(user.id, attributes)
    : await supabase.auth.admin.createUser(attributes);
  if (error) throw new Error(`Could not seed ${account.email}: ${error.message}`);
  const { error: writeError } = await supabase.from('profiles').upsert({
    id: data.user.id, name: account.name, role: account.role,
  });
  if (writeError) throw new Error(`Could not assign ${account.role}: ${writeError.message}`);
  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('name, role').eq('id', data.user.id).single();
  if (profileError || profile?.role !== account.role) throw new Error(`Profile creation failed for ${account.email}.`);
  ids[account.email] = data.user.id;
  console.log(`Ready: ${account.role} (${account.email})`);
}

const must = (result, what) => { if (result.error) throw new Error(`${what}: ${result.error.message}`); return result.data; };
const everyDay = { preset: 'everyday', days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: true, from: '08:00', to: '22:00' }])) };

// owner@gmail.com owns a live demo restaurant, so the existing owner tests land on the dashboard.
const demo = await createRestaurantForOwner(supabase, { ownerId: ids['owner@gmail.com'], name: 'Demo Restaurant' });
must(await supabase.from('restaurants').update({
  name: 'Demo Restaurant', kind: 'restaurant', area: 'Westlands, Nairobi', opening_hours: everyDay,
  phone: '+254712345678', theme: 'classic', status: 'live', went_live_at: new Date().toISOString(),
}).eq('id', demo.id), 'Demo restaurant details');
must(await supabase.from('restaurant_tables').upsert(
  Array.from({ length: 12 }, (_, index) => ({ restaurant_id: demo.id, number: index + 1 })),
  { onConflict: 'restaurant_id,number', ignoreDuplicates: true },
), 'Demo tables');
let [mains] = must(await supabase.from('menu_categories').select('id').eq('restaurant_id', demo.id).ilike('name', 'mains'), 'Demo category');
mains ||= must(await supabase.from('menu_categories').insert({ restaurant_id: demo.id, name: 'Mains', position: 0 }).select('id').single(), 'Demo category');
const [dish] = must(await supabase.from('menu_items').select('id').eq('category_id', mains.id).eq('name', 'Nyama choma'), 'Demo item');
if (!dish) must(await supabase.from('menu_items').insert({ restaurant_id: demo.id, category_id: mains.id, name: 'Nyama choma', price: 950, position: 0 }), 'Demo item');
must(await supabase.from('onboarding_progress').upsert({
  restaurant_id: demo.id, current_step: 'done',
  completed_steps: ['name', 'kind', 'location', 'hours', 'phone', 'tables', 'sections', 'menu-method', 'categories', 'items', 'theme', 'preview'],
  skipped_steps: ['logo', 'staff', 'cover'], data: { menuMethod: 'manual', tourCompleted: true },
}, { onConflict: 'restaurant_id' }), 'Demo progress');
console.log(`Ready: Demo Restaurant (live, ${demo.id})`);

// waiter@gmail.com works at the demo restaurant.
must(await supabase.from('restaurant_members').upsert(
  { restaurant_id: demo.id, user_id: ids['waiter@gmail.com'], role: 'waiter' }, { onConflict: 'restaurant_id,user_id' },
), 'Waiter membership');
console.log('Ready: waiter@gmail.com is a waiter at Demo Restaurant');

// onboarding@gmail.com starts onboarding from scratch every time this runs.
const fresh = await createRestaurantForOwner(supabase, { ownerId: ids['onboarding@gmail.com'], name: 'Mama Oliech’s' });
for (const table of ['menu_items', 'menu_categories', 'restaurant_tables', 'restaurant_sections', 'staff_invites']) {
  must(await supabase.from(table).delete().eq('restaurant_id', fresh.id), `Reset ${table}`);
}
must(await supabase.from('restaurant_members').delete().eq('restaurant_id', fresh.id).neq('user_id', ids['onboarding@gmail.com']), 'Reset members');
must(await supabase.from('restaurants').update({
  name: 'Mama Oliech’s', kind: null, area: null, address: null, lat: null, lng: null, opening_hours: null, phone: null,
  logo_url: null, cover_url: null, theme: 'classic', status: 'onboarding', went_live_at: null,
}).eq('id', fresh.id), 'Reset onboarding restaurant');
must(await supabase.from('onboarding_progress').upsert({
  restaurant_id: fresh.id, current_step: null, completed_steps: [], skipped_steps: [], data: {},
}, { onConflict: 'restaurant_id' }), 'Reset onboarding progress');
console.log(`Ready: Mama Oliech’s (onboarding, ${fresh.id})`);

// Demo Restaurant only: sections, 12 tables, a Kenyan menu, and 90 days of orders, payments, guest requests
// and menu scans, regenerated relative to now. Needs migration 003; without it the accounts above are still ready.
// With migration 004 it also seeds pairings, extras, featured dishes, deals and menu events.
try {
  const summary = await seedDemoActivity(supabase, demo.id, { ownerId: ids['owner@gmail.com'], waiterId: ids['waiter@gmail.com'] });
  console.log(`Ready: Demo Restaurant activity: ${summary.tables} tables, ${summary.items} menu items (${summary.soldOut} sold out), `
    + `${summary.orders} orders (${summary.live} live), ${summary.payments} payments, ${summary.openRequests} open guest requests, ${summary.scans} menu scans.`);
  if (summary.merch) {
    console.log(`Ready: Demo Restaurant merchandising: ${summary.merch.pairings} pairings, ${summary.merch.extras} extras, `
      + `${summary.merch.featured} featured dishes, ${summary.merch.deals} deals, ${summary.merch.events} menu events over ${summary.days} days.`);
  } else {
    console.log('Skipped pairings, extras, featured dishes, deals and menu events: apply migration 004, then run npm run db:seed again.');
  }
  if (summary.cartCode) console.log(`Demo: ${summary.readyCarts} guest cart(s) ready to order; table 6 has code ${summary.cartCode} (valid for 2 hours).`);
} catch (error) {
  if (isMissingSchema(error) || /orders|service_requests|menu_scans|guest_carts|payments/.test(error.message) && /schema cache|does not exist/.test(error.message)) {
    console.warn('Skipped Demo Restaurant activity: apply migration 003 (npm run db:migrate), then run npm run db:seed again.');
  } else {
    throw error;
  }
}
