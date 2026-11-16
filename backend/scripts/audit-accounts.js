// Read-only audit for the v2 role migration (docs/v2/MIGRATION-008.md).
// Lists accounts, profile roles, restaurant memberships, restaurants, staff invites and preview-inventory
// businesses so a person can review who is an actual business owner, branch manager, waiter or admin.
//
// It never writes: the whole session runs in a READ ONLY transaction that is rolled back.
// Usage: node backend/scripts/audit-accounts.js [--json] [--show-emails]
// Emails are masked unless --show-emails is passed. Do not commit the output: it contains personal data.
import { createDatabase } from './clients.js';

const json = process.argv.includes('--json');
const showEmails = process.argv.includes('--show-emails');
const mask = (email) => {
  if (!email || showEmails) return email;
  const [local, domain = ''] = email.split('@');
  return `${local.slice(0, 2)}…@${domain}`;
};

const db = createDatabase();
try {
  await db.connect();
  await db.query('begin transaction read only');
  const exists = async (name) => (await db.query('select to_regclass($1) is not null as ok', [name])).rows[0].ok;

  const users = (await db.query(`
    select u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until,
      u.raw_app_meta_data ->> 'role' as app_role, p.role as profile_role, p.name
    from auth.users u left join public.profiles p on p.id = u.id
    order by u.created_at`)).rows;
  const restaurants = (await db.query(`
    select r.id, r.name, r.status, r.owner_id, r.area, r.created_at,
      (select count(*) from public.restaurant_tables t where t.restaurant_id = r.id)::int as tables,
      (select count(*) from public.menu_items i where i.restaurant_id = r.id)::int as items,
      (select count(*) from public.orders o where o.restaurant_id = r.id)::int as orders
    from public.restaurants r order by r.created_at`)).rows;
  const members = (await db.query(`select restaurant_id, user_id, role, created_at from public.restaurant_members order by created_at`)).rows;
  const invites = (await db.query(`select restaurant_id, email, role, status, user_id from public.staff_invites order by created_at`)).rows;
  const stockBusinesses = await exists('private.stock_businesses')
    ? (await db.query(`select b.id, b.owner_id, b.name,
        (select count(*) from private.stock_locations l where l.business_id = b.id)::int as locations,
        (select count(*) from private.stock_products p where p.business_id = b.id)::int as products,
        (select count(*) from private.stock_movements m where m.business_id = b.id)::int as movements
      from private.stock_businesses b`)).rows : [];
  const v2 = await exists('public.businesses');

  const byUser = new Map(users.map((u) => [u.id, u]));
  const byRestaurant = new Map(restaurants.map((r) => [r.id, r]));
  const report = users.map((u) => {
    const memberships = members.filter((m) => m.user_id === u.id).map((m) => ({
      restaurantId: m.restaurant_id, restaurant: byRestaurant.get(m.restaurant_id)?.name, role: m.role,
      ownsRow: byRestaurant.get(m.restaurant_id)?.owner_id === u.id,
    }));
    const flags = [];
    if (u.profile_role === 'owner' && !memberships.length) flags.push('owner profile with no restaurant');
    if (u.profile_role === 'owner' && memberships.some((m) => m.role === 'manager')) flags.push('manager membership uses owner profile role');
    if (memberships.length > 1) flags.push('several restaurants');
    if (u.profile_role === 'waiter' && memberships.some((m) => m.role !== 'waiter')) flags.push('waiter profile with manager/owner membership');
    if (u.app_role && u.app_role !== u.profile_role) flags.push(`app_metadata role ${u.app_role} differs from profile`);
    if (u.banned_until && new Date(u.banned_until) > new Date()) flags.push('suspended');
    const stock = stockBusinesses.filter((b) => b.owner_id === u.id);
    if (stock.length) flags.push('has preview inventory business');
    return {
      id: u.id, email: mask(u.email), name: u.name, profileRole: u.profile_role, lastSignIn: u.last_sign_in_at,
      memberships, previewInventory: stock.map((b) => ({ id: b.id, name: b.name, locations: b.locations, products: b.products, movements: b.movements })),
      flags,
    };
  });
  const restaurantReport = restaurants.map((r) => ({
    id: r.id, name: r.name, status: r.status, area: r.area, ownerId: r.owner_id, ownerEmail: mask(byUser.get(r.owner_id)?.email),
    tables: r.tables, items: r.items, orders: r.orders,
    members: members.filter((m) => m.restaurant_id === r.id).map((m) => ({ userId: m.user_id, email: mask(byUser.get(m.user_id)?.email), role: m.role })),
    pendingInvites: invites.filter((i) => i.restaurant_id === r.id && !i.user_id).map((i) => ({ email: mask(i.email), role: i.role, status: i.status })),
  }));

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), v2SchemaPresent: v2, users: report, restaurants: restaurantReport }, null, 2));
  } else {
    console.log(`Accounts: ${users.length} · Restaurants: ${restaurants.length} · Memberships: ${members.length} · Preview inventory businesses: ${stockBusinesses.length} · v2 schema present: ${v2}\n`);
    console.log('RESTAURANTS');
    for (const r of restaurantReport) {
      console.log(`- ${r.name} [${r.status}] ${r.id}  tables=${r.tables} items=${r.items} orders=${r.orders}  owner_id→${r.ownerEmail || r.ownerId}`);
      for (const m of r.members) console.log(`    ${m.role.padEnd(8)} ${m.email || m.userId}`);
      for (const i of r.pendingInvites) console.log(`    invite   ${i.role.padEnd(8)} ${i.email} (${i.status})`);
    }
    console.log('\nACCOUNTS');
    for (const u of report) {
      const where = u.memberships.map((m) => `${m.role}@${m.restaurant}`).join(', ') || '—';
      console.log(`- ${u.email} profile=${u.profileRole ?? 'none'} memberships=${where}${u.flags.length ? `  ⚑ ${u.flags.join('; ')}` : ''}`);
    }
  }
  await db.query('rollback');
} catch (error) {
  console.error('Audit failed:', error.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
