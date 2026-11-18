/*
 * Inventory client (P1-13). Thin helpers over the backend's new inventory endpoints:
 *   owner     /api/owner/inventory/:businessId/...   (routes/inventory-owner.js, routes/inventory-recipes.js)
 *   branch    /api/inventory/...                     (routes/inventory-branch.js; the branch travels in X-Cravio-Branch, see lib/api.js)
 *   recipes   same two prefixes under /recipes
 *   notices   /api/notifications
 * Every write carries a commandId: the server applies a command once, so a retry (double tap, flaky network) can't
 * post twice. Pass the id you used last time to retry; omit it for a new command. useInventoryWrite() does this for you.
 * Errors are ApiError with `status`, `details` (the server's { code, ... }) and `code` (= details.code) so a screen can
 * react to e.g. 'confirm_large_amount' (details.suggestion) or 'unit_locked' and still show `message` in plain words.
 *
 * Also here: useInventoryEnabled(area), the feature switch behind the Operations navigation, and a few pure unit helpers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getActiveBranch } from './branch';
import { useAuth } from './auth';

/* ---------- errors and writes ---------- */

/** Puts the server's error code on the error itself (error.code) and returns it. */
export function withCode(error) {
  if (error && typeof error === 'object' && error.code === undefined) error.code = error.details?.code;
  return error;
}

/** { message, code, details, status } for any thrown value, for screens that keep the error in state. */
export function explain(error) {
  withCode(error);
  return { message: error?.message || 'Something went wrong. Please try again.', code: error?.code, details: error?.details, status: error?.status };
}

export const newCommandId = () => crypto.randomUUID();

/** One write. Pass `commandId` to retry a command that may or may not have been applied. Errors keep `code` and `details`. */
export async function send(method, path, body = {}, { commandId = newCommandId() } = {}) {
  try {
    return await api(path, { method, body: { ...body, commandId } });
  } catch (error) { throw withCode(error); }
}

/**
 * Writes with a stable command id per step. A failed write keeps its id, so pressing Save again is a retry of the same
 * command; a successful one renews it. `step` names the call when a form makes several (units, levels, ...).
 * Returns [run, { busy, error, clearError }]; run() resolves to the result, or null after setting `error`.
 */
