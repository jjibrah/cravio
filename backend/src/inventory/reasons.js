// Reason codes for wastage and adjustments (P3-03 migration 019, P3-04). The owner's configurable list: a code has a label and may require a photo
// and/or a note. Defaults are seeded per business, once, the first time the list is read (never by SQL). A used code is deactivated, never
// deleted: this service has no delete at all (and the 019 guard refuses one for a used code).
//   ensureDefaults(db, businessId, kind)             seeds when the business has no code of that kind yet (idempotent, race-safe)
//   list(db, scope, { kind, includeInactive })       anyone who can view stock; inactive codes only for people who can edit settings
//   create / update(db, scope, ...)                  owner only (inv.settings.edit), audited; update renames, flips needs_photo / needs_note / active, reorders
//   resolve(db, businessId, kind, { id | code })     for the wastage service: an ACTIVE code of the business, or a plain refusal
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { can, requireCan } from './permissions.js';
import { diff, record } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const KINDS = Object.freeze(['wastage', 'adjustment', 'staff_meal', 'complimentary']);

/** What gets seeded: [code, label, { needsPhoto, needsNote }]. Same codes as tests/inv/helpers.js DEFAULT_REASON_CODES (checked by a test). */
export const DEFAULT_REASON_CODES = Object.freeze({
  wastage: Object.freeze([
    ['burned', 'Burned'], ['spoiled', 'Spoiled'], ['expired', 'Expired'], ['prep_error', 'Preparation error'], ['spill', 'Spill'],
    ['damaged', 'Damaged'], ['customer_return', 'Customer return'], ['over_production', 'Over-production'], ['theft_suspected', 'Theft suspected', { needsNote: true }],
  ]),
  adjustment: Object.freeze([['found', 'Found stock'], ['recount', 'Recount'], ['damaged', 'Damaged'], ['theft_suspected', 'Theft suspected', { needsNote: true }]]),
  staff_meal: Object.freeze([['staff_meal', 'Staff meal']]),
  complimentary: Object.freeze([['complimentary', 'Complimentary'], ['owner_guest', 'Owner’s guest'], ['service_recovery', 'Service recovery']]),
});

const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const kindOf = (kind) => {
  if (!KINDS.includes(kind)) throw fail(400, `The reason kind must be one of: ${KINDS.join(', ')}.`, 'bad_kind');
  return kind;
};
const slug = (text) => tidy(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

const COLUMNS = `id, business_id, kind, code, label, needs_photo, needs_note, active, position, created_at, updated_at`;
const view = (r, used = undefined) => ({ id: r.id, kind: r.kind, code: r.code, label: r.label, needsPhoto: r.needs_photo, needsNote: r.needs_note, active: r.active,
  position: r.position, ...(used === undefined ? {} : { used }) });

/** Seeds the defaults of one kind when the business has none of that kind. Safe to call on every read: one insert that does nothing once rows exist. */
export async function ensureDefaults(db, businessId, kind = 'wastage') {
  kindOf(kind);
  const defaults = DEFAULT_REASON_CODES[kind];
  const { rows } = await db.query(`insert into public.stock_reason_codes (business_id, kind, code, label, needs_photo, needs_note, position)
    select $1, $2, d.code, d.label, d.needs_photo, d.needs_note, d.position
    from jsonb_to_recordset($3::jsonb) as d(code text, label text, needs_photo boolean, needs_note boolean, position int)
    where not exists (select 1 from public.stock_reason_codes where business_id = $1 and kind = $2)
    on conflict (business_id, kind, code) do nothing returning id`,
  [businessId, kind, JSON.stringify(defaults.map(([code, label, flags = {}], i) => ({ code, label, needs_photo: flags.needsPhoto === true, needs_note: flags.needsNote === true, position: i })))]);
  return rows.length;
}

/** The business's reason codes of one kind, in the owner's order. Seeds the defaults first. */
export async function list(db, scope, { kind = 'wastage', includeInactive = false } = {}) {
  kindOf(kind);
  requireCan(scope, 'inv.view');
  await ensureDefaults(db, scope.businessId, kind);
  const withInactive = includeInactive && can(scope, 'inv.settings.edit');
  const { rows } = await db.query(`select ${COLUMNS},
      (select count(*)::int from public.wastage_records w where w.reason_code_id = c.id) + (select count(*)::int from public.stock_adjustments a where a.reason_code_id = c.id) as used
    from public.stock_reason_codes c where business_id = $1 and kind = $2 and ($3::boolean or active) order by position, lower(label), id`, [scope.businessId, kind, withInactive]);
  return { kind, reasons: rows.map((r) => view(r, r.used)) };
}

/** An active code of this business by id or by code (case-insensitive code or label), or a plain refusal. Null when nothing was asked for. */
export async function resolve(db, businessId, kind, { id = null, code = null } = {}) {
  kindOf(kind);
  await ensureDefaults(db, businessId, kind);
  let row;
  if (id !== null && id !== undefined && id !== '') {
    if (!isId(id)) throw fail(400, 'The reason is invalid. Pick one from the list.', 'bad_reason');
    row = (await db.query(`select ${COLUMNS} from public.stock_reason_codes where id = $1 and business_id = $2 and kind = $3`, [id.toLowerCase(), businessId, kind])).rows[0];
    if (!row) throw fail(404, 'That reason isn’t in your list. Pick one from the list.', 'reason_not_found');
  } else if (code !== null && code !== undefined && tidy(code) !== '') {
    const text = tidy(code).toLowerCase();
    row = (await db.query(`select ${COLUMNS} from public.stock_reason_codes where business_id = $1 and kind = $2 and active and (code = $3 or lower(label) = $4)`, [businessId, kind, slug(text), text])).rows[0];
    return row ? view(row) : null;
  } else return null;
  if (!row.active) throw fail(409, `“${row.label}” is switched off. Pick another reason.`, 'reason_inactive');
  return view(row);
}

/** Adds a reason (owner). body: { kind, label, code?, needsPhoto?, needsNote? }. The code defaults to the label in snake_case and can't change later. */
export async function create(db, scope, body = {}) {
  requireCan(scope, 'inv.settings.edit');
  const kind = kindOf(body.kind ?? 'wastage');
  const label = tidy(body.label);
  if (!label) throw fail(400, 'Give the reason a name, like “Dropped”.', 'label_required');
  if (label.length > 60) throw fail(400, 'Keep the reason name under 60 characters.', 'label_too_long');
  const code = body.code ? slug(body.code) : slug(label);
  if (!code) throw fail(400, 'The reason name needs some letters or numbers.', 'bad_code');
  await ensureDefaults(db, scope.businessId, kind);
  const clash = (await db.query('select label, active from public.stock_reason_codes where business_id = $1 and kind = $2 and (code = $3 or lower(label) = lower($4))', [scope.businessId, kind, code, label])).rows[0];
  if (clash) throw fail(409, `You already have a reason called “${clash.label}”${clash.active ? '' : ' (switched off). Switch it back on instead'}.`, 'reason_exists');
  const next = (await db.query('select coalesce(max(position), -1) + 1 as p from public.stock_reason_codes where business_id = $1 and kind = $2', [scope.businessId, kind])).rows[0].p;
  const row = (await db.query(`insert into public.stock_reason_codes (business_id, kind, code, label, needs_photo, needs_note, position, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`, [scope.businessId, kind, code, label, body.needsPhoto === true, body.needsNote === true, next, scope.userId])).rows[0];
  await record(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'reason_code', entityId: row.id, action: 'create', after: view(row) });
  return view(row);
}

