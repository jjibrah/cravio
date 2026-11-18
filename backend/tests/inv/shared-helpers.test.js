// P2-02 leftovers: nextNumber (gap-free document numbers), notify() (recipients, dedupe, never throws) and the Phase 2 settings.
// Runs on a disposable PGlite database with every proposed migration applied.
// Usage: node backend/tests/inv/shared-helpers.test.js
import { rig, inventoryFixture } from './fixture.js';
import { makeAsserts } from './helpers.js';
import { nextNumber, nextSequence, peekNumber, nairobiYear, formatNumber } from '../../src/inventory/numbers.js';
import { notify, resolveRecipients } from '../../src/inventory/notifications.js';
import { SETTINGS, getSetting, getSettings, setSetting } from '../../src/inventory/policies.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, people, branches } = r;
const biz = ids.businessId;
const q = async (sql, p) => (await db.query(sql, p)).rows;

// ---------------------------------------------------------------------------------------------------------------
// nextNumber
// ---------------------------------------------------------------------------------------------------------------
{
  eq(formatNumber('PO', 2026, 7), 'PO-2026-0007', 'format pads to four digits');
  eq(formatNumber('PO', 2026, 12345), 'PO-2026-12345', 'and grows past 9999');
  eq(await peekNumber(db, { businessId: biz, kind: 'PO', year: 2026 }), 'PO-2026-0001', 'peek before any');
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'PO', year: 2026 })), 'PO-2026-0001', 'first PO');
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'PO', year: 2026 })), 'PO-2026-0002', 'second PO');
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'GRN', year: 2026 })), 'GRN-2026-0001', 'GRN has its own counter');
  eq(await peekNumber(db, { businessId: biz, kind: 'PO', year: 2026 }), 'PO-2026-0003', 'peek does not take a number');

  // Year rollover: a new year starts again at 1; the old year keeps counting.
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'PO', year: 2027 })), 'PO-2027-0001', 'new year restarts at 0001');
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'PO', year: 2026 })), 'PO-2026-0003', 'old year continues');
  eq(nairobiYear(new Date('2026-12-31T20:59:00Z')), 2026, 'Nairobi is UTC+3: 23:59 on 31 Dec is still 2026');
  eq(nairobiYear(new Date('2026-12-31T21:00:00Z')), 2027, 'and midnight is 2027');
  eq((await db.transaction((t) => nextSequence(t, { businessId: biz, kind: 'REQ', now: new Date('2026-12-31T21:30:00Z') }))).number, 'REQ-2027-0001', 'default year follows the Nairobi clock');

  // Businesses do not share counters.
  const otherOwner = (await q(`insert into auth.users (email) values ('other-owner@example.test') returning id`))[0].id;
  const other = (await q(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning business_id`, [otherOwner]))[0].business_id;
  eq(await db.transaction((t) => nextNumber(t, { businessId: other, kind: 'PO', year: 2026 })), 'PO-2026-0001', 'another business starts at 0001');

  // Many callers at once: all distinct, no gaps (PGlite runs the transactions one after another, which is what the row lock does on Postgres).
  const many = await Promise.all(Array.from({ length: 12 }, () => db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'TRF', year: 2026 }))));
  eq(new Set(many).size, 12, 'twelve callers, twelve different numbers');
  eq([...many].sort(), Array.from({ length: 12 }, (_x, i) => formatNumber('TRF', 2026, i + 1)), 'and exactly 1..12');

  // Gap-free: a rolled-back document gives its number back.
  await refuses(db.transaction(async (t) => { await nextNumber(t, { businessId: biz, kind: 'EP', year: 2026 }); throw new Error('document failed'); }).catch((e) => { throw Object.assign(e, { status: 500, details: { code: 'x' } }); }), 500, 'x', /document failed/, 'failing document');
  eq(await db.transaction((t) => nextNumber(t, { businessId: biz, kind: 'EP', year: 2026 })), 'EP-2026-0001', 'the rolled-back number was not burnt');

  // Validation.
  for (const kind of ['po', 'P', 'TOOLONGKIND', 'P-O', '', undefined]) {
    let e = null; try { await nextNumber(db, { businessId: biz, kind, year: 2026 }); } catch (x) { e = x; }
    ok(e instanceof TypeError, `kind ${JSON.stringify(kind)} refused`);
  }
  await refuses(nextNumber(db, { businessId: biz, kind: 'PO', year: 1999 }), 400, 'bad_year', /between 2000 and 2999/, 'bad year');
  eq((await q('select last_number from public.inventory_number_sequences where business_id = $1 and kind = $2 and year = $3', [biz, 'PO', 2026]))[0].last_number, 3, 'the counter row says 3');
}

// ---------------------------------------------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------------------------------------------
{
  const { branch1, branch2 } = branches;
  const rows = (kind) => q('select recipient_id, title, body, link, entity_type, entity_id, location_id, dedupe_key from public.notifications where kind = $1 order by recipient_id', [kind]);
  const ids3 = (list) => [...list].sort();

  eq(ids3((await resolveRecipients(db, biz, 'owners')).userIds), ids3([people.owner, people.owner2]), 'owners = business_members owner');
  eq(ids3((await resolveRecipients(db, biz, `branch_managers:${branch1.restaurantId}`)).userIds), ids3([people.owner, people.owner2, people.manager]), 'branch managers = restaurant owner|manager (not the waiter, not operations)');
  const b2 = await resolveRecipients(db, biz, `branch_managers:${branch2.restaurantId}`);
  eq(b2.userIds, [people.manager2], 'branch 2 manager only');
  eq(b2.locationId, branch2.locationId, 'the branch location comes with it');
  eq(ids3((await resolveRecipients(db, biz, `alerts:${branch2.restaurantId}`)).userIds), ids3([people.owner, people.owner2, people.manager2]), 'alerts = owners + that branch (what 013 triggers use)');
  eq((await resolveRecipients(db, biz, [people.waiter, people.ops])).userIds.length, 2, 'explicit users of the business are kept');
  eq((await resolveRecipients(db, biz, [`branch_managers:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`])).userIds, [], 'an unknown branch resolves to nobody');
  const stranger = (await q(`insert into auth.users (email) values ('x@example.test') returning id`))[0].id;
  eq((await resolveRecipients(db, biz, [stranger])).userIds, [], 'a user outside the business is never a recipient');
  eq(ids3((await resolveRecipients(db, biz, ['owners', `branch_managers:${branch2.restaurantId}`, people.waiter])).userIds), ids3([people.owner, people.owner2, people.manager2, people.waiter]), 'mixed specs are combined without repeats');

  const ref = '11111111-1111-4111-8111-111111111111';
  const sent = await db.transaction((t) => notify(t, { businessId: biz, recipients: 'owners', kind: 'po_pending', title: 'PO-2026-0001 needs approval', body: 'KES 12,000 from Mama Njeri', link: '/owner/inventory/purchasing', entity: { type: 'purchase_order', id: ref }, dedupeKey: 'po:1' }));
  eq(sent, { delivered: 2, recipients: 2, skipped: 0 }, 'both owners notified');
  const stored = await rows('po_pending');
  eq(stored.map((x) => x.recipient_id).sort(), ids3([people.owner, people.owner2]), 'rows for each owner');
  eq([stored[0].title, stored[0].link, stored[0].entity_type, stored[0].entity_id, stored[0].dedupe_key], ['PO-2026-0001 needs approval', '/owner/inventory/purchasing', 'purchase_order', ref, 'po:1'], 'fields stored');

  eq(await db.transaction((t) => notify(t, { businessId: biz, recipients: 'owners', kind: 'po_pending', title: 'again', dedupeKey: 'po:1' })), { delivered: 0, recipients: 2, skipped: 2 }, 'same dedupe key: nothing new, nothing thrown');
  eq((await rows('po_pending')).length, 2, 'still two rows');
  eq((await db.transaction((t) => notify(t, { businessId: biz, recipients: 'owners', kind: 'po_pending', title: 'other', dedupeKey: 'po:2' }))).delivered, 2, 'a different key is a new notification');
  eq((await db.transaction((t) => notify(t, { businessId: biz, recipients: 'owners', kind: 'info', title: 'no key' }))).delivered, 2, 'without a key it always delivers');
  eq((await db.transaction((t) => notify(t, { businessId: biz, recipients: 'owners', kind: 'info', title: 'no key' }))).delivered, 2, '... again');

  // Per-recipient dedupe: a new recipient still gets it.
  await db.transaction((t) => notify(t, { businessId: biz, recipients: [people.manager], kind: 'emg', title: 'Emergency buy', dedupeKey: 'e:1' }));
  const mixed = await db.transaction((t) => notify(t, { businessId: biz, recipients: [people.manager, people.waiter], kind: 'emg', title: 'Emergency buy', dedupeKey: 'e:1' }));
  eq([mixed.delivered, mixed.skipped], [1, 1], 'only the new recipient is added');

  // exclude + branch location
  const ex = await db.transaction((t) => notify(t, { businessId: biz, recipients: `branch_managers:${branch1.restaurantId}`, exclude: [people.manager], kind: 'exc', title: 'Returned', link: '/branch/inventory' }));
  eq(ex.delivered, 2, 'the actor can be left out');
  eq((await rows('exc')).every((x) => x.location_id === branch1.locationId), true, 'branch notifications carry the branch location');
  eq((await db.transaction((t) => notify(t, { businessId: biz, recipients: [], kind: 'x', title: 'nobody' }))).delivered, 0, 'no recipients: delivered 0');

  // Long text is clipped, not refused.
  await db.transaction((t) => notify(t, { businessId: biz, recipients: [people.waiter], kind: 'clip', title: 'T'.repeat(500), body: 'B'.repeat(5000), link: '/x'.repeat(400) }));
  const clipped = (await rows('clip'))[0];
  eq([clipped.title.length, clipped.body.length, clipped.link.length], [200, 1000, 300], 'title/body/link clipped to the column limits');

  // Never throws, and never poisons the caller's transaction.
  await db.transaction(async (t) => {
    const bad = await notify(t, { businessId: biz, recipients: 'owners', kind: 'bad', title: 'FK failure', locationId: '22222222-2222-4222-8222-222222222222' });
    eq([bad.delivered, typeof bad.error], [0, 'string'], 'a failing insert is reported, not thrown');
    eq((await t.query('select 1 as one')).rows[0].one, 1, 'the surrounding transaction is still usable');
    eq((await notify(t, { businessId: biz, recipients: 'owners', kind: 'after_bad', title: 'works after' })).delivered, 2, 'and notify works again');
    await t.query(`insert into public.inventory_settings (business_id, key, value) values ($1, 'low_alert_enabled', 'false'::jsonb)`, [biz]);
  });
  eq((await q(`select count(*)::int as n from public.inventory_settings where key = 'low_alert_enabled'`))[0].n, 1, 'the caller\'s own write committed');
  eq((await notify(db, { businessId: biz, recipients: 'owners', kind: 'nope' })).error, 'bad_arguments', 'missing title: reported, not thrown');
  eq((await notify(db, { recipients: 'owners', kind: 'k', title: 't' })).error, 'bad_arguments', 'missing business: reported, not thrown');
  eq((await notify(db, { businessId: 'not-a-uuid', recipients: 'owners', kind: 'k', title: 't' })).error, 'bad_arguments', 'bad business id: reported, not thrown');

  // Without migration 013 (no notifications table) it still never throws.
  const bare = await inventoryFixture({ extra: [] });
  await bare.db.transaction(async (t) => {
    const res = await notify(t, { businessId: bare.ids.businessId, recipients: 'owners', kind: 'k', title: 't' });
    eq([res.delivered, res.error], [0, '42P01'], 'no table: reported');
    eq((await t.query('select 1 as one')).rows[0].one, 1, 'and the transaction survives');
  });
  await bare.db.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Settings (09 P2-02): types, validators, defaults = "not set"
// ---------------------------------------------------------------------------------------------------------------
{
  const expected = {
    operations_can_purchase: false, price_variance_alert_pct: 10, transfer_over_tolerance_pct: 5, returns_need_approval: false,
    branch_to_branch_enabled: true, emergency_repeat_alert_count: 3, emergency_repeat_alert_days: 7, ai_usd_to_kes: null,
    wastage_approval_value_kes: null, count_tolerance_pct: null,
  };
  const all = await getSettings(db, biz);
  for (const [key, value] of Object.entries(expected)) eq(all[key], value, `default of ${key}`);
  eq(Object.keys(all).sort(), Object.keys(SETTINGS).sort(), 'every known key is returned');
  ok(!Object.keys(SETTINGS).some((k) => /(emergency|wastage|adjust|count).*(kes|amount|limit)/.test(k) && SETTINGS[k].default !== null), 'no built-in money amounts (D2-6, D2-16)');
  eq(SETTINGS.count_tolerance_pct.type, 'number|null', 'count tolerance is now nullable (the 3 % default is gone)');

  const actor = { actorId: people.owner, actorRole: 'owner' };
  const set = (key, value, extra = {}) => setSetting(db, { businessId: biz, key, value, ...actor, ...extra });
  eq(await set('price_variance_alert_pct', 15), 15, 'price variance accepts 15');
  eq(await getSetting(db, biz, 'price_variance_alert_pct'), 15, 'and stores it');
  eq(await getSetting(db, biz, 'price_variance_alert_pct', branches.branch2.locationId), 15, 'a branch inherits it');
  await set('price_variance_alert_pct', 20, { locationId: branches.branch2.locationId });
  eq(await getSetting(db, biz, 'price_variance_alert_pct', branches.branch2.locationId), 20, 'a branch can override');
  eq(await set('returns_need_approval', true), true, 'boolean on');
  eq(await set('branch_to_branch_enabled', false), false, 'boolean off');
  eq(await set('operations_can_purchase', true), true, 'operations can purchase on');
  eq(await set('transfer_over_tolerance_pct', 0), 0, 'zero tolerance is allowed');
  eq(await set('emergency_repeat_alert_count', 5), 5, 'repeat count');
  eq(await set('emergency_repeat_alert_days', 14), 14, 'repeat days');
  eq(await set('ai_usd_to_kes', 129.5), 129.5, 'rate');
  eq(await set('ai_usd_to_kes', null), null, 'rate can be cleared');
  eq(await set('count_tolerance_pct', null), null, 'count tolerance can be cleared to "not set"');
  eq(await set('count_tolerance_pct', 2.5), 2.5, 'or set');
  for (const [key, value, re] of [
    ['price_variance_alert_pct', -1, /between 0 and 1000/], ['price_variance_alert_pct', 'ten', /must be a number/], ['price_variance_alert_pct', null, /must be a number/],
    ['transfer_over_tolerance_pct', 101, /between 0 and 100/], ['returns_need_approval', 'yes', /on or off/], ['operations_can_purchase', 1, /on or off/],
    ['branch_to_branch_enabled', null, /on or off/], ['emergency_repeat_alert_count', 0, /between 1 and 50/], ['emergency_repeat_alert_count', 2.5, /whole number/],
    ['emergency_repeat_alert_days', 91, /between 1 and 90/], ['ai_usd_to_kes', 0, /between 1 and 10000/], ['ai_usd_to_kes', Number.NaN, /must be a number/],
    ['count_tolerance_pct', 101, /between 0 and 100/],
  ]) await refuses(set(key, value), 400, 'invalid_setting', re, `${key} = ${String(value)} refused`);
  const audit = (await q(`select before, after from public.inventory_events where entity = 'setting' and (after->>'key') = 'price_variance_alert_pct' order by id limit 1`))[0];
  eq([audit.before, audit.after], [{ key: 'price_variance_alert_pct', value: 10, inherited: true }, { key: 'price_variance_alert_pct', value: 15 }], 'a setting change is audited with before/after');
}

console.log(`Shared helpers (nextNumber, notify, settings): ${count()} checks passed.`);
await db.close();
