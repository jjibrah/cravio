// Inventory owner API (P1-08), base /api/owner/inventory/:businessId (migrations 009 + 012).
// Catalogue (items, units, barcodes, levels, categories), the warehouse and inventory settings.
// Pattern for every write: requireUser -> inventoryScope (pool) -> authorize (pool, BEFORE the transaction, so a refused
// attempt's 'denied' audit row isn't rolled back) -> one transaction -> once(commandId) -> service (which audits).
// Reads never open a transaction. Costs are only in responses for callers holding inv.cost.view.
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { once } from '../inventory/commands.js';
import { CAPABILITIES, authorize, can, inventoryScope } from '../inventory/permissions.js';
import { getSettings, setSetting } from '../inventory/policies.js';
import {
  archiveItem, createCategory, createItem, getItem, listCategories, listItems, loadUnits, restoreItem, setBarcodes, setItemUnits,
  setLevels, updateCategory, updateItem,
} from '../inventory/catalogue.js';
import { getWarehouse, listLocations, renameWarehouse } from '../inventory/locations.js';
import { openingStatus, setOpening } from '../inventory/opening.js';
import { TEMPLATE_CSV, TEMPLATE_FILENAME, commit as commitImport, dryRun as dryRunImport } from '../inventory/import.js';

const ID = '[0-9a-fA-F-]{36}';
const base = `/api/owner/inventory/(?<businessId>${ID})`;
const path = (suffix = '') => new RegExp(`^${base}${suffix}$`);

const MISSING_SCHEMA = new HttpError(503, 'Inventory needs database update 012, which hasn’t been applied yet.', { code: 'inventory_schema_missing' });
const camel = (capability) => capability.replace(/^inv\./, '').replace(/\.(\w)/g, (_m, c) => c.toUpperCase());