export function useInventoryWrite() {
  const ids = useRef(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const run = useCallback(async (method, path, body, { step } = {}) => {
    if (running.current) return null;
    running.current = true;
    setBusy(true); setError(null);
    const key = step || `${method} ${path}`;
    if (!ids.current.has(key)) ids.current.set(key, newCommandId());
    try {
      const result = await send(method, path, body, { commandId: ids.current.get(key) });
      ids.current.delete(key);
      return result;
    } catch (failure) {
      setError(explain(failure));
      return null;
    } finally { running.current = false; setBusy(false); }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return [run, { busy, error, clearError }];
}

/* ---------- paths ---------- */

const query = (params) => {
  const text = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString();
  return text ? `?${text}` : '';
};

/** Owner side, per business. */
export const ownerPaths = (businessId) => {
  const base = `/api/owner/inventory/${businessId}`;
  return {
    base,
    // Everything the Stock and Items screens need. Filters are optional; the screens usually filter in the browser.
    overview: ({ archived, low, search, category } = {}) => `${base}${query({ archived, low, search, category })}`,
    item: (id) => `${base}/items/${id}`,
    items: `${base}/items`,
    itemUnits: (id) => `${base}/items/${id}/units`,
    itemBarcodes: (id) => `${base}/items/${id}/barcodes`,
    itemLevels: (id) => `${base}/items/${id}/levels`,
    archive: (id) => `${base}/items/${id}/archive`,
    restore: (id) => `${base}/items/${id}/restore`,
    categories: `${base}/categories`,
    category: (id) => `${base}/categories/${id}`,
    warehouse: `${base}/warehouse`,
    setting: (key) => `${base}/settings/${key}`,
    opening: (locationId) => `${base}/opening${query({ location: locationId })}`,
    openingPost: `${base}/opening`,
    importTemplate: `${base}/import/template${query({ format: 'json' })}`,
    importDryRun: `${base}/import/dry-run`,
    importCommit: `${base}/import`,
    recipes: (branchId) => `${base}/recipes${query({ branch: branchId })}`,
    recipe: (menuItemId) => `${base}/recipes/${menuItemId}`,
    // Suppliers and their price lists (P2-13)
    suppliers: ({ search, type, status, incomplete } = {}) => `${base}/suppliers${query({ search, type, status, incomplete })}`,
    supplier: (id) => `${base}/suppliers/${id}`,
    supplierAction: (id, action) => `${base}/suppliers/${id}/${action}`, // deactivate | activate | complete
    supplierItems: (id) => `${base}/suppliers/${id}/items`,
    supplierPrices: (id, { item, unit } = {}) => `${base}/suppliers/${id}/prices${query({ item, unit })}`,
    bestPrice: (itemId, date) => `${base}/suppliers/best-price${query({ item: itemId, date })}`,
    // Purchasing (P2-14)
    reorderSuggestions: (locationId) => `${base}/reorder-suggestions${query({ location: locationId })}`,
    createFromSuggestions: `${base}/reorder-suggestions/create-orders`,
    purchaseOrders: ({ status, supplier, location, search, limit, before } = {}) => `${base}/purchase-orders${query({ status, supplier, location, search, limit, before })}`,
    purchaseOrder: (id) => `${base}/purchase-orders/${id}`,
    purchaseOrderAction: (id, action) => `${base}/purchase-orders/${id}/${action}`, // submit | approve | reject | send | cancel | close
    purchaseOrderDocument: (id) => `${base}/purchase-orders/${id}/document`,
    // Approvals inbox (P2-16) and evidence files (P2-06)
    approvals: ({ status, subject, limit } = {}) => `${base}/approvals${query({ status, subject, limit })}`,
    approval: (id) => `${base}/approvals/${id}`,
    approvalDecide: (id) => `${base}/approvals/${id}/decide`,
    attachments: ({ entityType, entityId } = {}) => `${base}/attachments${query({ entityType, entityId })}`,
    attachmentUrl: (id) => `${base}/attachments/${id}/url`,
  };
};

/** Branch side: the branch comes from X-Cravio-Branch (the active branch), so no id in the path. */
export const branchPaths = {
  snapshot: ({ all } = {}) => `/api/inventory${query({ all })}`,
  record: '/api/inventory/record',
  history: ({ itemId, limit, before } = {}) => `/api/inventory/history${query({ itemId, limit, before })}`,
  exceptions: ({ status } = {}) => `/api/inventory/exceptions${query({ status })}`,
  resolveException: (id) => `/api/inventory/exceptions/${id}/resolve`,
  availability: '/api/inventory/availability',
  item: (id) => `/api/inventory/items/${id}`,
  recipes: '/api/inventory/recipes',
  recipe: (menuItemId) => `/api/inventory/recipes/${menuItemId}`,
  recipePreview: (menuItemId) => `/api/inventory/recipes/${menuItemId}/preview`,
  recipeSuggest: (menuItemId) => `/api/inventory/recipes/${menuItemId}/suggest`,
  recipeVersions: (menuItemId) => `/api/inventory/recipes/${menuItemId}/versions`,
  recipeVersion: (menuItemId, versionId) => `/api/inventory/recipes/${menuItemId}/versions/${versionId}`,
  extraRecipe: (extraId) => `/api/inventory/extras/${extraId}/recipe`,
};

/**
 * Recipe endpoints for one side: pass a business id for the owner side, nothing for the branch side (the branch travels in
 * X-Cravio-Branch). Same shape either way, so the recipe screens work for both. (P1-16)
 */
export function recipePaths(businessId) {
  if (businessId) {
    const base = `/api/owner/inventory/${businessId}`;
    const one = (id) => `${base}/recipes/${id}`;
    return { list: (branchId) => ownerPaths(businessId).recipes(branchId), recipe: one, preview: (id) => `${one(id)}/preview`, suggest: (id) => `${one(id)}/suggest`,
      version: (id, versionId) => `${one(id)}/versions/${versionId}`, extra: (extraId) => `${base}/extras/${extraId}/recipe` };
  }
  return { list: () => branchPaths.recipes, recipe: branchPaths.recipe, preview: branchPaths.recipePreview, suggest: branchPaths.recipeSuggest,
    version: branchPaths.recipeVersion, extra: branchPaths.extraRecipe };
}

export const notificationPaths = { list: '/api/notifications', unread: '/api/notifications/unread-count', read: '/api/notifications/read' };

/* ---------- calls (each returns the server's answer; writes take an optional commandId) ---------- */

export const owner = {
  overview: (businessId, options) => api(ownerPaths(businessId).overview(options), { cache: 'swr', ttl: 15000 }),
  item: (businessId, id) => api(ownerPaths(businessId).item(id)),
  createItem: (businessId, body, options) => send('POST', ownerPaths(businessId).items, body, options),
  updateItem: (businessId, id, patch, options) => send('PATCH', ownerPaths(businessId).item(id), patch, options),
  setUnits: (businessId, id, units, displayUnit, options) => send('PUT', ownerPaths(businessId).itemUnits(id), { units, displayUnit }, options),
  setBarcodes: (businessId, id, barcodes, options) => send('PUT', ownerPaths(businessId).itemBarcodes(id), { barcodes }, options),
  setLevels: (businessId, id, levels, options) => send('PUT', ownerPaths(businessId).itemLevels(id), { levels }, options),
  archive: (businessId, id, options) => send('POST', ownerPaths(businessId).archive(id), {}, options),
  restore: (businessId, id, options) => send('POST', ownerPaths(businessId).restore(id), {}, options),
  createCategory: (businessId, name, options) => send('POST', ownerPaths(businessId).categories, { name }, options),
  renameWarehouse: (businessId, name, options) => send('PATCH', ownerPaths(businessId).warehouse, { name }, options),
  setSetting: (businessId, key, value, locationId, options) => send('PUT', ownerPaths(businessId).setting(key), { value, locationId }, options),
  opening: (businessId, locationId) => api(ownerPaths(businessId).opening(locationId)),
  setOpening: (businessId, locationId, lines, options) => send('POST', ownerPaths(businessId).openingPost, { locationId, lines }, options),
  importTemplate: (businessId) => api(ownerPaths(businessId).importTemplate),
  importDryRun: (businessId, csv) => api(ownerPaths(businessId).importDryRun, { method: 'POST', body: { csv } }).catch((error) => { throw withCode(error); }),
  importCommit: (businessId, csv, options) => send('POST', ownerPaths(businessId).importCommit, { csv }, options),
  recipes: (businessId, branchId) => api(ownerPaths(businessId).recipes(branchId)),
};

/** Purchasing calls (suppliers, orders, approvals, evidence files). Writes take an optional { commandId } to retry safely. */
export const purchasing = {
  suppliers: (businessId, options) => api(ownerPaths(businessId).suppliers(options)),
  supplier: (businessId, id) => api(ownerPaths(businessId).supplier(id)),
  createSupplier: (businessId, body, options) => send('POST', ownerPaths(businessId).suppliers(), body, options),
  updateSupplier: (businessId, id, patch, options) => send('PATCH', ownerPaths(businessId).supplier(id), patch, options),
  setSupplierActive: (businessId, id, active, options) => send('POST', ownerPaths(businessId).supplierAction(id, active ? 'activate' : 'deactivate'), {}, options),
  completeSupplier: (businessId, id, options) => send('POST', ownerPaths(businessId).supplierAction(id, 'complete'), {}, options),
  addPrice: (businessId, id, price, options) => send('POST', ownerPaths(businessId).supplierPrices(id), price, options),
  bestPrice: (businessId, itemId, date) => api(ownerPaths(businessId).bestPrice(itemId, date)),
  suggestions: (businessId, locationId) => api(ownerPaths(businessId).reorderSuggestions(locationId)),
  createFromSuggestions: (businessId, body, options) => send('POST', ownerPaths(businessId).createFromSuggestions, body, options),
  orders: (businessId, options) => api(ownerPaths(businessId).purchaseOrders(options)),
  order: (businessId, id) => api(ownerPaths(businessId).purchaseOrder(id)),
  createOrder: (businessId, body, options) => send('POST', ownerPaths(businessId).purchaseOrders(), body, options),
  updateOrder: (businessId, id, patch, options) => send('PATCH', ownerPaths(businessId).purchaseOrder(id), patch, options),
  orderAction: (businessId, id, action, body, options) => send('POST', ownerPaths(businessId).purchaseOrderAction(id, action), body, options),
  document: (businessId, id) => api(ownerPaths(businessId).purchaseOrderDocument(id)),
  approvals: (businessId, options) => api(ownerPaths(businessId).approvals(options)),
  decide: (businessId, id, body, options) => send('POST', ownerPaths(businessId).approvalDecide(id), body, options),
  attachments: (businessId, options) => api(ownerPaths(businessId).attachments(options)),
  attachmentUrl: (businessId, id) => api(ownerPaths(businessId).attachmentUrl(id)),
  /** Uploads a picked file as evidence: { entityType, entityId, locationId? }. The server accepts JSON with base64 (up to 8 MB). */
  async upload(businessId, { entityType, entityId, locationId, file }, options) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('That file could not be read. Try another one.'));
      reader.readAsDataURL(file);
    });
    return send('POST', ownerPaths(businessId).attachments(), { entityType, entityId, locationId, file: { name: file.name, type: file.type, base64 } }, options);
  },
};

