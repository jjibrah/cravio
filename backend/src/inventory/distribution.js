// Distribution (P2-21, P2-22; migration 018): stock requests from branches, the owner's approval that RESERVES stock at the Warehouse, preparing,
// dispatching, receiving with discrepancies, returns to the Warehouse and branch -> branch transfers. The Warehouse is the business's one 009
// 'center' location (scope.centerLocationId, D2-1). Every stock change goes through ledger.js; this file never writes stock_balances itself.
//
//   BRANCH            createRequest / editDraft / submit / cancel / listRequests / getRequest / suggestRequest
//                     receive(transferId | code)  findByCode  startReturn  requestBranchTransfer  dispatchTransfer (source branch, after approval)
//   OWNER             review (approve per line, reserves) / startPreparing + pickList / dispatch (request or direct) / cancelDispatch
//   BOTH              listTransfers / getTransfer (in transit is visible to the sender and the receiver)
//   LEGACY            adoptLegacy: 009 requests that `main` approved but has not dispatched get reservations the first time the new engine touches them.
//
// Lifecycle of a request:  draft -> submitted -> approved | partially_approved | rejected -> preparing -> dispatched -> partially_received -> received -> completed
//   (cancelled any time before the goods leave; after a partial dispatch only the undispatched remainder is cancelled and the request completes.)
//   * review(): per line approved 0..requested; each approved line is HELD at the Warehouse with ledger.reserve (409 insufficient_available says what is free).
//   * dispatch(): per line a ledger 'transfer_dispatch' that consumes the line's reservation; a partial dispatch leaves the rest reserved. The transfer
//     (TRF-<year>-<number>, a 10-letter code for the QR note) is in_transit; the branch receives it at the SAME unit cost.
//   * receive(): per line good (-> 'transfer_receipt' at the branch), damaged (not added), short (never arrived) and over (extra, accepted up to
//     transfer_over_tolerance_pct as 'transfer_discrepancy'). Any difference needs a note and opens a transfer_discrepancies row; owners are told.
//   * cancelDispatch() (owner, before any receipt): 'transfer_cancelled' puts the stock back at the sender and the request's hold is RE-RESERVED, so an
//     approved request is always backed by stock (decision: re-reserve, as the plan says, rather than leave the request approved but unheld).
//
// Numbers: stock_requests.number / stock_transfers.number stay the integer 009 uses (unique per business, shared with `main`'s flow); the display
// reference is formatNumber('REQ' | 'TRF', year of creation / dispatch, number), e.g. TRF-2026-0007. (numbers.js yearly counters would restart at 1 and
// collide with the integer column's uniqueness, so they are not used for these two.)
// Returns and branch -> branch transfers are transfers WITHOUT a request row (direction 'return' | 'branch_to_branch'); a branch -> branch transfer is
// first 'pending_approval' with an approvals-engine row (subject 'transfer'); once approved (approved_at set) the source branch dispatches it.
//
// Every function takes `db` inside a transaction and the caller's inventoryScope; `commandId` idempotency is applied by the route (commands.once).
import { randomInt } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { COST, MONEY, QTY, add, cmp, dec, div, isNeg, isZero, mul, neg, rescale, sub } from './decimal.js';
import { display, normaliseUnit, toBase } from './units.js';
import { can, locationsWith, requireCan } from './permissions.js';
import { loadUnits } from './catalogue.js';
import * as ledger from './ledger.js';
import * as approvals from './approvals.js';
import { formatNumber, nairobiYear } from './numbers.js';
import { notify } from './notifications.js';
import { getSettings } from './policies.js';
import { together } from '../lib/pool.js';
import { record as audit } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const lc = (id) => (id ? String(id).toLowerCase() : null);
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is missing or invalid.`, 'bad_id');
  return value.toLowerCase();
};
const clipKey = (text) => String(text).slice(0, 120);
const q4 = (d) => dec(d).toString(QTY);
const kes = (v) => `KES ${Number(dec(v).toString(MONEY)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const MAX_NOTE = 280;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const REQUEST_STATUSES = Object.freeze(['draft', 'submitted', 'pending_approval', 'approved', 'partially_approved', 'rejected', 'preparing', 'dispatched',
  'partially_received', 'received', 'completed', 'cancelled']);
export const TRANSFER_STATUSES = Object.freeze(['pending_approval', 'in_transit', 'partially_received', 'received', 'cancelled']);
const DISPATCHABLE = ['approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received'];
const CANCELLABLE = ['draft', 'submitted', 'pending_approval', 'approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received'];
const OPEN_TRANSFER = ['pending_approval', 'in_transit', 'partially_received'];
const WORDS = { in_transit: 'on its way', partially_received: 'partly received', received: 'received', cancelled: 'cancelled', pending_approval: 'waiting for approval' };

/* ---------- small shared pieces ---------- */

const place = (scope, locationId) => {
  const loc = scope.locations.find((l) => l.id === lc(locationId));
  if (!loc) throw fail(404, 'That branch or the Warehouse isn’t part of this business.', 'location_not_found');
  return loc.kind === 'branch' ? loc : { ...loc, name: 'Warehouse' };
};
const branchPlace = (scope, locationId) => {
  const loc = place(scope, locationId);
  if (loc.kind !== 'branch') throw fail(400, 'That has to be a branch, not the Warehouse.', 'not_a_branch');
  return loc;
};
/** The stock location of a branch (restaurant id) in this business. */
export function branchLocationOf(scope, restaurantId) {
  const loc = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === lc(restaurantId));
  if (!loc) throw fail(404, 'That branch isn’t part of this business.', 'branch_not_found');
  return loc;
}

const ITEM_SELECT = `select i.id, i.name, i.unit, i.display_unit, i.avg_cost::text as avg_cost, i.archived_at, i.storage, c.name as category,
    coalesce((select json_agg(json_build_object('name', u.name, 'factor', u.factor::text) order by u.position, lower(u.name))
      from public.stock_item_units u where u.item_id = i.id), '[]'::json) as own_units
  from public.stock_items i left join public.stock_categories c on c.id = i.category_id where i.business_id = $1`;
const itemMap = (rows) => {
  const out = new Map();
  for (const r of rows) {
    const own = typeof r.own_units === 'string' ? JSON.parse(r.own_units) : r.own_units;
    out.set(r.id, { id: r.id, name: r.name, baseUnit: r.unit, displayUnit: r.display_unit || undefined, avgCost: r.avg_cost, archived: Boolean(r.archived_at),
      storage: r.storage, category: r.category, units: own.map((u) => ({ name: u.name, factor: u.factor })) });
  }
  return out;
};

/** Items by id with their own units (one statement). Missing ids are absent from the map. */
export async function loadItems(db, businessId, ids) {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  return itemMap((await db.query(`${ITEM_SELECT} and i.id = any($2::uuid[])`, [businessId, list])).rows);
}
const needItem = (items, id) => {
  const it = items.get(id);
  if (!it) throw fail(404, 'That stock item isn’t in this business. Pick it from the stock list.', 'item_not_found');
  return it;
};
export const show = (it, base, units) => display(dec(base).toString(QTY), it, units);

/** A typed amount in any unit of the item -> base units (4 dp). Blank = 0 when allowZero. */
function amount(value, unit, it, units, { label, allowZero = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (allowZero) return { base: '0.0000', entered: null, unit: null };
    throw fail(400, `${label} is missing. Enter how much.`, 'quantity_required');
  }
  const d = dec(typeof value === 'string' ? value.trim() : value, { label });
  if (isNeg(d)) throw fail(400, `${label} can’t be negative.`, 'negative_quantity');
  if (!allowZero && isZero(d)) throw fail(400, `${label} must be more than zero.`, 'zero_quantity');
  const wanted = unit === undefined || unit === null || String(unit).trim() === '' ? (it.displayUnit ?? it.baseUnit) : String(unit).trim();
  const base = toBase(d.toString(), wanted, it, units, { label });
  return { base, entered: rescale(d, QTY, 'half-up').toString(QTY), unit: normaliseUnit(wanted, it, units) || it.baseUnit };
}

/** Request / transfer lines from a body: [{ itemId, quantity, unit? }], each item once, items live. Returns [{ itemId, base, entered, unit, item }]. */
async function parseLines(db, businessId, lines, { label = 'Quantity', allowZero = false, units = null } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Add at least one item.', 'lines_required');
  if (lines.length > 100) throw fail(400, 'Keep it to 100 items at a time.', 'too_many_lines');
  const ids = lines.map((l) => needId(l?.itemId, 'The stock item'));
  if (new Set(ids).size !== ids.length) throw fail(400, 'Each item can appear once.', 'duplicate_item');
  const items = await loadItems(db, businessId, ids);
  const u = units || await loadUnits(db);
  return lines.map((l, i) => {
    const it = needItem(items, ids[i]);
    if (it.archived) throw fail(409, `${it.name} is archived, so it can’t be moved. Restore it first.`, 'item_archived');
    const a = amount(l.quantity ?? l.approved, l.unit, it, u, { label: `${label} for ${it.name}`, allowZero });
    return { itemId: ids[i], item: it, ...a };
  });
}

async function nextInteger(db, table, businessId) {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 11))', [`${table}:${businessId}`]);
  return (await db.query(`select coalesce(max(number), 0) + 1 as next from public.${table} where business_id = $1`, [businessId])).rows[0].next;
}
const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const yearOf = (when) => nairobiYear(when instanceof Date ? when : new Date(when));
export const requestRef = (number, at = new Date()) => formatNumber('REQ', yearOf(at), number);
export const transferRef = (number, at = new Date()) => formatNumber('TRF', yearOf(at), number);

const tell = (db, scope, args) => notify(db, { businessId: scope.businessId, ...args });

/** Where a notification opens (P2-24). These match the frontend routes: owners at /owner/inventory/requests, a branch at /branch/<restaurantId>/inventory/requests. */
export const OWNER_REQUESTS_LINK = '/owner/inventory/requests';
export const OWNER_PROBLEMS_LINK = '/owner/inventory/requests?tab=problems';
export const branchRequestsLink = (restaurantId, query = '') => `/branch/${restaurantId}/inventory/requests${query}`;

/* ---------- requests: reading ---------- */

const REQUEST_SELECT = `select q.*, q.needed_by::text as needed_by_text, r.name as branch_name, pr.name as requested_by_name, pa.name as approved_by_name
  from public.stock_requests q join public.restaurants r on r.id = q.restaurant_id
  left join public.profiles pr on pr.id = q.requested_by left join public.profiles pa on pa.id = q.approved_by`;

async function warehouseNumbers(db, scope, itemIds) {
  const map = new Map();
  if (!itemIds.length || !scope.centerLocationId) return map;
  for (const r of (await db.query(`select item_id, on_hand::text as on_hand, reserved::text as reserved from public.stock_balances where location_id = $1 and item_id = any($2::uuid[])`,
    [scope.centerLocationId, itemIds])).rows) map.set(r.item_id, { onHand: r.on_hand, reserved: r.reserved, available: sub(r.on_hand, r.reserved, QTY).toString(QTY) });
  return map;
}

/**
 * Shapes request rows (with lines, holds, transfers and, for approvers, what the Warehouse has). Everything is fetched for ALL the
 * requests at once (no query per request), and the six reads only need the request ids, so they run together on separate connections.
 */
