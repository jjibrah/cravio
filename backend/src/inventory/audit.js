// Inventory audit trail (07 §0.6). Writes to public.inventory_events, which is append-only (trigger in 012).
// Quantities are audited by the ledger itself; this records the human side: edits, approvals, denials, settings.
// Call inside the same transaction as the change so the event and the change commit or roll back together.
// Exception: a *denied* attempt must be recorded outside the transaction that is about to fail (see permissions.js).

export const MAX_JSON_BYTES = 16 * 1024;
const PREVIEW_CHARS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const replacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

/** JSON-safe, size-capped copy of a payload. Undefined keys vanish; oversized payloads become a marker with a preview. */
export function pack(value, max = MAX_JSON_BYTES) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value, replacer); } catch { return JSON.stringify({ _unserializable: true }); }
  if (text === undefined) return null;
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return JSON.stringify({ _truncated: true, bytes: Buffer.byteLength(text, 'utf8'), preview: text.slice(0, PREVIEW_CHARS) });
}

const clip = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

/** Appends one audit event. Returns its id. Never throws because of the size or shape of before/after. */
export async function record(db, { businessId, locationId = null, actorId = null, actorRole = null, entity, entityId = null, action, before, after } = {}) {
  if (!businessId || !entity || !action) throw new TypeError('audit.record needs businessId, entity and action.');
  const { rows } = await db.query(
    `insert into public.inventory_events (business_id, location_id, actor_id, actor_role, entity, entity_id, action, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) returning id`,
    [businessId, locationId || null, actorId || null, clip(actorRole, 40), clip(entity, 60),
      UUID_RE.test(String(entityId ?? '')) ? entityId : null, clip(action, 60), pack(before), pack(after)]);
  return rows[0].id;
}

const same = (a, b) => JSON.stringify(a, replacer) === JSON.stringify(b, replacer);

/** Only the keys that changed: { before, after, changed }. Use for edits so events stay small. */
export function diff(before, after) {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  const out = { before: {}, after: {}, changed: [] };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === undefined && b[key] === undefined) continue;
    if (same(a[key], b[key])) continue;
    out.changed.push(key);
    if (a[key] !== undefined) out.before[key] = a[key];
    if (b[key] !== undefined) out.after[key] = b[key];
  }
  return out;
}