/** How an item can be measured, in plain words, for the item form. */
const MEASURED_BY = [
  { value: 'weight', label: 'Weight', baseUnit: 'g', example: 'flour, chicken, rice' },
  { value: 'volume', label: 'Volume', baseUnit: 'ml', example: 'oil, milk, juice' },
  { value: 'count', label: 'Count', baseUnit: 'piece', example: 'eggs, buns, bottles' },
  { value: 'servings', label: 'Servings', baseUnit: 'serving', example: 'prepared portions' },
];

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }) } = {}) {
  /** Reads/authorizes on the pool; turns "migration 012 missing" database errors into one plain 503. */
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (['42P01', '42703', '42883'].includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };

  /** The caller's inventory scope for the business in the path (locations are created for anyone who may use inventory). */
  async function open(request, params) {
    const context = await authenticate(request);
    const businessId = String(params.businessId).toLowerCase();
    const db = pool();
    let scope = await safely(() => inventoryScope(db, context, businessId));
    if (scope.enabled && scope.role !== 'none' && scope.role !== 'admin') {
      scope = await safely(() => inventoryScope(db, context, businessId, { ensureLocations: true }));
    }
    return { db, scope };
  }

  const read = (capability, fn) => async ({ request, params, url }) => {
    const { db, scope } = await open(request, params);
    await safely(() => authorize(db, scope, capability, { entity: 'inventory' }));
    return safely(() => fn(db, scope, params, url?.searchParams || new URLSearchParams()));
  };

  /**
   * A write. `check(scope, params, body)` may name extra authorizations (e.g. a location) and is run before the transaction too.
   * The body may carry commandId: a retry returns the first result instead of repeating the change.
   */
  const write = (kind, capability, run, { check } = {}) => withBody(async ({ request, params, body }) => {
    const { db, scope } = await open(request, params);
    await safely(() => authorize(db, scope, capability, { entity: kind }));
    if (check) await safely(() => check(db, scope, params, body));
    return transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind }, () => run(tx, scope, params, body)));
  });

  const flag = (searchParams, key) => ['1', 'true', 'yes'].includes(String(searchParams.get(key) || '').toLowerCase());

  return [
    // Everything the Stock / Items screens need in one call.
    { method: 'GET', path: path(), async handler({ request, params, url }) {
      const { db, scope } = await open(request, params);
      if (!scope.enabled && scope.roles.includes('owner')) {
        // The owner can still open the page, to be told how to switch inventory on.
        return { enabled: false, role: 'owner', capabilities: {}, warehouse: null, locations: [], categories: [], units: [], measuredBy: MEASURED_BY, items: [], settings: null,
          message: 'Inventory isn’t switched on for this business yet. Ask your Cravio administrator to switch it on.' };
      }
      await safely(() => authorize(db, scope, 'inv.view', { entity: 'inventory' }));
      const q = url?.searchParams || new URLSearchParams();
      return safely(async () => ({
        enabled: true, role: scope.role,
        capabilities: Object.fromEntries(CAPABILITIES.map((c) => [camel(c), can(scope, c)])),
        warehouse: await getWarehouse(db, scope.businessId),
        locations: await listLocations(db, scope),
        categories: await listCategories(db, scope),
        units: await loadUnits(db),
        measuredBy: MEASURED_BY,
        items: await listItems(db, scope, { search: q.get('search'), categoryId: q.get('category') || undefined, includeArchived: flag(q, 'archived'), lowOnly: flag(q, 'low') }),
        settings: await getSettings(db, scope.businessId),
      }));
    } },

    // ----- Items -----
    { method: 'GET', path: path(`/items/(?<id>${ID})`), handler: read('inv.view', (db, scope, params) => getItem(db, scope, params.id)) },
    { method: 'POST', path: path('/items'), handler: write('inv_item_create', 'inv.item.edit', (db, scope, _p, body) => createItem(db, scope, body)) },
    { method: 'PATCH', path: path(`/items/(?<id>${ID})`), handler: write('inv_item_edit', 'inv.item.edit', (db, scope, params, body) => {
      const { commandId, ...patch } = body;
      return updateItem(db, scope, params.id, patch);
    }) },
    { method: 'POST', path: path(`/items/(?<id>${ID})/archive`), handler: write('inv_item_archive', 'inv.item.edit', (db, scope, params) => archiveItem(db, scope, params.id)) },
    { method: 'POST', path: path(`/items/(?<id>${ID})/restore`), handler: write('inv_item_restore', 'inv.item.edit', (db, scope, params) => restoreItem(db, scope, params.id)) },
    { method: 'PUT', path: path(`/items/(?<id>${ID})/units`), handler: write('inv_item_units', 'inv.item.edit', (db, scope, params, body) =>
      setItemUnits(db, scope, params.id, body.units, { displayUnit: body.displayUnit })) },
    { method: 'PUT', path: path(`/items/(?<id>${ID})/barcodes`), handler: write('inv_item_barcodes', 'inv.item.edit', (db, scope, params, body) => setBarcodes(db, scope, params.id, body.barcodes)) },
    // Levels are per location: the caller must also be able to record stock at each location named (a branch manager: their own branch).
    { method: 'PUT', path: path(`/items/(?<id>${ID})/levels`), handler: write('inv_item_levels', 'inv.item.edit', (db, scope, params, body) => setLevels(db, scope, params.id, body.levels), {
      async check(db, scope, _params, body) {
        for (const entry of Array.isArray(body.levels) ? body.levels : []) {
          if (entry && typeof entry.locationId === 'string' && scope.locations.some((l) => l.id === entry.locationId.toLowerCase())) {
            await authorize(db, scope, 'inv.stock.record', { locationId: entry.locationId.toLowerCase(), entity: 'inv_item_levels' });
          }
        }
      },
    }) },

    // ----- Opening stock (P1-11): the first balance of an item at a location -----
    // GET ?location=<id>: every item with whether its opening is set there. POST { locationId, lines: [{ itemId, quantity, unit?, unitCost? }], commandId? }.
    // unitCost is KES per the ENTERED unit ("650" with unit kg = KES 650 per kg); the ledger stores it per base unit.
    { method: 'GET', path: path('/opening'), async handler({ request, params, url }) {
      const { db, scope } = await open(request, params);
      const locationId = String(url?.searchParams?.get('location') || '').toLowerCase();
      if (!locationId) throw new HttpError(400, 'Choose a location to see its opening stock.', { code: 'location_required' });
      await safely(() => authorize(db, scope, 'inv.view', { locationId, entity: 'inventory_opening' }));
      return safely(() => openingStatus(db, scope, locationId));
    } },
    { method: 'POST', path: path('/opening'), handler: write('inv_opening', 'inv.stock.record', (db, scope, _p, body) => setOpening(db, scope, { locationId: body.locationId, lines: body.lines, commandId: body.commandId }), {
      async check(db, scope, _params, body) {
        const locationId = typeof body.locationId === 'string' ? body.locationId.toLowerCase() : null;
        if (locationId && scope.locations.some((l) => l.id === locationId)) await authorize(db, scope, 'inv.stock.record', { locationId, entity: 'inv_opening' });
      },
    }) },

    // ----- CSV import (P1-11) -----
    // GET template: text/csv download (or { filename, csv } JSON with ?format=json). POST import/dry-run { csv }: row-by-row report, writes nothing.
    // POST import { csv, commandId }: all or nothing, 409 import_has_errors with details.report when any row has an error.
    { method: 'GET', path: path('/import/template'), async handler({ request, response, params, url }) {
      const { db, scope } = await open(request, params);
      await safely(() => authorize(db, scope, 'inv.item.edit', { entity: 'inv_import' }));
      if (!response || url?.searchParams?.get('format') === 'json') return { filename: TEMPLATE_FILENAME, csv: TEMPLATE_CSV };
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="${TEMPLATE_FILENAME}"`);
      response.writeHead(200);
      response.end(TEMPLATE_CSV);
      return undefined; // the server sees the response already ended and sends nothing more
    } },
    { method: 'POST', path: path('/import/dry-run'), handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await open(request, params);
      await safely(() => authorize(db, scope, 'inv.item.edit', { entity: 'inv_import' }));
      return safely(() => dryRunImport(db, scope, body.csv));
    }) },
    { method: 'POST', path: path('/import'), handler: write('inv_import', 'inv.item.edit', (db, scope, _p, body) => commitImport(db, scope, body.csv, { commandId: body.commandId })) },

    // ----- Categories -----
    { method: 'GET', path: path('/categories'), handler: read('inv.view', async (db, scope) => ({ categories: await listCategories(db, scope) })) },
    { method: 'POST', path: path('/categories'), handler: write('inv_category_create', 'inv.item.edit', (db, scope, _p, body) => createCategory(db, scope, body)) },
    { method: 'PATCH', path: path(`/categories/(?<id>${ID})`), handler: write('inv_category_edit', 'inv.item.edit', (db, scope, params, body) => {
      const { commandId, ...patch } = body;
      return updateCategory(db, scope, params.id, patch);
    }) },

    // ----- Warehouse (one per business) -----
    { method: 'PATCH', path: path('/warehouse'), handler: write('inv_warehouse_edit', 'inv.settings.edit', (db, scope, _p, body) => renameWarehouse(db, scope, { name: body.name, code: body.code })) },

    // ----- Settings (owner only) -----
    { method: 'PUT', path: path('/settings/(?<key>[a-z_]{1,60})'), handler: write('inv_setting', 'inv.settings.edit', async (db, scope, params, body) => {
      const locationId = body.locationId ? String(body.locationId).toLowerCase() : null;
      if (locationId && !scope.locations.some((l) => l.id === locationId)) throw new HttpError(404, 'That location isn’t part of this business. Pick it from the locations list.', { code: 'location_not_found' });
      const value = await setSetting(db, { businessId: scope.businessId, locationId, key: params.key, value: body.value, actorId: scope.userId, actorRole: scope.role });
      return { key: params.key, value, settings: await getSettings(db, scope.businessId) };
    }) },
  ];
}

export const routes = createRoutes();
