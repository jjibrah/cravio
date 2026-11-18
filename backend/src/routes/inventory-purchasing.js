// Purchasing and receiving API (P2-07, P2-08, migration 016).
//   Owner side, base /api/owner/inventory/:businessId/ : reorder-suggestions, purchase-orders, goods-receipts, supplier-invoices, supplier-returns.
//     Reads need inv.view and oversight (owner or operations manager); costs only with inv.cost.view. Writes need the capability AT THE ORDER'S OR
//     RECEIPT'S LOCATION (inv.purchase.create / inv.purchase.approve; receiving at a branch needs inv.stock.record there), checked BEFORE the write
//     transaction so a refused attempt's 'denied' audit row isn't rolled back.
//   Branch side, /api/inventory/ (X-Cravio-Branch names the branch): a branch manager sees the orders on their way to THEIR branch and receives them
//     (goods-receipts create / edit / post), never any other branch's or the warehouse's.
// Pattern for every write: requireUser -> inventoryScope (pool) -> authorize (pool) -> one transaction -> once(commandId) -> service (which audits).
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database. Approve/reject here delegate to the approvals engine (same rules as the Approvals inbox).
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, can, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import { oversees } from '../inventory/suppliers.js';
import {
  approvePo, cancelPo, closePo, createPo, createPosFromSuggestions, getPo, listPos, poDocument, receiveCapability, rejectPo, reorderSuggestions, sendPo, submitPo, updatePo,
} from '../inventory/purchasing.js';
import {
  createInvoice, createReceipt, expectedDeliveries, getInvoice, getReceipt, getReturn, listInvoices, listReceipts, listReturns, postReceipt, receive, returnToSupplier,
  reverseReceipt, updateInvoice, updateReceipt,
} from '../inventory/receiving.js';

const ID = '[0-9a-fA-F-]{36}';
const base = `/api/owner/inventory/(?<businessId>${ID})`;
const path = (suffix = '') => new RegExp(`^${base}${suffix}$`);
const branchPath = (suffix = '') => new RegExp(`^/api/inventory${suffix}$`);

