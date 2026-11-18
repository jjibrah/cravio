// Migration 015 (proposed): suppliers, supplier items, insert-only price history, document number counters.
// Rehearsal on PGlite: apply over a seeded database (012-014 present), constraints, immutability, RLS, idempotent re-run, down migration.
// Usage: node backend/tests/inv/migration-015.test.js
import assert from 'node:assert/strict';
import { asUser, readSql } from '../support/pg.js';
import { inventoryFixture } from './fixture.js';
import { proposedBefore } from './migrations.js';
import { makeItem } from './helpers.js';

const UP = 'proposed/015_suppliers.sql';
const DOWN = 'proposed/015_suppliers.down.sql';
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (v, m) => { assert.ok(v, m); checks++; };
const fails = async (promise, re, m) => {
  await assert.rejects(promise, (e) => { assert.match(`${e.message} ${e.constraint || ''}`, re, m); return true; }, m);
  checks++;
};

// ---------------------------------------------------------------------------------------------------------------
// Rehearsal: a database shaped like production after 012-014 (items, stock, movements, settings), then 015 on top.
// ---------------------------------------------------------------------------------------------------------------
const f = await inventoryFixture({ extra: proposedBefore(15) });
const { db, ids, users } = f;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const flour = await makeItem(db, biz, 'Flour', { packs: [{ name: 'sack', factor: 25000 }] });
await db.query(`insert into public.stock_balances (location_id, item_id, on_hand) values ($1, $2, 40000)`, [ids.centerLocationId, flour]);
const census = async () => one(`select (select count(*) from public.stock_items)::int as items, (select count(*) from public.stock_balances)::int as balances,
  (select count(*) from public.stock_movements)::int as movements, (select count(*) from public.inventory_settings)::int as settings, (select count(*) from public.notifications)::int as notes`);
