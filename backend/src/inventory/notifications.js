// Stored notifications (013: public.notifications). Written by triggers (stock ran out, dish served short) and the API.
// Readers only ever touch their OWN rows: every query is filtered by recipient_id = the caller.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';

const shape = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, entityType: r.entity_type, entityId: r.entity_id,
  businessId: r.business_id, locationId: r.location_id, read: r.read_at !== null, readAt: r.read_at, createdAt: r.created_at });

export async function unreadCount(db, userId) {
  return (await db.query('select count(*)::int as n from public.notifications where recipient_id = $1 and read_at is null', [userId])).rows[0].n;
}

/** Newest first. { unreadOnly, limit = 30 (max 100), before = an ISO time from nextBefore }. */
export async function list(db, userId, { unreadOnly = false, limit = 30, before = null } = {}) {
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
  let cursor = null;
  if (before) {
    const t = new Date(before);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'The page marker is invalid. Start from the top.', { code: 'bad_cursor' });
    cursor = t.toISOString();
  }
  const { rows } = await db.query(`select id, business_id, location_id, kind, title, body, link, entity_type, entity_id, read_at, created_at
    from public.notifications where recipient_id = $1 and ($2::boolean is not true or read_at is null) and ($3::timestamptz is null or created_at < $3::timestamptz)
    order by created_at desc, id desc limit $4`, [userId, Boolean(unreadOnly), cursor, size + 1]);
  const page = rows.slice(0, size);
  return { notifications: page.map(shape), unreadCount: await unreadCount(db, userId),
    nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null };
}

/** Marks the caller's own notifications read: ids (array of ids, max 100) or 'all'. Other people's ids are ignored. */
export async function markRead(db, userId, ids) {
  let marked;
  if (ids === 'all') {
    marked = (await db.query(`update public.notifications set read_at = now() where recipient_id = $1 and read_at is null returning id`, [userId])).rows.length;
  } else {
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Say which notifications to mark as read, or send all: true.', { code: 'ids_required' });
    if (ids.length > 100) throw new HttpError(400, 'Mark at most 100 at a time, or send all: true.', { code: 'too_many' });
    if (!ids.every((id) => isId(id))) throw new HttpError(400, 'One of the notification ids is invalid.', { code: 'bad_id' });
    marked = (await db.query(`update public.notifications set read_at = now() where recipient_id = $1 and read_at is null and id = any($2::uuid[]) returning id`,
      [userId, ids.map((id) => id.toLowerCase())])).rows.length;
  }
  return { marked, unreadCount: await unreadCount(db, userId) };
}

/* ---------- Writer (P2-02) ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

/**
 * Who a recipients spec means, for one business (same sources as 013's private.stock_alert_recipients and inventoryScope):
 *   'owners'                      business_members with role owner
 *   'branch_managers:<branchId>'  restaurant_members owner|manager of that branch
 *   'alerts:<branchId>'           both of the above: what the stock-out alerts use
 *   [userId, ...]                 those people, but only when they belong to this business (a member of it or one of its branches)
 * An array may mix the three kinds. Returns { userIds, locationId } (locationId = the branch's stock location, when one branch is named).
 */
export async function resolveRecipients(db, businessId, recipients) {
  const specs = Array.isArray(recipients) ? recipients : [recipients];
  const ids = new Set();
  const explicit = new Set();
  let locationId = null;
  for (const spec of specs) {
    if (typeof spec !== 'string') continue;
    const text = spec.trim();
    const [kind, arg] = text.split(':');
    if (UUID.test(text)) { explicit.add(text.toLowerCase()); continue; }
    if (kind === 'owners' || kind === 'alerts') {
      for (const r of (await db.query(`select user_id from public.business_members where business_id = $1 and role = 'owner'`, [businessId])).rows) ids.add(r.user_id);
    }
    if ((kind === 'branch_managers' || kind === 'alerts') && arg && UUID.test(arg)) {
      const branch = (await db.query('select id from public.restaurants where id = $1 and business_id = $2', [arg.toLowerCase(), businessId])).rows[0];
      if (!branch) continue;
      for (const r of (await db.query(`select user_id from public.restaurant_members where restaurant_id = $1 and role in ('owner', 'manager')`, [branch.id])).rows) ids.add(r.user_id);
      locationId ??= (await db.query('select id from public.stock_locations where business_id = $1 and restaurant_id = $2', [businessId, branch.id])).rows[0]?.id || null;
    }
  }
  if (explicit.size) {
    const { rows } = await db.query(`select u from unnest($2::uuid[]) u where exists (select 1 from public.business_members where business_id = $1 and user_id = u)
      or exists (select 1 from public.restaurant_members rm join public.restaurants r on r.id = rm.restaurant_id where r.business_id = $1 and rm.user_id = u)`, [businessId, [...explicit]]);
    for (const r of rows) ids.add(r.u);
  }
  return { userIds: [...ids], locationId };
}

/**
 * Stores a notification for each recipient (public.notifications, 013). Never throws and never poisons the caller's
 * transaction: the insert runs inside a savepoint that is rolled back on any error. Returns { delivered, recipients, skipped, error? }.
 *   notify(tx, { businessId, recipients: 'owners' | 'branch_managers:<restaurantId>' | [userId...] | [..mixed..],
 *                kind, title, body, link, entity: { type, id }, locationId, dedupeKey, exclude: [userId...] })
 * With a dedupeKey a recipient gets that notification once: repeats are counted in `skipped`, not delivered again.
 * `exclude` leaves people out (usually the person who just acted).
 */
export async function notify(db, { businessId, recipients, kind, title, body = null, link = null, entity = null, locationId = null, dedupeKey = null, exclude = [] } = {}) {
  const sp = `notify_${Math.random().toString(36).slice(2, 10)}`;
  let savepoint = false;
  try {
    if (!businessId || !UUID.test(String(businessId)) || !kind || !title || recipients === undefined || recipients === null) return { delivered: 0, recipients: 0, skipped: 0, error: 'bad_arguments' };
    try { await db.query(`savepoint ${sp}`); savepoint = true; } catch { savepoint = false; }
    const found = await resolveRecipients(db, String(businessId).toLowerCase(), recipients);
    const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean).map((x) => String(x).toLowerCase()));
    const userIds = found.userIds.filter((id) => !skip.has(String(id).toLowerCase()));
    if (!userIds.length) { if (savepoint) await db.query(`release savepoint ${sp}`); return { delivered: 0, recipients: 0, skipped: 0 }; }
    const where = locationId || found.locationId;
    const entityId = entity?.id && UUID.test(String(entity.id)) ? String(entity.id).toLowerCase() : null;
    const { rows } = await db.query(`insert into public.notifications (business_id, recipient_id, location_id, kind, title, body, link, entity_type, entity_id, dedupe_key)
      select $1, u, $2, $3, $4, $5, $6, $7, $8, $9 from unnest($10::uuid[]) u
      on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing returning id`,
    [businessId, where || null, clip(kind, 40), clip(title, 200), clip(body, 1000), clip(link, 300), clip(entity?.type, 40), entityId, clip(dedupeKey, 200), userIds]);
    if (savepoint) await db.query(`release savepoint ${sp}`);
    return { delivered: rows.length, recipients: userIds.length, skipped: userIds.length - rows.length };
  } catch (error) {
    if (savepoint) { try { await db.query(`rollback to savepoint ${sp}`); await db.query(`release savepoint ${sp}`); } catch { /* the transaction is already gone */ } }
    console.error('[inventory] could not store a notification:', error.message);
    return { delivered: 0, recipients: 0, skipped: 0, error: error.code || 'notify_failed' };
  }
}
