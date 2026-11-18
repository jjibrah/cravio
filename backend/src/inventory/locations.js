// Stock locations for the inventory module: the business's ONE warehouse (the 009 'center' location, shown as "Warehouse")
// and one location per branch. Decision: one warehouse per business (docs/v2/DECISIONS.md INV-A3).
import { HttpError } from '../lib/http.js';
import { requireCan, locationsWith } from './permissions.js';
import { record, diff } from './audit.js';

const fail = (status, message, code) => new HttpError(status, message, { code });

const shape = (r) => ({ id: r.id, kind: r.kind, name: r.name, code: r.code || null, status: r.status || 'active',
  restaurantId: r.restaurant_id || null, label: r.kind === 'center' || r.kind === 'warehouse' ? 'Warehouse' : 'Branch' });

/** The business's warehouse row, creating it (named "Warehouse") when it doesn't exist yet. Same logic as 009's centerLocation. */
export async function getWarehouse(db, businessId) {
  await db.query(`insert into public.stock_locations (business_id, kind, name)
    select id, 'center', 'Warehouse' from public.businesses where id = $1 on conflict do nothing`, [businessId]);
  const { rows } = await db.query(`select id, kind, name, code, status, restaurant_id from public.stock_locations
    where business_id = $1 and kind in ('center', 'warehouse') order by kind limit 1`, [businessId]);
  if (!rows[0]) throw fail(404, 'That business doesn’t exist.', 'business_not_found');
  return shape(rows[0]);
}

/** Creates any branch location that is missing (009's private.branch_location is idempotent). */
export async function ensureBranchLocations(db, businessId) {
  const { rows } = await db.query('select id from public.restaurants where business_id = $1', [businessId]);
  for (const r of rows) await db.query('select private.branch_location($1)', [r.id]);
}

/** Warehouse + branch locations the scope can see (inv.view there), with the capabilities it holds at each. */
export async function listLocations(db, scope) {
  await getWarehouse(db, scope.businessId);
  await ensureBranchLocations(db, scope.businessId);
  const visible = new Set(locationsWith(scope, 'inv.view'));
  const { rows } = await db.query(`select l.id, l.kind, l.code, l.status, l.restaurant_id, coalesce(r.name, l.name) as name
    from public.stock_locations l left join public.restaurants r on r.id = l.restaurant_id
    where l.business_id = $1 order by (l.kind <> 'branch') desc, lower(coalesce(r.name, l.name))`, [scope.businessId]);
  return rows.filter((l) => visible.has(l.id)).map((l) => ({ ...shape(l), capabilities: [...(scope.locationCaps.get(l.id) || [])].sort() }));
}

/** Renames the warehouse and/or sets its short code (null or '' clears the code). Owner only (inv.settings.edit). */
export async function renameWarehouse(db, scope, input = {}) {
  requireCan(scope, 'inv.settings.edit');
  const warehouse = await getWarehouse(db, scope.businessId);
  const patch = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw fail(400, 'Enter a name for the warehouse.', 'name_required');
    if (name.length > 80) throw fail(400, 'Keep the warehouse name under 80 characters.', 'name_too_long');
    patch.name = name;
  }
  if (input.code !== undefined) {
    const code = input.code === null ? '' : String(input.code).trim();
    if (code.length > 20) throw fail(400, 'Keep the warehouse code under 20 characters.', 'code_too_long');
    patch.code = code || null;
    if (patch.code) {
      const clash = (await db.query(`select id from public.stock_locations where business_id = $1 and lower(btrim(code)) = lower($2) and id <> $3`,
        [scope.businessId, patch.code, warehouse.id])).rows[0];
      if (clash) throw fail(409, `The code “${patch.code}” is already used by another location. Choose a different code.`, 'code_taken');
    }
  }
  if (!Object.keys(patch).length) throw fail(400, 'Change the name or the code.', 'nothing_to_change');
  const change = diff({ name: warehouse.name, code: warehouse.code }, { name: patch.name ?? warehouse.name, code: 'code' in patch ? patch.code : warehouse.code });
  if (!change.changed.length) return warehouse;
  await db.query(`update public.stock_locations set name = $2, code = $3 where id = $1`,
    [warehouse.id, patch.name ?? warehouse.name, 'code' in patch ? patch.code : warehouse.code]);
  await record(db, { businessId: scope.businessId, locationId: warehouse.id, actorId: scope.userId, actorRole: scope.role,
    entity: 'warehouse', entityId: warehouse.id, action: 'update', before: change.before, after: change.after });
  return getWarehouse(db, scope.businessId);
}
