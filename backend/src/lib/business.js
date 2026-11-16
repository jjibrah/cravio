// Owner / operations-manager data (migration 008). Every function takes `db` (anything with
// query(sql, params) -> { rows }) and the acting user's id, and checks the actor's business grant in SQL
// before reading or writing. Routes never pass branch or business ids through without these checks.
//
// Powers (recommendation pending D02, see docs/v2/DECISIONS.md):
//   business owner     – sees every branch of the business; creates branches; grants/revokes operations access
//                        and assigns branches; adds branch staff.
//   operations manager – sees only assigned branches (overview, detail, people at those branches). No grants.
// Business-owner grants themselves are never created here: they come from the reviewed mapping or platform admin.
import { HttpError } from './http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value) => typeof value === 'string' && UUID_RE.test(value);
const needId = (value, label) => { if (!isId(value)) throw new HttpError(400, `${label} is invalid.`); return value.toLowerCase(); };

/** Branches the actor oversees, with their business and the actor's business role. */
export async function oversight(db, actorId) {
  const { rows } = await db.query(`
    select r.id, r.name, r.status, r.area, r.address, r.business_id, b.name as business_name, m.role as business_role
    from public.business_members m
    join public.businesses b on b.id = m.business_id
    join public.restaurants r on r.business_id = m.business_id
    where m.user_id = $1 and (m.role = 'owner' or exists (
      select 1 from public.business_member_branches x where x.user_id = m.user_id and x.restaurant_id = r.id))
    order by b.name, r.name`, [actorId]);
  return rows;
}

async function businessRole(db, actorId, businessId) {
  const { rows } = await db.query('select role from public.business_members where business_id = $1 and user_id = $2', [businessId, actorId]);
  return rows[0]?.role || null;
}

async function requireOwner(db, actorId, businessId) {
  const role = await businessRole(db, actorId, needId(businessId, 'Business'));
  if (role !== 'owner') throw new HttpError(403, 'Only the business owner can do this.');
  return businessId.toLowerCase();
}

/** The branch if the actor oversees it, else 404 (no existence leak across businesses). */
export async function requireOverseen(db, actorId, branchId) {
  const id = needId(branchId, 'Branch');
  const branch = (await oversight(db, actorId)).find((row) => row.id === id);
  if (!branch) throw new HttpError(404, 'That branch isn’t in your businesses.');
  return branch;
}

const NAIROBI_DAY = `date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'`;

/** Today's recorded activity per branch id: orders (not cancelled), paid sales, open requests, last order. */
async function activity(db, branchIds) {
  if (!branchIds.length) return new Map();
  const { rows } = await db.query(`
    select r.id,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.created_at >= ${NAIROBI_DAY} and o.status <> 'cancelled')::int as orders_today,
      (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = r.id and o.status = 'paid' and o.paid_at >= ${NAIROBI_DAY})::numeric(12,2)::text as paid_today,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status in ('taken', 'accepted', 'served'))::int as open_orders,
      (select count(*) from public.service_requests s where s.restaurant_id = r.id and s.status in ('open', 'acknowledged'))::int as open_requests,
      (select max(o.created_at) from public.orders o where o.restaurant_id = r.id) as last_order_at,
      (select count(*) from public.restaurant_tables t where t.restaurant_id = r.id)::int as tables,
      (select count(*) from public.menu_items i where i.restaurant_id = r.id)::int as items,
      (select count(*) from public.menu_items i where i.restaurant_id = r.id and not i.available)::int as sold_out
    from public.restaurants r where r.id = any($1::uuid[])`, [branchIds]);
  return new Map(rows.map((row) => [row.id, row]));
}

