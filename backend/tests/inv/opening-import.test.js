// Opening balances and CSV import (P1-11). Runs the real route handlers against an in-memory database (see catalogue.test.js for the harness idea).
// Usage: node backend/tests/inv/opening-import.test.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from './fixture.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';
import { createRoutes } from '../../src/routes/inventory-owner.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import * as ledger from '../../src/inventory/ledger.js';
import { openingStatus, setOpening } from '../../src/inventory/opening.js';
import { LIMITS, TEMPLATE_CSV, commit, dryRun, parseCsv, readTable } from '../../src/inventory/import.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const refuses = async (promise, status, code, pattern, m) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status, `${m}: status (${e.message})`);
    if (code) assert.equal(e.details?.code, code, `${m}: code (${e.message})`);
    if (pattern) assert.match(e.message, pattern, `${m}: message`);
    return true;
  }, m);
  checks++;
};

const f = await inventoryFixture({ extra: ['proposed/012_inventory_catalogue.sql'] });
const { db, ids, users } = f;
const { businessId, branchId, centerLocationId, branchLocationId } = ids;
const tx = (fn) => db.transaction(fn);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const branch2 = (await db.query(`insert into public.restaurants (owner_id, name, status, business_id, owner_primary) values ($1, 'Second branch', 'live', $2, false) returning id`, [users.owner, businessId])).rows[0].id;
const branch2Location = await tx((t) => branchLocation(t, branch2));
const manager2 = await createUser(db, 'manager2@example.test', { role: 'owner' });
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'manager')`, [branch2, manager2]);
const ops = await createUser(db, 'ops@example.test', { role: 'owner' });
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'operations')`, [businessId, ops]);
await db.query(`insert into public.business_member_branches (business_id, user_id, restaurant_id) values ($1, $2, $3)`, [businessId, ops, branchId]);
await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);