const before = await census();
eq(await one(`select to_regclass('public.suppliers') is null as absent`), { absent: true }, '015 is not applied yet');
await db.exec(readSql(UP));
eq(await census(), before, 'applying 015 changed no existing row');
eq((await one(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('suppliers', 'supplier_items', 'supplier_prices', 'inventory_number_sequences')`)).n, 4, 'four new tables');
await db.exec(readSql(UP)); checks++;   // idempotent
eq(await census(), before, 're-running 015 is harmless');

// ---------------------------------------------------------------------------------------------------------------
// suppliers: formats and uniqueness
// ---------------------------------------------------------------------------------------------------------------
const supplier = (name, extra = {}) => {
  const cols = { business_id: biz, name, ...extra };
  const keys = Object.keys(cols);
  return db.query(`insert into public.suppliers (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => cols[k]));
};
const mama = (await supplier('Mama Njeri', { phone: '254712345678', kra_pin: 'A123456789B', type: 'informal' })).rows[0].id;
eq(await one(`select type, status, incomplete, payment_method, payment_terms_days from public.suppliers where id = $1`, [mama]),
  { type: 'informal', status: 'active', incomplete: false, payment_method: 'cash', payment_terms_days: 0 }, 'defaults: active, complete, cash, pay on delivery');
await fails(supplier('mama  njeri'.replace('  ', ' ')), /suppliers_name/, 'same name, different case: refused');
await fails(supplier('  MAMA NJERI '), /suppliers_name/, 'same name with spaces and capitals: refused');
await fails(supplier('Other', { phone: '0712345678' }), /suppliers_phone_check/, 'phone must be 254 format');
await fails(supplier('Other', { phone: '254212345678' }), /suppliers_phone_check/, 'only 2547/2541 numbers');
await fails(supplier('Other', { phone: '25471234567' }), /suppliers_phone_check/, 'too short');
await supplier('Safaricom line', { phone: '254112345678' }); checks++;
await fails(supplier('Other', { kra_pin: 'a123456789b' }), /kra_pin_check/, 'PIN must be capitals');
await fails(supplier('Other', { kra_pin: 'X123456789B' }), /kra_pin_check/, 'PIN starts with A or P');
await fails(supplier('Other', { kra_pin: 'A12345678B' }), /kra_pin_check/, 'PIN has nine digits');
await supplier('Company', { kra_pin: 'P051234567Z', type: 'formal' }); checks++;
await fails(supplier('Other', { type: 'wholesaler' }), /suppliers_type_check/, 'type check');
await fails(supplier('Other', { status: 'deleted' }), /suppliers_status_check/, 'status check');
await fails(supplier('Other', { payment_terms_days: 181 }), /payment_terms_days_check/, 'terms at most 180 days');
await fails(supplier('Other', { payment_terms_days: -1 }), /payment_terms_days_check/, 'terms not negative');
await fails(supplier('Other', { payment_method: 'cheque' }), /payment_method_check/, 'payment method check');
await fails(supplier('Other', { mpesa_till: '12ab' }), /mpesa_till_check/, 'till digits only');
await fails(supplier('Other', { email: 'not an email' }), /email_check/, 'email shape');
await fails(supplier('   '), /suppliers_name_check/, 'blank name');
await supplier('Full', { email: 'orders@full.co.ke', payment_terms_days: 30, payment_method: 'bank', bank_details: 'KCB 123456', mpesa_paybill: '522522', mpesa_account: 'F1' }); checks++;
await fails(db.query(`insert into public.suppliers (business_id, name) values ('00000000-0000-4000-8000-000000000000', 'Ghost')`), /foreign key|violates/, 'business must exist');

// Two businesses may use the same supplier name.
const otherOwner = (await one(`insert into auth.users (email) values ('o2@example.test') returning id`)).id;
const otherBiz = (await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning business_id`, [otherOwner])).business_id;
await db.query(`insert into public.suppliers (business_id, name) values ($1, 'Mama Njeri')`, [otherBiz]); checks++;

// ---------------------------------------------------------------------------------------------------------------
// supplier_items: one row per (supplier, item), one preferred supplier per item, same business only
// ---------------------------------------------------------------------------------------------------------------
const company = (await one(`select id from public.suppliers where name = 'Company'`)).id;
const link = (supplierId, itemId, extra = '') => db.query(`insert into public.supplier_items (business_id, supplier_id, item_id${extra ? ', preferred' : ''}) values ($1, $2, $3${extra ? ', true' : ''})`, [biz, supplierId, itemId]);
await link(mama, flour, 'preferred'); checks++;
await fails(link(mama, flour), /supplier_items_supplier_id_item_id_key|duplicate/, 'one row per supplier and item');
await fails(link(company, flour, 'preferred'), /supplier_items_one_preferred/, 'only one preferred supplier per item');
await link(company, flour); checks++;
const foreignItem = await makeItem(db, otherBiz, 'Foreign flour');
await fails(link(mama, foreignItem), /foreign key|violates/, 'an item of another business cannot be linked');
const otherSupplier = (await one(`select id from public.suppliers where business_id = $1`, [otherBiz])).id;
await fails(link(otherSupplier, flour), /foreign key|violates/, 'a supplier of another business cannot be linked');
await fails(db.query(`insert into public.supplier_items (business_id, supplier_id, item_id, rank) values ($1, $2, $3, 0)`, [biz, mama, (await makeItem(db, biz, 'Salt'))]), /rank_check/, 'rank starts at 1');

// ---------------------------------------------------------------------------------------------------------------
// supplier_prices: unique per date, insert-only, cascade only from the parent
// ---------------------------------------------------------------------------------------------------------------
const price = (supplierId, extra = {}) => {
  const row = { business_id: biz, supplier_id: supplierId, item_id: flour, unit: 'sack', unit_factor: '25000', price: '3250.00', price_per_base: '0.130000', effective_from: '2026-11-01', ...extra };
  const keys = Object.keys(row);
  return db.query(`insert into public.supplier_prices (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]));
};
const p1 = (await price(mama)).rows[0].id;
await fails(price(mama), /supplier_prices_unique/, 'same supplier, item, unit and date twice: refused');
await price(mama, { effective_from: '2026-12-01', price: '3400.00', price_per_base: '0.136000' }); checks++;
await price(mama, { unit: 'kg', unit_factor: '1000', price: '140.00', price_per_base: '0.140000' }); checks++;
await price(company); checks++;
await fails(price(mama, { price: '0' }), /price_check/, 'a price is more than zero');
await fails(price(mama, { unit_factor: '0' }), /unit_factor_check/, 'a unit holds something');
await fails(price(mama, { item_id: foreignItem, effective_from: '2026-10-01' }), /foreign key|violates/, 'item must belong to the same business');
await fails(db.query(`update public.supplier_prices set price = 1 where id = $1`, [p1]), /history/, 'a price row cannot be updated');
await fails(db.query(`delete from public.supplier_prices where id = $1`, [p1]), /history/, 'or deleted');
eq((await one(`select count(*)::int as n from public.supplier_prices where supplier_id = $1`, [mama])).n, 3, 'history intact after the attempts');
// KES 6,500 per crate of 10 kg is KES 0.65 per g: numeric(18,6) keeps the comparison figure exact.
await db.query(`insert into public.supplier_prices (business_id, supplier_id, item_id, unit, unit_factor, price, price_per_base, effective_from) values ($1, $2, $3, 'crate', 10000, 6500, 0.65, '2026-11-01')`, [biz, company, flour]);
eq((await one(`select price_per_base::text as p from public.supplier_prices where unit = 'crate'`)).p, '0.650000', 'KES 0.65 per g stored exactly');
// Deleting the supplier (or the item) still removes its prices: the guard only blocks direct edits.
await db.query(`delete from public.suppliers where id = $1`, [company]);
eq((await one(`select count(*)::int as n from public.supplier_prices where supplier_id = $1`, [company])).n, 0, 'deleting a supplier cascades to its prices');
eq((await one(`select count(*)::int as n from public.supplier_items where supplier_id = $1`, [company])).n, 0, '... and its item list');
await db.query(`delete from public.stock_items where id = $1`, [flour]);
eq((await one(`select count(*)::int as n from public.supplier_prices where item_id = $1`, [flour])).n, 0, 'deleting an item cascades to its prices');