const branchOut = (row, stats, membership) => ({
  id: row.id, name: row.name, status: row.status, location: row.area || row.address?.split(',')[0] || '',
  businessId: row.business_id,
  canOpenWorkspace: Boolean(membership && ['owner', 'manager'].includes(membership)),
  today: stats ? {
    orders: stats.orders_today, paidSales: Number(stats.paid_today), openOrders: stats.open_orders,
    openRequests: stats.open_requests, lastOrderAt: stats.last_order_at ? new Date(stats.last_order_at).toISOString() : null,
  } : null,
  setup: stats ? { tables: stats.tables, items: stats.items, soldOut: stats.sold_out } : null,
});

async function ownMemberships(db, actorId, branchIds) {
  if (!branchIds.length) return new Map();
  const { rows } = await db.query('select restaurant_id, role from public.restaurant_members where user_id = $1 and restaurant_id = any($2::uuid[])', [actorId, branchIds]);
  return new Map(rows.map((row) => [row.restaurant_id, row.role]));
}

/** Owner home: businesses the actor holds a grant in, with their overseen branches and today's activity. */
export async function overview(db, actorId) {
  const branches = await oversight(db, actorId);
  const ids = branches.map((row) => row.id);
  const [stats, mine] = await Promise.all([activity(db, ids), ownMemberships(db, actorId, ids)]);
  const { rows: grants } = await db.query(`
    select m.business_id, m.role, b.name from public.business_members m join public.businesses b on b.id = m.business_id
    where m.user_id = $1 order by b.name`, [actorId]);
  return {
    generatedAt: new Date().toISOString(),
    timeZone: 'Africa/Nairobi',
    businesses: grants.map((grant) => ({
      id: grant.business_id, name: grant.name, role: grant.role,
      branches: branches.filter((row) => row.business_id === grant.business_id).map((row) => branchOut(row, stats.get(row.id), mine.get(row.id))),
    })),
  };
}

/** One overseen branch: details, staff, today's activity, and the last 7 days of recorded orders/sales. */
export async function branchDetail(db, actorId, branchId) {
  const branch = await requireOverseen(db, actorId, branchId);
  const [stats, mine, staff, week] = await Promise.all([
    activity(db, [branch.id]),
    ownMemberships(db, actorId, [branch.id]),
    db.query(`select m.user_id, m.role, m.created_at, p.name from public.restaurant_members m
      left join public.profiles p on p.id = m.user_id where m.restaurant_id = $1 order by m.role, p.name`, [branch.id]),
    db.query(`select to_char(d, 'YYYY-MM-DD') as day,
        (select count(*) from public.orders o where o.restaurant_id = $1 and o.status <> 'cancelled'
          and o.created_at >= d at time zone 'Africa/Nairobi' and o.created_at < (d + interval '1 day') at time zone 'Africa/Nairobi')::int as orders,
        (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = $1 and o.status = 'paid'
          and o.paid_at >= d at time zone 'Africa/Nairobi' and o.paid_at < (d + interval '1 day') at time zone 'Africa/Nairobi')::numeric(12,2)::text as paid
      from generate_series((now() at time zone 'Africa/Nairobi')::date - 6, (now() at time zone 'Africa/Nairobi')::date, interval '1 day') as d
      order by d`, [branch.id]),
  ]);
  return {
    ...branchOut(branch, stats.get(branch.id), mine.get(branch.id)),
    businessName: branch.business_name, businessRole: branch.business_role,
    address: branch.address || null,
    staff: staff.rows.map((row) => ({ userId: row.user_id, name: row.name || 'Team member', role: row.role === 'waiter' ? 'waiter' : 'manager', since: new Date(row.created_at).toISOString() })),
    last7Days: week.rows.map((row) => ({ day: row.day, orders: row.orders, paidSales: Number(row.paid) })),
    generatedAt: new Date().toISOString(),
  };
}