const ctx = (userId, { role = 'owner', memberships = [], grants = [] } = {}) => ({
  user: { id: userId }, profile: { role }, memberships: memberships.map(([rid, r]) => ({ role: r, restaurant: { id: rid } })), grants,
});
const contexts = {
  owner: ctx(users.owner, { memberships: [[branchId, 'owner']], grants: [{ businessId, role: 'owner', branchIds: null }] }),
  ops: ctx(ops, { grants: [{ businessId, role: 'operations', branchIds: [branchId] }] }),
  manager: ctx(users.manager, { memberships: [[branchId, 'manager']] }),
  manager2: ctx(manager2, { memberships: [[branch2, 'manager']] }),
  waiter: ctx(users.waiter, { role: 'waiter', memberships: [[branchId, 'waiter']] }),
};
const routes = createRoutes({
  authenticate: async (request) => {
    const who = request.headers.authorization?.replace(/^Bearer /, '');
    if (!contexts[who]) { const { HttpError } = await import('../../src/lib/http.js'); throw new HttpError(401, 'Please sign in to continue.'); }
    return contexts[who];
  },
  pool: () => db,
  transact: (fn) => db.transaction(fn),
});
const api = async (as, method, pathname, body, query = '', response = undefined) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    return route.handler({ request: { headers: { authorization: `Bearer ${as}` } }, response, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const base = `/api/owner/inventory/${businessId}`;
const scopeOf = (who) => inventoryScope(db, contexts[who], businessId, { ensureLocations: true });
const names = {
  warehouse: (await one('select name from public.stock_locations where id = $1', [centerLocationId])).name,
  branch: 'Main branch',
};

const movements = (itemId, locationId) => db.query(`select delta::text as delta, reason, unit_cost::text as unit_cost, entered_quantity::text as eq, entered_unit, idempotency_key, id::text as id
  from public.stock_movements where item_id = $1 and location_id = $2 order by id`, [itemId, locationId]).then((r) => r.rows);
const snapshot = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_item_units)::int as units,
  (select count(*) from public.stock_categories)::int as categories, (select count(*) from public.stock_movements)::int as movements,
  (select count(*) from public.stock_balances)::int as balances, (select count(*) from public.inventory_events)::int as events, (select count(*) from public.stock_commands)::int as commands,
  (select count(*) from public.stock_item_levels)::int as levels`);

// ===== Items to work with =====
await api('owner', 'GET', base); // first read seeds the default categories
const chicken = await api('owner', 'POST', `${base}/items`, { name: 'Chicken', baseUnit: 'weight', displayUnit: 'kg', units: [{ name: 'crate', factor: '10 kg' }] });
const eggs = await api('owner', 'POST', `${base}/items`, { name: 'Eggs', baseUnit: 'count', units: [{ name: 'tray', factor: 30 }] });
const oil = await api('owner', 'POST', `${base}/items`, { name: 'Oil', baseUnit: 'volume', displayUnit: 'l' });

// =============================================================================================================
// 1. Opening stock
// =============================================================================================================
{
  const status0 = await api('owner', 'GET', `${base}/opening`, undefined, `?location=${centerLocationId}`);
  eq([status0.locationName, status0.canRecord, status0.counts.withOpening], [names.warehouse, true, 0], 'status: nothing set yet');
  eq(status0.items.find((i) => i.itemId === chicken.id).canSetOpening, true, 'chicken can take an opening');

  const cmd = randomUUID();
  const r = await api('owner', 'POST', `${base}/opening`, { commandId: cmd, locationId: centerLocationId, lines: [
    { itemId: chicken.id, quantity: 40, unit: 'kg', unitCost: 650 },
    { itemId: eggs.id, quantity: '2', unit: 'tray', unitCost: 'KES 420' },
    { itemId: oil.id, quantity: 0 },
  ] });
  eq([r.posted, r.skipped], [2, 1], 'two posted, the zero line skipped');
  eq(r.results.map((x) => x.status), ['posted', 'posted', 'skipped'], 'per-line results');
  const [m] = await movements(chicken.id, centerLocationId);
  eq([m.reason, m.delta, m.eq, m.entered_unit, m.unit_cost], ['opening', '40000.0000', '40.0000', 'kg', '0.650000'], 'chicken: 40 kg entered, 40000 g stored, KES 650/kg = 0.65/g');
  const [e] = await movements(eggs.id, centerLocationId);
  eq([e.delta, e.eq, e.entered_unit, e.unit_cost], ['60.0000', '2.0000', 'tray', '14.000000'], 'eggs: 2 trays = 60 pieces, KES 420/tray = 14 each');
  eq((await one('select avg_cost::text as c from public.stock_items where id = $1', [chicken.id])).c, '0.650000', 'average cost follows the opening cost');
  eq((await movements(oil.id, centerLocationId)).length, 0, 'nothing posted for the zero line');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'opening_stock'`)).n, 1, 'one audit event for the opening');

  // The same command id again: the first answer comes back, nothing posts twice.
  const again = await api('owner', 'POST', `${base}/opening`, { commandId: cmd, locationId: centerLocationId, lines: [{ itemId: chicken.id, quantity: 99, unit: 'kg' }] });
  eq(again.posted, 2, 'retried command returns the first result');
  eq((await movements(chicken.id, centerLocationId)).length, 1, 'still one movement');
  // And directly at service level, a replayed line is reported as replayed, not refused.
  const owner = await scopeOf('owner');
  const replay = await tx((t) => setOpening(t, owner, { locationId: centerLocationId, commandId: cmd, lines: [{ itemId: chicken.id, quantity: 40, unit: 'kg', unitCost: 650 }] }));
  eq(replay.results[0].status, 'replayed', 'service replay');

  const status1 = await api('owner', 'GET', `${base}/opening`, undefined, `?location=${centerLocationId}`);
  const c1 = status1.items.find((i) => i.itemId === chicken.id);
  eq([c1.hasOpening, c1.canSetOpening, c1.opening.quantity, c1.opening.unit, c1.onHand, c1.display, c1.openingUnitCost], [true, false, '40.0000', 'kg', '40000.0000', '40 kg · 4 crates', '0.650000'], 'status after: opening shown with entered units');
  eq(status1.counts, { items: 3, withOpening: 2, waiting: 1 }, 'counts');

  // A second opening is refused with a plain message.
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: centerLocationId, lines: [{ itemId: chicken.id, quantity: 5, unit: 'kg' }] }), 409, 'opening_exists',
    new RegExp(`^Opening stock for Chicken at ${names.warehouse} was already set on \\d\\d/\\d\\d/\\d{4}\\. Use a count to correct it\\.$`), 'second opening');
  // Atomic: a good line next to a refused one posts nothing.
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: centerLocationId, lines: [{ itemId: oil.id, quantity: 3, unit: 'l' }, { itemId: chicken.id, quantity: 1, unit: 'kg' }] }), 409, 'opening_exists', null, 'one refused line stops all');
  eq((await movements(oil.id, centerLocationId)).length, 0, 'the good line was not posted');

  // Reversed, then allowed again.
  await tx((t) => ledger.reverse(t, { movementId: m.id, idempotencyKey: 'undo-chicken-open', actorId: users.owner }));
  const second = await api('owner', 'POST', `${base}/opening`, { locationId: centerLocationId, lines: [{ itemId: chicken.id, quantity: 4, unit: 'crate', unitCost: 6500 }] });
  eq(second.results[0].status, 'posted', 'a reversed opening can be set again');
  eq((await one('select on_hand::text as o from public.stock_balances where item_id = $1 and location_id = $2', [chicken.id, centerLocationId])).o, '40000.0000', '4 crates = 40 kg');
  eq((await movements(chicken.id, centerLocationId)).at(-1).unit_cost, '0.650000', 'KES 6,500 per crate of 10 kg = 0.65 per g');

  // Stock that is already there (anything but an opening) blocks an opening.
  await tx((t) => ledger.post(t, { businessId, locationId: centerLocationId, itemId: oil.id, qty: '5000', reason: 'purchase_receipt', idempotencyKey: 'oil-buy', actorId: users.owner }));
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: centerLocationId, lines: [{ itemId: oil.id, quantity: 3, unit: 'l' }] }), 409, 'opening_exists', /already has 5 L recorded at .*Use a count to correct it/, 'stock already there');

  // Bad input.
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: 3, unit: 'l' }] }), 400, 'unit_mismatch', /measured by weight|counted by weight/i, 'wrong kind of unit');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: -3, unit: 'kg' }] }), 400, 'negative', /can’t be negative/, 'negative');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: 'lots', unit: 'kg' }] }), 400, 'bad_quantity', /must be a number/, 'not a number');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: 3, unit: 'kg', unitCost: -1 }] }), 400, 'bad_cost', null, 'negative cost');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: 3 }, { itemId: chicken.id, quantity: 4 }] }), 400, 'duplicate_line', /listed twice/, 'duplicate line');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [] }), 400, 'no_lines', null, 'no lines');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: randomUUID(), lines: [{ itemId: chicken.id, quantity: 3 }] }), 403, 'forbidden', null, 'a location outside this business');
  await refuses(api('owner', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: randomUUID(), quantity: 3 }] }), 404, 'item_not_found', null, 'unknown item');
  await refuses(api('owner', 'GET', `${base}/opening`), 400, 'location_required', null, 'location needed');

  // Who may: the branch manager only for their own branch; operations and waiters never.
  const mine = await api('manager', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: chicken.id, quantity: 12, unit: 'kg', unitCost: 700 }] });
  eq(mine.results[0].status, 'posted', 'branch manager sets opening at their own branch');
  await refuses(api('manager', 'POST', `${base}/opening`, { locationId: centerLocationId, lines: [{ itemId: eggs.id, quantity: 1, unit: 'tray' }] }), 403, 'forbidden', null, 'manager cannot do the warehouse');
  await refuses(api('manager', 'POST', `${base}/opening`, { locationId: branch2Location, lines: [{ itemId: eggs.id, quantity: 1, unit: 'tray' }] }), 403, 'forbidden', null, 'manager cannot do another branch');
  await refuses(api('manager2', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: eggs.id, quantity: 1, unit: 'tray' }] }), 403, 'forbidden', null, 'other branch manager');
  await refuses(api('ops', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: eggs.id, quantity: 1, unit: 'tray' }] }), 403, 'forbidden', null, 'operations manager refused');
  await refuses(api('waiter', 'POST', `${base}/opening`, { locationId: branchLocationId, lines: [{ itemId: eggs.id, quantity: 1, unit: 'tray' }] }), 403, 'forbidden', null, 'waiter refused');
  ok((await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and entity = 'inv_opening'`)).n >= 3, 'refusals are audited');
  eq((await api('manager', 'GET', `${base}/opening`, undefined, `?location=${branchLocationId}`)).canRecord, true, 'manager reads their branch');
  await refuses(api('manager', 'GET', `${base}/opening`, undefined, `?location=${branch2Location}`), 403, 'forbidden', null, 'manager cannot read another branch');
  const opsStatus = await api('ops', 'GET', `${base}/opening`, undefined, `?location=${branchLocationId}`);
  eq(opsStatus.canRecord, false, 'operations may look but not record');
  const mgrStatus = await api('manager', 'GET', `${base}/opening`, undefined, `?location=${branchLocationId}`);
  eq(mgrStatus.items.find((i) => i.itemId === chicken.id).hasOpening, true, 'manager sees the opening they set');
  const s = await tx((t) => openingStatus(t, owner, centerLocationId));
  eq(s.locationId, centerLocationId, 'service works too');
}
eq(await ledger.reconcile(db, { businessId }), [], 'ledger reconciles after openings');

// =============================================================================================================
// 2. The CSV parser
// =============================================================================================================
{
  const cells = (text) => parseCsv(text).records.map((r) => r.cells);
  eq(cells('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']], 'plain');
  eq(cells('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF and a trailing newline');
  eq(cells('﻿name,code\nx,y'), [['name', 'code'], ['x', 'y']], 'BOM stripped');
  eq(cells('"Tomatoes, ripe",2\n'), [['Tomatoes, ripe', '2']], 'comma inside quotes');
  eq(cells('"say ""hi""",2'), [['say "hi"', '2']], 'escaped quotes');
  eq(cells('"two\nlines",x\nnext,y'), [['two\nlines', 'x'], ['next', 'y']], 'newline inside quotes');
  eq(cells('"two\r\nlines",x'), [['two\r\nlines', 'x']], 'CRLF inside quotes');
  eq(cells('a,b\n\n   \n1,2'), [['a', 'b'], ['1', '2']], 'blank lines dropped');
  eq(cells('a,,c\n1,,'), [['a', '', 'c'], ['1', '', '']], 'empty cells kept');
  eq(cells('a; b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']], 'semicolon separator (some spreadsheets)');
  eq(cells('a\tb\n1\t2'), [['a', 'b'], ['1', '2']], 'tab separator');
  eq(parseCsv('a,b\n"x\ny",2\nc,d').records.map((r) => r.line), [1, 2, 4], 'line numbers count lines inside quotes');
  assert.throws(() => parseCsv('a,b\n"open,2\n'), (e) => e.status === 400 && e.details.code === 'csv_bad_quote' && /line 2/.test(e.message)); checks++;

  const t = readTable('Item Name , SKU,Measured By,Unit,Pack,Pack Size,Pack-Unit,Opening Qty,Cost,Branch,Mystery\nChicken,C1,weight,kg,crate,10,kg,5,650,Main branch,x');
  eq(Object.keys(t.columns), ['name', 'code', 'measured_by', 'display_unit', 'pack_name', 'pack_size', 'pack_unit', 'opening_qty', 'opening_cost_per_unit', 'location'], 'header aliases, any case and spacing');
  eq(t.ignored, ['Mystery'], 'unknown columns are listed, not fatal');
  await refuses(Promise.resolve().then(() => readTable('code,category\nx,y')), 400, 'csv_no_name_column', /needs a “name” column/, 'no name column');
  await refuses(Promise.resolve().then(() => readTable('name,item\nx,y')), 400, 'csv_duplicate_column', null, 'two name columns');
  await refuses(Promise.resolve().then(() => readTable('name,code\n')), 400, 'csv_no_rows', null, 'header only');
  await refuses(Promise.resolve().then(() => readTable('   ')), 400, 'csv_empty', null, 'empty');
  const many = `name\n${Array.from({ length: LIMITS.rows + 1 }, (_, i) => `item ${i}`).join('\n')}`;
  await refuses(Promise.resolve().then(() => readTable(many)), 400, 'too_many_rows', /at most 2,000/, 'over 2,000 rows');
  eq(readTable(`name\n${Array.from({ length: LIMITS.rows }, (_, i) => `item ${i}`).join('\n')}`).rows.length, 2000, 'exactly 2,000 rows is fine');
  await refuses(Promise.resolve().then(() => readTable(`name\n${'x'.repeat(LIMITS.bytes)}`)), 413, 'csv_too_large', /over 1 MB/, 'over 1 MB');
  eq(readFileSync(new URL('../../../docs/inventory-kb/templates/items-import.csv', import.meta.url), 'utf8'), TEMPLATE_CSV, 'the documented template is the one the API serves');
  eq(readTable(TEMPLATE_CSV).rows.length, 3, 'template has three example rows');
}

// =============================================================================================================
// 3. Dry run: reports, writes nothing
// =============================================================================================================
const owner = await scopeOf('owner');
await api('owner', 'POST', `${base}/items`, { name: 'Basmati rice', baseUnit: 'weight', sku: 'RICE-1', displayUnit: 'kg' });
const badCsv = [
  'name,code,category,measured_by,display_unit,pack_name,pack_size,pack_unit,opening_qty,opening_unit,location',
  'Milk 2,MLK-2,Dairy,volume,kg,,,,,,',                       // 2: kg shows a volume
  'Sugar,SUG-1,Dry goods,weight,kg,,,,,,',                    // 3: fine
  'sugar,SUG-9,Dry goods,weight,kg,,,,,,',                    // 4: same name as line 3
  'Salt,sug-1,Dry goods,weight,kg,,,,,,',                     // 5: same code as line 3
  'Flour,FLR,Mystery shelf,weight,kg,,,,,,',                  // 6: new category (warning only)
  'Honey,,,,kg,,,,,,',                                        // 7: measured_by missing
  'Beans,BN,Dry goods,mass,kg,,,,,,',                         // 8: bad measured_by
  'Rice sack,,Dry goods,weight,kg,kg,50,,,,',                 // 9: pack named like a unit
  'Chicken,,,,,,,,5,kg,warehouse',                            // 10: chicken already has an opening there
  'Tea,TEA,Dry goods,weight,kg,,,,3,kg,Nairobi CBD',          // 11: no such location
  'Cocoa,CCA,Dry goods,weight,kg,,,,abc,kg,',                 // 12: opening not a number
  'Jam,JAM,Dry goods,weight,kg,box,,,,,',                     // 13: pack without a size
  'Basmati rice,RICE-1,Dry goods,volume,l,,,,,,',             // 14: would change how rice is measured
].join('\n');
{
  const before = await snapshot();
  const rep = await api('owner', 'POST', `${base}/import/dry-run`, { csv: badCsv });
  eq(await snapshot(), before, 'dry run wrote nothing at all (every table the import could touch)');
  eq(rep.ok, false, 'not ok');
  const by = Object.fromEntries(rep.rows.map((r) => [r.line, r]));
  const only = (line, pattern, m) => { eq(by[line].action, 'error', `${m}: action`); ok(by[line].messages.some((x) => pattern.test(x)), `${m}: ${by[line].messages.join(' | ')}`); };
  only(2, /can’t be used to show Milk 2/, 'kg on a volume item');
  eq(by[3].action, 'create', 'a good row is a create');
  only(4, /“sugar” is already on line 3/, 'same name in the file, any case');
  only(5, /code “sug-1” is already used on line 3/, 'same code in the file');
  eq([by[6].action, by[6].warnings.length], ['create', 1], 'unknown category: still a create, with a warning');
  ok(/“Mystery shelf” doesn’t exist yet/.test(by[6].warnings[0]), 'warning says it will be created');
  only(7, /Say how this item is measured/, 'measured_by missing');
  only(8, /“mass” isn’t how an item can be measured/, 'bad measured_by');
  only(9, /already a standard unit/, 'pack named kg');
  only(10, new RegExp(`Opening stock for Chicken at ${names.warehouse} was already set on \\d\\d/\\d\\d/\\d{4}\\. Use a count`), 'second opening');
  eq(by[10].itemId, chicken.id, 'matched by name');
  only(11, /“Nairobi CBD” isn’t one of your locations\. Use “warehouse”/, 'unknown location');
  only(12, /must be a number/, 'opening amount');
  only(13, /needs both a pack_name .* and a pack_size/, 'pack without size');
  only(14, /already measured by weight/, 'measured_by change refused');
  eq(by[14].itemId, (await one(`select id from public.stock_items where name = 'Basmati rice'`)).id, 'matched by code');
  eq(rep.summary, { create: 2, update: 0, skip: 0, errors: 11, warnings: 1, openings: 0 }, 'summary');
  eq(by[2].line, 2, 'line numbers start under the header');
  ok(!('apply' in rep.rows[0]), 'internal plan is not exposed');
  await refuses(api('ops', 'POST', `${base}/import/dry-run`, { csv: badCsv }), 403, 'forbidden', null, 'operations cannot import');
  await refuses(api('waiter', 'POST', `${base}/import/dry-run`, { csv: badCsv }), 403, 'forbidden', null, 'waiters cannot import');
  await refuses(api('owner', 'POST', `${base}/import/dry-run`, {}), 400, 'csv_empty', null, 'no file');
}

// =============================================================================================================
// 4. Commit: all or nothing
// =============================================================================================================
{
  const before = await snapshot();
  const err = await api('owner', 'POST', `${base}/import`, { commandId: randomUUID(), csv: badCsv }).then(() => null, (e) => e);
  eq([err.status, err.details.code], [409, 'import_has_errors'], 'commit with errors is refused');
  ok(/11 rows have problems, so nothing was imported/.test(err.message), `plain message: ${err.message}`);
  eq(err.details.report.summary.errors, 11, 'the report comes back with the refusal');
  eq(await snapshot(), before, 'nothing was written (not even the good rows or the new category)');
  await refuses(api('ops', 'POST', `${base}/import`, { csv: TEMPLATE_CSV }), 403, 'forbidden', null, 'operations cannot import');
}

// =============================================================================================================
// 5. Commit a good file
// =============================================================================================================
const goodCsv = `${TEMPLATE_CSV}"Tomatoes, ripe",TOM-1,Specials,weight,kg,,,,raw,chilled,5,,12,kg,90,Main branch\n`;
const importCmd = randomUUID();
let committed;
{
  // Chicken, Eggs and Oil already exist (section 1), so use new names for the three template rows.
  const fresh = goodCsv.replace(/^Chicken,.*$/m, 'Turkey,TRK-001,Meat and poultry,weight,kg,crate,10,kg,raw,frozen,20,85,40,kg,650,warehouse')
    .replace(/^Eggs,.*$/m, 'Quail eggs,QEG-001,Dairy,count,piece,tray,30,piece,raw,chilled,60,100,20,tray,420,warehouse')
    .replace(/^Cooking oil,.*$/m, 'Sunflower oil,OIL-001,Cooking ingredients and spices,volume,L,jerrican,20,L,raw,ambient,40,100,5,jerrican,4200,warehouse');
  const rep = await api('owner', 'POST', `${base}/import/dry-run`, { csv: fresh });
  eq(rep.summary, { create: 4, update: 0, skip: 0, errors: 0, warnings: 1, openings: 4 }, 'dry run of the good file');
  eq(rep.rows[0].changes[0], 'Create the item', 'plain "what will happen" list');
  ok(rep.rows[0].changes.some((c) => /Record opening stock: 40 kg at /.test(c)), 'opening shown in the list');
  // The template as shipped matches the existing Chicken and Eggs: their openings are already set, so it is refused as a whole.
  eq((await api('owner', 'POST', `${base}/import/dry-run`, { csv: goodCsv })).rows.slice(0, 3).map((r) => r.action), ['error', 'error', 'create'], 'template rows for Chicken and Eggs (openings already set) are errors; Cooking oil is new');
  const before = await snapshot();
  committed = await api('owner', 'POST', `${base}/import`, { commandId: importCmd, csv: fresh });
  eq([committed.ok, committed.committed, committed.summary.create, committed.summary.openings], [true, true, 4, 4], 'committed');
  eq(committed.rows.map((r) => r.action), ['create', 'create', 'create', 'create'], 'rows');
  ok(committed.rows.every((r) => r.itemId), 'every row returns its item id');
  const after = await snapshot();
  eq([after.items - before.items, after.units - before.units, after.movements - before.movements, after.levels - before.levels], [4, 3, 4, 0], 'four items, three packs, four opening movements');
  eq(after.categories - before.categories, 1, 'one new category (Specials)');

  const turkey = committed.rows[0];
  const item = await api('owner', 'GET', `${base}/items/${turkey.itemId}`);
  eq([item.baseUnit, item.displayUnit, item.sku, item.kind, item.storage, item.categoryName, item.yieldPct], ['g', 'kg', 'TRK-001', 'raw', 'frozen', 'Meat and poultry', 85], 'turkey fields');
  eq(item.units.map((u) => [u.name, u.factor]), [['crate', '10000.0000']], 'crate = 10 kg');
  eq(item.lowLevel, '20000.0000', 'low level 20 kg');
  eq(item.locations.find((l) => l.locationId === centerLocationId).onHand, '40000.0000', 'opening 40 kg in the warehouse');
  const [tm] = await movements(turkey.itemId, centerLocationId);
  eq([tm.reason, tm.eq, tm.entered_unit, tm.unit_cost], ['opening', '40.0000', 'kg', '0.650000'], 'turkey opening cost per gram');
  const quail = await api('owner', 'GET', `${base}/items/${committed.rows[1].itemId}`);
  eq([quail.baseUnit, quail.units[0].factor, quail.locations.find((l) => l.locationId === centerLocationId).onHand], ['piece', '30.0000', '600.0000'], 'eggs: tray of 30, 20 trays = 600 pieces');
  eq((await movements(committed.rows[1].itemId, centerLocationId))[0].unit_cost, '14.000000', '420 per tray = 14 each');
  const sun = await api('owner', 'GET', `${base}/items/${committed.rows[2].itemId}`);
  eq([sun.displayUnit, sun.locations.find((l) => l.locationId === centerLocationId).onHand, sun.lowLevel], ['l', '100000.0000', '40000.0000'], 'oil: 5 jerricans of 20 L = 100 L');
  eq((await movements(committed.rows[2].itemId, centerLocationId))[0].unit_cost, '0.210000', '4,200 per jerrican of 20 L = 0.21 per ml');
  const tom = await api('owner', 'GET', `${base}/items/${committed.rows[3].itemId}`);
  eq([tom.name, tom.categoryName, tom.locations.find((l) => l.locationId === branchLocationId).onHand, tom.yieldPct], ['Tomatoes, ripe', 'Specials', '12000.0000', 100], 'quoted comma name, new category, opening at the branch');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'import' and action = 'commit' and entity_id = $1`, [importCmd])).n, 1, 'import audited');

  // Re-sending the same command: the first answer, nothing changes.
  const mid = await snapshot();
  const retry = await api('owner', 'POST', `${base}/import`, { commandId: importCmd, csv: fresh });
  eq(retry.summary, committed.summary, 'same commandId through the route returns the first result');
  eq(await snapshot(), mid, 'and writes nothing');

  // Service level, same command id: every row is "skip" (already up to date), no opening is posted twice.
  const svc = await tx((t) => commit(t, owner, fresh, { commandId: importCmd }));
  eq(svc.rows.map((r) => r.action), ['skip', 'skip', 'skip', 'skip'], 'same command id again: nothing left to do');
  eq((await snapshot()).movements, mid.movements, 'no second opening movement');

  const mid2 = await snapshot();
  // A NEW command id: the openings were already set, so those rows are refused and nothing changes.
  const err = await api('owner', 'POST', `${base}/import`, { commandId: randomUUID(), csv: fresh }).then(() => null, (e) => e);
  eq([err.status, err.details.code], [409, 'import_has_errors'], 'new command id: refused');
  eq(err.details.report.rows.map((r) => r.action), ['error', 'error', 'error', 'error'], 'every opening row says it was already set');
  ok(/was already set on \d\d\/\d\d\/\d{4}\. Use a count to correct it\./.test(err.details.report.rows[0].messages[0]), 'plain message per row');
  eq(await snapshot(), mid2, 'still nothing written');

  // Without the opening columns the same file is a clean "skip" (idempotent import of the catalogue itself).
  const noOpening = fresh.split('\n').map((l, i) => (i === 0 ? l : l.replace(/,(40|20|5|12),(kg|tray|jerrican),(650|420|4200|90),(warehouse|Main branch)$/, ',,,,'))).join('\n');
  const repeat = await api('owner', 'POST', `${base}/import/dry-run`, { csv: noOpening });
  eq(repeat.rows.map((r) => r.action), ['skip', 'skip', 'skip', 'skip'], 'the catalogue part of the file is already up to date');
  eq(repeat.summary.skip, 4, 'summary skip');
}