async function requestViews(db, scope, rows, { withWarehouse = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [lineRows, heldRows, itemRows, units, whRows, transfers] = await together(db,
    async () => (await db.query(`select request_id, item_id, requested::text as requested, approved::text as approved, dispatched::text as dispatched, received::text as received,
      entered_quantity::text as entered_quantity, entered_unit from public.stock_request_lines where request_id = any($1::uuid[])`, [ids])).rows,
    async () => (await db.query(`select request_id, item_id, sum(qty_reserved - qty_consumed - qty_released)::text as remaining from public.stock_reservations
    where request_id = any($1::uuid[]) and status = 'active' group by request_id, item_id`, [ids])).rows,
    async () => (await db.query(`${ITEM_SELECT} and i.id in (select item_id from public.stock_request_lines where request_id = any($2::uuid[]))`, [scope.businessId, ids])).rows,
    () => loadUnits(db, scope),
    async () => (withWarehouse && scope.centerLocationId ? (await db.query(`select item_id, on_hand::text as on_hand, reserved::text as reserved from public.stock_balances
      where location_id = $1 and item_id in (select item_id from public.stock_request_lines where request_id = any($2::uuid[]))`, [scope.centerLocationId, ids])).rows : []),
    async () => (await db.query(`select id, request_id, number, status, dispatched_at, received_at from public.stock_transfers where request_id = any($1::uuid[]) order by dispatched_at, number`, [ids])).rows);
  const held = new Map(heldRows.map((r) => [`${r.request_id}:${r.item_id}`, r.remaining]));
  const items = itemMap(itemRows);
  const wh = new Map(whRows.map((r) => [r.item_id, { onHand: r.on_hand, reserved: r.reserved, available: sub(r.on_hand, r.reserved, QTY).toString(QTY) }]));
  return rows.map((q) => {
    const open = ['submitted', 'approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received', 'pending_approval'].includes(q.status);
    const lines = lineRows.filter((l) => l.request_id === q.id).map((l) => {
      const it = items.get(l.item_id);
      const approved = l.approved === null ? null : l.approved;
      const remaining = approved === null ? null : (cmp(sub(approved, l.dispatched, QTY), 0) > 0 ? sub(approved, l.dispatched, QTY).toString(QTY) : '0.0000');
      const w = wh.get(l.item_id) || (withWarehouse ? { onHand: '0.0000', reserved: '0.0000', available: '0.0000' } : null);
      return { itemId: l.item_id, name: it?.name, unit: it?.baseUnit, requested: l.requested, approved, dispatched: l.dispatched, received: l.received, remaining,
        held: held.get(`${q.id}:${l.item_id}`) || '0.0000', entered: l.entered_quantity ? { quantity: l.entered_quantity, unit: l.entered_unit } : null,
        requestedDisplay: it ? show(it, l.requested, units) : null, approvedDisplay: it && approved !== null ? show(it, approved, units) : null,
        dispatchedDisplay: it ? show(it, l.dispatched, units) : null, receivedDisplay: it ? show(it, l.received, units) : null,
        warehouse: open && w ? { ...w, availableDisplay: it ? show(it, w.available, units) : null } : undefined,
        short: open && withWarehouse && w && cmp(w.available, approved ?? l.requested) < 0 };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      id: q.id, number: q.number, ref: requestRef(q.number, q.created_at), status: q.status, kind: q.kind, branchId: q.restaurant_id, branchName: q.branch_name,
      fromLocationId: q.from_location, toLocationId: q.to_location, priority: q.priority, neededBy: q.needed_by_text ? q.needed_by_text.slice(0, 10) : null,
      note: q.note, reviewNote: q.review_note, needsAttention: q.needs_attention, requestedBy: q.requested_by, requestedByName: q.requested_by_name || null,
      approvedBy: q.approved_by, approvedByName: q.approved_by_name || null, approvedAt: q.approved_at, reviewedAt: q.reviewed_at, completedAt: q.completed_at,
      createdAt: q.created_at, updatedAt: q.updated_at,
      hasRemainder: lines.some((l) => l.remaining !== null && cmp(l.remaining, 0) > 0),
      lines, transfers: transfers.filter((t) => t.request_id === q.id).map((t) => ({ id: t.id, number: t.number, ref: transferRef(t.number, t.dispatched_at), status: t.status, dispatchedAt: t.dispatched_at, receivedAt: t.received_at })),
    };
  });
}

async function loadRequest(db, scope, id, { lock = false } = {}) {
  const row = (await db.query(`select *, needed_by::text as needed_by_text from public.stock_requests where id = $1 and business_id = $2 ${lock ? 'for update' : ''}`, [needId(id, 'The request'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That request isn’t in this business.', 'request_not_found');
  // Requests `main` created after migration 018 have no locations yet: fill them (Warehouse -> the requesting branch).
  if (!row.from_location || !row.to_location) {
    const to = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === row.restaurant_id);
    if (to && scope.centerLocationId) {
      await db.query('update public.stock_requests set from_location = coalesce(from_location, $2), to_location = coalesce(to_location, $3) where id = $1', [row.id, scope.centerLocationId, to.id]);
      row.from_location ||= scope.centerLocationId; row.to_location ||= to.id;
    }
  }
  return row;
}

export async function requestLocation(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That request id is invalid.', 'bad_id');
  const row = (await db.query(`select q.restaurant_id, q.to_location, (select l.id from public.stock_locations l where l.restaurant_id = q.restaurant_id and l.business_id = q.business_id) as branch_location
    from public.stock_requests q where q.id = $1 and q.business_id = $2`, [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That request isn’t in this business.', 'request_not_found');
  return { locationId: row.to_location || row.branch_location, restaurantId: row.restaurant_id };
}

/** Which requests the caller may see: branches where they hold inv.view. */
const visibleBranchLocations = (scope) => locationsWith(scope, 'inv.view').filter((id) => scope.locations.find((l) => l.id === id)?.kind === 'branch');

export async function listRequests(db, scope, { locationId = null, status = null, limit = 50, before = null, kind = null } = {}) {
  const visible = visibleBranchLocations(scope);
  if (!visible.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  let places = visible;
  if (locationId) {
    const id = needId(locationId, 'The branch');
    if (!visible.includes(id)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    places = [id];
  }
  const args = [scope.businessId, places];
  const where = ['q.business_id = $1', `exists (select 1 from public.stock_locations l where l.restaurant_id = q.restaurant_id and l.id = any($2::uuid[]))`];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (status) {
    const wanted = status === 'open' ? ['submitted', 'approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received'] : String(status).split(',').map((s) => s.trim());
    if (!wanted.every((s) => REQUEST_STATUSES.includes(s))) throw fail(400, `The status must be one of: open, ${REQUEST_STATUSES.join(', ')}.`, 'bad_status');
    where.push(`q.status = any(${arg(wanted)}::text[])`);
  }
  if (kind) where.push(`q.kind = ${arg(String(kind))}`);
  if (before) {
    const t = new Date(before);
    if (Number.isNaN(t.getTime())) throw fail(400, 'The page marker is invalid.', 'bad_cursor');
    where.push(`q.created_at < ${arg(t)}`);
  }
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = (await db.query(`${REQUEST_SELECT} where ${where.join(' and ')} order by q.created_at desc, q.number desc limit ${size + 1}`, args)).rows;
  const page = rows.slice(0, size);
  const approver = scope.roles.includes('owner') || can(scope, 'inv.request.approve');
  return { requests: await requestViews(db, scope, page, { withWarehouse: approver }), nextBefore: rows.length > size ? new Date(page.at(-1).created_at).toISOString() : null };
}

/** One request. Visible to anyone with inv.view at its branch. Approvers also see what the Warehouse has per line. */
export async function getRequest(db, scope, id) {
  const q = await loadRequest(db, scope, id);
  const locationId = q.to_location || (await requestLocation(db, scope.businessId, q.id)).locationId;
  requireCan(scope, 'inv.view', { locationId });
  const row = (await db.query(`${REQUEST_SELECT} where q.id = $1`, [q.id])).rows[0];
  const approver = scope.roles.includes('owner') || can(scope, 'inv.request.approve', { locationId });
  return { request: (await requestViews(db, scope, [row], { withWarehouse: approver }))[0] };
}

/** The owner's inbox: submitted requests, oldest first, with the Warehouse's available figure beside each line. */
export async function inbox(db, scope, { now = new Date() } = {}) {
  const places = locationsWith(scope, 'inv.request.approve').filter((id) => scope.locations.find((l) => l.id === id)?.kind === 'branch');
  if (!places.length) requireCan(scope, 'inv.request.approve', { locationId: scope.centerLocationId });
  await adoptLegacy(db, scope, { now });
  const mine = `exists (select 1 from public.stock_locations l where l.restaurant_id = q.restaurant_id and l.id = any($2::uuid[]))`;
  const rows = (await db.query(`${REQUEST_SELECT} where q.business_id = $1 and q.status = 'submitted' and ${mine} order by case q.priority when 'urgent' then 0 when 'normal' then 1 else 2 end, q.created_at`, [scope.businessId, places])).rows;
  const attention = (await db.query(`${REQUEST_SELECT} where q.business_id = $1 and q.needs_attention and q.status in ('approved', 'partially_approved', 'preparing') and ${mine}`, [scope.businessId, places])).rows;
  return { requests: await requestViews(db, scope, rows, { withWarehouse: true }), needsAttention: await requestViews(db, scope, attention, { withWarehouse: true }) };
}

/* ---------- requests: writing (branch) ---------- */

/**
 * A branch asks the Warehouse for stock. input: { locationId (the branch's stock location), lines:[{ itemId, quantity, unit? }], note?, neededBy? ('YYYY-MM-DD'),
 * priority? ('low'|'normal'|'urgent'), submit? (default true; false keeps a draft) }. Needs inv.request.create at that branch.
 */
export async function createRequest(db, scope, input = {}, { now = new Date() } = {}) {
  const loc = branchPlace(scope, input.locationId);
  requireCan(scope, 'inv.request.create', { locationId: loc.id });
  if (!scope.centerLocationId) throw fail(409, 'This business has no Warehouse yet. Open Inventory as the owner first.', 'no_warehouse');
  const lines = await parseLines(db, scope.businessId, input.lines, { label: 'The amount' });
  const meta = requestMeta(input);
  const status = input.submit === false ? 'draft' : 'submitted';
  const number = await nextInteger(db, 'stock_requests', scope.businessId);
  const { id } = (await db.query(`insert into public.stock_requests (business_id, restaurant_id, number, status, note, requested_by, kind, from_location, to_location, priority, needed_by)
    values ($1, $2, $3, $4, $5, $6, 'stock', $7, $8, $9, $10) returning id`,
  [scope.businessId, loc.restaurantId, number, status, meta.note, scope.userId, scope.centerLocationId, loc.id, meta.priority, meta.neededBy])).rows[0];
  await insertLines(db, id, lines);
  await audit(db, { businessId: scope.businessId, locationId: loc.id, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: id, action: status === 'draft' ? 'create_draft' : 'submit',
    after: { ref: requestRef(number, now), status, lines: lines.map((l) => ({ itemId: l.itemId, base: l.base })), note: meta.note, priority: meta.priority, neededBy: meta.neededBy } });
  if (status === 'submitted') await notifySubmitted(db, scope, { id, number, branchName: loc.name, lines: lines.length, priority: meta.priority }, now);
  return getRequest(db, scope, id);
}

function requestMeta(input) {
  const note = input.note === undefined || input.note === null ? null : tidy(input.note);
  if (note && note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  const priority = input.priority === undefined || input.priority === null || input.priority === '' ? 'normal' : String(input.priority);
  if (!['low', 'normal', 'urgent'].includes(priority)) throw fail(400, 'Priority must be low, normal or urgent.', 'bad_priority');
  let neededBy = null;
  if (input.neededBy !== undefined && input.neededBy !== null && input.neededBy !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.neededBy)) || Number.isNaN(new Date(`${input.neededBy}T00:00:00Z`).getTime())) throw fail(400, 'Needed by must be a date like 2026-11-25.', 'bad_date');
    neededBy = String(input.neededBy);
  }
  return { note: note || null, priority, neededBy };
}

async function insertLines(db, requestId, lines) {
  for (const l of lines) {
    await db.query(`insert into public.stock_request_lines (request_id, item_id, requested, entered_quantity, entered_unit) values ($1, $2, $3, $4, $5)`,
      [requestId, l.itemId, l.base, l.entered, l.unit]);
  }
}

const notifySubmitted = (db, scope, r, now) => tell(db, scope, { recipients: 'owners', kind: 'request_submitted', title: `${r.branchName} asked for stock`,
  body: `${requestRef(r.number, now)}: ${r.lines} item${r.lines === 1 ? '' : 's'}${r.priority === 'urgent' ? ' (urgent)' : ''}.`, link: OWNER_REQUESTS_LINK, entity: { type: 'stock_request', id: r.id }, dedupeKey: `request_submitted:${r.id}` });

/** Change a draft (lines, note, priority, neededBy). */
export async function editDraft(db, scope, requestId, input = {}) {
  const q = await loadRequest(db, scope, requestId, { lock: true });
  requireCan(scope, 'inv.request.create', { locationId: q.to_location });
  if (q.status !== 'draft') throw fail(409, `Only a draft can be changed. This request is ${q.status.replace(/_/g, ' ')}.`, 'not_a_draft');
  const meta = requestMeta({ note: input.note ?? q.note, priority: input.priority ?? q.priority, neededBy: input.neededBy === undefined ? q.needed_by_text : input.neededBy });
  await db.query('update public.stock_requests set note = $2, priority = $3, needed_by = $4, updated_at = now() where id = $1', [q.id, meta.note, meta.priority, meta.neededBy]);
  if (input.lines !== undefined) {
    const lines = await parseLines(db, scope.businessId, input.lines, { label: 'The amount' });
    await db.query('delete from public.stock_request_lines where request_id = $1', [q.id]);
    await insertLines(db, q.id, lines);
  }
  await audit(db, { businessId: scope.businessId, locationId: q.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: 'edit_draft', after: { note: meta.note, priority: meta.priority, neededBy: meta.neededBy, lines: input.lines !== undefined } });
  return getRequest(db, scope, q.id);
}

/** draft -> submitted. */
export async function submit(db, scope, requestId, { now = new Date() } = {}) {
  const q = await loadRequest(db, scope, requestId, { lock: true });
  requireCan(scope, 'inv.request.create', { locationId: q.to_location });
  if (q.status !== 'draft') {
    if (q.status === 'submitted') return { ...(await getRequest(db, scope, q.id)), replayed: true };
    throw fail(409, `This request is already ${q.status.replace(/_/g, ' ')}.`, 'not_a_draft');
  }
  const n = (await db.query('select count(*)::int as n from public.stock_request_lines where request_id = $1', [q.id])).rows[0].n;
  if (!n) throw fail(400, 'Add at least one item before sending the request.', 'lines_required');
  await db.query(`update public.stock_requests set status = 'submitted', updated_at = now() where id = $1`, [q.id]);
  await audit(db, { businessId: scope.businessId, locationId: q.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: 'submit', before: { status: 'draft' }, after: { status: 'submitted' } });
  const branch = place(scope, q.to_location);
  await notifySubmitted(db, scope, { id: q.id, number: q.number, branchName: branch.name, lines: n, priority: q.priority }, now);
  return getRequest(db, scope, q.id);
}

/**
 * Cancels a request that has not been delivered: the branch (inv.request.create) or the owner (inv.request.approve). Releases what is still held
 * (after a partial dispatch only the undispatched remainder). Refused while a delivery is on its way (cancel the dispatch first).
 */
export async function cancel(db, scope, requestId, { reason = null } = {}) {
  const q = await loadRequest(db, scope, requestId, { lock: true });
  const mayBranch = can(scope, 'inv.request.create', { locationId: q.to_location });
  const mayOwner = can(scope, 'inv.request.approve', { locationId: q.to_location }) || can(scope, 'inv.transfer.dispatch', { locationId: scope.centerLocationId });
  if (!mayBranch && !mayOwner) requireCan(scope, 'inv.request.create', { locationId: q.to_location });
  if (q.status === 'cancelled') return { ...(await getRequest(db, scope, q.id)), replayed: true };
  if (!CANCELLABLE.includes(q.status)) throw fail(409, `This request is already ${q.status.replace(/_/g, ' ')}, so it can’t be cancelled.`, 'not_cancellable');
  const open = (await db.query(`select number, dispatched_at from public.stock_transfers where request_id = $1 and status = any($2::text[]) limit 1`, [q.id, OPEN_TRANSFER])).rows[0];
  if (open) throw fail(409, `${transferRef(open.number, open.dispatched_at)} is on its way for this request. Receive it, or ask the owner to cancel the dispatch, first.`, 'delivery_in_transit');
  const text = tidy(reason);
  if (text.length > MAX_NOTE) throw fail(400, `Keep the reason under ${MAX_NOTE} characters.`, 'note_too_long');
  const released = await releaseHolds(db, scope, q.id, 'request_cancelled');
  const sent = (await db.query('select coalesce(sum(dispatched), 0)::text as n from public.stock_request_lines where request_id = $1', [q.id])).rows[0].n;
  const status = cmp(sent, 0) > 0 ? 'completed' : 'cancelled';
  await db.query(`update public.stock_requests set status = $2, review_note = coalesce(review_note, $3), completed_at = case when $2 = 'completed' then now() else completed_at end, updated_at = now() where id = $1`,
    [q.id, status, text || (mayBranch ? 'Cancelled by the branch' : 'Cancelled by the owner')]);
  await audit(db, { businessId: scope.businessId, locationId: q.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: status === 'completed' ? 'cancel_remainder' : 'cancel',
    before: { status: q.status }, after: { status, released, reason: text || null } });
  if (!mayBranch || scope.roles.includes('owner')) {
    await tell(db, scope, { recipients: [`branch_managers:${q.restaurant_id}`], exclude: [scope.userId], kind: 'request_cancelled', title: `${requestRef(q.number, q.created_at)} was cancelled`, body: text || null,
      link: branchRequestsLink(q.restaurant_id), entity: { type: 'stock_request', id: q.id }, dedupeKey: `request_cancelled:${q.id}` });
  }
  return { ...(await getRequest(db, scope, q.id)), released };
}

/** Gives back whatever the request still holds at the Warehouse. Returns [{ itemId, released }]. */
async function releaseHolds(db, scope, requestId, reason) {
  const holds = (await db.query(`select id, item_id, (qty_reserved - qty_consumed - qty_released)::text as remaining from public.stock_reservations where request_id = $1 and status = 'active' order by item_id`, [requestId])).rows;
  const out = [];
  for (const h of holds) {
    const r = await ledger.release(db, h.id, { reason, actorId: scope.userId, idempotencyKey: clipKey(`req:${requestId}:release:${reason}:${h.id}`) });
    out.push({ itemId: h.item_id, released: r.released });
  }
  return out;
}

/* ---------- requests: the owner reviews (reserves) ---------- */

/**
 * input: { decision: 'approve' | 'reject', note?, lines?: [{ itemId, approved, unit? }] }. approve: each line defaults to what was asked; 0 declines that line; more than asked is
 * refused; at least one line > 0. Each approved line is HELD at the Warehouse (ledger.reserve): when it has less free than the owner approves, nothing is approved and the
 * message says how much is free (409 insufficient_available, details.available, details.itemId). reject needs a reason.
 */
export async function review(db, scope, requestId, input = {}, { now = new Date() } = {}) {
  const q = await loadRequest(db, scope, requestId, { lock: true });
  requireCan(scope, 'inv.request.approve', { locationId: q.to_location });
  await adoptLegacy(db, scope, { now });
  if (!['submitted', 'pending_approval'].includes(q.status)) {
    throw fail(409, q.status === 'draft' ? 'The branch hasn’t sent this request yet.' : `This request is already ${q.status.replace(/_/g, ' ')}.`, 'already_reviewed');
  }
  const text = input.note === undefined || input.note === null ? '' : tidy(input.note);
  if (text.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  const ref = requestRef(q.number, q.created_at);
  if (input.decision === 'reject') {
    if (!text) throw fail(400, 'Give the branch a reason for rejecting.', 'reason_required');
    await db.query(`update public.stock_requests set status = 'rejected', reviewed_by = $2, reviewed_at = $3, review_note = $4, updated_at = now() where id = $1`, [q.id, scope.userId, now, text]);
    await audit(db, { businessId: scope.businessId, locationId: q.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: 'reject', before: { status: q.status }, after: { status: 'rejected', note: text } });
    await tell(db, scope, { recipients: [`branch_managers:${q.restaurant_id}`], kind: 'request_rejected', title: `${ref} was rejected`, body: text, link: branchRequestsLink(q.restaurant_id), entity: { type: 'stock_request', id: q.id }, dedupeKey: `request_rejected:${q.id}` });
    return getRequest(db, scope, q.id);
  }
  if (input.decision !== 'approve') throw fail(400, 'Choose approve or reject.', 'bad_decision');
  const asked = (await db.query('select item_id, requested::text as requested from public.stock_request_lines where request_id = $1 order by item_id', [q.id])).rows;
  const items = await loadItems(db, scope.businessId, asked.map((l) => l.item_id));
  const units = await loadUnits(db);
  const given = new Map();
  for (const l of input.lines || []) given.set(needId(l.itemId, 'The stock item'), l);
  for (const id of given.keys()) if (!asked.some((l) => l.item_id === id)) throw fail(400, 'One of the lines isn’t on this request.', 'line_not_on_request');
  const plan = asked.map((l) => {
    const it = items.get(l.item_id);
    const g = given.get(l.item_id);
    const a = g ? amount(g.approved ?? g.quantity, g.unit, it, units, { label: `The approved amount for ${it.name}`, allowZero: true }).base : l.requested;
    if (cmp(a, l.requested) > 0) throw fail(400, `You can’t approve more than was asked for ${it.name} (${show(it, l.requested, units)}). Send extra as a separate dispatch.`, 'approved_over_requested');
    return { itemId: l.item_id, it, requested: l.requested, approved: rescale(a, QTY, 'half-up').toString(QTY) };
  });
  if (plan.every((p) => isZero(p.approved))) throw fail(400, 'Approve at least one item, or reject the request.', 'nothing_approved');
  for (const p of plan) {
    await db.query('update public.stock_request_lines set approved = $3 where request_id = $1 and item_id = $2', [q.id, p.itemId, p.approved]);
    if (isZero(p.approved)) continue;
    try {
      await ledger.reserve(db, { businessId: scope.businessId, locationId: scope.centerLocationId, itemId: p.itemId, qty: p.approved, requestId: q.id, actorId: scope.userId, idempotencyKey: clipKey(`req:${q.id}:${p.itemId}:approve`) });
    } catch (error) {
      if (error instanceof HttpError && error.details?.code === 'insufficient_available') throw fail(409, error.message, 'insufficient_available', { ...error.details, itemId: p.itemId, itemName: p.it.name });
      throw error;
    }
  }
  const full = plan.every((p) => cmp(p.approved, p.requested) === 0);
  const status = full ? 'approved' : 'partially_approved';
  await db.query(`update public.stock_requests set status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5, approved_by = $3, approved_at = $4, updated_at = now() where id = $1`,
    [q.id, status, scope.userId, now, text || null]);
  await audit(db, { businessId: scope.businessId, locationId: q.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: status === 'approved' ? 'approve' : 'approve_partial',
    before: { status: q.status }, after: { status, note: text || null, lines: plan.map((p) => ({ itemId: p.itemId, requested: p.requested, approved: p.approved })) } });
  await tell(db, scope, { recipients: [`branch_managers:${q.restaurant_id}`], kind: full ? 'request_approved' : 'request_partially_approved',
    title: full ? `${ref} was approved` : `${ref} was partly approved`,
    body: plan.filter((p) => cmp(p.approved, p.requested) < 0).map((p) => `${p.it.name}: ${show(p.it, p.approved, units)} of ${show(p.it, p.requested, units)}`).join('; ') || (text || null),
    link: branchRequestsLink(q.restaurant_id), entity: { type: 'stock_request', id: q.id }, dedupeKey: `request_approved:${q.id}` });
  return getRequest(db, scope, q.id);
}

/**
 * Moves an approved request to 'preparing' (idempotent) and returns the pick list: what is left to send per line (approved - dispatched), in the item's own pack
 * and in base units, sorted by where it is kept (storage, category, name).
 */
export async function startPreparing(db, scope, requestId, { now = new Date() } = {}) {
  const q = await loadRequest(db, scope, requestId, { lock: true });
  requireCan(scope, 'inv.transfer.dispatch', { locationId: scope.centerLocationId });
  await adoptLegacy(db, scope, { now });
  if (!['approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received'].includes(q.status)) {
    throw fail(409, q.status === 'submitted' ? 'Review the request before preparing it.' : `This request is ${q.status.replace(/_/g, ' ')}, so there is nothing to prepare.`, 'not_preparable');
  }
  if (['approved', 'partially_approved'].includes(q.status)) {
    await db.query(`update public.stock_requests set status = 'preparing', updated_at = now() where id = $1`, [q.id]);
    await audit(db, { businessId: scope.businessId, locationId: scope.centerLocationId, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: q.id, action: 'prepare', before: { status: q.status }, after: { status: 'preparing' } });
  }
  return pickList(db, scope, q.id);
}

export async function pickList(db, scope, requestId) {
  const q = await loadRequest(db, scope, requestId);
  requireCan(scope, 'inv.transfer.dispatch', { locationId: scope.centerLocationId });
  const lines = (await db.query(`select item_id, approved::text as approved, dispatched::text as dispatched from public.stock_request_lines where request_id = $1 and coalesce(approved, 0) > dispatched`, [q.id])).rows;
  const items = await loadItems(db, scope.businessId, lines.map((l) => l.item_id));
  const units = await loadUnits(db);
  const wh = await warehouseNumbers(db, scope, lines.map((l) => l.item_id));
  const rows = lines.map((l) => {
    const it = items.get(l.item_id);
    const remaining = sub(l.approved, l.dispatched, QTY).toString(QTY);
    const pack = it.units[0] || null;
    return { itemId: l.item_id, name: it.name, qtyBase: remaining, baseUnit: it.baseUnit, display: show(it, remaining, units),
      pack: pack ? { name: pack.name, factor: pack.factor, count: div(remaining, pack.factor, 2, 'half-up').toString(2) } : null,
      location: [it.storage, it.category].filter(Boolean).join(' / ') || 'Unsorted', storage: it.storage || null, category: it.category || null,
      warehouseOnHand: wh.get(l.item_id)?.onHand ?? '0.0000' };
  }).sort((a, b) => (a.storage || '~').localeCompare(b.storage || '~') || (a.category || '~').localeCompare(b.category || '~') || a.name.localeCompare(b.name));
  return { request: { id: q.id, ref: requestRef(q.number, q.created_at), number: q.number, status: q.status, branchId: q.restaurant_id,
    branchName: place(scope, q.to_location).name }, lines: rows };
}

/* ---------- transfers: reading ---------- */

const TRANSFER_SELECT = `select t.*, lf.kind as from_kind, lf.restaurant_id as from_restaurant, case when lf.kind = 'branch' then coalesce(rf.name, lf.name) else 'Warehouse' end as from_name,
    lt.kind as to_kind, lt.restaurant_id as to_restaurant, case when lt.kind = 'branch' then coalesce(rt.name, lt.name) else 'Warehouse' end as to_name, pd.name as dispatched_by_name, pr.name as received_by_name
  from public.stock_transfers t join public.stock_locations lf on lf.id = t.from_location left join public.restaurants rf on rf.id = lf.restaurant_id
  join public.stock_locations lt on lt.id = t.to_location left join public.restaurants rt on rt.id = lt.restaurant_id
  left join public.profiles pd on pd.id = t.dispatched_by left join public.profiles pr on pr.id = t.received_by`;

async function loadTransfer(db, scope, id, { lock = false } = {}) {
  const row = (await db.query(`${TRANSFER_SELECT} where t.id = $1 and t.business_id = $2 ${lock ? 'for update of t' : ''}`, [needId(id, 'The delivery'), scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That delivery isn’t in this business.', 'transfer_not_found');
  return row;
}

/** { fromLocationId, toLocationId, direction, status, requestId } for routes that authorise before the transaction. */
export async function transferLocations(db, businessId, id) {
  if (!isId(id)) throw fail(400, 'That delivery id is invalid.', 'bad_id');
  const row = (await db.query('select from_location, to_location, direction, status, request_id from public.stock_transfers where id = $1 and business_id = $2', [id.toLowerCase(), businessId])).rows[0];
  if (!row) throw fail(404, 'That delivery isn’t in this business.', 'transfer_not_found');
  return { fromLocationId: row.from_location, toLocationId: row.to_location, direction: row.direction, status: row.status, requestId: row.request_id };
}

/** Finds a delivery by its 10-letter code across businesses (the QR landing). Only ids; the route then builds the scope and checks the caller. */
export async function codeOwner(db, code) {
  const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(clean)) throw fail(400, 'Enter the 10-character code on the dispatch note.', 'bad_code');
  const row = (await db.query('select id, business_id, to_location, from_location from public.stock_transfers where code = $1', [clean])).rows[0];
  if (!row) throw fail(404, 'No delivery with that code was found. Check the code on the dispatch note.', 'code_not_found');
  return { transferId: row.id, businessId: row.business_id, toLocationId: row.to_location, fromLocationId: row.from_location };
}

async function transferViews(db, scope, rows, { detail = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lineRows = (await db.query(`select transfer_id, item_id, quantity::text as quantity, received::text as received, damaged::text as damaged, over::text as over, unit_cost::text as unit_cost, entered_unit
    from public.stock_transfer_lines where transfer_id = any($1::uuid[])`, [ids])).rows;
  const items = await loadItems(db, scope.businessId, lineRows.map((l) => l.item_id));
  const units = await loadUnits(db);
  const disc = (await db.query(`select d.*, d.qty_base::text as qty_text, d.value_kes::text as value_text from public.transfer_discrepancies d where d.transfer_id = any($1::uuid[]) order by d.created_at, d.kind`, [ids])).rows;
  const requests = new Map((await db.query('select id, number, created_at, restaurant_id from public.stock_requests where id = any($1::uuid[])', [rows.map((r) => r.request_id).filter(Boolean)])).rows.map((r) => [r.id, r]));
  const approvalRows = new Map();
  if (detail) {
    for (const a of (await db.query(`select id, subject_id, status, decided_by, decided_at, decision_note, self_approved, requested_by from public.approvals where business_id = $1 and subject_type = 'transfer' and subject_id = any($2::uuid[]) order by requested_at`, [scope.businessId, ids])).rows) approvalRows.set(a.subject_id, a);
  }
  const meta = new Map();
  if (detail) {
    for (const e of (await db.query(`select entity_id, after from public.inventory_events where business_id = $1 and entity = 'transfer' and action = 'dispatch' and entity_id = any($2::uuid[]) order by id`, [scope.businessId, ids])).rows) {
      meta.set(e.entity_id, typeof e.after === 'string' ? JSON.parse(e.after) : e.after);
    }
  }
  return rows.map((t) => {
    const showCost = can(scope, 'inv.cost.view', { locationId: t.from_location }) || can(scope, 'inv.cost.view', { locationId: t.to_location });
    const sees = can(scope, 'inv.transfer.receive', { locationId: t.to_location }) || can(scope, 'inv.transfer.dispatch', { locationId: t.from_location }) || can(scope, 'inv.request.create', { locationId: t.from_location });
    const lines = lineRows.filter((l) => l.transfer_id === t.id).map((l) => {
      const it = items.get(l.item_id);
      const got = l.received ?? '0.0000';
      const outstanding = sub(sub(l.quantity, got, QTY), l.damaged, QTY);
      return { itemId: l.item_id, name: it?.name, unit: it?.baseUnit, quantity: l.quantity, received: got, damaged: l.damaged, over: l.over,
        outstanding: isNeg(outstanding) ? '0.0000' : outstanding.toString(QTY), display: it ? show(it, l.quantity, units) : null, receivedDisplay: it ? show(it, got, units) : null,
        unitCost: showCost ? l.unit_cost : null };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const req = t.request_id ? requests.get(t.request_id) : null;
    const m = meta.get(t.id) || null;
    const view = {
      id: t.id, number: t.number, ref: transferRef(t.number, t.dispatched_at), direction: t.direction, status: t.status, requestId: t.request_id,
      requestRef: req ? requestRef(req.number, req.created_at) : null,
      fromLocationId: t.from_location, fromName: t.from_name, fromBranchId: t.from_restaurant, toLocationId: t.to_location, toName: t.to_name, toBranchId: t.to_restaurant,
      note: t.note, dispatchedAt: t.dispatched_at, dispatchedBy: t.dispatched_by, dispatchedByName: t.dispatched_by_name || null, receivedAt: t.received_at, receivedByName: t.received_by_name || null,
      approvedAt: t.approved_at, approvedBy: t.approved_by, awaitingApproval: t.status === 'pending_approval' && !t.approved_at, awaitingDispatch: t.status === 'pending_approval' && Boolean(t.approved_at),
      inTransit: ['in_transit', 'partially_received'].includes(t.status),
      code: sees && t.status !== 'cancelled' ? t.code : undefined,
      qr: sees && t.status !== 'cancelled' ? { code: t.code, path: `/receive/${t.code}` } : undefined,
      lines,
      discrepancies: disc.filter((d) => d.transfer_id === t.id).map((d) => ({ id: d.id, itemId: d.item_id, name: items.get(d.item_id)?.name, kind: d.kind, quantity: d.qty_text,
        display: items.get(d.item_id) ? show(items.get(d.item_id), d.qty_text, units) : null, valueKes: showCost ? d.value_text : null, status: d.status, bearer: d.bearer, resolution: d.resolution, note: d.note, createdAt: d.created_at })),
    };
    if (detail) {
      const a = approvalRows.get(t.id);
      view.approval = a ? { id: a.id, status: a.status, decidedAt: a.decided_at, decisionNote: a.decision_note, selfApproved: a.self_approved } : null;
      if (sees && t.status !== 'pending_approval') {
        view.deliveryNote = { ref: view.ref, number: t.number, code: t.code, qr: view.qr, direction: t.direction, from: t.from_name, to: t.to_name, dispatchedAt: t.dispatched_at, dispatchedBy: t.dispatched_by_name || null,
          driver: m?.driver || null, vehicle: m?.vehicle || null, note: t.note, requestRef: view.requestRef, lines: lines.map((l) => ({ itemId: l.itemId, name: l.name, quantity: l.quantity, display: l.display, unit: l.unit })) };
      }
    }
    return view;
  });
}

/** One delivery with its lines, discrepancies, approval and (for the sender and receiver) the dispatch note JSON and QR payload. */
export async function getTransfer(db, scope, id) {
  const t = await loadTransfer(db, scope, id);
  const may = can(scope, 'inv.view', { locationId: t.from_location }) || can(scope, 'inv.view', { locationId: t.to_location });
  if (!may) requireCan(scope, 'inv.view', { locationId: t.to_location });
  return { transfer: (await transferViews(db, scope, [t], { detail: true }))[0] };
}

/** Deliveries the caller can see (sender or receiver side). { direction, status ('active' = on its way or waiting, or a list), locationId, limit }. */
export async function listTransfers(db, scope, { locationId = null, direction = null, status = null, limit = 50 } = {}) {
  const visible = locationsWith(scope, 'inv.view');
  if (!visible.length) throw fail(403, 'You don’t have access to this.', 'forbidden');
  let places = visible;
  if (locationId) {
    const id = needId(locationId, 'The place');
    if (!visible.includes(id)) throw fail(403, 'You don’t have access to this branch.', 'branch_forbidden');
    places = [id];
  }
  const args = [scope.businessId, places];
  const where = ['t.business_id = $1', '(t.from_location = any($2::uuid[]) or t.to_location = any($2::uuid[]))'];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (direction) {
    if (!['out', 'return', 'branch_to_branch'].includes(direction)) throw fail(400, 'The direction must be out, return or branch_to_branch.', 'bad_direction');
    where.push(`t.direction = ${arg(direction)}`);
  }
  if (status) {
    const wanted = status === 'active' ? OPEN_TRANSFER : String(status).split(',').map((s) => s.trim());
    if (!wanted.every((s) => TRANSFER_STATUSES.includes(s))) throw fail(400, `The status must be active or one of: ${TRANSFER_STATUSES.join(', ')}.`, 'bad_status');
    where.push(`t.status = any(${arg(wanted)}::text[])`);
  }
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = (await db.query(`${TRANSFER_SELECT} where ${where.join(' and ')} order by t.dispatched_at desc, t.number desc limit ${size}`, args)).rows;
  return { transfers: await transferViews(db, scope, rows) };
}

/* ---------- dispatch ---------- */

async function insertTransfer(db, scope, { direction, from, to, requestId = null, status, note = null, lines, now }) {
  const number = await nextInteger(db, 'stock_transfers', scope.businessId);
  const code = newCode();
  const { id } = (await db.query(`insert into public.stock_transfers (business_id, number, code, from_location, to_location, request_id, status, note, dispatched_by, dispatched_at, direction)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`, [scope.businessId, number, code, from, to, requestId, status, note, scope.userId, now, direction])).rows[0];
  for (const l of lines) {
    await db.query('insert into public.stock_transfer_lines (transfer_id, item_id, quantity, entered_unit) values ($1, $2, $3, $4)', [id, l.itemId, l.base, l.unit]);
  }
  return { id, number, code };
}

/**
 * Takes the stock out of the sender for every line of a stored transfer, puts it in transit and records the dispatch note details.
 * `holds` (itemId -> reservation id) lets a request's dispatch use up its hold. `respectHeld` keeps branch stock that open orders need.
 */
async function sendTransfer(db, scope, t, { holds = new Map(), respectHeld = false, note = undefined, driver = null, vehicle = null, now }) {
  const lines = (await db.query('select item_id, quantity::text as quantity, entered_unit from public.stock_transfer_lines where transfer_id = $1 order by item_id', [t.id])).rows;
  const posted = [];
  for (const l of lines) {
    let res;
    try {
      res = await ledger.post(db, { businessId: scope.businessId, locationId: t.from_location, itemId: l.item_id, qty: `-${l.quantity}`, reason: 'transfer_dispatch',
        ref: { type: 'transfer', id: t.id }, counterpartyLocationId: t.to_location, reservationId: holds.get(l.item_id) || null, respectHeld,
        note: `${transferRef(t.number, now)}`, actorId: scope.userId, idempotencyKey: clipKey(`trf:${t.id}:out:${l.item_id}`), occurredAt: now });
    } catch (error) {
      if (error instanceof HttpError && ['insufficient_stock', 'stock_reserved', 'stock_held'].includes(error.details?.code)) {
        throw fail(409, error.message, error.details.code, { ...error.details, itemId: l.item_id });
      }
      throw error;
    }
    posted.push({ itemId: l.item_id, movementId: res.movement.id, unitCost: res.movement.unitCost });
    await db.query('update public.stock_transfer_lines set unit_cost = $3 where transfer_id = $1 and item_id = $2', [t.id, l.item_id, res.movement.unitCost]);
  }
  await db.query(`update public.stock_transfers set status = 'in_transit', dispatched_at = $2, dispatched_by = $3, note = coalesce($4, note) where id = $1`, [t.id, now, scope.userId, note === undefined ? null : note]);
  await audit(db, { businessId: scope.businessId, locationId: t.from_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: 'dispatch',
    after: { ref: transferRef(t.number, now), direction: t.direction, from: t.from_location, to: t.to_location, driver, vehicle, requestId: t.request_id, movements: posted } });
  return posted;
}

function deliveryMeta(input) {
  const note = input.note === undefined || input.note === null ? undefined : tidy(input.note) || undefined;
  if (note && note.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  const driver = input.driver ? tidy(input.driver).slice(0, 80) : null;
  const vehicle = input.vehicle ? tidy(input.vehicle).slice(0, 40) : null;
  return { note, driver, vehicle };
}

const notifyIncoming = (db, scope, t, from, to, now) => tell(db, scope, {
  recipients: to.restaurantId ? [`branch_managers:${to.restaurantId}`] : 'owners', kind: 'delivery_incoming',
  title: `A delivery from ${from.name} is on its way`, body: `${transferRef(t.number, now)}, code ${t.code}.`, link: to.restaurantId ? branchRequestsLink(to.restaurantId, `?receive=${t.id}`) : OWNER_REQUESTS_LINK, entity: { type: 'transfer', id: t.id }, dedupeKey: `delivery_incoming:${t.id}` });

/**
 * The owner sends stock from the Warehouse to a branch, either for a request or directly.
 *   input: { requestId?, lines?: [{ itemId, quantity, unit? }], branchId? (restaurant id; direct dispatch), note?, driver?, vehicle? }
 *   with requestId: lines default to everything still to send (approved - dispatched); a line may be less (partial dispatch: the rest stays held); not more.
 *   without: a direct dispatch (owner only) of `lines` to `branchId`; it cannot dip into stock held for approved requests.
 */
export async function dispatch(db, scope, input = {}, { now = new Date() } = {}) {
  requireCan(scope, 'inv.transfer.dispatch', { locationId: scope.centerLocationId });
  await adoptLegacy(db, scope, { now });
  const meta = deliveryMeta(input);
  const units = await loadUnits(db);
  let q = null;
  let toLoc;
  let lines;
  const holds = new Map();
  if (input.requestId) {
    q = await loadRequest(db, scope, input.requestId, { lock: true });
    await syncProgress(db, q.id);
    if (!DISPATCHABLE.includes(q.status)) {
      throw fail(409, q.status === 'submitted' ? 'Review the request before dispatching.' : `This request is ${q.status.replace(/_/g, ' ')}, so it can’t be dispatched.`, 'not_dispatchable');
    }
    const open = (await db.query(`select number, status, dispatched_at from public.stock_transfers where request_id = $1 and status = any($2::text[]) limit 1`, [q.id, OPEN_TRANSFER])).rows[0];
    if (open) throw fail(409, `${transferRef(open.number, open.dispatched_at)} is still ${WORDS[open.status]}. Receive it or cancel it before sending the rest.`, 'delivery_open');
    toLoc = branchPlace(scope, q.to_location);
    const rem = (await db.query(`select item_id, (approved - dispatched)::text as remaining from public.stock_request_lines where request_id = $1 and coalesce(approved, 0) > dispatched order by item_id`, [q.id])).rows;
    if (!rem.length) throw fail(409, 'Everything approved on this request has already been sent.', 'nothing_to_dispatch');
    const items = await loadItems(db, scope.businessId, rem.map((r) => r.item_id));
    if (Array.isArray(input.lines) && input.lines.length) {
      const wanted = await parseLines(db, scope.businessId, input.lines, { label: 'The amount to send', units });
      lines = wanted.map((w) => {
        const r = rem.find((x) => x.item_id === w.itemId);
        if (!r) throw fail(400, `${w.item.name} isn’t waiting to be sent on this request.`, 'line_not_pending');
        if (cmp(w.base, r.remaining) > 0) throw fail(409, `Only ${show(w.item, r.remaining, units)} of ${w.item.name} is left to send on this request; you tried to send ${show(w.item, w.base, units)}.`, 'dispatch_over_approved');
        return w;
      });
    } else {
      lines = rem.map((r) => ({ itemId: r.item_id, item: items.get(r.item_id), base: r.remaining, entered: null, unit: items.get(r.item_id).baseUnit }));
    }
    for (const h of (await db.query(`select id, item_id from public.stock_reservations where request_id = $1 and status = 'active'`, [q.id])).rows) holds.set(h.item_id, h.id);
  } else {
    if (!input.branchId) throw fail(400, 'Say which branch to send to.', 'branch_required');
    toLoc = branchLocationOf(scope, input.branchId);
    lines = await parseLines(db, scope.businessId, input.lines, { label: 'The amount to send', units });
  }
  const from = place(scope, scope.centerLocationId);
  const created = await insertTransfer(db, scope, { direction: 'out', from: scope.centerLocationId, to: toLoc.id, requestId: q?.id || null, status: 'in_transit', note: meta.note || null, lines, now });
  const t = { id: created.id, number: created.number, code: created.code, from_location: scope.centerLocationId, to_location: toLoc.id, direction: 'out', request_id: q?.id || null };
  await sendTransfer(db, scope, t, { holds, respectHeld: false, note: undefined, driver: meta.driver, vehicle: meta.vehicle, now });
  if (q) {
    await syncProgress(db, q.id);
    await db.query(`update public.stock_requests set status = 'dispatched', updated_at = now() where id = $1`, [q.id]);
  }
  await notifyIncoming(db, scope, t, from, toLoc, now);
  const out = await getTransfer(db, scope, t.id);
  return { ...out, request: q ? (await getRequest(db, scope, q.id)).request : null };
}

/**
 * The owner takes back a delivery that nobody has received (any line counted already -> refused: resolve it as a discrepancy instead).
 * The stock goes back to the sender; for a request the lines become sendable again and the hold is put back (re-reserved).
 */
export async function cancelDispatch(db, scope, transferId, { now = new Date() } = {}) {
  const t = await loadTransfer(db, scope, transferId, { lock: true });
  requireCan(scope, 'inv.transfer.dispatch', { locationId: t.from_location });
  if (t.status === 'cancelled') return { ...(await getTransfer(db, scope, t.id)), replayed: true };
  if (t.status !== 'in_transit') {
    throw fail(409, t.status === 'received' || t.status === 'partially_received' ? `This delivery was already ${t.status === 'received' ? 'received' : 'partly received'}, so it can’t be cancelled. Resolve what is missing as a discrepancy instead.` : `This delivery is ${WORDS[t.status]}.`, 'not_cancellable');
  }
  const lines = (await db.query(`select item_id, quantity::text as quantity, unit_cost::text as unit_cost, coalesce(received, 0)::text as received, damaged::text as damaged, over::text as over
    from public.stock_transfer_lines where transfer_id = $1 order by item_id`, [t.id])).rows;
  if (lines.some((l) => !isZero(l.received) || !isZero(l.damaged) || !isZero(l.over))) throw fail(409, 'Part of this delivery was already counted, so it can’t be cancelled. Resolve what is missing as a discrepancy instead.', 'already_received');
  for (const l of lines) {
    await ledger.post(db, { businessId: scope.businessId, locationId: t.from_location, itemId: l.item_id, qty: l.quantity, reason: 'transfer_cancelled', unitCost: l.unit_cost,
      ref: { type: 'transfer', id: t.id }, counterpartyLocationId: t.to_location, note: `${transferRef(t.number, t.dispatched_at)} cancelled`, actorId: scope.userId,
      idempotencyKey: clipKey(`trf:${t.id}:cancel:${l.item_id}`), occurredAt: now });
  }
  await db.query(`update public.stock_transfers set status = 'cancelled', cancelled_by = $2, cancelled_at = $3 where id = $1`, [t.id, scope.userId, now]);
  let rereserved = [];
  if (t.request_id) {
    const q = await loadRequest(db, scope, t.request_id, { lock: true });
    await db.query(`update public.stock_request_lines set dispatched = 0, received = 0 where request_id = $1 and item_id = any($2::uuid[])`, [q.id, lines.map((l) => l.item_id)]);
    await syncProgress(db, q.id);
    rereserved = await restoreHolds(db, scope, q.id, t.id);
    const sent = (await db.query('select coalesce(sum(dispatched), 0)::text as n, bool_or(approved < requested) as cut from public.stock_request_lines where request_id = $1', [q.id])).rows[0];
    const status = cmp(sent.n, 0) > 0 ? 'partially_received' : (sent.cut ? 'partially_approved' : 'approved');
    await db.query('update public.stock_requests set status = $2, updated_at = now() where id = $1', [q.id, status]);
  }
  await audit(db, { businessId: scope.businessId, locationId: t.from_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: 'cancel_dispatch',
    before: { status: 'in_transit' }, after: { status: 'cancelled', rereserved } });
  await tell(db, scope, { recipients: t.to_restaurant ? [`branch_managers:${t.to_restaurant}`] : 'owners', exclude: [scope.userId], kind: 'delivery_cancelled',
    title: `${transferRef(t.number, t.dispatched_at)} was cancelled`, body: 'The goods did not leave. Do not receive them.', link: t.to_restaurant ? branchRequestsLink(t.to_restaurant) : OWNER_REQUESTS_LINK, entity: { type: 'transfer', id: t.id }, dedupeKey: `delivery_cancelled:${t.id}` });
  return getTransfer(db, scope, t.id);
}

/** Makes every approved-but-unsent line hold exactly what is left to send (after stock came back). Returns [{ itemId, held }]. */
async function restoreHolds(db, scope, requestId, tag) {
  const lines = (await db.query(`select item_id, (approved - dispatched)::text as remaining from public.stock_request_lines where request_id = $1 and coalesce(approved, 0) > dispatched order by item_id`, [requestId])).rows;
  const out = [];
  for (const l of lines) {
    const active = (await db.query(`select id, (qty_reserved - qty_consumed - qty_released)::text as remaining from public.stock_reservations where request_id = $1 and item_id = $2 and status = 'active'`, [requestId, l.item_id])).rows[0];
    if (active) {
      if (cmp(active.remaining, l.remaining) >= 0) { out.push({ itemId: l.item_id, held: active.remaining }); continue; }
      await ledger.release(db, active.id, { reason: 'rebuilt_after_cancelled_dispatch', actorId: scope.userId, idempotencyKey: clipKey(`req:${requestId}:rebuild:${tag}:${l.item_id}`) });
    }
    await ledger.reserve(db, { businessId: scope.businessId, locationId: scope.centerLocationId, itemId: l.item_id, qty: l.remaining, requestId, actorId: scope.userId, idempotencyKey: clipKey(`req:${requestId}:${l.item_id}:rehold:${tag}`) });
    out.push({ itemId: l.item_id, held: l.remaining });
  }
  return out;
}

/* ---------- receive ---------- */

/**
 * The destination confirms what arrived. input: { lines: [{ itemId, received, damaged?, over?, unit? }], note?, final? (default true) }.
 *   received  the good amount counted (added to the branch's stock at the dispatch cost); damaged  broken on arrival (NOT added); over  more than was sent.
 *   If good + damaged is more than what was still expected and `over` is left out, the extra is taken as over.
 *   Over is accepted only up to transfer_over_tolerance_pct of what was sent (409 over_delivery_too_large beyond it).
 *   Any difference (short, damaged, over) needs a note and opens a discrepancy row for the owner. `final: false` means more of this delivery is still to come
 *   (status partially_received, shortages are not raised yet); the default closes the delivery and any shortage is recorded.
 * Amounts are in each line's `unit` (default: the item's display unit).
 */
export async function receive(db, scope, transferId, input = {}, { now = new Date() } = {}) {
  const t = await loadTransfer(db, scope, transferId, { lock: true });
  requireCan(scope, 'inv.transfer.receive', { locationId: t.to_location });
  if (!['in_transit', 'partially_received'].includes(t.status)) {
    throw fail(409, t.status === 'pending_approval' ? 'This delivery hasn’t been sent yet.' : `This delivery is already ${WORDS[t.status] || t.status}.`, 'not_receivable');
  }
  const final = input.final !== false;
  const text = input.note === undefined || input.note === null ? '' : tidy(input.note);
  if (text.length > MAX_NOTE) throw fail(400, `Keep the note under ${MAX_NOTE} characters.`, 'note_too_long');
  const settings = await getSettings(db, scope.businessId);
  const tolerance = settings.transfer_over_tolerance_pct;
  const lines = (await db.query(`select item_id, quantity::text as quantity, coalesce(received, 0)::text as received, damaged::text as damaged, over::text as over, unit_cost::text as unit_cost
    from public.stock_transfer_lines where transfer_id = $1 order by item_id`, [t.id])).rows;
  const items = await loadItems(db, scope.businessId, lines.map((l) => l.item_id));
  const units = await loadUnits(db);
  const given = new Map();
  for (const l of input.lines || []) given.set(needId(l.itemId, 'The stock item'), l);
  for (const id of given.keys()) if (!lines.some((l) => l.item_id === id)) throw fail(400, 'One of the items isn’t on this delivery.', 'line_not_on_delivery');
  const from = place(scope, t.from_location);

  // 1. Work everything out (and refuse) before posting anything.
  const plan = [];
  let anyDifference = false;
  for (const l of lines) {
    const it = items.get(l.item_id);
    const outstanding = sub(sub(l.quantity, l.received, QTY), l.damaged, QTY);
    const g = given.get(l.item_id);
    if (!g) {
      if (final && !isZero(outstanding) && !isNeg(outstanding)) throw fail(400, `Enter what arrived of ${it.name}. Put 0 if none came.`, 'line_missing');
      plan.push({ l, it, outstanding, good: dec('0'), dmg: dec('0'), over: dec('0'), short: final && !isNeg(outstanding) ? outstanding : dec('0') });
      continue;
    }
    let good = dec(amount(g.received ?? g.good, g.unit, it, units, { label: `The amount received of ${it.name}`, allowZero: true }).base);
    const dmg = dec(amount(g.damaged, g.unit, it, units, { label: `The damaged amount of ${it.name}`, allowZero: true }).base);
    let over = dec(amount(g.over, g.unit, it, units, { label: `The extra amount of ${it.name}`, allowZero: true }).base);
    const excess = sub(add(good, dmg), outstanding);
    if (cmp(excess, 0) > 0) {
      if (g.over !== undefined && g.over !== null && String(g.over).trim() !== '' && cmp(excess, 0) > 0) {
        throw fail(400, `${it.name}: the good and damaged amounts add up to more than the ${show(it, isNeg(outstanding) ? '0' : outstanding.toString(QTY), units)} still expected. Put the extra under “over”.`, 'amounts_exceed_expected');
      }
      if (cmp(good, excess) < 0) throw fail(400, `${it.name}: the damaged amount is more than was expected. Count again.`, 'amounts_exceed_expected');
      over = add(over, excess);
      good = sub(good, excess);
    }
    const short = final ? sub(sub(outstanding, good), dmg) : dec('0');
    if (cmp(over, 0) > 0) {
      const allowed = div(mul(l.quantity, tolerance, 8, 'half-up'), 100, QTY, 'half-up');
      if (cmp(add(l.over, over), allowed) > 0) {
        throw fail(409, `${it.name}: ${show(it, over.toString(QTY), units)} more than was sent is over the ${tolerance}% extra allowed (${show(it, allowed.toString(QTY), units)}). Count again, or ask the owner.`, 'over_delivery_too_large', { itemId: l.item_id, allowed: allowed.toString(QTY) });
      }
    }
    if (cmp(dmg, 0) > 0 || cmp(over, 0) > 0 || cmp(short, 0) > 0) anyDifference = true;
    plan.push({ l, it, outstanding, good, dmg, over, short });
  }
  if (anyDifference && !text) throw fail(400, 'Something didn’t arrive as sent (short, damaged or extra). Add a note saying what happened.', 'note_required');
  if (!plan.some((p) => cmp(p.good, 0) > 0 || cmp(p.dmg, 0) > 0 || cmp(p.over, 0) > 0 || cmp(p.short, 0) > 0)) throw fail(400, 'Enter what arrived before confirming.', 'nothing_received');

  // 2. Post and record.
  const round = (await db.query(`select count(*)::int as n from public.inventory_events where business_id = $1 and entity = 'transfer' and entity_id = $2 and action in ('receive', 'receive_part')`, [scope.businessId, t.id])).rows[0].n + 1;
  const created = [];
  const posted = [];
  for (const p of plan) {
    const { l, it } = p;
    if (cmp(p.good, 0) > 0) {
      const r = await ledger.post(db, { businessId: scope.businessId, locationId: t.to_location, itemId: l.item_id, qty: p.good.toString(QTY), reason: 'transfer_receipt', unitCost: l.unit_cost,
        ref: { type: 'transfer', id: t.id }, counterpartyLocationId: t.from_location, note: text || null, actorId: scope.userId, idempotencyKey: clipKey(`trf:${t.id}:in:${l.item_id}:r${round}`), occurredAt: now });
      posted.push(r.movement.id);
    }
    if (cmp(p.over, 0) > 0) {
      const r = await ledger.post(db, { businessId: scope.businessId, locationId: t.to_location, itemId: l.item_id, qty: p.over.toString(QTY), reason: 'transfer_discrepancy', unitCost: l.unit_cost,
        ref: { type: 'transfer', id: t.id }, counterpartyLocationId: t.from_location, note: `Over-delivery: ${text}`.slice(0, 280), actorId: scope.userId, idempotencyKey: clipKey(`trf:${t.id}:over:${l.item_id}:r${round}`), occurredAt: now });
      posted.push(r.movement.id);
    }
    if (cmp(p.good, 0) > 0 || cmp(p.dmg, 0) > 0 || cmp(p.over, 0) > 0) {
      await db.query(`update public.stock_transfer_lines set received = coalesce(received, 0) + $3, damaged = damaged + $4, over = over + $5 where transfer_id = $1 and item_id = $2`,
        [t.id, l.item_id, p.good.toString(QTY), p.dmg.toString(QTY), p.over.toString(QTY)]);
    }
    for (const [kind, qty] of [['short', p.short], ['damaged', p.dmg], ['over', p.over]]) {
      if (cmp(qty, 0) <= 0) continue;
      const value = l.unit_cost === null ? null : mul(qty, l.unit_cost, MONEY, 'half-up').toString(MONEY);
      const row = (await db.query(`insert into public.transfer_discrepancies (business_id, transfer_id, item_id, kind, qty_base, value_kes, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (transfer_id, item_id, kind) where status = 'open' do update set qty_base = public.transfer_discrepancies.qty_base + excluded.qty_base,
          value_kes = case when public.transfer_discrepancies.value_kes is null or excluded.value_kes is null then coalesce(excluded.value_kes, public.transfer_discrepancies.value_kes) else public.transfer_discrepancies.value_kes + excluded.value_kes end,
          note = excluded.note returning id`, [scope.businessId, t.id, l.item_id, kind, qty.toString(QTY), value, text || null, scope.userId])).rows[0];
      created.push({ id: row.id, itemId: l.item_id, name: it.name, kind, quantity: qty.toString(QTY), display: show(it, qty.toString(QTY), units), valueKes: value });
    }
  }
  const after = (await db.query(`select item_id, quantity::text as quantity, coalesce(received, 0)::text as received, damaged::text as damaged from public.stock_transfer_lines where transfer_id = $1`, [t.id])).rows;
  const stillOut = after.some((l) => cmp(sub(sub(l.quantity, l.received, QTY), l.damaged, QTY), 0) > 0);
  const closed = final || !stillOut;
  await db.query(`update public.stock_transfers set status = $2, received_by = case when $2 = 'received' then $3::uuid else received_by end, received_at = case when $2 = 'received' then $4::timestamptz else received_at end where id = $1`,
    [t.id, closed ? 'received' : 'partially_received', scope.userId, now]);
  if (t.request_id) await settleRequestAfterReceipt(db, scope, t.request_id, closed, now);
  await audit(db, { businessId: scope.businessId, locationId: t.to_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: closed ? 'receive' : 'receive_part',
    before: { status: t.status }, after: { status: closed ? 'received' : 'partially_received', note: text || null, round,
      lines: plan.map((p) => ({ itemId: p.l.item_id, received: p.good.toString(QTY), damaged: p.dmg.toString(QTY), over: p.over.toString(QTY), short: p.short.toString(QTY) })), movements: posted, discrepancies: created.map((d) => d.id) } });

  // 3. Tell people.
  const ref = transferRef(t.number, t.dispatched_at);
  const sides = ['owners', ...(t.from_restaurant ? [`branch_managers:${t.from_restaurant}`] : []), ...(t.to_restaurant ? [`branch_managers:${t.to_restaurant}`] : [])];
  if (created.length) {
    await tell(db, scope, { recipients: sides, exclude: [scope.userId], kind: 'discrepancy_opened', title: `${ref} arrived with differences`,
      body: `${created.map((d) => `${d.kind} ${d.display} of ${d.name}`).join('; ')}. ${text}`.slice(0, 900), link: OWNER_PROBLEMS_LINK, entity: { type: 'transfer', id: t.id }, dedupeKey: `discrepancy_opened:${t.id}:r${round}` });
  }
  await tell(db, scope, { recipients: ['owners', ...(t.from_restaurant ? [`branch_managers:${t.from_restaurant}`] : [])], exclude: [scope.userId], kind: 'delivery_received',
    title: `${ref} ${closed ? 'was received' : 'was partly received'} at ${t.to_name}`, body: created.length ? 'There were differences; see the discrepancy.' : `${from.name} to ${t.to_name}.`,
    link: OWNER_REQUESTS_LINK, entity: { type: 'transfer', id: t.id }, dedupeKey: `delivery_received:${t.id}:r${round}` });
  const out = await getTransfer(db, scope, t.id);
  return { ...out, discrepanciesOpened: created, closed, request: t.request_id ? (await getRequest(db, scope, t.request_id)).request : null };
}

/** Recomputes a request's per-line dispatched / received from its deliveries (so a 009 dispatch made by `main` after migration 018, which doesn't know these columns, still counts). */
async function syncProgress(db, requestId) {
  await db.query(`update public.stock_request_lines l set dispatched = s.d, received = s.r from (
      select tl.item_id, sum(tl.quantity) as d, sum(coalesce(tl.received, 0)) as r from public.stock_transfer_lines tl join public.stock_transfers t on t.id = tl.transfer_id
       where t.request_id = $1 and t.status in ('in_transit', 'partially_received', 'received') group by tl.item_id) s
    where l.request_id = $1 and l.item_id = s.item_id`, [requestId]);
}

/** Moves the request's status after a receipt: partially_received while goods are still expected or to be sent, else received / completed. */
async function settleRequestAfterReceipt(db, scope, requestId, closed, now) {
  await syncProgress(db, requestId);
  const open = (await db.query(`select 1 from public.stock_transfers where request_id = $1 and status = any($2::text[]) limit 1`, [requestId, OPEN_TRANSFER])).rows[0];
  const rem = (await db.query(`select 1 from public.stock_request_lines where request_id = $1 and coalesce(approved, 0) > dispatched limit 1`, [requestId])).rows[0];
  if (open || !closed || rem) {
    await db.query(`update public.stock_requests set status = 'partially_received', updated_at = now() where id = $1`, [requestId]);
    return;
  }
  await db.query(`update public.stock_requests set status = 'received', updated_at = now() where id = $1`, [requestId]);
  await settleRequest(db, requestId, now);
}

/** 'received' -> 'completed' once none of the request's deliveries has an open discrepancy (P2-23 calls this after a resolution). */
export async function settleRequest(db, requestId, now = new Date()) {
  const open = (await db.query(`select 1 from public.transfer_discrepancies d join public.stock_transfers t on t.id = d.transfer_id where t.request_id = $1 and d.status = 'open' limit 1`, [requestId])).rows[0];
  if (open) return false;
  const done = (await db.query(`update public.stock_requests set status = 'completed', completed_at = $2, updated_at = now() where id = $1 and status = 'received' returning id`, [requestId, now])).rows[0];
  return Boolean(done);
}

/** The delivery with this code, for the QR landing. 400 bad code, 404 unknown, 403 when the caller doesn't receive at its destination (T-SEC-1). */
export async function findByCode(db, scope, code) {
  const found = await codeOwner(db, code);
  if (found.businessId !== scope.businessId) throw fail(403, 'You don’t have access to this delivery.', 'forbidden');
  requireCan(scope, 'inv.transfer.receive', { locationId: found.toLocationId });
  return getTransfer(db, scope, found.transferId);
}

/* ---------- returns (branch -> Warehouse) and branch -> branch transfers ---------- */

const availabilityMessage = (it, a, units) => `Only ${show(it, a.available < 0 ? '0' : a.available, units)} of ${it.name} can leave here${cmp(a.held, 0) > 0 || cmp(a.reserved, 0) > 0 ? ` (${show(it, a.held, units)} is held for open orders)` : ''}.`;

async function checkAvailable(db, locationId, lines, units, where) {
  for (const l of lines) {
    const a = await ledger.availability(db, locationId, l.itemId);
    if (cmp(l.base, a.available) > 0) throw fail(409, `${availabilityMessage(l.item, a, units)} ${where} Send less.`, 'insufficient_available', { itemId: l.itemId, available: a.available });
  }
}

/**
 * A branch sends stock back to the Warehouse. input: { locationId (the branch), lines, reason, note?, driver?, vehicle? }. Needs inv.request.create at that branch.
 * Dispatches at once (no approval) unless the owner turned on returns_need_approval, then it waits as 'pending_approval' like a branch -> branch transfer.
 * It can't take stock that open orders hold (stock_held / insufficient_available).
 */
export async function startReturn(db, scope, input = {}, { now = new Date() } = {}) {
  const from = branchPlace(scope, input.locationId);
  requireCan(scope, 'inv.request.create', { locationId: from.id });
  const reason = tidy(input.reason);
  if (!reason) throw fail(400, 'Say why the stock is going back to the Warehouse.', 'reason_required');
  if (reason.length > 200) throw fail(400, 'Keep the reason under 200 characters.', 'note_too_long');
  const meta = deliveryMeta(input);
  const units = await loadUnits(db);
  const lines = await parseLines(db, scope.businessId, input.lines, { label: 'The amount to return', units });
  await checkAvailable(db, from.id, lines, units, 'Only stock that is not needed for open orders can go back.');
  const settings = await getSettings(db, scope.businessId, from.id);
  const toLoc = place(scope, scope.centerLocationId);
  const noteText = `Return: ${reason}${meta.note ? ` (${meta.note})` : ''}`.slice(0, MAX_NOTE);
  const approval = settings.returns_need_approval === true;
  const created = await insertTransfer(db, scope, { direction: 'return', from: from.id, to: toLoc.id, status: approval ? 'pending_approval' : 'in_transit', note: noteText, lines, now });
  const t = { id: created.id, number: created.number, code: created.code, from_location: from.id, to_location: toLoc.id, direction: 'return', request_id: null };
  if (approval) {
    await requestApproval(db, scope, t, from, lines, now);
  } else {
    await sendTransfer(db, scope, t, { respectHeld: true, driver: meta.driver, vehicle: meta.vehicle, now });
    await notifyIncoming(db, scope, t, from, toLoc, now);
  }
  return { ...(await getTransfer(db, scope, t.id)), pendingApproval: approval };
}

async function requestApproval(db, scope, t, fromLoc, lines, now) {
  const value = lines.every((l) => l.item.avgCost !== null) ? lines.reduce((s, l) => add(s, mul(l.base, l.item.avgCost, MONEY, 'half-up')), dec('0')).toString(MONEY) : null;
  const a = await approvals.request(db, { businessId: scope.businessId, subject: 'transfer', subjectId: t.id, locationId: fromLoc.id, requestedBy: scope.userId, requestedByRole: scope.role, amountKes: value,
    evaluation: { reasons: [t.direction === 'return' ? 'Returns to the Warehouse need the owner’s approval.' : 'Moving stock between branches needs the owner’s approval.'], safeDefault: true, approverCapability: 'inv.request.approve' }, at: now });
  await audit(db, { businessId: scope.businessId, locationId: fromLoc.id, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: 'request',
    after: { ref: transferRef(t.number, now), direction: t.direction, approvalId: a.id, lines: lines.map((l) => ({ itemId: l.itemId, base: l.base })) } });
  return a;
}

/**
 * Asks to move stock from one branch to another (needs branch_to_branch_enabled). input: { fromLocationId, toLocationId (stock locations of two different branches), lines, note? }.
 * The caller needs inv.request.create at the source OR the destination. Nothing is reserved (D2-12): the owner approves in the approvals inbox, then the SOURCE branch
 * dispatches (availability is checked then) and the destination receives.
 */
export async function requestBranchTransfer(db, scope, input = {}, { now = new Date() } = {}) {
  const from = branchPlace(scope, input.fromLocationId);
  const to = branchPlace(scope, input.toLocationId);
  if (from.id === to.id) throw fail(400, 'Choose two different branches.', 'same_branch');
  if (!can(scope, 'inv.request.create', { locationId: from.id }) && !can(scope, 'inv.request.create', { locationId: to.id })) requireCan(scope, 'inv.request.create', { locationId: from.id });
  const settings = await getSettings(db, scope.businessId);
  if (settings.branch_to_branch_enabled === false) throw fail(409, 'Moving stock between branches is switched off for this business. The owner can turn it on in Settings.', 'branch_to_branch_disabled');
  const meta = deliveryMeta(input);
  const units = await loadUnits(db);
  const lines = await parseLines(db, scope.businessId, input.lines, { label: 'The amount to move', units });
  const created = await insertTransfer(db, scope, { direction: 'branch_to_branch', from: from.id, to: to.id, status: 'pending_approval', note: meta.note || null, lines, now });
  const t = { id: created.id, number: created.number, code: created.code, from_location: from.id, to_location: to.id, direction: 'branch_to_branch', request_id: null };
  const a = await requestApproval(db, scope, t, from, lines, now);
  await tell(db, scope, { recipients: 'owners', exclude: [scope.userId], kind: 'branch_transfer_requested', title: `${from.name} to ${to.name}: stock transfer needs approval`,
    body: lines.map((l) => `${l.item.name} ${show(l.item, l.base, units)}`).join(', ').slice(0, 300), link: '/owner/inventory/approvals', entity: { type: 'transfer', id: t.id }, dedupeKey: `branch_transfer_requested:${t.id}` });
  return { ...(await getTransfer(db, scope, t.id)), approvalId: a.id };
}

/**
 * The source branch (or the owner) sends an approved transfer or return. Refused until the owner approved (409 approval_required); takes the stock out of the
 * source with respectHeld, so stock needed for open orders stays. input: { note?, driver?, vehicle? }.
 */
export async function dispatchTransfer(db, scope, transferId, input = {}, { now = new Date() } = {}) {
  const t = await loadTransfer(db, scope, transferId, { lock: true });
  if (t.direction === 'out') throw fail(409, 'Deliveries from the Warehouse are sent from the request (or as a direct dispatch).', 'wrong_direction');
  if (!can(scope, 'inv.request.create', { locationId: t.from_location })) requireCan(scope, 'inv.transfer.dispatch', { locationId: t.from_location });
  if (t.status === 'in_transit' || t.status === 'partially_received' || t.status === 'received') return { ...(await getTransfer(db, scope, t.id)), replayed: true };
  if (t.status === 'cancelled') throw fail(409, 'This transfer was cancelled or not approved.', 'not_dispatchable');
  if (!t.approved_at) throw fail(409, 'This transfer needs the owner’s approval before it can be sent. Ask the owner to approve it in the Approvals inbox.', 'approval_required');
  const meta = deliveryMeta(input);
  const units = await loadUnits(db);
  const lines = (await db.query('select item_id, quantity::text as quantity from public.stock_transfer_lines where transfer_id = $1', [t.id])).rows;
  const items = await loadItems(db, scope.businessId, lines.map((l) => l.item_id));
  await checkAvailable(db, t.from_location, lines.map((l) => ({ itemId: l.item_id, base: l.quantity, item: items.get(l.item_id) })), units, 'Send less, or ask for a smaller transfer.');
  await sendTransfer(db, scope, t, { respectHeld: true, note: meta.note, driver: meta.driver, vehicle: meta.vehicle, now });
  await notifyIncoming(db, scope, t, place(scope, t.from_location), place(scope, t.to_location), now);
  return getTransfer(db, scope, t.id);
}

/** Withdraws a transfer or return that has not been sent (the requester, the source, the destination for a branch transfer, or the owner). */
export async function cancelTransfer(db, scope, transferId) {
  const t = await loadTransfer(db, scope, transferId, { lock: true });
  const may = [t.from_location, t.to_location].some((l) => can(scope, 'inv.request.create', { locationId: l })) || can(scope, 'inv.transfer.dispatch', { locationId: t.from_location });
  if (!may) requireCan(scope, 'inv.request.create', { locationId: t.from_location });
  if (t.status === 'cancelled') return { ...(await getTransfer(db, scope, t.id)), replayed: true };
  if (t.status !== 'pending_approval') throw fail(409, t.status === 'in_transit' ? 'This transfer is already on its way. Ask the owner to cancel the dispatch.' : `This transfer is ${WORDS[t.status] || t.status}.`, 'not_cancellable');
  await db.query(`update public.stock_transfers set status = 'cancelled', cancelled_by = $2, cancelled_at = now() where id = $1`, [t.id, scope.userId]);
  await approvals.cancel(db, scope, { subject: 'transfer', subjectId: t.id }, { note: 'Withdrawn' });
  await audit(db, { businessId: scope.businessId, locationId: t.from_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: 'cancel', before: { status: 'pending_approval' }, after: { status: 'cancelled' } });
  return getTransfer(db, scope, t.id);
}

/* ---------- the approvals engine calls this for subject 'transfer' ---------- */

/** Approved -> the transfer may be dispatched (approved_at set); rejected -> it is cancelled. Nothing moves yet (D2-12: no reservation at a branch). */
export async function applyTransferDecision(db, approval, { scope }) {
  const t = (await db.query(`${TRANSFER_SELECT} where t.id = $1 and t.business_id = $2 for update of t`, [approval.subjectId, approval.businessId])).rows[0];
  if (!t || t.status !== 'pending_approval' || t.approved_at) return null;
  const at = approval.decidedAt ? new Date(approval.decidedAt) : new Date();
  const ref = transferRef(t.number, t.dispatched_at);
  if (approval.status === 'approved') {
    await db.query('update public.stock_transfers set approved_by = $2, approved_at = $3 where id = $1', [t.id, approval.decidedBy, at]);
    await audit(db, { businessId: t.business_id, locationId: t.from_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: approval.selfApproved ? 'approve_self' : 'approve',
      before: { status: 'pending_approval' }, after: { approvalId: approval.id, selfApproved: approval.selfApproved } });
    await notify(db, { businessId: t.business_id, recipients: t.from_restaurant ? [`branch_managers:${t.from_restaurant}`] : 'owners', exclude: [scope.userId], kind: 'transfer_approved', title: `${ref} was approved`,
      body: `${t.from_name} can now send it to ${t.to_name}.`, link: t.from_restaurant ? branchRequestsLink(t.from_restaurant) : OWNER_REQUESTS_LINK, entity: { type: 'transfer', id: t.id }, dedupeKey: `transfer_approved:${t.id}` });
  } else if (approval.status === 'rejected') {
    await db.query(`update public.stock_transfers set status = 'cancelled', cancelled_by = $2, cancelled_at = $3 where id = $1`, [t.id, approval.decidedBy, at]);
    await audit(db, { businessId: t.business_id, locationId: t.from_location, actorId: scope.userId, actorRole: scope.role, entity: 'transfer', entityId: t.id, action: 'reject',
      before: { status: 'pending_approval' }, after: { status: 'cancelled', note: approval.decisionNote } });
  }
  return t.id;
}
let unregister = null;
/** Registers the decision callback once per process. */
export function ensureDistributionApprovals() {
  if (!unregister) unregister = approvals.onDecided('transfer', applyTransferDecision);
  return unregister;
}
/** For tests: forget the registration so ensureDistributionApprovals() adds it back after approvals.clearDecisionHandlers(). */
export function resetDistributionApprovals() { unregister = null; }
ensureDistributionApprovals();

/* ---------- suggestions ---------- */

/** Days of cover suggested for an item with no par level, from its recent use (P2-24). */
export const SUGGEST_COVER_DAYS = 7;
/** How many days of pos_consumption the average daily use looks at (P2-24). */
export const SUGGEST_USE_DAYS = 14;

/**
 * What a branch should ask for. Target = the branch's par level (stock_item_levels.par); an item with NO par level falls back to SUGGEST_COVER_DAYS (7) days of its
 * average daily use over the last SUGGEST_USE_DAYS (14) days (pos_consumption), so a branch that never had par levels still gets sensible suggestions.
 *   need = target - available - incoming,   available = on hand - held for open orders,
 *   incoming = on its way (sent, not yet counted) + what open requests still expect (submitted, or approved and not yet sent).
 * need > 0 is rounded UP to the item's main pack (its first own unit). Each row says its `basis` ('par' or 'use'), the figures behind it and the average daily use.
 */
export async function suggestRequest(db, scope, locationId) {
  const loc = branchPlace(scope, locationId);
  requireCan(scope, 'inv.request.create', { locationId: loc.id });
  const levels = (await db.query(`select item_id, par::text as par from public.stock_item_levels where location_id = $1 and par is not null and par > 0`, [loc.id])).rows;
  const use = new Map((await db.query(`select item_id, (-sum(delta) / ${SUGGEST_USE_DAYS})::text as q from public.stock_movements where location_id = $1 and reason = 'pos_consumption' and occurred_at > now() - interval '${SUGGEST_USE_DAYS} days' group by item_id having sum(delta) < 0`, [loc.id])).rows.map((r) => [r.item_id, r.q]));
  const targets = new Map(levels.map((l) => [l.item_id, { target: l.par, basis: 'par' }]));
  for (const [itemId, daily] of use) {
    if (!targets.has(itemId)) targets.set(itemId, { target: mul(daily, SUGGEST_COVER_DAYS, QTY).toString(QTY), basis: 'use' });
  }
  if (!targets.size) return { suggestions: [], message: 'No par levels are set for this branch yet and nothing has been used recently, so there is nothing to suggest. The owner sets par levels on each item.' };
  const ids = [...targets.keys()];
  const items = await loadItems(db, scope.businessId, ids);
  const units = await loadUnits(db);
  const bal = new Map((await db.query('select item_id, on_hand::text as on_hand from public.stock_balances where location_id = $1 and item_id = any($2::uuid[])', [loc.id, ids])).rows.map((r) => [r.item_id, r.on_hand]));
  const held = new Map((await db.query('select item_id, quantity::text as q from private.branch_committed($1)', [loc.restaurantId])).rows.map((r) => [r.item_id, r.q]));
  const transit = new Map((await db.query(`select tl.item_id, sum(tl.quantity - coalesce(tl.received, 0) - tl.damaged)::text as q from public.stock_transfer_lines tl join public.stock_transfers t on t.id = tl.transfer_id
    where t.to_location = $1 and t.status in ('in_transit', 'partially_received') group by tl.item_id`, [loc.id])).rows.map((r) => [r.item_id, r.q]));
  const asked = new Map((await db.query(`select l.item_id, sum(case when q.status = 'submitted' then l.requested else greatest(coalesce(l.approved, 0) - l.dispatched, 0) end)::text as q
    from public.stock_request_lines l join public.stock_requests q on q.id = l.request_id where q.restaurant_id = $1 and q.status in ('submitted', 'approved', 'partially_approved', 'preparing', 'dispatched', 'partially_received')
    group by l.item_id`, [loc.restaurantId])).rows.map((r) => [r.item_id, r.q]));
  const out = [];
  for (const [itemId, t] of targets) {
    const it = items.get(itemId);
    if (!it || it.archived) continue;
    const available = sub(bal.get(itemId) ?? '0', held.get(itemId) ?? '0');
    const incoming = add(transit.get(itemId) ?? '0', asked.get(itemId) ?? '0');
    let need = sub(sub(t.target, available), incoming);
    if (cmp(need, 0) <= 0) continue;
    const pack = it.units[0];
    if (pack && cmp(pack.factor, 0) > 0) {
      let n = div(need, pack.factor, 0, 'down');
      if (cmp(mul(n, pack.factor, QTY), need) < 0) n = add(n, 1);
      need = mul(n, pack.factor, QTY);
    }
    const daily = use.get(itemId) ?? null;
    out.push({ itemId, name: it.name, unit: it.baseUnit, basis: t.basis, par: t.basis === 'par' ? q4(t.target) : null, target: q4(t.target), onHand: q4(bal.get(itemId) ?? '0'), held: q4(held.get(itemId) ?? '0'),
      available: q4(available), incoming: q4(incoming), suggested: need.toString(QTY), suggestedDisplay: show(it, need.toString(QTY), units), pack: pack ? { name: pack.name, factor: pack.factor } : null,
      avgDailyUse: daily === null ? null : q4(daily), daysCover: daily !== null && cmp(daily, 0) > 0 ? div(available, daily, 1, 'half-up').toString(1) : null });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { suggestions: out };
}

/* ---------- 009 requests adopted by the new engine ---------- */

/**
 * `main`'s 009 flow approves a request without holding any stock. The first time the new engine touches a business (inbox, review, prepare, dispatch)
 * this holds stock for each approved-but-unsent legacy request, OLDEST FIRST, with ledger.reserve. A line the Warehouse can't fully cover is held as far
 * as it goes and the request is flagged needs_attention (never silently shortened: `approved` is not changed) and the owners are told once.
 * Idempotent: a line that already has a reservation row, a request with a delivery open, or a request nothing is left to send on is skipped.
 * Returns [{ requestId, ref, held: [...], short: [...] }] for the requests it handled.
 */
export async function adoptLegacy(db, scope, { now = new Date() } = {}) {
  if (!scope.centerLocationId) return [];
  const missing = (await db.query('select 1 from public.stock_requests where business_id = $1 and (from_location is null or to_location is null) limit 1', [scope.businessId])).rows[0];
  if (missing) {
    for (const r of (await db.query(`select q.id, l.id as branch_location from public.stock_requests q join public.stock_locations l on l.restaurant_id = q.restaurant_id and l.business_id = q.business_id
      where q.business_id = $1 and (q.from_location is null or q.to_location is null)`, [scope.businessId])).rows) {
      await db.query('update public.stock_requests set from_location = coalesce(from_location, $2), to_location = coalesce(to_location, $3) where id = $1', [r.id, scope.centerLocationId, r.branch_location]);
    }
  }
  const candidates = (await db.query(`select q.id, q.number, q.restaurant_id, q.created_at from public.stock_requests q
    where q.business_id = $1 and q.status = 'approved' and q.kind = 'stock'
      and exists (select 1 from public.stock_request_lines l where l.request_id = q.id and coalesce(l.approved, 0) > l.dispatched
                    and not exists (select 1 from public.stock_reservations r where r.request_id = l.request_id and r.item_id = l.item_id))
      and not exists (select 1 from public.stock_transfers t where t.request_id = q.id and t.status = any($2::text[]))
    order by q.created_at, q.number`, [scope.businessId, OPEN_TRANSFER])).rows;
  const handled = [];
  const units = candidates.length ? await loadUnits(db) : null;
  for (const c of candidates) {
    await db.query('select id from public.stock_requests where id = $1 for update', [c.id]);
    const lines = (await db.query(`select l.item_id, (l.approved - l.dispatched)::text as want from public.stock_request_lines l where l.request_id = $1 and coalesce(l.approved, 0) > l.dispatched
      and not exists (select 1 from public.stock_reservations r where r.request_id = l.request_id and r.item_id = l.item_id) order by l.item_id`, [c.id])).rows;
    const items = await loadItems(db, scope.businessId, lines.map((l) => l.item_id));
    const held = []; const short = [];
    for (const l of lines) {
      const it = items.get(l.item_id);
      let qty = l.want;
      const free = (await ledger.balance(db, scope.centerLocationId, l.item_id)).available;
      if (cmp(free, qty) < 0) { short.push({ itemId: l.item_id, name: it.name, wanted: l.want, free: isNeg(free) ? '0.0000' : free }); qty = isNeg(free) ? '0' : free; }
      if (isZero(qty)) continue;
      await ledger.reserve(db, { businessId: scope.businessId, locationId: scope.centerLocationId, itemId: l.item_id, qty, requestId: c.id, actorId: scope.userId, idempotencyKey: clipKey(`adopt:${c.id}:${l.item_id}`) });
      held.push({ itemId: l.item_id, qty });
    }
    if (short.length) {
      await db.query('update public.stock_requests set needs_attention = true, updated_at = now() where id = $1', [c.id]);
      await tell(db, scope, { recipients: 'owners', kind: 'reservation_attention', title: `${requestRef(c.number, c.created_at)} needs attention`,
        body: `It was approved before the new stock system. The Warehouse can’t cover: ${short.map((s) => `${s.name} (${show(items.get(s.itemId), s.free, units)} free of ${show(items.get(s.itemId), s.wanted, units)})`).join('; ')}.`,
        link: OWNER_REQUESTS_LINK, entity: { type: 'stock_request', id: c.id }, dedupeKey: `reservation_attention:${c.id}` });
    }
    await audit(db, { businessId: scope.businessId, locationId: scope.centerLocationId, actorId: scope.userId, actorRole: scope.role, entity: 'stock_request', entityId: c.id, action: 'adopt_legacy',
      after: { held, short } });
    handled.push({ requestId: c.id, ref: requestRef(c.number, c.created_at), held, short });
  }
  return handled;
}
