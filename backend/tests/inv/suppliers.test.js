// Suppliers service + owner/branch API (P2-04). Runs the REAL route handlers from routes/inventory-suppliers.js against an in-memory
// database with every proposed migration applied. Covers formats (254 phone, KRA PIN), duplicates, price history and the price in
// force on a date, per-base conversion (KES 6,500 per crate of 10 kg = 0.65 per g), permissions per role, on-the-spot suppliers and
// tenant isolation.
// Usage: node backend/tests/inv/suppliers.test.js
import { randomUUID } from 'node:crypto';
import { rig } from './fixture.js';
import { fakeClock, makeAsserts, makeItem } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { createRoutes } from '../../src/routes/inventory-suppliers.js';
import { normalisePhone, normalisePin, priceFor } from '../../src/inventory/suppliers.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches, items, contexts, helpers } = r;
const biz = ids.businessId;
const clock = fakeClock('2026-11-18T09:00:00+03:00');
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// A stranger with no access, a platform admin, and a second business with its own owner (tenant isolation).
const stranger = await createUser(db, 'stranger@example.test', { role: 'owner' });
const admin = await createUser(db, 'admin@example.test', { role: 'admin' });
const otherOwner = await createUser(db, 'other-owner@example.test', { role: 'owner' });
const otherRestaurant = (await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning id, business_id`, [otherOwner]));
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.business_id, otherOwner]);
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.id, otherOwner]);
await db.query('update public.businesses set inventory_enabled = true where id = $1', [otherRestaurant.business_id]);
await db.transaction((t) => branchLocation(t, otherRestaurant.id));
const all = { ...contexts,
  stranger: helpers.ctx(stranger), admin: helpers.ctx(admin, { role: 'admin' }),
  otherOwner: helpers.ctx(otherOwner, { memberships: [[otherRestaurant.id, 'owner']], grants: [{ businessId: otherRestaurant.business_id, role: 'owner', branchIds: null }] }) };

const routes = createRoutes({
  authenticate: async (request) => {
    const who = request.headers.authorization?.replace(/^Bearer /, '');
    if (!all[who]) throw new HttpError(401, 'Please sign in to continue.');
    return all[who];
  },
  pool: () => db, transact: (fn) => db.transaction(fn), now: () => clock.now(),
});
const call = async (as, method, pathname, body, query = '', branch = null) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (!m) continue;
    const headers = { authorization: `Bearer ${as}` };
    if (branch) headers['x-cravio-branch'] = branch;
    return route.handler({ request: { headers }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}${query}`) });
  }
  throw new Error(`No route for ${method} ${pathname}`);
};
const base = `/api/owner/inventory/${biz}/suppliers`;
const api = (as, method, path, body, query) => call(as, method, `${base}${path}`, body, query);
const deniedCount = async (who) => (await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [who])).n;

const { flour, rice } = items;
const tomatoes = await makeItem(db, biz, 'Tomatoes', { packs: [{ name: 'crate', factor: 10000 }] });
const oil = await makeItem(db, biz, 'Cooking oil', { unit: 'ml', displayUnit: 'l', packs: [{ name: 'jerrycan', factor: 20000 }] });
const eggs = await makeItem(db, biz, 'Eggs', { unit: 'piece', displayUnit: 'piece', packs: [{ name: 'tray', factor: 30 }] });

// =============================================================================================================
// 0. Phone and PIN formats (pure)
// =============================================================================================================
for (const [input, out] of [['0712 345 678', '254712345678'], ['+254 712-345-678', '254712345678'], ['254712345678', '254712345678'], ['712345678', '254712345678'],
  ['0112345678', '254112345678'], ['(0722) 111 222', '254722111222']]) eq(normalisePhone(input), out, `phone ${input}`);
for (const bad of ['071234567', '0212345678', '25471234567890', 'abc', '+255712345678', '07123456789']) {
  let e = null; try { normalisePhone(bad); } catch (x) { e = x; }
  eq([e?.status, e?.details?.code], [400, 'bad_phone'], `bad phone ${bad}`);
}
eq(normalisePin(' a123456789b '), 'A123456789B', 'PIN is upper-cased and trimmed');
eq(normalisePin('P 051234567 Z'), 'P051234567Z', 'spaces inside a PIN are dropped');
for (const bad of ['A12345678B', 'X123456789B', 'A1234567890', '123456789AB', 'AAAAAAAAAAA']) {
  let e = null; try { normalisePin(bad); } catch (x) { e = x; }
  eq([e?.status, e?.details?.code], [400, 'bad_pin'], `bad PIN ${bad}`);
}