// =============================================================================================================
// 6. Commit as an update: change what exists, add a pack, rename by code
// =============================================================================================================
{
  const csv = [
    'Item,SKU,Category,Unit,Pack,Pack size,Pack unit,Low level,Yield,Opening qty,Opening unit,Cost,Location',
    'Basmati rice,RICE-1,Dry goods,kg,sack,50,kg,10,95,100,sack,5500,warehouse',
    'Rice (pishori),TRK-001,,,,,,,,,,,',
  ].join('\n');
  const rep = await api('owner', 'POST', `${base}/import/dry-run`, { csv });
  eq(rep.rows.map((r) => r.action), ['update', 'update'], 'existing items are updates');
  ok(rep.rows[1].changes.some((c) => /Rename “Turkey” to “Rice \(pishori\)”/.test(c)), 'a code match with a new name renames');
  const out = await api('owner', 'POST', `${base}/import`, { commandId: randomUUID(), csv });
  eq(out.rows.map((r) => r.action), ['update', 'update'], 'applied');
  const rice = await api('owner', 'GET', `${base}/items/${out.rows[0].itemId}`);
  eq([rice.categoryName, rice.units.map((u) => [u.name, u.factor]), rice.lowLevel, rice.yieldPct, rice.displayUnit], ['Dry goods', [['sack', '50000.0000']], '10000.0000', 95, 'kg'], 'rice updated');
  eq(rice.locations.find((l) => l.locationId === centerLocationId).onHand, '5000000.0000', '100 sacks of 50 kg = 5,000 kg');
  eq((await movements(out.rows[0].itemId, centerLocationId))[0].unit_cost, '0.110000', 'KES 5,500 per 50 kg sack = 0.11 per g');
  eq((await one(`select name from public.stock_items where id = $1`, [out.rows[1].itemId])).name, 'Rice (pishori)', 'renamed');
  eq((await one(`select count(*)::int as n from public.stock_items where lower(name) in ('turkey')`)).n, 0, 'no duplicate left under the old name');
  // Applying the same update again changes nothing.
  const again = await api('owner', 'POST', `${base}/import/dry-run`, { csv: csv.replace(',100,sack,5500,warehouse', ',,,,') });
  eq(again.rows.map((r) => r.action), ['skip', 'skip'], 'second pass: up to date');
}

