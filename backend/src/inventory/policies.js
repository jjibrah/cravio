// Inventory policies: typed business-wide defaults with optional per-location overrides (07 §0.5 / Phase 1 P1-07).
// Lookup order: location override -> business default row (location_id null) -> SETTINGS default below.
import { HttpError } from '../lib/http.js';
import { record } from './audit.js';

const bad = (message) => new HttpError(400, message, { code: 'invalid_setting' });

const bool = (label) => (value) => {
  if (typeof value !== 'boolean') throw bad(`${label} must be on or off.`);
  return value;
};
const number = (label, { min = 0, max = 1e9, integer = false, nullable = false } = {}) => (value) => {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${label} must be a number.`);
  if (integer && !Number.isInteger(value)) throw bad(`${label} must be a whole number.`);
  if (value < min || value > max) throw bad(`${label} must be between ${min} and ${max}.`);
  return value;
};
const choice = (label, options) => (value) => {
  if (!options.includes(value)) throw bad(`${label} must be one of: ${options.join(', ')}.`);
  return value;
};

/** Every setting: its default, type and validator (returns the cleaned value or throws 400 'invalid_setting'). */
export const SETTINGS = {
  low_alert_enabled: { default: true, type: 'boolean', validate: bool('Low-stock alerts') },
  branch_can_add_items: { default: true, type: 'boolean', validate: bool('Branch managers adding items') },
  operations_can_approve: { default: false, type: 'boolean', validate: bool('Operations managers approving') },
  large_amount_warning_factor: { default: 10, type: 'number', validate: number('The large-amount warning', { min: 1, max: 1000 }) },
  // Legacy approval thresholds: NOT set until the owner sets them (D2-16). Phase 3 moves them to approval rules. Unset = the safe
  // behaviour: wastage recorded without approval, any count variance and every manual adjustment needing an approval.
  wastage_approval_value_kes: { default: null, type: 'number|null', validate: number('The wastage approval value', { min: 0, max: 1e9, nullable: true }) },
  count_tolerance_pct: { default: null, type: 'number|null', validate: number('The count tolerance', { min: 0, max: 100, nullable: true }) },
  cost_method: { default: 'weighted_average', type: 'enum', validate: choice('The cost method', ['weighted_average']) },
  notify_on_zero: { default: true, type: 'boolean', validate: bool('Alerts when an item hits zero') },
  notify_on_exception: { default: true, type: 'boolean', validate: bool('Alerts on stock exceptions') },

  // ---- Phase 2 (purchasing and distribution, 09 P2-02). No money amounts are built in: emergency-buy limits and PO bands live in
  // approval rules the owner sets (D2-6, D2-7); until a limit is set every emergency buy goes to the owner (D2-6).
  operations_can_purchase: { default: false, type: 'boolean', validate: bool('Operations managers creating purchase orders') },
  price_variance_alert_pct: { default: 10, type: 'number', validate: number('The price-increase alert', { min: 0, max: 1000 }) },
  over_delivery_tolerance_pct: { default: 5, type: 'number', validate: number('The extra-delivery allowance on supplier deliveries', { min: 0, max: 50 }) },
  transfer_over_tolerance_pct: { default: 5, type: 'number', validate: number('The extra-delivery allowance on transfers', { min: 0, max: 100 }) },
  returns_need_approval: { default: false, type: 'boolean', validate: bool('Approval for returns to the warehouse') },
  branch_to_branch_enabled: { default: true, type: 'boolean', validate: bool('Transfers between branches') },
  emergency_repeat_alert_count: { default: 3, type: 'number', validate: number('The repeated emergency-buy count', { min: 1, max: 50, integer: true }) },
  emergency_repeat_alert_days: { default: 7, type: 'number', validate: number('The repeated emergency-buy window in days', { min: 1, max: 90, integer: true }) },
  // An emergency buy that cost more than this % over what was authorised goes to the owner for review (P2-11). A percentage, not an amount.
  emergency_over_estimate_alert_pct: { default: 10, type: 'number', validate: number('The emergency over-estimate alert', { min: 0, max: 1000 }) },
  // KES per US dollar for the AI usage meter. Set by the Cravio admin; null until set (AI cost is then shown in dollars only).
  ai_usd_to_kes: { default: null, type: 'number|null', validate: number('The dollar-to-shilling rate', { min: 1, max: 10000, nullable: true }) },

  // ---- Phase 3 (controls, counts, batches, reports; 10 P3-02). Every money amount and limit starts as NOT SET (null), D2-16 / D3-4 / D3-5:
  // nothing here is a built-in KES figure. Until the owner sets them: wastage posts at once, every adjustment needs approval, any count
  // with a non-zero variance needs one approval, allowances are off, no period close day. The approval limits themselves live in
  // approval rules (017, edited in Settings -> Inventory); count_variance_* are the read-as-fallback pair for a business that has not made a rule.
  count_variance_value_kes: { default: null, type: 'number|null', validate: number('The count variance value', { min: 0, max: 1e9, nullable: true }) },
  count_variance_pct: { default: null, type: 'number|null', validate: number('The count variance percentage', { min: 0, max: 100, nullable: true }) },
  // A report highlight (variance rows outside it turn amber), NOT an approval limit. A percentage, not money.
  variance_tolerance_pct: { default: 5, type: 'number', validate: number('The variance tolerance', { min: 0, max: 100 }) },
  // Unusual wastage: this week's value for an item at a branch vs its 4-week weekly average (a ratio, not money); the optional floor hides trivial amounts.
  unusual_wastage_factor: { default: 2, type: 'number', validate: number('The unusual-wastage factor', { min: 1, max: 100 }) },
  unusual_wastage_floor_kes: { default: null, type: 'number|null', validate: number('The unusual-wastage floor', { min: 0, max: 1e9, nullable: true }) },
  expiry_alert_days: { default: 3, type: 'number', validate: number('The expiry alert lead time in days', { min: 0, max: 365, integer: true }) },
  expired_override_hours: { default: 24, type: 'number', validate: number('How long an expired-batch override lasts, in hours', { min: 1, max: 168, integer: true }) },
  // Staff meals and complimentaries (D3-6): per branch per day, off until set (null). Over the allowance goes to approval.
  staff_meal_allowance_portions: { default: null, type: 'number|null', validate: number('The staff-meal allowance in portions', { min: 0, max: 100000, integer: true, nullable: true }) },
  complimentary_allowance_kes: { default: null, type: 'number|null', validate: number('The complimentary allowance', { min: 0, max: 1e9, nullable: true }) },
  // Period close (D3-11): the day of the month the owner is reminded to close the previous month; null = no reminder.
  period_close_day: { default: null, type: 'number|null', validate: number('The period-close day', { min: 1, max: 28, integer: true, nullable: true }) },
  // Menu engineering (P3-25): ratios, not money.
  price_change_alert_pct: { default: 10, type: 'number', validate: number('The ingredient price-change alert', { min: 0, max: 1000 }) },
  food_cost_target_pct: { default: 35, type: 'number', validate: number('The food-cost target', { min: 1, max: 100 }) },
  // Standard VAT rate used when a supplier document does not state one (purchasing.js already reads this key and assumes 16 until set).
  vat_standard_pct: { default: 16, type: 'number', validate: number('The standard VAT rate', { min: 0, max: 100 }) },
};

const known = (key) => {
  if (!Object.hasOwn(SETTINGS, key)) throw bad(`Unknown setting “${String(key).slice(0, 40)}”.`);
  return SETTINGS[key];
};

/** { key: value } for every known key from business-level rows [{ key, value }] (defaults where no row). Pure. */
export function effectiveSettings(rows = []) {
  const out = Object.fromEntries(Object.entries(SETTINGS).map(([key, def]) => [key, def.default]));
  for (const row of rows) if (Object.hasOwn(SETTINGS, row.key)) out[row.key] = row.value;
  return out;
}

// Settings change rarely and are read by many requests. On the real pool (never inside a transaction, never in tests' in-memory databases)
// the answer is kept for SETTINGS_TTL_MS. setSetting / resetSetting drop it at once; because they run inside a transaction that is not yet
// committed, reads for that business bypass the cache for a few seconds afterwards instead of re-caching the old value.
export const SETTINGS_TTL_MS = 30_000;
const SETTINGS_QUIET_MS = 5_000;
const cached = new Map();   // `${businessId}|${locationId}` -> { value, until }
const quietUntil = new Map(); // businessId -> time before which the cache is not used
const isPool = (db) => typeof db?.totalCount === 'number' && db.parallelSafe !== true;
export function invalidateSettings(businessId) {
  for (const key of cached.keys()) if (key.startsWith(`${businessId}|`)) cached.delete(key);
  quietUntil.set(businessId, Date.now() + SETTINGS_QUIET_MS);
}
export const clearSettingsCache = () => { cached.clear(); quietUntil.clear(); };

/** Effective values for a business (and optionally one location): { key: value } for every known key. */
export async function getSettings(db, businessId, locationId = null) {
  const key = `${businessId}|${locationId || ''}`;
  const useCache = isPool(db) && (quietUntil.get(businessId) || 0) <= Date.now();
  if (useCache) { const hit = cached.get(key); if (hit && hit.until > Date.now()) return { ...hit.value }; }
  const { rows } = await db.query(
    `select key, value, location_id from public.inventory_settings
     where business_id = $1 and (location_id is null or location_id = $2::uuid)`, [businessId, locationId || null]);
  const out = effectiveSettings(rows.filter((r) => r.location_id === null));
  for (const row of rows.filter((r) => r.location_id !== null)) if (Object.hasOwn(SETTINGS, row.key)) out[row.key] = row.value;
  if (useCache) cached.set(key, { value: out, until: Date.now() + SETTINGS_TTL_MS });
  return { ...out };
}

export async function getSetting(db, businessId, key, locationId = null) {
  known(key);
  return (await getSettings(db, businessId, locationId))[key];
}

/** Validates and upserts one setting (business default when locationId is null), then writes an audit event with before/after. */
export async function setSetting(db, { businessId, locationId = null, key, value, actorId = null, actorRole = null }) {
  const def = known(key);
  if (value === undefined) throw bad('Choose a value.');
  const clean = def.validate(value);
  const { rows: old } = await db.query(
    `select id, value from public.inventory_settings where business_id = $1 and key = $2 and location_id is not distinct from $3::uuid`,
    [businessId, key, locationId || null]);
  const before = old[0] ? old[0].value : undefined;
  const { rows } = await db.query(
    `insert into public.inventory_settings (business_id, location_id, key, value, updated_by) values ($1, $2, $3, $4::jsonb, $5)
     on conflict (business_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now() returning id`,
    [businessId, locationId || null, key, JSON.stringify(clean), actorId]);
  invalidateSettings(businessId);
  await record(db, { businessId, locationId, actorId, actorRole, entity: 'setting', entityId: rows[0].id, action: old[0] ? 'update' : 'create',
    before: { key, value: before === undefined ? SETTINGS[key].default : before, inherited: before === undefined }, after: { key, value: clean } });
  return clean;
}

/** Removes an override so the setting falls back to the next level. */
export async function resetSetting(db, { businessId, locationId = null, key, actorId = null, actorRole = null }) {
  known(key);
  const { rows } = await db.query(
    `delete from public.inventory_settings where business_id = $1 and key = $2 and location_id is not distinct from $3::uuid returning id, value`,
    [businessId, key, locationId || null]);
  invalidateSettings(businessId);
  if (rows[0]) await record(db, { businessId, locationId, actorId, actorRole, entity: 'setting', entityId: rows[0].id, action: 'reset', before: { key, value: rows[0].value } });
  return Boolean(rows[0]);
}