export const branch = {
  snapshot: (options) => api(branchPaths.snapshot(options), { cache: 'swr', ttl: 10000 }),
  record: (body, options) => send('POST', branchPaths.record, body, options),
  history: (options) => api(branchPaths.history(options)),
  exceptions: (options) => api(branchPaths.exceptions(options)),
  resolveException: (id, note, options) => send('POST', branchPaths.resolveException(id), { note }, options),
  item: (id) => api(branchPaths.item(id)),
  recipes: () => api(branchPaths.recipes),
};

export const notices = {
  list: (options = {}) => api(`${notificationPaths.list}${query(options)}`),
  unreadCount: () => api(notificationPaths.unread),
  markRead: (ids, options) => send('POST', notificationPaths.read, { ids }, options),
};

/* ---------- the feature switch ---------- */

/*
 * Is the new inventory switched on? Owner: GET the overview (`enabled`). Branch: GET /api/inventory, where
 * 403 inventory_disabled means off. The answer is read through the API cache (so the page itself costs no extra
 * request) and remembered for this tab, so a reload doesn't flash the old navigation. Anything unclear (no
 * answer yet, schema not applied, a network error) counts as OFF: the old Inventory entry and page keep working.
 */
const HINT = 'cravio-inventory-on:';
const readHint = (key) => { try { const v = sessionStorage.getItem(HINT + key); return v === null ? null : v === '1'; } catch { return null; } };
const writeHint = (key, on) => { try { sessionStorage.setItem(HINT + key, on ? '1' : '0'); } catch { /* storage blocked */ } };