// =============================================================================================================
// 1. Create: validation, duplicates, warnings, idempotency
// =============================================================================================================
let mama; let kiosk; let wholesaler;
{
  const cmd = randomUUID();
  const made = await api('owner', 'POST', '', { commandId: cmd, name: '  Mama   Njeri ', type: 'informal', contactName: 'Njeri W.', phone: '0712 345 678', kraPin: 'a123456789b', paymentMethod: 'mpesa',
    mpesaTill: '123456', paymentTermsDays: 0, notes: 'Market stall 12' });
  mama = made.supplier.id;
  eq([made.supplier.name, made.supplier.phone, made.supplier.kraPin, made.supplier.type, made.supplier.status, made.supplier.incomplete], ['Mama Njeri', '254712345678', 'A123456789B', 'informal', 'active', false], 'created, tidied and normalised');
  eq([made.supplier.mpesaTill, made.warnings], ['123456', []], 'owner sees M-Pesa till; no warnings');
  const replay = await api('owner', 'POST', '', { commandId: cmd, name: 'Mama Njeri', type: 'informal' });
  eq(replay.supplier.id, mama, 'same commandId: the first result comes back');
  eq((await one(`select count(*)::int as n from public.suppliers where business_id = $1`, [biz])).n, 1, '... and nothing was created twice');

  const dup = await refuses(api('owner', 'POST', '', { name: 'MAMA njeri' }), 409, 'name_taken', /already in your supplier list/, 'same name, any case');
  eq(dup.details.supplierId, mama, 'the refusal says which supplier it is');
  await refuses(api('owner', 'POST', '', { name: ' mama   njeri ' }), 409, 'name_taken', null, 'same name, extra spaces');

  const same = await api('owner', 'POST', '', { name: 'Njeri Brothers', phone: '254712345678' });
  kiosk = same.supplier.id;
  eq(same.warnings.map((w) => [w.code, w.supplierId]), [['phone_used', mama]], 'same phone as another supplier is a warning, not a refusal');

  await refuses(api('owner', 'POST', '', {}), 400, 'name_required', /Enter the supplier/, 'name required');
  await refuses(api('owner', 'POST', '', { name: '   ' }), 400, 'name_required', null, 'blank name');
  await refuses(api('owner', 'POST', '', { name: 'x'.repeat(81) }), 400, 'name_too_long', null, 'long name');
  await refuses(api('owner', 'POST', '', { name: 'A', phone: '0712' }), 400, 'bad_phone', /Kenyan mobile/, 'phone format');
  await refuses(api('owner', 'POST', '', { name: 'A', kraPin: '12345' }), 400, 'bad_pin', /A123456789B/, 'KRA PIN format');
  await refuses(api('owner', 'POST', '', { name: 'A', email: 'nope' }), 400, 'bad_email', null, 'email');
  await refuses(api('owner', 'POST', '', { name: 'A', type: 'big' }), 400, 'bad_choice', /formal, informal, one_off/, 'type');
  await refuses(api('owner', 'POST', '', { name: 'A', paymentMethod: 'cheque' }), 400, 'bad_choice', null, 'payment method');
  await refuses(api('owner', 'POST', '', { name: 'A', paymentTermsDays: 200 }), 400, 'bad_terms', /0 to 180/, 'terms');
  await refuses(api('owner', 'POST', '', { name: 'A', paymentTermsDays: 2.5 }), 400, 'bad_terms', null, 'terms whole days');
  await refuses(api('owner', 'POST', '', { name: 'A', mpesaTill: '12' }), 400, 'bad_mpesa', /5 to 7 digits/, 'till');
  await refuses(api('owner', 'POST', '', { name: 'A', notes: 'n'.repeat(501) }), 400, 'text_too_long', null, 'notes');
  eq((await one(`select count(*)::int as n from public.suppliers where business_id = $1`, [biz])).n, 2, 'no refused request left a supplier behind');

  const w = await api('owner2', 'POST', '', { name: 'Unga Wholesalers Ltd', type: 'formal', kraPin: 'P051234567Z', phone: '+254 20 ...'.length ? '0733000111' : '', email: 'Sales@Unga.co.ke', paymentTermsDays: 30,
    paymentMethod: 'bank', bankDetails: 'KCB Westlands, A/C 1234567890', address: 'Industrial Area, Nairobi' });
  wholesaler = w.supplier.id;
  eq([w.supplier.email, w.supplier.paymentTermsDays, w.supplier.bankDetails], ['sales@unga.co.ke', 30, 'KCB Westlands, A/C 1234567890'], 'a second owner can create too; email lower-cased');
  const ev = await one(`select actor_id, before, after from public.inventory_events where entity = 'supplier' and entity_id = $1 and action = 'create'`, [wholesaler]);
  eq(ev.actor_id, people.owner2, 'audited with the actor');
  eq(ev.after.bankDetails, '…7890', 'bank details are masked in the audit trail');
}

