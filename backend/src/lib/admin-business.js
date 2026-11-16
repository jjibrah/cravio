// Platform admin view of businesses (migration 008/009). Callers must have checked requireRole('admin').
// The admin sees structure, people and counts; not individual orders, guest requests or stock records
// (those stay with the business, see docs/v2/IMPLEMENTATION-PLAN.md › Platform admin).
// Every change here is written to public.access_events with the admin as actor.
import { HttpError } from './http.js';
import { isId } from './business.js';

const needId = (value, label) => { if (!isId(value)) throw new HttpError(400, `${label} is invalid.`); return value.toLowerCase(); };
const TZ = 'Africa/Nairobi';
const SINCE_30 = `now() - interval '30 days'`;

async function hasStock(db) {
  return (await db.query(`select to_regclass('public.stock_items') is not null as ok`)).rows[0].ok;
}

async function audit(db, { businessId, restaurantId = null, actorId, subjectId = null, action, detail = {} }) {
  await db.query(`insert into public.access_events (business_id, restaurant_id, actor_id, subject_id, action, detail)
    values ($1, $2, $3, $4, $5, $6)`, [businessId, restaurantId, actorId, subjectId, action, JSON.stringify({ ...detail, by: 'platform_admin' })]);
}

/** Per-branch figures: last-30-day orders and paid sales, tables, dishes, staff, latest order. */
async function branchFigures(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`
    select r.id,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status <> 'cancelled' and o.created_at > ${SINCE_30})::int as orders30,
      (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = r.id and o.status = 'paid' and o.paid_at > ${SINCE_30})::float as paid30,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status <> 'cancelled'
         and o.created_at >= date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}')::int as orders_today,
      (select max(o.created_at) from public.orders o where o.restaurant_id = r.id) as last_order_at,
      (select count(*) from public.restaurant_tables t where t.restaurant_id = r.id)::int as tables,
      (select count(*) from public.menu_items i where i.restaurant_id = r.id)::int as dishes,
      (select count(*) from public.restaurant_members m where m.restaurant_id = r.id)::int as staff
    from public.restaurants r where r.id = any($1::uuid[])`, [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

async function stockCounts(db, businessIds) {
  if (!businessIds.length || !(await hasStock(db))) return null;
  const { rows } = await db.query(`
    select b.id,
      (select count(*) from public.stock_items i where i.business_id = b.id)::int as items,
      (select count(*) from public.menu_item_stock s join public.restaurants r on r.id = s.restaurant_id where r.business_id = b.id)::int as tracked_dishes,
      (select count(*) from public.stock_balances x join public.stock_locations l on l.id = x.location_id where l.business_id = b.id and l.kind = 'branch' and x.on_hand <= 0)::int as out,
      (select count(*) from public.stock_requests q where q.business_id = b.id and q.status = 'submitted')::int as requests_waiting,
      (select count(*) from public.stock_transfers t where t.business_id = b.id and t.status = 'in_transit')::int as in_transit,
      (select count(*) from public.stock_transfers t where t.business_id = b.id and t.status = 'received' and t.received_at > ${SINCE_30}
         and exists (select 1 from public.stock_transfer_lines l where l.transfer_id = t.id and l.received < l.quantity))::int as short_deliveries
    from public.businesses b where b.id = any($1::uuid[])`, [businessIds]);
  return new Map(rows.map((row) => [row.id, {
    items: row.items, trackedDishes: row.tracked_dishes, out: row.out, requestsWaiting: row.requests_waiting,
    inTransit: row.in_transit, shortDeliveries30d: row.short_deliveries,
  }]));
}

const person = (row) => ({ userId: row.user_id, name: row.name || row.email || 'Account', email: row.email || null });

/** Every business with its branches, owners and headline figures. */
export async function listBusinesses(db) {
  const [{ rows: businesses }, { rows: branches }, { rows: grants }] = await Promise.all([
    db.query('select id, name, created_at from public.businesses order by name'),
    db.query('select id, name, status, area, address, business_id, created_at, went_live_at from public.restaurants order by name'),
    db.query(`select m.business_id, m.user_id, m.role, p.name, u.email from public.business_members m
      left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id order by p.name`),
  ]);
  const [figures, stock] = await Promise.all([branchFigures(db, branches.map((b) => b.id)), stockCounts(db, businesses.map((b) => b.id))]);
  const rows = businesses.map((business) => {
    const own = branches.filter((b) => b.business_id === business.id);
    const f = own.map((b) => figures.get(b.id));
    const status = own.some((b) => b.status === 'live') ? 'live' : own.length ? 'onboarding' : 'empty';
    return {
      id: business.id, name: business.name, createdAt: business.created_at, status,
      owners: grants.filter((g) => g.business_id === business.id && g.role === 'owner').map(person),
      operations: grants.filter((g) => g.business_id === business.id && g.role === 'operations').length,
      branches: own.map((b) => ({ id: b.id, name: b.name, status: b.status, location: b.area || b.address?.split(',')[0] || '' })),
      staff: f.reduce((sum, x) => sum + (x?.staff || 0), 0),
      orders30d: f.reduce((sum, x) => sum + (x?.orders30 || 0), 0),
      paid30d: Math.round(f.reduce((sum, x) => sum + (x?.paid30 || 0), 0) * 100) / 100,
      lastOrderAt: f.reduce((latest, x) => (x?.last_order_at && (!latest || x.last_order_at > latest) ? x.last_order_at : latest), null),
      stock: stock?.get(business.id) || null,
    };
  });
  const counts = { all: rows.length, live: rows.filter((r) => r.status === 'live').length, onboarding: rows.filter((r) => r.status === 'onboarding').length,
    noOwner: rows.filter((r) => !r.owners.length).length, branches: branches.length };
  return { businesses: rows, counts, stockAvailable: Boolean(stock), currency: 'KES' };
}

async function requireBusiness(db, id) {
  const { rows } = await db.query('select id, name, created_at from public.businesses where id = $1', [needId(id, 'Business')]);
  if (!rows[0]) throw new HttpError(404, 'That business doesn’t exist.');
  return rows[0];
}

/** One business: branches with figures and staff, access, inventory health (counts only), access history. */
export async function businessDetail(db, id) {
  const business = await requireBusiness(db, id);
  const [{ rows: branches }, { rows: grants }, { rows: assigned }] = await Promise.all([
    db.query('select id, name, status, area, address, created_at, went_live_at from public.restaurants where business_id = $1 order by name', [business.id]),
    db.query(`select m.user_id, m.role, m.created_at, p.name, u.email, u.last_sign_in_at from public.business_members m
      left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.business_id = $1 order by m.role desc, p.name`, [business.id]),
    db.query('select user_id, restaurant_id from public.business_member_branches where business_id = $1', [business.id]),
  ]);
  const ids = branches.map((b) => b.id);
  const [figures, stock, { rows: staff }, history] = await Promise.all([
    branchFigures(db, ids),
    stockCounts(db, [business.id]),
    db.query(`select m.restaurant_id, m.user_id, m.role, p.name, u.email, u.last_sign_in_at from public.restaurant_members m
      left join public.profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id
      where m.restaurant_id = any($1::uuid[]) order by m.role, p.name`, [ids]),
    activity(db, { businessId: business.id, limit: 30 }),
  ]);
  return {
    id: business.id, name: business.name, createdAt: business.created_at,
    branches: branches.map((b) => {
      const f = figures.get(b.id) || {};
      return {
        id: b.id, name: b.name, status: b.status, location: b.area || b.address?.split(',')[0] || '', createdAt: b.created_at, wentLiveAt: b.went_live_at,
        ordersToday: f.orders_today || 0, orders30d: f.orders30 || 0, paid30d: Math.round((f.paid30 || 0) * 100) / 100, lastOrderAt: f.last_order_at || null,
        tables: f.tables || 0, dishes: f.dishes || 0,
        staff: staff.filter((s) => s.restaurant_id === b.id).map((s) => ({ ...person(s), role: s.role === 'waiter' ? 'waiter' : 'manager', lastSignInAt: s.last_sign_in_at })),
      };
    }),
    access: grants.map((g) => ({ ...person(g), role: g.role, since: g.created_at, lastSignInAt: g.last_sign_in_at,
      branchIds: g.role === 'owner' ? null : assigned.filter((a) => a.user_id === g.user_id).map((a) => a.restaurant_id) })),
    stock: stock?.get(business.id) || null,
    history,
  };
}

/** Make an existing account a business owner (sees and manages every branch). */
export async function grantOwner(db, adminId, businessId, userId) {
  const business = await requireBusiness(db, businessId);
  const subject = needId(userId, 'Account');
  const { rows: profile } = await db.query('select role from public.profiles where id = $1', [subject]);
  if (!profile[0]) throw new HttpError(404, 'That account doesn’t exist.');
  if (profile[0].role === 'admin') throw new HttpError(400, 'Platform admins can’t own a business. Use a separate account.');
  const { rows: current } = await db.query('select role from public.business_members where business_id = $1 and user_id = $2', [business.id, subject]);
  if (current[0]?.role === 'owner') throw new HttpError(409, 'They already own this business.');
  await db.query(`insert into public.business_members (business_id, user_id, role, granted_by) values ($1, $2, 'owner', $3)
    on conflict (business_id, user_id) do update set role = 'owner', granted_by = excluded.granted_by`, [business.id, subject, adminId]);
  await db.query('delete from public.business_member_branches where business_id = $1 and user_id = $2', [business.id, subject]);
  await audit(db, { businessId: business.id, actorId: adminId, subjectId: subject, action: 'business_grant', detail: { role: 'owner', from: current[0]?.role || null } });
  return { userId: subject, role: 'owner' };
}

/** Remove someone's owner or operations access to a business. Their branch roles are not changed. */
export async function revokeAccess(db, adminId, businessId, userId) {
  const business = await requireBusiness(db, businessId);
  const subject = needId(userId, 'Account');
  const { rows } = await db.query('delete from public.business_members where business_id = $1 and user_id = $2 returning role', [business.id, subject]);
  if (!rows[0]) throw new HttpError(404, 'That account has no access to this business.');
  await audit(db, { businessId: business.id, actorId: adminId, subjectId: subject, action: 'business_revoke', detail: { role: rows[0].role } });
  return { userId: subject, removed: rows[0].role };
}

export async function renameBusiness(db, businessId, name) {
  const business = await requireBusiness(db, businessId);
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean) throw new HttpError(400, 'Enter the business name.');
  if (clean.length > 120) throw new HttpError(400, 'Keep the name under 120 characters.');
  await db.query('update public.businesses set name = $2 where id = $1', [business.id, clean]);
  return { id: business.id, name: clean };
}

/** Add a branch (in setup) owned by the business's first owner. The business needs an owner first. */
export async function addBranch(db, adminId, businessId, body = {}) {
  const business = await requireBusiness(db, businessId);
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(400, 'Enter the branch name.');
  if (name.length > 120) throw new HttpError(400, 'Keep the name under 120 characters.');
  const area = typeof body.area === 'string' && body.area.trim() ? body.area.trim().slice(0, 120) : null;
  const { rows: owners } = await db.query(`select user_id from public.business_members where business_id = $1 and role = 'owner' order by created_at limit 1`, [business.id]);
  if (!owners[0]) throw new HttpError(409, 'Add a business owner first: every branch belongs to an owner.');
  const { rows } = await db.query(`insert into public.restaurants (owner_id, name, area, business_id, owner_primary, status)
    values ($1, $2, $3, $4, false, 'onboarding') returning id, name, status`, [owners[0].user_id, name, area, business.id]);
  await db.query('insert into public.onboarding_progress (restaurant_id) values ($1) on conflict do nothing', [rows[0].id]);
  await audit(db, { businessId: business.id, restaurantId: rows[0].id, actorId: adminId, action: 'branch_create', detail: { name } });
  return rows[0];
}

const ACTION_TEXT = {
  business_grant: 'gave business access', business_revoke: 'removed business access', branch_assign: 'assigned a branch',
  branch_unassign: 'unassigned a branch', branch_create: 'added a branch', branch_member_add: 'added branch staff',
  branch_member_remove: 'removed branch staff', mapping_applied: 'applied a reviewed access mapping',
};

/** Access history, newest first, platform-wide or for one business. */
export async function activity(db, { businessId = null, limit = 100, before = null } = {}) {
  const params = [Math.min(Math.max(Number(limit) || 100, 1), 200)];
  const where = [];
  if (businessId) { params.push(needId(businessId, 'Business')); where.push(`e.business_id = $${params.length}`); }
  if (before) { params.push(Number(before)); where.push(`e.id < $${params.length}`); }
  const { rows } = await db.query(`
    select e.id, e.action, e.detail, e.created_at, e.business_id, b.name as business, e.restaurant_id, r.name as branch,
      e.actor_id, pa.name as actor, ua.email as actor_email, e.subject_id, ps.name as subject, us.email as subject_email
    from public.access_events e
    left join public.businesses b on b.id = e.business_id left join public.restaurants r on r.id = e.restaurant_id
    left join public.profiles pa on pa.id = e.actor_id left join auth.users ua on ua.id = e.actor_id
    left join public.profiles ps on ps.id = e.subject_id left join auth.users us on us.id = e.subject_id
    ${where.length ? `where ${where.join(' and ')}` : ''} order by e.id desc limit $1`, params);
  return rows.map((row) => ({
    id: Number(row.id), action: row.action, text: ACTION_TEXT[row.action] || row.action, at: row.created_at,
    business: row.business_id ? { id: row.business_id, name: row.business || 'Removed business' } : null,
    branch: row.restaurant_id ? { id: row.restaurant_id, name: row.branch || 'Removed branch' } : null,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor || row.actor_email || 'Account', email: row.actor_email } : { name: 'System' },
    subject: row.subject_id ? { id: row.subject_id, name: row.subject || row.subject_email || 'Account', email: row.subject_email } : null,
    role: row.detail?.role || null, viaAdmin: row.detail?.by === 'platform_admin',
  }));
}

/** user id → what they can reach: business grants and branch roles (for the Users page). */
export async function accessByUser(db) {
  const [{ rows: grants }, { rows: members }] = await Promise.all([
    db.query(`select m.user_id, m.role, b.id, b.name from public.business_members m join public.businesses b on b.id = m.business_id`),
    db.query(`select m.user_id, m.role, r.id, r.name from public.restaurant_members m join public.restaurants r on r.id = m.restaurant_id`),
  ]);
  const map = new Map();
  const entry = (id) => { if (!map.has(id)) map.set(id, { businesses: [], branches: [] }); return map.get(id); };
  for (const g of grants) entry(g.user_id).businesses.push({ id: g.id, name: g.name, role: g.role });
  for (const m of members) entry(m.user_id).branches.push({ id: m.id, name: m.name, role: m.role === 'waiter' ? 'waiter' : 'manager' });
  return map;
}
