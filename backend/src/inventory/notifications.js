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