// =============================================================================================================
// 2. Edit with an audit diff
// =============================================================================================================
{
  const res = await api('owner', 'PATCH', `/${mama}`, { name: 'Mama Njeri Fresh', phone: '0722000111', notes: null });
  eq(res.changed.sort(), ['name', 'notes', 'phone'], 'only the changed fields');
  eq([res.supplier.name, res.supplier.phone, res.supplier.notes], ['Mama Njeri Fresh', '254722000111', null], 'edited');
  const ev = await one(`select before, after from public.inventory_events where entity = 'supplier' and entity_id = $1 and action = 'update' order by id desc limit 1`, [mama]);
  eq(ev.before, { name: 'Mama Njeri', phone: '254712345678', notes: 'Market stall 12' }, 'audit before has only changed fields');
  eq(ev.after, { name: 'Mama Njeri Fresh', notes: null, phone: '254722000111' }, 'audit after has only changed fields');
  const events = (await one(`select count(*)::int as n from public.inventory_events where entity = 'supplier' and entity_id = $1`, [mama])).n;
  eq((await api('owner', 'PATCH', `/${mama}`, { name: 'Mama Njeri Fresh' })).changed, [], 'saving the same values changes nothing');
  eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'supplier' and entity_id = $1`, [mama])).n, events, '... and records no event');
  await refuses(api('owner', 'PATCH', `/${mama}`, { name: 'unga wholesalers ltd' }), 409, 'name_taken', null, 'rename onto another supplier');
  await api('owner', 'PATCH', `/${mama}`, { name: 'MAMA NJERI FRESH' });
  eq((await one('select name from public.suppliers where id = $1', [mama])).name, 'MAMA NJERI FRESH', 'changing only the case of your own name is allowed');
  await refuses(api('owner', 'PATCH', `/${mama}`, { kraPin: 'bad' }), 400, 'bad_pin', null, 'bad PIN on edit');
  await refuses(api('owner', 'PATCH', `/${randomUUID()}`, { name: 'Ghost' }), 404, 'supplier_not_found', null, 'unknown supplier');
  await api('owner', 'PATCH', `/${mama}`, { name: 'Mama Njeri' });
  const bank = await api('owner', 'PATCH', `/${mama}`, { bankDetails: 'Equity 0011223344' });
  const bev = await one(`select before, after from public.inventory_events where entity_id = $1 and action = 'update' order by id desc limit 1`, [mama]);
  eq([bank.changed, bev.before, bev.after], [['bankDetails'], { bankDetails: null }, { bankDetails: '…3344' }], 'bank details change is audited, masked');
}

// =============================================================================================================
// 3. Permissions
// =============================================================================================================
{
  // Reads: owner and operations manager.
  for (const who of ['owner', 'owner2', 'ops']) {
    const list = await api(who, 'GET', '');
    eq(list.suppliers.map((s) => s.name), ['Mama Njeri', 'Njeri Brothers', 'Unga Wholesalers Ltd'], `${who} lists suppliers sorted by name`);
  }
  // Everyone else is refused, and the refusal is audited.
  for (const who of ['manager', 'manager2', 'waiter', 'stranger', 'admin', 'otherOwner']) {
    const before = who === 'manager' || who === 'waiter' || who === 'manager2' ? await deniedCount(people[who]) : null;
    await refuses(api(who, 'GET', ''), 403, 'forbidden', null, `${who} cannot list suppliers`);
    await refuses(api(who, 'GET', `/${mama}`), 403, 'forbidden', null, `${who} cannot open a supplier`);
    await refuses(api(who, 'GET', `/${mama}/prices`), 403, 'forbidden', null, `${who} cannot read prices`);
    await refuses(api(who, 'GET', '/best-price', undefined, `?item=${flour}`), 403, 'forbidden', null, `${who} cannot compare prices`);
    if (before !== null) ok((await deniedCount(people[who])) > before, `${who}: the refusal is audited`);
  }
  await refuses(call('nobody', 'GET', base), 401, undefined, null, 'not signed in');
  // Writes: owner only. Operations is read-only (until a later ticket lets the setting grant purchasing).
  for (const who of ['ops', 'manager', 'waiter', 'stranger', 'admin']) {
    await refuses(api(who, 'POST', '', { name: `Sneaky ${who}` }), 403, 'forbidden', null, `${who} cannot create`);
    await refuses(api(who, 'PATCH', `/${mama}`, { notes: 'hacked' }), 403, 'forbidden', null, `${who} cannot edit`);
    await refuses(api(who, 'POST', `/${mama}/deactivate`, {}), 403, 'forbidden', null, `${who} cannot deactivate`);
    await refuses(api(who, 'POST', `/${mama}/prices`, { itemId: flour, unit: 'sack', price: 1 }), 403, 'forbidden', null, `${who} cannot add prices`);
    await refuses(api(who, 'PUT', `/${mama}/items`, { items: [] }), 403, 'forbidden', null, `${who} cannot change the item list`);
  }
  eq((await one(`select count(*)::int as n from public.suppliers where name like 'Sneaky%'`)).n, 0, 'no sneaky supplier exists');
  eq((await one(`select notes from public.suppliers where id = $1`, [mama])).notes, null, 'nothing was edited by a refused caller');

  // Bank and M-Pesa details: the owner only.
  const asOps = await api('ops', 'GET', `/${wholesaler}`);
  ok(!('bankDetails' in asOps.supplier) && !('mpesaTill' in asOps.supplier) && !('mpesaPaybill' in asOps.supplier) && !('mpesaAccount' in asOps.supplier), 'operations manager sees no bank or M-Pesa fields');
  eq(asOps.supplier.kraPin, 'P051234567Z', '... but sees the KRA PIN');
  ok(!JSON.stringify(await api('ops', 'GET', '')).includes('1234567890'), 'the list leaks no bank details either');
  eq((await api('owner', 'GET', `/${wholesaler}`)).supplier.bankDetails, 'KCB Westlands, A/C 1234567890', 'the owner sees them');

  // Another business: a supplier is invisible from outside.
  await refuses(api('otherOwner', 'GET', `/${mama}`), 403, 'forbidden', null, 'another business\'s owner is refused on this business');
  const otherBase = `/api/owner/inventory/${otherRestaurant.business_id}/suppliers`;
  const foreign = await call('otherOwner', 'POST', otherBase, { name: 'Mama Njeri' });
  eq(foreign.supplier.name, 'Mama Njeri', 'the same name is fine in another business');
  await refuses(call('otherOwner', 'GET', `${otherBase}/${mama}`), 404, 'supplier_not_found', null, 'a supplier id from another business is a 404');
  await refuses(call('otherOwner', 'PATCH', `${otherBase}/${mama}`, { name: 'Taken over' }), 404, 'supplier_not_found', null, 'and cannot be edited');
  eq((await call('otherOwner', 'GET', otherBase)).suppliers.length, 1, 'the other business sees only its own');
}

// =============================================================================================================
// 4. Search and filters
// =============================================================================================================
{
  eq((await api('owner', 'GET', '', undefined, '?search=unga')).suppliers.map((s) => s.name), ['Unga Wholesalers Ltd'], 'search by name');
  eq((await api('owner', 'GET', '', undefined, '?search=0733')).suppliers.length, 0, 'phone search uses the stored 254 form');
  eq((await api('owner', 'GET', '', undefined, '?search=254733')).suppliers.map((s) => s.name), ['Unga Wholesalers Ltd'], 'search by phone');
  eq((await api('owner', 'GET', '', undefined, '?search=p051')).suppliers.map((s) => s.name), ['Unga Wholesalers Ltd'], 'search by KRA PIN');
  eq((await api('owner', 'GET', '', undefined, '?search=njeri+w')).suppliers.map((s) => s.name), ['Mama Njeri'], 'search by contact');
  eq((await api('owner', 'GET', '', undefined, '?type=formal')).suppliers.map((s) => s.name), ['Njeri Brothers', 'Unga Wholesalers Ltd'], 'filter by type (formal is the default type)');
  eq((await api('owner', 'GET', '', undefined, '?type=informal')).suppliers.length, 1, 'informal');
  await refuses(api('owner', 'GET', '', undefined, '?type=bogus'), 400, 'bad_choice', null, 'bad filter');
  eq((await api('owner', 'GET', '', undefined, '?status=inactive')).suppliers.length, 0, 'nobody inactive yet');
}

// =============================================================================================================
// 5. What a supplier sells
// =============================================================================================================
{
  const res = await api('owner', 'PUT', `/${mama}/items`, { items: [
    { itemId: tomatoes, unit: 'crate', supplierCode: 'TOM-1', rank: 1, preferred: true, leadTimeDays: 1, minOrder: { quantity: 2, unit: 'crate' } },
    { itemId: eggs, unit: 'trays', rank: 2 },
  ] });
  eq(res.items.map((i) => [i.name, i.purchaseUnit, i.rank, i.preferred]), [['Tomatoes', 'crate', 1, true], ['Eggs', 'tray', 2, false]], 'items saved; "trays" normalised to the item\'s tray');
  const row = await one(`select supplier_code, lead_time_days, min_order_base::text as m from public.supplier_items where supplier_id = $1 and item_id = $2`, [mama, tomatoes]);
  eq([row.supplier_code, row.lead_time_days, row.m], ['TOM-1', 1, '20000.0000'], 'minimum order 2 crates stored as 20 kg in grams');

  // Preferred moves to the new supplier.
  await api('owner', 'PUT', `/${wholesaler}/items`, { items: [{ itemId: tomatoes, unit: 'kg', preferred: true }, { itemId: flour, unit: 'sack' }] });
  eq((await q(`select supplier_id from public.supplier_items where item_id = $1 and preferred`, [tomatoes])).map((x) => x.supplier_id), [wholesaler], 'one preferred supplier per item: it moved');
  const mev = await one(`select after from public.inventory_events where entity_id = $1 and action = 'items' order by id desc limit 1`, [wholesaler]);
  eq(mev.after.preferredClearedFrom, [{ itemId: tomatoes, supplierId: mama }], 'the audit event says who lost the preferred flag');
  await api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: tomatoes, unit: 'crate', rank: 1 }, { itemId: eggs, unit: 'tray', rank: 2 }] });

  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: tomatoes, unit: 'litres' }] }), 400, 'unit_mismatch', /counted by weight/, 'a litre price for tomatoes');
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: oil, unit: 'crate' }] }), 400, 'bad_unit', /isn’t a unit Cravio knows/, 'a crate the item does not have');
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: tomatoes }, { itemId: tomatoes }] }), 400, 'duplicate_item', null, 'twice');
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: randomUUID() }] }), 404, 'item_not_found', null, 'unknown item');
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: tomatoes, rank: 0 }] }), 400, 'bad_rank', null, 'rank');
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: 'tomatoes' }), 400, 'items_required', null, 'not a list');
  await db.query(`update public.stock_items set archived_at = now() where id = $1`, [oil]);
  await refuses(api('owner', 'PUT', `/${mama}/items`, { items: [{ itemId: oil }] }), 409, 'item_archived', /archived/, 'an archived item cannot be newly added');
  await db.query(`update public.stock_items set archived_at = null where id = $1`, [oil]);
  const profile = await api('owner', 'GET', `/${mama}`);
  eq(profile.items.map((i) => [i.name, i.purchaseUnit]), [['Eggs', 'tray'], ['Tomatoes', 'crate']], 'the profile lists the items');
}

// =============================================================================================================
// 6. Prices: history, effective dates, per-base conversion
// =============================================================================================================
let firstPrice;
{
  // KES 6,500 per crate of 10 kg is KES 0.65 per gram, KES 650 per kg.
  const p = await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: '6500', effectiveFrom: '2026-11-01', note: 'November list' });
  firstPrice = p.price;
  eq([p.price.price, p.price.pricePerBase, p.price.unit, p.price.unitFactor, p.price.effectiveFrom], ['6500.00', '0.650000', 'crate', '10000', '2026-11-01'], 'KES 6,500 per crate of 10 kg = 0.65 per g');
  eq(p.price.perDisplayUnit, { unit: 'kg', price: '650.00' }, 'and KES 650.00 per kg for comparing');
  eq([p.previous, p.changePct, p.warnings, p.backdated], [null, null, [], false], 'first price: nothing to compare with');
  eq((await api('owner', 'POST', `/${mama}/prices`, { itemId: oil, unit: 'jerrycan', price: 4200, effectiveFrom: '2026-11-01' })).price.pricePerBase, '0.210000', 'KES 4,200 per 20 l jerrycan = 0.21 per ml');
  eq((await api('owner', 'POST', `/${mama}/prices`, { itemId: eggs, unit: 'tray', price: '450.00', effectiveFrom: '2026-11-01' })).price.pricePerBase, '15.000000', 'KES 450 per tray of 30 = 15 per egg');
  eq((await api('owner', 'POST', `/${mama}/prices`, { itemId: flour, unit: 'kg', price: '130.50', effectiveFrom: '2026-11-01' })).price.pricePerBase, '0.130500', 'KES 130.50 per kg = 0.1305 per g');
  eq((await one(`select supplier_id from public.supplier_items where item_id = $1 and supplier_id = $2`, [flour, mama])).supplier_id, mama, 'a price adds the item to the supplier\'s list');

  const d1 = await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 7000, effectiveFrom: '2026-12-01' });
  eq([d1.previous.price, d1.changePct, d1.warnings], ['6500.00', '7.69', []], 'a price rise of 7.69 % against the previous one');
  const d2 = await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: '6800.50', effectiveFrom: '2026-11-15' });
  eq([d2.backdated, d2.previous.price], [true, '6500.00'], 'a price dated before the latest one is accepted and flagged as backdated');
  const d3 = await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'kg', price: 640, effectiveFrom: '2026-11-10' });
  eq(d3.price.pricePerBase, '0.640000', 'the same item priced per kg is a separate unit line');

  const biz1 = { businessId: biz, supplierId: mama, itemId: tomatoes };
  eq((await priceFor(db, { ...biz1, date: '2026-10-31' })), null, 'no price before the first effective date');
  eq((await priceFor(db, { ...biz1, date: '2026-11-01', unit: 'crate' })).price, '6500.00', 'in force from its effective date');
  eq((await priceFor(db, { ...biz1, date: '2026-11-14', unit: 'crate' })).price, '6500.00', 'the old price holds until the next one starts');
  eq((await priceFor(db, { ...biz1, date: '2026-11-15', unit: 'crate' })).price, '6800.50', 'the backdated price applies from its date');
  eq((await priceFor(db, { ...biz1, date: '2026-11-30', unit: 'crate' })).price, '6800.50', 'last day of November');
  eq((await priceFor(db, { ...biz1, date: '2026-12-01', unit: 'crate' })).price, '7000.00', 'December price from 1 Dec');
  eq((await priceFor(db, { ...biz1, date: '2027-06-01', unit: 'crate' })).price, '7000.00', 'and onwards');
  eq((await priceFor(db, { ...biz1, date: '2026-11-12' })).unit, 'kg', 'without a unit: the latest row in force across units (kg from 10 Nov)');
  eq((await priceFor(db, { ...biz1, date: '2026-11-12', unit: 'KG' })).price, '640.00', 'unit match ignores case');

  const hist = await api('owner', 'GET', `/${mama}/prices`, undefined, `?item=${tomatoes}`);
  eq(hist.prices.map((x) => [x.unit, x.effectiveFrom, x.price, x.current, x.scheduled]),
    [['crate', '2026-12-01', '7000.00', false, true], ['crate', '2026-11-15', '6800.50', true, false], ['kg', '2026-11-10', '640.00', true, false], ['crate', '2026-11-01', '6500.00', false, false]],
    'history: newest first; the row in force today (18 Nov) is current; 1 Dec is scheduled');
  eq((await api('owner', 'GET', `/${mama}/prices`, undefined, `?item=${tomatoes}&unit=kg`)).prices.length, 1, 'filter by unit');
  const prof = await api('owner', 'GET', `/${mama}`);
  eq(prof.prices.filter((x) => x.itemId === tomatoes).map((x) => [x.unit, x.price]), [['crate', '6800.50'], ['kg', '640.00']], 'the profile shows the prices in force today');

  // Insert-only history and the validators.
  const dup = await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 6600, effectiveFrom: '2026-11-15' }), 409, 'price_exists', /can’t be edited.*later date/, 'same date twice');
  ok(dup, 'duplicate refused');
  eq((await one(`select price::text as p from public.supplier_prices where id = $1`, [firstPrice.id])).p, '6500.00', 'the old row is untouched');
  let direct = null; try { await db.query(`update public.supplier_prices set price = 1 where id = $1`, [firstPrice.id]); } catch (e) { direct = e; }
  ok(/history/.test(direct?.message || ''), 'a direct database edit of a price is refused too');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: '6500.555' }), 400, 'bad_price', /2 decimal places/, 'three decimals');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 0 }), 400, 'bad_price', /more than zero/, 'zero');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: -5 }), 400, 'bad_price', null, 'negative');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 'lots' }), 400, 'bad_number', null, 'not a number');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 1e12 }), 400, 'bad_price', null, 'absurd');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'litres', price: 5, effectiveFrom: '2026-11-20' }), 400, 'unit_mismatch', /counted by weight/, 'a litre price for tomatoes');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 5, effectiveFrom: '2026-02-30' }), 400, 'bad_date', /date like/, 'impossible date');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 5, effectiveFrom: '18/11/2026' }), 400, 'bad_date', null, 'wrong date format');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 5, effectiveFrom: '2025-01-01' }), 400, 'date_too_old', /more than a year ago/, 'older than a year');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 5, effectiveFrom: '2028-01-01' }), 400, 'date_too_far', /more than a year away/, 'too far ahead');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { itemId: randomUUID(), unit: 'crate', price: 5 }), 404, 'item_not_found', null, 'unknown item');
  await refuses(api('owner', 'POST', `/${mama}/prices`, { unit: 'crate', price: 5 }), 400, 'bad_id', null, 'item required');
  const unusual = await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 70000, effectiveFrom: '2026-12-15' });
  eq(unusual.warnings.map((w) => w.code), ['unusual_price'], 'ten times the previous price is accepted with a warning');
  eq((await api('owner', 'POST', `/${mama}/prices`, { itemId: tomatoes, unit: 'crate', price: 7000, effectiveFrom: '2027-01-15' })).warnings.map((w) => w.code), ['unusual_price'], 'a tenth of the previous price warns too');
  const noUnit = await api('owner', 'POST', `/${mama}/prices`, { itemId: eggs, price: 460, effectiveFrom: '2026-11-17' });
  eq(noUnit.price.unit, 'tray', 'a missing unit falls back to the supplier\'s purchase unit for the item');
  const pe = await one(`select before, after from public.inventory_events where entity = 'supplier_price' and entity_id = $1`, [d1.price.id]);
  eq([pe.before.price, pe.after.price, pe.after.pricePerBase, pe.after.effectiveFrom], ['6500.00', '7000.00', '0.700000', '2026-12-01'], 'a price is audited with the previous one');
  const bev = await one(`select after from public.inventory_events where entity = 'supplier_price' and entity_id = $1`, [d2.price.id]);
  eq(bev.after.backdated, true, 'a backdated price is marked in the audit');
  const replayCmd = randomUUID();
  const a = await api('owner', 'POST', `/${mama}/prices`, { commandId: replayCmd, itemId: oil, unit: 'jerrycan', price: 4300, effectiveFrom: '2026-11-18' });
  const b = await api('owner', 'POST', `/${mama}/prices`, { commandId: replayCmd, itemId: oil, unit: 'jerrycan', price: 4300, effectiveFrom: '2026-11-18' });
  eq(a.price.id, b.price.id, 'a retried price (same commandId) is recorded once');
}

// =============================================================================================================
// 7. Where to buy: cheapest and preferred, compared per base unit
// =============================================================================================================
let third;
{
  // Unga: tomatoes per kg KES 600 from 16 Nov (0.60/g), preferred. Cheap & Cheerful: crate 6,500 from 17 Nov (0.65/g).
  // Mama: her latest price in force today is the crate at KES 6,800.50 from 15 Nov (0.68005/g).
  await api('owner', 'PUT', `/${wholesaler}/items`, { items: [{ itemId: tomatoes, unit: 'kg', preferred: true, rank: 2 }, { itemId: flour, unit: 'sack' }] });
  await api('owner', 'POST', `/${wholesaler}/prices`, { itemId: tomatoes, unit: 'kg', price: 600, effectiveFrom: '2026-11-16' });
  third = (await api('owner', 'POST', '', { name: 'Cheap & Cheerful', type: 'one_off' })).supplier.id;
  await api('owner', 'POST', `/${third}/prices`, { itemId: tomatoes, unit: 'crate', price: '6500', effectiveFrom: '2026-11-17' });
  const best = await api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}`);
  eq(best.candidates.map((c) => [c.supplierName, c.unit, c.pricePerBase]),
    [['Unga Wholesalers Ltd', 'kg', '0.600000'], ['Cheap & Cheerful', 'crate', '0.650000'], ['Mama Njeri', 'crate', '0.680050']],
    'sorted cheapest first per BASE unit: a kg price and crate prices line up (0.60, 0.65, 0.68005)');
  eq(best.cheapest.supplierName, 'Unga Wholesalers Ltd', 'cheapest');
  eq(best.preferred.supplierName, 'Unga Wholesalers Ltd', 'preferred');
  eq(best.candidates[0].perDisplayUnit, { unit: 'kg', price: '600.00' }, 'each candidate also shows the price per display unit');
  eq(best.candidates[1].perDisplayUnit, { unit: 'kg', price: '650.00' }, 'KES 6,500 per crate = KES 650 per kg');
  eq(best.date, '2026-11-18', 'as at today (Nairobi)');
  const earlier = await api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}&date=2026-11-12`);
  eq(earlier.candidates.map((c) => [c.supplierName, c.unit, c.price]), [['Mama Njeri', 'kg', '640.00']], 'as at 12 Nov only Mama had a price in force (her kg price from 10 Nov)');
  eq((await api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}&date=2026-11-16`)).candidates.map((c) => c.supplierName), ['Unga Wholesalers Ltd', 'Mama Njeri'], 'as at 16 Nov the third supplier had no price yet');
  const none = await api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}&date=2026-10-01`);
  eq([none.candidates, none.cheapest, none.preferred], [[], null, null], 'before any price: nothing');
  eq((await api('ops', 'GET', '/best-price', undefined, `?item=${tomatoes}`)).cheapest.supplierName, 'Unga Wholesalers Ltd', 'operations managers can compare prices');
  await refuses(api('owner', 'GET', '/best-price'), 400, 'item_required', null, 'item required');
  await refuses(api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}&date=soon`), 400, 'bad_date', null, 'bad date');
  await refuses(api('owner', 'GET', '/best-price', undefined, `?item=${randomUUID()}`), 404, 'item_not_found', null, 'unknown item');
  eq((await api('owner', 'GET', '/best-price', undefined, `?item=${rice}`)).candidates, [], 'an item nobody supplies');
}

