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