/** Renames or switches a reason (owner). patch: { label?, needsPhoto?, needsNote?, active?, position? }. A reason is never deleted. */
export async function update(db, scope, id, patch = {}) {
  requireCan(scope, 'inv.settings.edit');
  if (!isId(id)) throw fail(400, 'The reason is invalid.', 'bad_id');
  const old = (await db.query(`select ${COLUMNS} from public.stock_reason_codes where id = $1 and business_id = $2 for update`, [id.toLowerCase(), scope.businessId])).rows[0];
  if (!old) throw fail(404, 'That reason isn’t in your list.', 'reason_not_found');
  const next = { label: old.label, needs_photo: old.needs_photo, needs_note: old.needs_note, active: old.active, position: old.position };
  if (patch.label !== undefined) {
    next.label = tidy(patch.label);
    if (!next.label) throw fail(400, 'Give the reason a name.', 'label_required');
    if (next.label.length > 60) throw fail(400, 'Keep the reason name under 60 characters.', 'label_too_long');
    const clash = (await db.query('select 1 from public.stock_reason_codes where business_id = $1 and kind = $2 and id <> $3 and lower(label) = lower($4)', [scope.businessId, old.kind, old.id, next.label])).rows[0];
    if (clash) throw fail(409, `You already have a reason called “${next.label}”.`, 'reason_exists');
  }
  for (const [key, column] of [['needsPhoto', 'needs_photo'], ['needsNote', 'needs_note'], ['active', 'active']]) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') throw fail(400, `${key} must be true or false.`, 'bad_value');
    next[column] = patch[key];
  }
  if (patch.position !== undefined) {
    if (!Number.isInteger(patch.position) || patch.position < 0 || patch.position > 1000) throw fail(400, 'The position must be a whole number from 0 to 1000.', 'bad_value');
    next.position = patch.position;
  }
  const row = (await db.query(`update public.stock_reason_codes set label = $2, needs_photo = $3, needs_note = $4, active = $5, position = $6, updated_at = now()
    where id = $1 returning ${COLUMNS}`, [old.id, next.label, next.needs_photo, next.needs_note, next.active, next.position])).rows[0];
  const d = diff(view(old), view(row));
  if (d.changed.length) {
    const only = d.changed.length === 1 && d.changed[0] === 'active';
    await record(db, { businessId: scope.businessId, actorId: scope.userId, actorRole: scope.role, entity: 'reason_code', entityId: row.id,
      action: only ? (row.active ? 'activate' : 'deactivate') : 'update', before: d.before, after: d.after });
  }
  return view(row);
}