async function isOn(area, id) {
  if (area === 'owner') return Boolean((await owner.overview(id))?.enabled);
  try { await branch.snapshot(); return true; } catch { return false; }
}

export function useInventoryEnabled(area) {
  const { account } = useAuth() || {};
  const ids = area === 'owner' ? (account?.businesses || []).map((business) => business.id)
    : area === 'branch' ? [getActiveBranch()].filter(Boolean) : [];
  const key = `${area}:${ids.join(',')}`;
  const [answer, setAnswer] = useState(() => ({ key, on: readHint(key) }));
  useEffect(() => {
    if (!ids.length) { setAnswer({ key, on: false }); return undefined; }
    let live = true;
    Promise.all(ids.map((id) => isOn(area, id).catch(() => false))).then((results) => {
      if (!live) return;
      const on = results.some(Boolean);
      writeHint(key, on);
      setAnswer({ key, on });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, area]);
  const current = answer.key === key ? answer.on : readHint(key);
  return { enabled: current === true, loading: current === null };
}

/* ---------- units and amounts (display only; the server does the real arithmetic) ---------- */

const NUMBER = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 3 });
export const formatNumber = (value) => NUMBER.format(Number(value) || 0);
const lower = (text) => String(text || '').trim().toLowerCase();
export const plural = (name) => (/(s|x|ch|sh)$/i.test(name) ? `${name}es` : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);