// =============================================================================================================
// 8. Switching off, open orders, completing
// =============================================================================================================
{
  const off = await api('owner', 'POST', `/${wholesaler}/deactivate`, {});
  eq([off.supplier.status, off.changed], ['inactive', true], 'deactivated');
  eq((await api('owner', 'POST', `/${wholesaler}/deactivate`, {})).changed, false, 'deactivating twice changes nothing');
  eq((await api('owner', 'GET', '')).suppliers.map((s) => s.name).includes('Unga Wholesalers Ltd'), true, 'an inactive supplier is still in the owner list');
  eq((await api('owner', 'GET', '', undefined, '?status=active')).suppliers.map((s) => s.name).includes('Unga Wholesalers Ltd'), false, '... and filtered out by status=active');
  eq((await api('owner', 'GET', '', undefined, '?status=inactive')).suppliers.map((s) => s.name), ['Unga Wholesalers Ltd'], 'status=inactive');
  eq((await api('owner', 'GET', '/best-price', undefined, `?item=${tomatoes}`)).cheapest.supplierName, 'Cheap & Cheerful', 'an inactive supplier drops out of price comparison');
  await refuses(api('owner', 'POST', `/${wholesaler}/prices`, { itemId: flour, unit: 'sack', price: 3200 }), 409, 'supplier_inactive', /switched off/, 'no new prices for an inactive supplier');
  eq((await api('owner', 'GET', `/${wholesaler}`)).supplier.status, 'inactive', 'its profile is still readable');
  const on = await api('owner', 'POST', `/${wholesaler}/activate`, {});
  eq(on.supplier.status, 'active', 'activated again');
  const ev = await q(`select action from public.inventory_events where entity = 'supplier' and entity_id = $1 and action in ('deactivate', 'activate') order by id`, [wholesaler]);
  eq(ev.map((e) => e.action), ['deactivate', 'activate'], 'audited');

  // Open purchase orders block deactivation (the table arrives with migration 016; this stands in for it).
  await db.query(`create table public.purchase_orders (id uuid primary key default gen_random_uuid(), supplier_id uuid not null, status text not null)`);
  await db.query(`insert into public.purchase_orders (supplier_id, status) values ($1, 'received'), ($1, 'cancelled'), ($1, 'closed')`, [wholesaler]);
  eq((await api('owner', 'POST', `/${wholesaler}/deactivate`, {})).supplier.status, 'inactive', 'finished and cancelled orders do not block');
  await api('owner', 'POST', `/${wholesaler}/activate`, {});
  await db.query(`insert into public.purchase_orders (supplier_id, status) values ($1, 'approved'), ($1, 'partially_received')`, [wholesaler]);
  const blocked = await refuses(api('owner', 'POST', `/${wholesaler}/deactivate`, {}), 409, 'open_orders', /2 purchase orders with Unga Wholesalers Ltd are still open/, 'open orders block deactivation');
  eq(blocked.details.openOrders, 2, 'with the count');
  eq((await api('owner', 'GET', `/${wholesaler}`)).openOrders, 2, 'the profile shows the open orders');
  eq((await one(`select status from public.suppliers where id = $1`, [wholesaler])).status, 'active', 'still active');
  await db.query('drop table public.purchase_orders');
}