/** People with business access, and branch staff at the branches the actor oversees in that business. */
export async function people(db, actorId, businessId) {
  const id = needId(businessId, 'Business');
  const role = await businessRole(db, actorId, id);
  if (!role) throw new HttpError(404, 'That business isn’t yours.');
  const branches = (await oversight(db, actorId)).filter((row) => row.business_id === id);
  const branchIds = branches.map((row) => row.id);
  const [grants, assignments, staff] = await Promise.all([
    role === 'owner'
      ? db.query(`select m.user_id, m.role, m.created_at, p.name from public.business_members m left join public.profiles p on p.id = m.user_id
          where m.business_id = $1 order by m.role desc, p.name`, [id])
      : db.query(`select m.user_id, m.role, m.created_at, p.name from public.business_members m left join public.profiles p on p.id = m.user_id
          where m.business_id = $1 and m.user_id = $2`, [id, actorId]),
    db.query('select user_id, restaurant_id from public.business_member_branches where business_id = $1 and restaurant_id = any($2::uuid[])', [id, branchIds]),
    db.query(`select m.user_id, m.role, m.restaurant_id, p.name from public.restaurant_members m left join public.profiles p on p.id = m.user_id
      where m.restaurant_id = any($1::uuid[]) order by p.name`, [branchIds]),
  ]);
  return {
    businessId: id, yourRole: role, canManageAccess: role === 'owner',
    branches: branches.map((row) => ({ id: row.id, name: row.name })),
    businessAccess: grants.rows.map((row) => ({
      userId: row.user_id, name: row.name || 'Team member', role: row.role, since: new Date(row.created_at).toISOString(),
      branchIds: row.role === 'owner' ? null : assignments.rows.filter((a) => a.user_id === row.user_id).map((a) => a.restaurant_id),
    })),
    branchStaff: staff.rows.map((row) => ({ userId: row.user_id, name: row.name || 'Team member', branchId: row.restaurant_id, role: row.role === 'waiter' ? 'waiter' : 'manager' })),
  };
}

async function audit(db, { businessId, restaurantId = null, actorId, subjectId = null, action, detail = {} }) {
  await db.query(`insert into public.access_events (business_id, restaurant_id, actor_id, subject_id, action, detail)
    values ($1, $2, $3, $4, $5, $6)`, [businessId, restaurantId, actorId, subjectId, action, JSON.stringify(detail)]);
}

/**
 * Grants (or updates) operations access for an existing user and sets exactly the branches they oversee.
 * Owner only; cannot target yourself or another owner; every branch must belong to the business.
 * Call inside a transaction.
 */
export async function setOperations(db, actorId, businessId, subjectId, branchIds) {
  const business = await requireOwner(db, actorId, businessId);
  const subject = needId(subjectId, 'Person');
  if (subject === actorId.toLowerCase()) throw new HttpError(400, 'You can’t change your own access.');
  if (!Array.isArray(branchIds) || !branchIds.length) throw new HttpError(400, 'Choose at least one branch.');
  const wanted = [...new Set(branchIds.map((value) => needId(value, 'Branch')))];
  const { rows: valid } = await db.query('select id from public.restaurants where business_id = $1 and id = any($2::uuid[])', [business, wanted]);
  if (valid.length !== wanted.length) throw new HttpError(400, 'Every branch must belong to this business.');
  const current = await businessRole(db, subject, business);
  if (current === 'owner') throw new HttpError(400, 'Business owners already see every branch.');
  if (!current) {
    await db.query(`insert into public.business_members (business_id, user_id, role, granted_by) values ($1, $2, 'operations', $3)`, [business, subject, actorId]);
    await audit(db, { businessId: business, actorId, subjectId: subject, action: 'business_grant', detail: { role: 'operations' } });
  }
  const { rows: existing } = await db.query('select restaurant_id from public.business_member_branches where business_id = $1 and user_id = $2', [business, subject]);
  const had = new Set(existing.map((row) => row.restaurant_id));
  for (const id of wanted.filter((value) => !had.has(value))) {
    await db.query('insert into public.business_member_branches (business_id, user_id, restaurant_id, granted_by) values ($1, $2, $3, $4)', [business, subject, id, actorId]);
    await audit(db, { businessId: business, restaurantId: id, actorId, subjectId: subject, action: 'branch_assign' });
  }
  for (const id of [...had].filter((value) => !wanted.includes(value))) {
    await db.query('delete from public.business_member_branches where user_id = $1 and restaurant_id = $2', [subject, id]);
    await audit(db, { businessId: business, restaurantId: id, actorId, subjectId: subject, action: 'branch_unassign' });
  }
  return { userId: subject, role: 'operations', branchIds: wanted };
}