/** Base units in one `unit` (a standard unit code from `units`, or one of the item's own units, any case). null if unknown. */
export function factorOf(unit, item, units = []) {
  const name = lower(unit);
  const own = (item?.units || []).find((u) => lower(u.name) === name);
  if (own) return Number(own.factor);
  const standard = units.find((u) => lower(u.code) === name);
  return standard ? Number(standard.toBase) : null;
}

/** "kg", "pieces", "crates": the unit's name for a quantity. */
export function unitWord(unit, quantity, units = []) {
  const standard = units.find((u) => lower(u.code) === lower(unit));
  if (standard) return Number(quantity) === 1 ? standard.label : standard.plural;
  return Number(quantity) === 1 ? unit : plural(unit);
}

/** "400 kg", "1 crate", "30 pieces". */
export const sayAmount = (quantity, unit, units = []) => `${formatNumber(quantity)} ${unitWord(unit, quantity, units)}`;

/** `quantity` entered in `from`, shown in `to` for this item ("40" crate -> kg = 400). null when a unit is unknown. */
export function convert(quantity, from, to, item, units) {
  const a = factorOf(from, item, units);
  const b = factorOf(to, item, units);
  if (!a || !b) return null;
  return (Number(quantity) * a) / b;
}

/** Standard units that can measure the same thing as the item's base unit (kg and g for a gram item). */
export function standardUnitsFor(baseUnit, units = []) {
  const dimension = units.find((u) => lower(u.code) === lower(baseUnit))?.dimension;
  return units.filter((u) => u.dimension === dimension);
}

/** Every unit an amount for this item can be typed in: the standard ones, then the item's own packs. [{ value, label }] */
export function unitChoices(item, units) {
  return [
    ...standardUnitsFor(item.baseUnit, units).map((u) => ({ value: u.code, label: u.plural === u.label ? u.label : `${u.plural}` })),
    ...(item.units || []).map((u) => ({ value: u.name, label: plural(u.name) })),
  ];
}

/** Readable measure names for a base unit ("g" -> "Weight"). */
export const MEASURED_LABEL = { weight: 'Weight', volume: 'Volume', count: 'Count', servings: 'Servings', serving: 'Servings' };

/* ---------- times (P1-15) ---------- */