// =============================================================================================================
// 7. Permissions inside an import, template, limits through the route
// =============================================================================================================
{
  // A branch manager may import items, but not open stock at the warehouse or another branch.
  const csv = 'name,measured_by,display_unit,opening_qty,location\nMop heads,count,piece,10,warehouse\nBin bags,count,piece,10,Main branch\nTape,count,piece,10,Second branch';
  const rep = await api('manager', 'POST', `${base}/import/dry-run`, { csv });
  eq(rep.rows.map((r) => r.action), ['error', 'create', 'error'], 'manager: only their own branch is allowed');
  ok(/You can’t record stock at/.test(rep.rows[0].messages[0]), 'plain message');
  const before = await snapshot();
  await refuses(api('manager', 'POST', `${base}/import`, { csv }), 409, 'import_has_errors', null, 'all or nothing for the manager too');
  eq(await snapshot(), before, 'nothing written');
  const good = await api('manager', 'POST', `${base}/import`, { csv: 'name,measured_by,display_unit,opening_qty,location\nBin bags,count,piece,10,Main branch' });
  eq(good.summary.openings, 1, 'manager imports with an opening at their branch');

  // Template endpoint: plain JSON without a response object, text/csv with one.
  eq(await api('owner', 'GET', `${base}/import/template`), { filename: 'cravio-items-import-template.csv', csv: TEMPLATE_CSV }, 'template as JSON when there is no response to write to');
  const sent = {};
  const fake = { setHeader: (k, v) => { sent[k] = v; }, writeHead: (s) => { sent.status = s; }, end: (body) => { sent.body = body; } };
  eq(await api('owner', 'GET', `${base}/import/template`, undefined, '', fake), undefined, 'handler returns nothing after writing the file itself');
  eq([sent.status, sent['Content-Type'], sent.body], [200, 'text/csv; charset=utf-8', TEMPLATE_CSV], 'template as text/csv');
  eq((await api('owner', 'GET', `${base}/import/template`, undefined, '?format=json', fake)).filename, 'cravio-items-import-template.csv', '?format=json forces JSON');
  await refuses(api('ops', 'GET', `${base}/import/template`), 403, 'forbidden', null, 'template needs item edit');

  await refuses(api('owner', 'POST', `${base}/import/dry-run`, { csv: `name\n${'x'.repeat(LIMITS.bytes)}` }), 413, 'csv_too_large', null, 'size limit through the route');
  await refuses(api('owner', 'POST', `${base}/import`, { csv: `name,measured_by\n${Array.from({ length: LIMITS.rows + 1 }, (_, i) => `n${i},count`).join('\n')}` }), 400, 'too_many_rows', null, 'row limit through the route');
  eq((await dryRun(db, owner, 'name,measured_by\nX1,count\nX2,count')).rows.length, 2, 'dryRun works on the plain pool handle');
}

eq(await ledger.reconcile(db, { businessId }), [], 'ledger reconciles at the end');
console.log(`opening-import.test.js: ${checks} checks passed`);
await db.close();