// =============================================================================================================
// 9. Branch managers: the emergency picker and on-the-spot suppliers
// =============================================================================================================
let spot;
{
  const { branch1, branch2 } = branches;
  const picker = await call('manager', 'GET', '/api/inventory/suppliers', undefined, '', branch1.restaurantId);
  eq(picker.suppliers.map((s) => s.name), ['Cheap & Cheerful', 'Mama Njeri', 'Njeri Brothers', 'Unga Wholesalers Ltd'], 'the picker lists active suppliers by name');
  eq(Object.keys(picker.suppliers[0]).sort(), ['id', 'incomplete', 'name', 'type'], 'names only: no phone, PIN, bank or prices');
  ok(!JSON.stringify(picker).includes('1234567890') && !JSON.stringify(picker).includes('254733'), 'no bank or contact data leaks');
  const priced = await call('manager', 'GET', '/api/inventory/suppliers', undefined, `?item=${tomatoes}`, branch1.restaurantId);
  eq(priced.suppliers.find((s) => s.name === 'Mama Njeri').lastPrice.price, '6800.50', 'with ?item= a branch manager (who holds inv.cost.view at their branch) sees the last price');
  eq(priced.suppliers.find((s) => s.name === 'Njeri Brothers').lastPrice, null, 'null when the supplier has no price for it');
  eq((await call('manager', 'GET', '/api/inventory/suppliers', undefined, '?search=mama', branch1.restaurantId)).suppliers.map((s) => s.name), ['Mama Njeri'], 'search');
  eq((await call('manager2', 'GET', '/api/inventory/suppliers', undefined, '', branch2.restaurantId)).suppliers.length, 4, 'the other branch manager too');
  await refuses(call('manager', 'GET', '/api/inventory/suppliers', undefined, '', branch2.restaurantId), 403, 'forbidden', null, 'a manager cannot use another branch\'s picker');
  await refuses(call('waiter', 'GET', '/api/inventory/suppliers', undefined, '', branch1.restaurantId), 403, 'forbidden', null, 'a waiter has nothing here');
  await refuses(call('ops', 'GET', '/api/inventory/suppliers', undefined, '', branch1.restaurantId), 403, 'forbidden', null, 'operations use the owner screens, not the branch picker');
  await refuses(call('stranger', 'GET', '/api/inventory/suppliers', undefined, '', branch1.restaurantId), 403, 'forbidden', null, 'a stranger');
  eq((await call('manager', 'GET', '/api/inventory/suppliers')).suppliers.length, 4, 'a manager with a single branch may leave the branch header out');

  // The manager reaches the owner API: refused and audited.
  const denied = await deniedCount(people.manager);
  await refuses(api('manager', 'GET', ''), 403, 'forbidden', null, 'manager on the owner list');
  await refuses(api('manager', 'POST', '', { name: 'Not allowed' }), 403, 'forbidden', null, 'manager on owner create');
  ok((await deniedCount(people.manager)) >= denied + 2, 'both refusals audited');

  // On the spot.
  const cmd = randomUUID();
  const made = await call('manager', 'POST', '/api/inventory/suppliers', { commandId: cmd, name: ' Roadside  Mama ', phone: '0722 111 222', kraPin: 'a000111222z', type: 'formal', bankDetails: 'x', paymentTermsDays: 90 }, '', branch1.restaurantId);
  spot = made.supplier.id;
  eq(made.supplier, { id: spot, name: 'Roadside Mama', type: 'one_off', incomplete: true }, 'created on the spot: incomplete, one-off');
  const row = await one(`select phone, kra_pin, type, payment_method, payment_terms_days, bank_details, created_by, incomplete from public.suppliers where id = $1`, [spot]);
  eq(row, { phone: '254722111222', kra_pin: 'A000111222Z', type: 'one_off', payment_method: 'cash', payment_terms_days: 0, bank_details: null, created_by: people.manager, incomplete: true }, 'extra fields (type, terms, bank) are ignored for a branch manager');
  eq((await call('manager', 'POST', '/api/inventory/suppliers', { commandId: cmd, name: 'Roadside Mama', phone: '0722111222' }, '', branch1.restaurantId)).supplier.id, spot, 'a retry returns the first result');
  const dup = await refuses(call('manager', 'POST', '/api/inventory/suppliers', { name: 'roadside mama', phone: '0722111222' }, '', branch1.restaurantId), 409, 'name_taken', /Pick it|Use that one/, 'a name that exists');
  eq(dup.details.supplierId, spot, 'the refusal names the existing supplier');
  await refuses(call('manager', 'POST', '/api/inventory/suppliers', { name: 'No phone' }, '', branch1.restaurantId), 400, 'phone_required', /phone number/, 'phone is required');
  await refuses(call('manager', 'POST', '/api/inventory/suppliers', { name: 'Bad phone', phone: '123' }, '', branch1.restaurantId), 400, 'bad_phone', null, 'phone format');
  await refuses(call('manager', 'POST', '/api/inventory/suppliers', { name: 'Bad pin', phone: '0722111223', kraPin: 'zzz' }, '', branch1.restaurantId), 400, 'bad_pin', null, 'PIN format');
  await refuses(call('manager', 'POST', '/api/inventory/suppliers', { phone: '0722111223' }, '', branch1.restaurantId), 400, 'name_required', null, 'name is required');
  await refuses(call('manager2', 'POST', '/api/inventory/suppliers', { name: 'Elsewhere', phone: '0722111224' }, '', branch1.restaurantId), 403, 'forbidden', null, 'another branch\'s manager cannot add through this branch');
  for (const who of ['waiter', 'ops', 'stranger']) {
    await refuses(call(who, 'POST', '/api/inventory/suppliers', { name: `Nope ${who}`, phone: '0722111225' }, '', branch1.restaurantId), 403, 'forbidden', null, `${who} cannot add on the spot`);
  }
  const ev = await one(`select location_id, actor_id, actor_role, after from public.inventory_events where entity = 'supplier' and entity_id = $1`, [spot]);
  eq([ev.location_id, ev.actor_id, ev.actor_role], [branch1.locationId, people.manager, 'branch_manager'], 'audited at the branch, as the manager');

  // The owner sees it flagged and completes it.
  eq((await api('owner', 'GET', '', undefined, '?incomplete=1')).suppliers.map((s) => [s.name, s.incomplete]), [['Roadside Mama', true]], 'owner list: incomplete filter');
  eq((await api('ops', 'GET', `/${spot}`)).supplier.incomplete, true, 'operations see the flag too');
  await db.query(`update public.suppliers set phone = null where id = $1`, [spot]);
  await refuses(api('owner', 'POST', `/${spot}/complete`, {}), 409, 'phone_required', /Add a phone number/, 'cannot complete without a phone');
  await api('owner', 'PATCH', `/${spot}`, { phone: '0722111222', type: 'informal', contactName: 'Mama R.' });
  eq((await api('owner', 'GET', `/${spot}`)).supplier.incomplete, true, 'editing alone does not clear the flag');
  const done = await api('owner', 'POST', `/${spot}/complete`, {});
  eq([done.supplier.incomplete, done.changed], [false, true], 'completed');
  eq((await api('owner', 'POST', `/${spot}/complete`, {})).changed, false, 'completing twice changes nothing');
  eq((await api('owner', 'GET', '', undefined, '?incomplete=1')).suppliers.length, 0, 'nothing incomplete any more');
  await refuses(api('manager', 'POST', `/${spot}/complete`, {}), 403, 'forbidden', null, 'a manager cannot complete a supplier');

  // A branch manager cannot flood the list with on-the-spot suppliers.
  let last = null;
  for (let i = 0; i < 12; i++) {
    try { await call('manager', 'POST', '/api/inventory/suppliers', { name: `Stall ${i}`, phone: `07220000${String(i).padStart(2, '0')}` }, '', branch1.restaurantId); } catch (e) { last = e; break; }
  }
  eq([last?.status, last?.details?.code], [429, 'too_many_on_the_spot'], 'at most 10 new on-the-spot suppliers per person per day');
  eq((await one(`select count(*)::int as n from public.suppliers where created_by = $1`, [people.manager])).n, 10, 'exactly ten exist');
}

// =============================================================================================================
// 10. Switched off, and the shapes of unusual calls
// =============================================================================================================
{
  await db.query('update public.businesses set inventory_enabled = false where id = $1', [biz]);
  await refuses(api('owner', 'GET', ''), 403, 'inventory_disabled', /switched on/, 'owner while the module is off');
  await refuses(api('owner', 'POST', '', { name: 'Nope' }), 403, 'inventory_disabled', null, 'create while off');
  await refuses(call('manager', 'GET', '/api/inventory/suppliers', undefined, '', branches.branch1.restaurantId), 403, 'inventory_disabled', null, 'branch picker while off');
  await db.query('update public.businesses set inventory_enabled = true where id = $1', [biz]);
  eq((await api('owner', 'GET', '')).suppliers.length > 0, true, 'back on');
}

console.log(`Suppliers service + API: ${count()} checks passed.`);
await db.close();