/** Removes someone's operations access to the business (owner only; owners are not removable here). */
export async function revokeOperations(db, actorId, businessId, subjectId) {
  const business = await requireOwner(db, actorId, businessId);
  const subject = needId(subjectId, 'Person');
  if (subject === actorId.toLowerCase()) throw new HttpError(400, 'You can’t change your own access.');
  const current = await businessRole(db, subject, business);
  if (!current) throw new HttpError(404, 'That person has no access to this business.');
  if (current === 'owner') throw new HttpError(400, 'Owner access is changed by Cravio, not here.');
  await db.query('delete from public.business_members where business_id = $1 and user_id = $2', [business, subject]);
  await audit(db, { businessId: business, actorId, subjectId: subject, action: 'business_revoke', detail: { role: current } });
}

const cleanText = (value, label, max, required = false) => {
  if (value === undefined || value === null || value === '') { if (required) throw new HttpError(400, `Enter ${label}.`); return null; }
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean && required) throw new HttpError(400, `Enter ${label}.`);
  if (clean.length > max) throw new HttpError(400, `Keep ${label} under ${max} characters.`);
  return clean || null;
};

/**
 * Creates a branch (a restaurant row in 'onboarding') in the business. Owner only. Optionally makes the owner its
 * branch manager so they can set it up; otherwise someone is assigned later. Call inside a transaction.
 */
export async function createBranch(db, actorId, businessId, body = {}) {
  const business = await requireOwner(db, actorId, businessId);
  const name = cleanText(body.name, 'the branch name', 120, true);
  const area = cleanText(body.area, 'the area', 120);
  const { rows } = await db.query(`insert into public.restaurants (owner_id, name, area, business_id, owner_primary, status)
    values ($1, $2, $3, $4, false, 'onboarding') returning id, name, status, area`, [actorId, name, area, business]);
  const branch = rows[0];
  await db.query('insert into public.onboarding_progress (restaurant_id) values ($1) on conflict do nothing', [branch.id]);
  if (body.manageItMyself === true) {
    await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager') on conflict do nothing`, [branch.id, actorId]);
    await audit(db, { businessId: business, restaurantId: branch.id, actorId, subjectId: actorId, action: 'branch_member_add', detail: { role: 'manager' } });
  }
  await audit(db, { businessId: business, restaurantId: branch.id, actorId, action: 'branch_create', detail: { name } });
  return { id: branch.id, name: branch.name, status: branch.status, location: branch.area || '' };
}

/**
 * Adds an existing account to a branch's staff (owner only). role: 'manager' | 'waiter'.
 * An existing membership is left unchanged (branch-level role changes stay in branch Settings → Team).
 */
export async function addBranchStaff(db, actorId, branchId, subjectId, role) {
  const branch = await requireOverseen(db, actorId, branchId);
  if (branch.business_role !== 'owner') throw new HttpError(403, 'Only the business owner can add branch staff.');
  if (!['manager', 'waiter'].includes(role)) throw new HttpError(400, 'Choose Branch manager or Waiter.');
  const subject = needId(subjectId, 'Person');
  const { rows } = await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, $3)
    on conflict (restaurant_id, user_id) do nothing returning role`, [branch.id, subject, role]);
  if (!rows.length) throw new HttpError(409, 'That person already works at this branch. Change their role in the branch’s Settings → Team.');
  await audit(db, { businessId: branch.business_id, restaurantId: branch.id, actorId, subjectId: subject, action: 'branch_member_add', detail: { role } });
  return { userId: subject, branchId: branch.id, role };
}