const MISSING_SCHEMA = new HttpError(503, 'Purchasing needs database updates 012, 015 and 016, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
const NOT_FOUND_PO = () => new HttpError(404, 'That purchase order isn’t in this business.', { code: 'po_not_found' });
const NOT_FOUND_GRN = () => new HttpError(404, 'That goods receipt isn’t in this business.', { code: 'grn_not_found' });
const empty = (v) => v === undefined || v === null || v === '';

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), now = () => new Date() } = {}) {
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());

  async function open(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    return { db, scope };
  }

  const poLocation = async (db, scope, id) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(String(id))) throw NOT_FOUND_PO();
    const row = (await safely(() => db.query('select deliver_to_location_id as l from public.purchase_orders where id = $1 and business_id = $2', [String(id).toLowerCase(), scope.businessId]))).rows[0];
    if (!row) throw NOT_FOUND_PO();
    return row.l;
  };
  const grnLocation = async (db, scope, id) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(String(id))) throw NOT_FOUND_GRN();
    const row = (await safely(() => db.query('select location_id as l from public.goods_receipts where id = $1 and business_id = $2', [String(id).toLowerCase(), scope.businessId]))).rows[0];
    if (!row) throw NOT_FOUND_GRN();
    return row.l;
  };

  /** Reads: inv.view plus owner/operations oversight, then the service (which checks the record's own location). */
  const read = (fn) => async ({ request, params, url }) => {
    const { db, scope } = await open(request, params);
    await safely(() => authorize(db, scope, 'inv.view', { entity: 'purchasing' }));
    if (!oversees(scope)) throw await denyAndAudit(db, scope, 'inv.view', { entity: 'purchasing' });
    return safely(() => fn(db, scope, params, url?.searchParams || new URLSearchParams()));
  };

  /** Writes: `locate(db, scope, params, body)` -> the location the capability is needed at; `capability` is a name or (scope, locationId) -> name. */
  const write = (kind, capability, locate, run) => withBody(async ({ request, params, body }) => {
    const { db, scope } = await open(request, params);
    const locationId = locate ? await locate(db, scope, params, body) : null;
    const cap = typeof capability === 'function' ? capability(scope, locationId) : capability;
    await safely(() => authorize(db, scope, cap, { locationId, entity: kind }));
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind }, () => run(tx, scope, params, body))));
  });

  const poAt = (_db, _scope, params) => poLocation(_db, _scope, params.id);
  const grnAt = (db, scope, params) => grnLocation(db, scope, params.id);
  const newPoAt = (_db, scope, _p, body) => (body.deliverToLocationId ? String(body.deliverToLocationId).toLowerCase() : scope.centerLocationId);
  const newGrnAt = async (db, scope, _p, body) => (body.poId ? poLocation(db, scope, body.poId) : (body.locationId ? String(body.locationId).toLowerCase() : scope.centerLocationId));
  const rejectCap = (scope, locationId) => (can(scope, 'inv.purchase.approve', { locationId }) ? 'inv.purchase.approve' : 'inv.purchase.create');
  const receiveCap = (scope, locationId) => receiveCapability(scope, locationId);
  const strip = (body) => { const { commandId, ...rest } = body; return rest; };

  /* ----- branch side ----- */

  async function openBranch(request) {
    const context = await authenticate(request);
    const db = pool();
    let restaurantId = requestedBranch(request);
    if (!restaurantId) {
      const membership = selectMembership(context.memberships, null, STAFF_ROLES);
      if (!membership) throw new HttpError(409, 'Choose which branch you are working in. Send the X-Cravio-Branch header.', { code: 'branch_required' });
      restaurantId = String(membership.restaurant.id).toLowerCase();
    }
    const row = (await db.query('select business_id from public.restaurants where id = $1', [restaurantId])).rows[0];
    if (!row) throw NO_BRANCH();
    const scope = await safely(async () => {
      const first = await inventoryScope(db, context, row.business_id);
      return first.enabled && first.role !== 'none' && first.role !== 'admin' ? inventoryScope(db, context, row.business_id, { ensureLocations: true }) : first;
    });
    const location = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId) || null;
    await safely(() => authorize(db, scope, 'inv.stock.record', { locationId: location?.id || null, entity: 'goods_receipt' }));
    if (!location) throw NO_BRANCH();
    return { db, scope, location };
  }
  const branchRead = (fn) => async ({ request, params, url }) => {
    const { db, scope, location } = await openBranch(request);
    return safely(() => fn(db, scope, location, params, url?.searchParams || new URLSearchParams()));
  };
  const branchWrite = (kind, run, { pre } = {}) => withBody(async ({ request, params, body }) => {
    const { db, scope, location } = await openBranch(request);
    if (pre) await safely(() => pre(db, scope, location, params, body));
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind }, () => run(tx, scope, location, params, body))));
  });
  /** The receipt must be at this branch's own location, or the caller is told it isn't theirs (403, audited). */
  const ownReceipt = async (db, scope, location, id) => {
    const at = await grnLocation(db, scope, id);
    if (at !== location.id) throw await denyAndAudit(db, scope, 'inv.stock.record', { locationId: at, entity: 'goods_receipt', error: NO_BRANCH() });
  };

  return [
    // ----- Reorder suggestions -----
    { method: 'GET', path: path('/reorder-suggestions'), handler: read((db, scope, _p, q) => reorderSuggestions(db, scope, { locationId: q.get('location') || undefined, today: today() })) },
    { method: 'POST', path: path('/reorder-suggestions/create-orders'), handler: write('po_from_suggestions', 'inv.purchase.create', (_db, scope, _p, body) => (body.locationId ? String(body.locationId).toLowerCase() : scope.centerLocationId),
      (tx, scope, _p, body) => createPosFromSuggestions(tx, scope, { locationId: body.locationId, itemIds: body.itemIds, supplierId: body.supplierId, today: today() })) },

    // ----- Purchase orders -----
    { method: 'GET', path: path('/purchase-orders'), handler: read((db, scope, _p, q) => listPos(db, scope,
      { status: q.get('status') || undefined, supplierId: q.get('supplier') || undefined, locationId: q.get('location') || undefined, search: q.get('search') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined })) },
    { method: 'POST', path: path('/purchase-orders'), handler: write('po_create', 'inv.purchase.create', newPoAt, (tx, scope, _p, body) => createPo(tx, scope, strip(body), { today: today() })) },
    { method: 'GET', path: path(`/purchase-orders/(?<id>${ID})`), handler: read((db, scope, params) => getPo(db, scope, params.id)) },
    { method: 'PATCH', path: path(`/purchase-orders/(?<id>${ID})`), handler: write('po_edit', 'inv.purchase.create', poAt, (tx, scope, params, body) => updatePo(tx, scope, params.id, strip(body), { today: today() })) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/submit`), handler: write('po_submit', 'inv.purchase.create', poAt, (tx, scope, params) => submitPo(tx, scope, params.id)) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/approve`), handler: write('po_approve', 'inv.purchase.approve', poAt, (tx, scope, params, body) => approvePo(tx, scope, params.id, { note: body.note })) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/reject`), handler: write('po_reject', rejectCap, poAt, (tx, scope, params, body) => rejectPo(tx, scope, params.id, { reason: body.reason })) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/send`), handler: write('po_send', 'inv.purchase.create', poAt, (tx, scope, params, body) => sendPo(tx, scope, params.id, { via: body.via })) },
    { method: 'GET', path: path(`/purchase-orders/(?<id>${ID})/document`), handler: read(async (db, scope, params) => {
      await authorize(db, scope, 'inv.purchase.create', { locationId: await poLocation(db, scope, params.id), entity: 'purchase_order' });
      return poDocument(db, scope, params.id);
    }) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/cancel`), handler: write('po_cancel', 'inv.purchase.create', poAt, (tx, scope, params, body) => cancelPo(tx, scope, params.id, { reason: body.reason })) },
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/close`), handler: write('po_close', 'inv.purchase.create', poAt, (tx, scope, params, body) => closePo(tx, scope, params.id, { reason: body.reason })) },
    // Receive against an order in one step (create + post). Lines default to everything still outstanding.
    { method: 'POST', path: path(`/purchase-orders/(?<id>${ID})/receive`), handler: write('grn_receive', receiveCap, poAt,
      (tx, scope, params, body) => receive(tx, scope, { ...strip(body), poId: params.id }, { today: today() })) },

    // ----- Goods receipts -----
    { method: 'GET', path: path('/goods-receipts'), handler: read((db, scope, _p, q) => listReceipts(db, scope,
      { status: q.get('status') || undefined, supplierId: q.get('supplier') || undefined, locationId: q.get('location') || undefined, poId: q.get('po') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined })) },
    { method: 'POST', path: path('/goods-receipts'), handler: write('grn_create', receiveCap, newGrnAt, (tx, scope, _p, body) => (body.post === true
      ? receive(tx, scope, strip(body), { today: today() }) : createReceipt(tx, scope, strip(body), { today: today() }))) },
    { method: 'GET', path: path(`/goods-receipts/(?<id>${ID})`), handler: read((db, scope, params) => getReceipt(db, scope, params.id)) },
    { method: 'PATCH', path: path(`/goods-receipts/(?<id>${ID})`), handler: write('grn_edit', receiveCap, grnAt, (tx, scope, params, body) => updateReceipt(tx, scope, params.id, strip(body), { today: today() })) },
    { method: 'POST', path: path(`/goods-receipts/(?<id>${ID})/post`), handler: write('grn_post', receiveCap, grnAt,
      (tx, scope, params, body) => postReceipt(tx, scope, params.id, { confirmOverDelivery: body.confirmOverDelivery === true, today: today() })) },
    { method: 'POST', path: path(`/goods-receipts/(?<id>${ID})/reverse`), handler: write('grn_reverse', receiveCap, grnAt, (tx, scope, params, body) => reverseReceipt(tx, scope, params.id, { reason: body.reason })) },

    // ----- Supplier invoices (owner) -----
    { method: 'GET', path: path('/supplier-invoices'), handler: read((db, scope, _p, q) => listInvoices(db, scope,
      { supplierId: q.get('supplier') || undefined, status: q.get('status') || undefined, search: q.get('search') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined })) },
    { method: 'POST', path: path('/supplier-invoices'), handler: write('invoice_create', 'inv.purchase.create', null, (tx, scope, _p, body) => createInvoice(tx, scope, strip(body))) },
    { method: 'GET', path: path(`/supplier-invoices/(?<id>${ID})`), handler: read((db, scope, params) => getInvoice(db, scope, params.id)) },
    { method: 'PATCH', path: path(`/supplier-invoices/(?<id>${ID})`), handler: write('invoice_edit', 'inv.purchase.create', null, (tx, scope, params, body) => updateInvoice(tx, scope, params.id, strip(body))) },

    // ----- Returns to the supplier -----
    { method: 'GET', path: path('/supplier-returns'), handler: read((db, scope, _p, q) => listReturns(db, scope,
      { grnId: q.get('grn') || undefined, supplierId: q.get('supplier') || undefined, locationId: q.get('location') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined })) },
    { method: 'POST', path: path('/supplier-returns'), handler: write('supplier_return', receiveCap, (db, scope, _p, body) => grnLocation(db, scope, body.grnId), (tx, scope, _p, body) => returnToSupplier(tx, scope, strip(body))) },
    { method: 'GET', path: path(`/supplier-returns/(?<id>${ID})`), handler: read((db, scope, params) => getReturn(db, scope, params.id)) },

    // ----- Branch manager: orders on their way to this branch, and receiving them -----
    { method: 'GET', path: branchPath('/purchase-orders/expected'), handler: branchRead((db, scope, location) => expectedDeliveries(db, scope, location.id)) },
    { method: 'GET', path: branchPath('/goods-receipts'), handler: branchRead((db, scope, location, _p, q) => listReceipts(db, scope,
      { status: q.get('status') || undefined, locationId: location.id, poId: q.get('po') || undefined, limit: q.get('limit') || undefined, before: q.get('before') || undefined })) },
    { method: 'POST', path: branchPath('/goods-receipts'), handler: branchWrite('grn_create_branch', (tx, scope, location, _p, body) => {
      const input = { ...strip(body), locationId: location.id };
      return body.post === true ? receive(tx, scope, input, { today: today() }) : createReceipt(tx, scope, input, { today: today() });
    }, { pre: async (db, scope, location, _p, body) => {
      // An order for another branch (or the warehouse) is not theirs to receive: refused and audited before anything is written.
      if (empty(body.poId)) return;
      const at = await poLocation(db, scope, body.poId);
      if (at !== location.id) throw await denyAndAudit(db, scope, 'inv.stock.record', { locationId: at, entity: 'goods_receipt', error: NO_BRANCH() });
    } }) },
    { method: 'GET', path: branchPath(`/goods-receipts/(?<id>${ID})`), handler: branchRead(async (db, scope, location, params) => { await ownReceipt(db, scope, location, params.id); return getReceipt(db, scope, params.id); }) },
    { method: 'PATCH', path: branchPath(`/goods-receipts/(?<id>${ID})`), handler: branchWrite('grn_edit_branch',
      (tx, scope, _l, params, body) => updateReceipt(tx, scope, params.id, strip(body), { today: today() }), { pre: (db, scope, location, params) => ownReceipt(db, scope, location, params.id) }) },
    { method: 'POST', path: branchPath(`/goods-receipts/(?<id>${ID})/post`), handler: branchWrite('grn_post_branch',
      (tx, scope, _l, params, body) => postReceipt(tx, scope, params.id, { confirmOverDelivery: body.confirmOverDelivery === true, today: today() }),
      { pre: (db, scope, location, params) => ownReceipt(db, scope, location, params.id) }) },
  ];
}

export const routes = createRoutes();
