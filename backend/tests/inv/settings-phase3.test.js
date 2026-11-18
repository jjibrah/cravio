// P3-02: the Phase 3 settings keys (policies.js SETTINGS): defaults are "not set" for every money amount and limit (D2-16, D3-4, D3-5),
// the non-money ratios have their documented defaults, every key validates, and a value round-trips through setSetting / getSettings.
// Usage: node backend/tests/inv/settings-phase3.test.js
import { inventoryFixture } from './fixture.js';
import { makeAsserts } from './helpers.js';
import { SETTINGS, getSettings, getSetting, setSetting, resetSetting } from '../../src/inventory/policies.js';

const { eq, ok, refuses, count } = makeAsserts();
const { db, ids, users } = await inventoryFixture();
const biz = ids.businessId;

// ---- defaults -----------------------------------------------------------------------------------------------------------------
const NOT_SET = ['count_variance_value_kes', 'count_variance_pct', 'unusual_wastage_floor_kes', 'staff_meal_allowance_portions', 'complimentary_allowance_kes', 'period_close_day',
  'wastage_approval_value_kes', 'count_tolerance_pct'];
const RATIOS = { variance_tolerance_pct: 5, unusual_wastage_factor: 2, expiry_alert_days: 3, expired_override_hours: 24, price_change_alert_pct: 10, food_cost_target_pct: 35, vat_standard_pct: 16 };
const all = await getSettings(db, biz);
for (const key of NOT_SET) eq(all[key], null, `${key} starts as not set`);
for (const [key, value] of Object.entries(RATIOS)) eq(all[key], value, `${key} default`);
eq(all.cost_method, 'weighted_average', 'cost method is still weighted average (batch arrives with P3-19)');
ok(Object.values(SETTINGS).every((d) => typeof d.validate === 'function' && 'default' in d), 'every setting has a default and a validator');

// ---- a value round-trips, per business and per location ---------------------------------------------------------------------------
const actor = { actorId: users.owner, actorRole: 'owner' };
eq(await setSetting(db, { businessId: biz, key: 'count_variance_pct', value: 2.5, ...actor }), 2.5, 'set a count variance %');
eq(await getSetting(db, biz, 'count_variance_pct'), 2.5, 'read it back');
eq(await setSetting(db, { businessId: biz, locationId: ids.branchLocationId, key: 'count_variance_pct', value: 1, ...actor }), 1, 'a branch override');
eq(await getSetting(db, biz, 'count_variance_pct', ids.branchLocationId), 1, 'the branch sees its override');
eq(await getSetting(db, biz, 'count_variance_pct'), 2.5, 'the business keeps its own');
ok(await resetSetting(db, { businessId: biz, locationId: ids.branchLocationId, key: 'count_variance_pct', ...actor }), 'reset the override');
eq(await getSetting(db, biz, 'count_variance_pct', ids.branchLocationId), 2.5, 'falls back to the business value');
eq(await setSetting(db, { businessId: biz, key: 'count_variance_pct', value: null, ...actor }), null, 'null puts a limit back to not set');
eq(await setSetting(db, { businessId: biz, key: 'staff_meal_allowance_portions', value: 5, ...actor }), 5, 'staff-meal allowance in whole portions');
eq(await setSetting(db, { businessId: biz, key: 'period_close_day', value: 5, ...actor }), 5, 'period close day');
eq((await db.query(`select count(*)::int as n from public.inventory_events where business_id = $1 and entity = 'setting'`, [biz])).rows[0].n, 6, 'every change is audited');

// ---- validation ----------------------------------------------------------------------------------------------------------------
const set = (key, value) => setSetting(db, { businessId: biz, key, value, ...actor });
const bad = async (key, value, re) => refuses(set(key, value), 400, 'invalid_setting', re, `${key} = ${JSON.stringify(value)}`);
await bad('count_variance_pct', 101, /between 0 and 100/);
await bad('count_variance_pct', -1, /between 0 and 100/);
await bad('count_variance_pct', '5', /must be a number/);
await bad('count_variance_value_kes', -10, /between 0/);
await bad('unusual_wastage_factor', 0.5, /between 1 and 100/);
await bad('unusual_wastage_factor', null, /must be a number/);
await bad('unusual_wastage_floor_kes', -1, /between 0/);
await bad('expiry_alert_days', 2.5, /whole number/);
await bad('expiry_alert_days', 366, /between 0 and 365/);
await bad('expired_override_hours', 0, /between 1 and 168/);
await bad('staff_meal_allowance_portions', 1.5, /whole number/);
await bad('complimentary_allowance_kes', 'lots', /must be a number/);
await bad('period_close_day', 29, /between 1 and 28/);
await bad('period_close_day', 0, /between 1 and 28/);
await bad('variance_tolerance_pct', null, /must be a number/);
await bad('food_cost_target_pct', 0, /between 1 and 100/);
await bad('vat_standard_pct', 101, /between 0 and 100/);
await bad('no_such_setting', 1, /Unknown setting/);
eq(await getSetting(db, biz, 'period_close_day'), 5, 'a refused value changed nothing');

// ---- purchasing already reads vat_standard_pct from the same table: setting it now works through the validated path
eq(await set('vat_standard_pct', 16), 16, 'vat_standard_pct can be set');

console.log(`${count()} checks passed`);