// ---------------------------------------------------------------------------------------------------------------
// inventory_number_sequences
// ---------------------------------------------------------------------------------------------------------------
await db.query(`insert into public.inventory_number_sequences (business_id, kind, year, last_number) values ($1, 'PO', 2026, 1)`, [biz]);
await fails(db.query(`insert into public.inventory_number_sequences (business_id, kind, year) values ($1, 'PO', 2026)`, [biz]), /duplicate|primary|pkey/, 'one counter per business, kind and year');
await fails(db.query(`insert into public.inventory_number_sequences (business_id, kind, year) values ($1, 'po', 2026)`, [biz]), /kind_check/, 'kind is capital letters');
await fails(db.query(`insert into public.inventory_number_sequences (business_id, kind, year) values ($1, 'GRN', 1999)`, [biz]), /year_check/, 'year range');

// ---------------------------------------------------------------------------------------------------------------
// RLS: nothing readable by signed-in browser users, even the owner (the API is the only reader)
// ---------------------------------------------------------------------------------------------------------------
for (const t of ['suppliers', 'supplier_items', 'supplier_prices', 'inventory_number_sequences']) {
  eq((await one(`select relrowsecurity as on from pg_class where oid = 'public.${t}'::regclass`)).on, true, `${t}: RLS enabled`);
  await fails(asUser(db, users.owner, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: owner cannot read through the browser role`);
  await fails(asUser(db, users.manager, (tx) => tx.query(`select * from public.${t}`)), /permission denied/, `${t}: manager cannot either`);
}

// ---------------------------------------------------------------------------------------------------------------
// Down migration
// ---------------------------------------------------------------------------------------------------------------
await fails(db.exec(readSql(DOWN)), /Refusing rollback of 015: \d+ supplier\(s\)/, 'down refuses while suppliers exist');
eq((await one(`select to_regclass('public.suppliers') is not null as there`)).there, true, 'the refusal changed nothing');
await db.query(`delete from public.suppliers`);
await fails(db.exec(readSql(DOWN)), /1 document number counter\(s\)/, 'down refuses while number counters exist');
await db.query(`delete from public.inventory_number_sequences`);
await db.exec(readSql(DOWN));
eq((await one(`select to_regclass('public.suppliers') is null and to_regclass('public.supplier_items') is null and to_regclass('public.supplier_prices') is null
  and to_regclass('public.inventory_number_sequences') is null as gone`)).gone, true, 'down drops the four tables');
eq((await one(`select count(*)::int as n from pg_proc where proname = 'supplier_price_guard'`)).n, 0, 'and the guard function');
eq((await one(`select to_regclass('public.units') is not null and to_regclass('public.notifications') is not null and to_regclass('public.stock_items') is not null as kept`)).kept, true, '012-014 objects untouched');
await db.exec(readSql(DOWN)); checks++;   // running it again is harmless
await db.exec(readSql(UP));               // and 015 can be re-applied
eq((await one(`select to_regclass('public.suppliers') is not null as back`)).back, true, '015 re-applies after a rollback');
void users; void ids;

console.log(`Migration 015: ${checks} checks passed (disposable PGlite database).`);
await db.close();