const STAMP = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** "18/11/2026 14:05 EAT" (East Africa Time, whatever the device's clock says). */
export function formatStamp(iso) {
  const time = iso ? new Date(iso) : null;
  if (!time || Number.isNaN(time.getTime())) return '';
  return `${STAMP.format(time).replace(',', '')} EAT`;
}

/** Stock money: "Ksh 2,600" for whole amounts, "Ksh 7.80" when there are cents (never "Ksh 7.8"). */
const stockKes = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stockKesWhole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
export function formatStockMoney(value) {
  const n = Number(value) || 0;
  return `Ksh ${Number.isInteger(Math.round(n * 100) / 100) ? stockKesWhole.format(n) : stockKes.format(n)}`;
}

/* ---------- purchasing helpers (P2-12 to P2-14): display only; the server does the real arithmetic ---------- */

/** 0712 345 678, +254 712 345 678, 254712345678 or 712345678 -> '254712345678'; null when it isn't a Kenyan mobile number. */
export function normalisePhone(value) {
  const digits = String(value ?? '').trim().replace(/[\s\-().]/g, '');
  const match = /^(?:\+?254|0)?([17][0-9]{8})$/.exec(digits);
  return match ? `254${match[1]}` : null;
}
/** A KRA PIN in its usual shape (A123456789B) or null. */
export function normalisePin(value) {
  const pin = String(value ?? '').trim().replace(/[\s-]/g, '').toUpperCase();
  return /^[AP][0-9]{9}[A-Z]$/.test(pin) ? pin : null;
}
/** '254712345678' -> '0712 345 678' for reading. */
export const showPhone = (phone) => { const m = /^254([17]\d{2})(\d{3})(\d{3})$/.exec(String(phone || '')); return m ? `0${m[1]} ${m[2]} ${m[3]}` : phone || ''; };

/** Today's date in Nairobi as YYYY-MM-DD. */
export const todayNairobi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
/** '2026-11-20' -> 'Fri 20 Nov 2026'. */
export function formatDay(isoDate) {
  const d = isoDate ? new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? DAY.format(d).replace(',', '') : '';
}

export const SUPPLIER_TYPE_LABEL = { formal: 'Formal', informal: 'Informal', one_off: 'One-off' };
export const SUPPLIER_TYPE_HELP = {
  formal: 'A registered business that gives invoices and has a KRA PIN.',
  informal: 'A market trader or small seller you buy from regularly.',
  one_off: 'Someone you bought from once, for example in an emergency.',
};
export const PAYMENT_METHOD_LABEL = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank transfer', credit: 'On credit' };
export const termsText = (days) => (!Number(days) ? 'Pay on delivery' : `Pay within ${days} days`);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const moneyOrDash = (value) => (value === null || value === undefined || value === '' ? '–' : formatStockMoney(value));

/**
 * How a supplier price reads: { main: 'Ksh 6,500 per crate', pack: '10 kg', perUnit: 'Ksh 650/kg' }.
 * `price` is a price row (unit, unitFactor, price, pricePerBase); `item` needs baseUnit, displayUnit and its own units.
 */
export function describePrice(price, item, units = []) {
  const unit = String(price.unit || '').toLowerCase();
  const out = { main: `${formatStockMoney(price.price)} per ${unit}`, pack: null, perUnit: null };
  const shown = item?.displayUnit || item?.baseUnit;
  const factor = shown ? factorOf(shown, item, units) : null;
  if (!shown || !factor || unit === String(shown).toLowerCase()) return out;
  const size = Number(price.unitFactor) / factor;
  if (Number.isFinite(size) && size > 0 && size !== 1) out.pack = sayAmount(round2(size * 1000) / 1000, shown, units);
  const per = Number(price.pricePerBase) * factor;
  if (Number.isFinite(per) && per > 0) out.perUnit = `${formatStockMoney(round2(per))}/${unitWord(shown, 1, units)}`;
  return out;
}
/** 'Ksh 6,500 per crate (10 kg) · Ksh 650/kg' */
export function priceSentence(price, item, units = []) {
  const d = describePrice(price, item, units);
  return `${d.main}${d.pack ? ` (${d.pack})` : ''}${d.perUnit ? ` · ${d.perUnit}` : ''}`;
}
/** Percent change between two price rows' per-base prices, rounded to 1 decimal: 12 or -3.5; null when unknown. */
export function priceChange(now, before) {
  const a = Number(now?.pricePerBase); const b = Number(before?.pricePerBase);
  if (!(a > 0) || !(b > 0)) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

/** The plain-words purchase order statuses: label and badge tone (see inv-badge). */
export const PO_STATUS = {
  draft: { label: 'Draft', tone: 'off' },
  pending_approval: { label: 'Waiting for approval', tone: 'low' },
  approved: { label: 'Approved', tone: 'ok' },
  sent: { label: 'Sent', tone: 'ok' },
  partially_received: { label: 'Part received', tone: 'low' },
  received: { label: 'Received', tone: 'ok' },
  closed: { label: 'Closed', tone: 'off' },
  cancelled: { label: 'Cancelled', tone: 'out' },
};
export const PO_STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled'];

/** Order totals as the screen estimates them (the server's numbers win once saved): each line to the cent, then summed. */
export function estimateTotals(lines, vatPct = 16) {
  let subtotal = 0; let vat = 0;
  for (const line of lines) {
    const amount = round2((Number(line.qty) || 0) * (Number(line.price) || 0));
    subtotal = round2(subtotal + amount);
    if ((line.vatClass || 'standard') === 'standard') vat = round2(vat + round2((amount * vatPct) / 100));
  }
  return { subtotal, vat, total: round2(subtotal + vat) };
}
export { round2 };
