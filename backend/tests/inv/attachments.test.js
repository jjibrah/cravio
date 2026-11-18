// Evidence attachments (P2-06). Runs the REAL route handlers from routes/inventory-attachments.js against an in-memory database (all proposed
// migrations) and an in-memory fake of the private 'inventory-evidence' bucket: type and size refusals, magic-byte sniffing, sha256, path layout,
// who may upload, who may open (5-minute signed URL), branch isolation (T-SEC-1 shape) and business isolation. No network.
// Usage: node backend/tests/inv/attachments.test.js
import { createHash } from 'node:crypto';
import { rig } from './fixture.js';
import { fakeClock, fakeStorage, makeAsserts, makeSupplier } from './helpers.js';
import { HttpError } from '../../src/lib/http.js';
import { BODY_LIMIT, createRoutes } from '../../src/routes/inventory-attachments.js';
import { MAX_BYTES, sniffMime, supabaseStorage } from '../../src/inventory/attachments.js';
import { createUser } from '../support/pg.js';
import { branchLocation } from '../../src/stock/service.js';

const { eq, ok, refuses, count } = makeAsserts();
const r = await rig();
const { db, ids, contexts, helpers, branches } = r;
const biz = ids.businessId;
const clock = fakeClock('2026-11-18T09:00:00+03:00');
const storage = fakeStorage({ clock });
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// A second business with its own owner (isolation), a stranger.
const otherOwner = await createUser(db, 'other-owner@example.test', { role: 'owner' });
const otherRestaurant = await one(`insert into public.restaurants (owner_id, name, status) values ($1, 'Elsewhere', 'live') returning id, business_id`, [otherOwner]);
await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.business_id, otherOwner]);
await db.query(`insert into public.restaurant_members (restaurant_id, user_id, role) values ($1, $2, 'owner')`, [otherRestaurant.id, otherOwner]);
await db.query('update public.businesses set inventory_enabled = true where id = $1', [otherRestaurant.business_id]);
await db.transaction((t) => branchLocation(t, otherRestaurant.id));
const stranger = await createUser(db, 'stranger@example.test', { role: 'owner' });
const all = { ...contexts, stranger: helpers.ctx(stranger),
  otherOwner: helpers.ctx(otherOwner, { memberships: [[otherRestaurant.id, 'owner']], grants: [{ businessId: otherRestaurant.business_id, role: 'owner', branchIds: null }] }) };

const routes = createRoutes({
  authenticate: async (request) => {
    const who = request.headers.authorization?.replace(/^Bearer /, '');
    if (!all[who]) throw new HttpError(401, 'Please sign in to continue.');
    return all[who];
  },
  pool: () => db, storage, now: () => clock.now(),
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
const owner = `/api/owner/inventory/${biz}/attachments`;
const branchApi = '/api/inventory/attachments';
const deniedCount = async (who) => (await one(`select count(*)::int as n from public.inventory_events where action = 'denied' and actor_id = $1`, [who])).n;

// Bytes that really are each file type (headers are enough: that is all the sniffer reads).
const jpeg = (extra = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.from(extra.repeat(40))]);
const png = (extra = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(extra.repeat(40))]);
const webp = (extra = 'a') => Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(extra.repeat(40))]);
const pdf = (extra = 'a') => Buffer.from(`%PDF-1.7\n${extra.repeat(40)}\n%%EOF`);
const file = (bytes, type, name = 'invoice.jpg') => ({ name, type, base64: bytes.toString('base64') });

// Records to attach to.
const supplier = await makeSupplier(db, biz, 'Mama Njeri');
const insert = async (table, row) => {
  const keys = Object.keys(row);
  return (await db.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k]))).rows[0].id;
};
const b1 = branches.branch1.locationId;
const b2 = branches.branch2.locationId;
const warehouse = ids.centerLocationId;
let n = 0;
const makeGrn = (locationId) => insert('goods_receipts', { business_id: biz, number: `GRN-2026-${String(++n).padStart(4, '0')}`, location_id: locationId, supplier_id: supplier, po_id: null, unplanned_reason: 'walk-in' });
const grn1 = await makeGrn(b1);
const grn2 = await makeGrn(b2);
const grnW = await makeGrn(warehouse);
const po = await insert('purchase_orders', { business_id: biz, number: 'PO-2026-0001', supplier_id: supplier, deliver_to_location_id: warehouse });
const invoice = await insert('supplier_invoices', { business_id: biz, supplier_id: supplier, invoice_no: 'INV-1', invoice_date: '2026-11-18', amount: '100', vat: '0' });
const lonelyInvoice = await insert('supplier_invoices', { business_id: biz, supplier_id: supplier, invoice_no: 'INV-2', invoice_date: '2026-11-18', amount: '100', vat: '0' });
await db.query(`update public.goods_receipts set invoice_id = $1 where id = $2`, [invoice, grn1]);
const otherSupplier = await makeSupplier(db, otherRestaurant.business_id, 'Elsewhere supplier');
const otherLoc = (await one(`select id from public.stock_locations where business_id = $1 limit 1`, [otherRestaurant.business_id])).id;
const otherGrn = await insert('goods_receipts', { business_id: otherRestaurant.business_id, number: 'GRN-2026-0001', location_id: otherLoc, supplier_id: otherSupplier, po_id: null, unplanned_reason: 'x' });

// =============================================================================================================
// 0. Sniffing and declared limits
// =============================================================================================================
eq(sniffMime(jpeg()), 'image/jpeg', 'jpeg sniffed'); eq(sniffMime(png()), 'image/png', 'png sniffed'); eq(sniffMime(webp()), 'image/webp', 'webp sniffed'); eq(sniffMime(pdf()), 'application/pdf', 'pdf sniffed');
eq(sniffMime(Buffer.from('<html><script>alert(1)</script></html>')), null, 'html is not a file we accept');
eq(sniffMime(Buffer.from('GIF89a......')), null, 'gif is not');
eq(sniffMime(Buffer.from('RIFF....WAVEfmt ')), null, 'RIFF but not WEBP');
eq(sniffMime(Buffer.alloc(3)), null, 'too short');
eq(MAX_BYTES, 8 * 1024 * 1024, 'limit is 8 MB (D2-8)');
ok(BODY_LIMIT > Math.ceil(MAX_BYTES / 3) * 4, 'the route body limit fits an 8 MB file as base64');
ok(routes.filter((x) => x.method === 'POST').every((x) => x.bodyLimit === BODY_LIMIT), 'both upload routes raise the body limit');
ok(routes.filter((x) => x.method === 'GET').every((x) => x.bodyLimit === undefined), 'reads keep the default');

// =============================================================================================================
// 1. Owner uploads: path layout, row, sha256, fake storage received the bytes
// =============================================================================================================
const bytes1 = jpeg('x');
const up1 = await call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(bytes1, 'image/jpeg', '../../etc/passwd/goods.jpg') });
eq(up1.mime, 'image/jpeg', 'mime'); eq(up1.sizeBytes, bytes1.length, 'size');
eq(up1.sha256, createHash('sha256').update(bytes1).digest('hex'), 'sha256 of the bytes');
eq(up1.locationId, b1, 'the location comes from the receipt, not from the request');
eq(up1.name, 'goods.jpg', 'path pieces are stripped from the file name');
ok(!('storage_path' in up1) && !('storagePath' in up1), 'the storage path is never returned');
const row1 = await one('select * from public.attachments where id = $1', [up1.id]);
ok(new RegExp(`^${biz}/grn/[0-9a-f-]{36}\\.jpg$`).test(row1.storage_path), `path layout <business>/<entityType>/<uuid>.<ext> (${row1.storage_path})`);
eq([row1.storage_bucket, row1.mime, row1.uploaded_by, row1.deleted_at], ['inventory-evidence', 'image/jpeg', r.people.owner, null], 'row recorded');
eq(storage.objects.get(row1.storage_path).bytes.equals(bytes1), true, 'the fake storage received exactly the uploaded bytes');
eq(storage.objects.get(row1.storage_path).contentType, 'image/jpeg', 'with its content type');
eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'attachment' and action = 'upload' and entity_id = $1`, [up1.id])).n, 1, 'the upload is audited');

// Each type, each entity type
for (const [type, make, ext] of [['image/png', png, 'png'], ['image/webp', webp, 'webp'], ['application/pdf', pdf, 'pdf']]) {
  const out = await call('owner', 'POST', owner, { entityType: 'po', entityId: po, file: file(make(ext), type, `doc.${ext}`) });
  ok((await one('select storage_path from public.attachments where id = $1', [out.id])).storage_path.endsWith(`.${ext}`), `${type} stored as .${ext}`);
  eq(out.locationId, warehouse, 'a PO photo belongs to the delivery location');
}
const upInvoice = await call('owner', 'POST', owner, { entityType: 'invoice', entityId: invoice, file: file(pdf('i'), 'application/pdf', 'inv.pdf') });
eq(upInvoice.locationId, b1, 'an invoice follows its goods receipt location');
const upLonely = await call('owner', 'POST', owner, { entityType: 'invoice', entityId: lonelyInvoice, file: file(pdf('l'), 'application/pdf') });
eq(upLonely.locationId, null, 'an invoice with no receipt yet is owner-only');
const upEmergency = await call('owner', 'POST', owner, { entityType: 'emergency', entityId: '11111111-1111-4111-8111-111111111111', locationId: b2, file: file(jpeg('e'), 'image/jpeg') });
eq(upEmergency.locationId, b2, 'emergency evidence takes the named location');
await refuses(call('owner', 'POST', owner, { entityType: 'emergency', entityId: '11111111-1111-4111-8111-111111111111', file: file(jpeg('e2'), 'image/jpeg') }), 400, 'location_required', null, 'emergency without a place');
await refuses(call('owner', 'POST', owner, { entityType: 'emergency', entityId: '11111111-1111-4111-8111-111111111111', locationId: otherLoc, file: file(jpeg('e3'), 'image/jpeg') }), 400, 'location_required', null, 'a location of another business');

// Same file again for the same record: no second copy
const stored = storage.objects.size;
const again = await call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(bytes1, 'image/jpeg') });
eq([again.id, again.duplicate], [up1.id, true], 'the same file for the same record returns the existing attachment');
eq(storage.objects.size, stored, 'and stores nothing new');

// =============================================================================================================
// 2. Refusals: type, size, content, record
// =============================================================================================================
const stash = storage.objects.size;
const rows = async () => (await one('select count(*)::int as n from public.attachments')).n;
const rowsBefore = await rows();
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(Buffer.from('GIF89a.........'), 'image/gif') }), 400, 'bad_file_type', /photos/, 'gif');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(Buffer.from('<html>hi there</html>'), 'text/html') }), 400, 'bad_file_type', null, 'html');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(Buffer.from('<script>alert(1)</script>'), 'image/jpeg') }), 400, 'bad_file_type', /isn’t a photo or PDF/, 'html claiming to be a jpeg (magic bytes)');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(png('m'), 'image/jpeg') }), 400, 'file_type_mismatch', null, 'png claiming to be jpeg');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(pdf('m'), 'image/png') }), 400, 'file_type_mismatch', null, 'pdf claiming to be png');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(jpeg('z'), 'IMAGE/JPG') }), 400, 'bad_file_type', null, 'unknown type string');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: { name: 'x.jpg', type: 'image/jpeg', base64: '' } }), 400, 'file_required', null, 'empty file');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1 }), 400, 'file_required', null, 'no file at all');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: { name: 'x.jpg', type: 'image/jpeg', base64: '!!!not base64!!!' } }), 400, 'bad_file', null, 'garbage base64');
const big = Buffer.concat([jpeg('b'), Buffer.alloc(MAX_BYTES)]);
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(big, 'image/jpeg') }), 413, 'file_too_big', /8 MB/, 'over 8 MB');
const exact = Buffer.concat([jpeg('b'), Buffer.alloc(MAX_BYTES - jpeg('b').length)]);
eq(exact.length, MAX_BYTES, 'a file of exactly 8 MB');
const okBig = await call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(exact, 'image/jpeg', 'big.jpg') });
eq(okBig.sizeBytes, MAX_BYTES, 'exactly 8 MB is accepted');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: { name: 'x', type: 'image/jpeg', base64: 'A'.repeat(MAX_BYTES * 2) } }), 413, 'file_too_big', null, 'huge base64 refused before decoding');
await refuses(call('owner', 'POST', owner, { entityType: 'cheque', entityId: grn1, file: file(jpeg(), 'image/jpeg') }), 400, 'bad_entity_type', null, 'unknown record type');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: 'nope', file: file(jpeg(), 'image/jpeg') }), 400, 'bad_id', null, 'bad id');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: '22222222-2222-4222-8222-222222222222', file: file(jpeg('q'), 'image/jpeg') }), 404, 'entity_not_found', null, 'record does not exist');
await refuses(call('owner', 'POST', owner, { entityType: 'grn', entityId: otherGrn, file: file(jpeg('q'), 'image/jpeg') }), 404, 'entity_not_found', null, 'a receipt of another business');
eq(await rows(), rowsBefore + 1, 'refusals stored no rows (only the 8 MB file got in)'); eq(storage.objects.size, stash + 1, 'and no files');
// A database failure after the file was stored removes the file again.
const brokenDb = { query: (sql, p) => (/insert into public\.attachments/.test(sql) ? Promise.reject(new Error('boom')) : db.query(sql, p)) };
const { upload } = await import('../../src/inventory/attachments.js');
const { inventoryScope } = await import('../../src/inventory/permissions.js');
const ownerScope = await inventoryScope(db, all.owner, biz);
const filesBefore = storage.objects.size;
let boom = null; try { await upload(brokenDb, ownerScope, { entityType: 'grn', entityId: grn1, file: file(jpeg('rollback'), 'image/jpeg'), storage }); } catch (e) { boom = e; }
eq(boom?.message, 'boom', 'the insert failure surfaces'); eq(storage.objects.size, filesBefore, 'and the orphaned file was removed');

// =============================================================================================================
// 3. Who may upload
// =============================================================================================================
const branchUp = (as, body, branch) => call(as, 'POST', branchApi, body, '', branch);
const mgr1 = await branchUp('manager', { entityType: 'grn', entityId: grn1, file: file(jpeg('m1'), 'image/jpeg') }, ids.branchId);
eq(mgr1.locationId, b1, 'a branch manager attaches to their own branch\'s receipt');
const mgrInvoice = await branchUp('manager', { entityType: 'emergency', entityId: '33333333-3333-4333-8333-333333333333', locationId: warehouse, file: file(jpeg('m2'), 'image/jpeg') }, ids.branchId)
  .catch((e) => e);
eq([mgrInvoice.status, mgrInvoice.details?.code], [403, 'branch_forbidden'], 'a branch route refuses evidence for another place (even the warehouse)');
const d0 = await deniedCount(r.people.manager);
await refuses(branchUp('manager', { entityType: 'grn', entityId: grn2, file: file(jpeg('m3'), 'image/jpeg') }, ids.branchId), 403, 'branch_forbidden', null, 'branch 1 manager, branch 2 receipt (branch route)');
await refuses(branchUp('manager', { entityType: 'grn', entityId: grnW, file: file(jpeg('m4'), 'image/jpeg') }, ids.branchId), 403, 'branch_forbidden', null, 'branch 1 manager, warehouse receipt');
eq(await deniedCount(r.people.manager), d0 + 2, 'both refusals are audited');
await refuses(call('manager', 'POST', owner, { entityType: 'grn', entityId: grn2, file: file(jpeg('m5'), 'image/jpeg') }), 403, 'forbidden', null, 'branch 1 manager through the owner route, branch 2 receipt');
await refuses(call('manager', 'POST', owner, { entityType: 'po', entityId: po, file: file(jpeg('m6'), 'image/jpeg') }), 403, 'forbidden', null, 'a branch manager cannot attach to the warehouse PO');
await refuses(call('manager', 'POST', owner, { entityType: 'invoice', entityId: lonelyInvoice, file: file(jpeg('m7'), 'image/jpeg') }), 403, 'forbidden', null, 'owner-only evidence (no receipt)');
await refuses(call('ops', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(jpeg('o1'), 'image/jpeg') }), 403, 'forbidden', null, 'operations managers only read');
await refuses(call('waiter', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(jpeg('w1'), 'image/jpeg') }), 403, 'forbidden', null, 'waiter');
await refuses(call('stranger', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(jpeg('s1'), 'image/jpeg') }), 403, 'forbidden', null, 'a stranger with no role in the business');
await refuses(call('otherOwner', 'POST', owner, { entityType: 'grn', entityId: grn1, file: file(jpeg('x1'), 'image/jpeg') }), 403, 'forbidden', null, "another business's owner");
const mgr2 = await branchUp('manager2', { entityType: 'grn', entityId: grn2, file: file(jpeg('m8'), 'image/jpeg') }, branches.branch2.restaurantId);
eq(mgr2.locationId, b2, 'the branch 2 manager attaches to their own receipt');
await refuses(branchUp('manager', { entityType: 'grn', entityId: grn1, file: file(jpeg('m9'), 'image/jpeg') }, branches.branch2.restaurantId), 403, 'branch_forbidden', null, 'naming a branch you do not work at');
await refuses(branchUp('waiter', { entityType: 'grn', entityId: grn1, file: file(jpeg('w2'), 'image/jpeg') }, ids.branchId), 403, 'forbidden', null, 'a waiter on the branch route');

// =============================================================================================================
// 4. Signed URLs
// =============================================================================================================
const view = await call('owner', 'GET', `${owner}/${up1.id}/url`);
ok(view.url.startsWith('https://storage.test/inventory-evidence/'), 'a link into the private bucket');
eq(storage.verify(view.url), true, 'the link works now');
eq(Math.round((new Date(view.expiresAt) - clock.now()) / 1000), 300, 'it lasts 5 minutes');
ok(!/storage_path/.test(JSON.stringify(view)) && view.mime === 'image/jpeg', 'the response says what the file is, nothing more');
clock.advance(301_000);
eq(storage.verify(view.url), false, 'and has expired after 5 minutes');
const fresh = await call('owner', 'GET', `${owner}/${up1.id}/url`);
ok(fresh.url !== view.url || new Date(fresh.expiresAt) > new Date(view.expiresAt), 'a new request gets a fresh link (nothing is cached by the API)');
eq((await one(`select count(*)::int as n from public.inventory_events where entity = 'attachment' and action = 'view' and entity_id = $1`, [up1.id])).n, 2, 'each opening is audited');

const own = await call('manager', 'GET', `${branchApi}/${mgr1.id}/url`, undefined, '', ids.branchId);
eq(storage.verify(own.url), true, 'a branch manager opens their own branch\'s file');
await refuses(call('manager', 'GET', `${branchApi}/${mgr2.id}/url`, undefined, '', ids.branchId), 403, 'forbidden', null, 'branch 1 manager cannot open a branch 2 attachment (branch route)');
await refuses(call('manager', 'GET', `${owner}/${mgr2.id}/url`), 403, 'forbidden', null, '... nor through the owner route');
await refuses(call('manager', 'GET', `${owner}/${upLonely.id}/url`), 403, 'forbidden', null, 'owner-only evidence stays owner-only');
await refuses(call('manager', 'GET', `${owner}/${view.id}/url`).then(() => call('manager', 'GET', `${owner}/${upEmergency.id}/url`)), 403, 'forbidden', null, 'branch 2 emergency evidence');
await refuses(call('manager2', 'GET', `${branchApi}/${mgr1.id}/url`, undefined, '', branches.branch2.restaurantId), 403, 'forbidden', null, 'and the other way round');
const warehousePo = (await q(`select id from public.attachments where entity_type = 'po' limit 1`))[0].id;
await refuses(call('manager', 'GET', `${owner}/${warehousePo}/url`), 403, 'forbidden', null, 'a branch manager cannot open warehouse evidence');
await refuses(call('waiter', 'GET', `${owner}/${up1.id}/url`), 403, 'forbidden', null, 'a waiter cannot');
await refuses(call('manager', 'GET', `${branchApi}/${up1.id}/url`, undefined, '', ids.branchId).then(() => call('manager', 'GET', `${branchApi}/${warehousePo}/url`, undefined, '', ids.branchId)), 403, 'forbidden', null, 'branch route + warehouse file');
const opsView = await call('ops', 'GET', `${owner}/${up1.id}/url`);
eq(storage.verify(opsView.url), true, 'an operations manager opens evidence at their assigned branch');
await refuses(call('ops', 'GET', `${owner}/${upEmergency.id}/url`), 403, 'forbidden', null, 'but not at a branch they are not assigned to');
await refuses(call('ops', 'GET', `${owner}/${upLonely.id}/url`), 403, 'forbidden', null, 'nor owner-only evidence');
await refuses(call('otherOwner', 'GET', `${owner}/${up1.id}/url`), 403, 'forbidden', null, "another business's owner cannot use this business's URL");
await refuses(call('otherOwner', 'GET', `/api/owner/inventory/${otherRestaurant.business_id}/attachments/${up1.id}/url`), 404, 'attachment_not_found', null, '... nor ask their own business for it by id');
await refuses(call('owner', 'GET', `${owner}/44444444-4444-4444-8444-444444444444/url`), 404, 'attachment_not_found', null, 'unknown id');
ok((await deniedCount(r.people.manager)) > d0 + 2, 'refused openings are audited too');
// Soft-deleted evidence is gone from view
await db.query(`update public.attachments set deleted_at = now(), deleted_by = $2 where id = $1`, [mgr1.id, r.people.owner]);
await refuses(call('owner', 'GET', `${owner}/${mgr1.id}/url`), 404, 'attachment_not_found', null, 'hidden evidence cannot be opened');
// The storage failure is a plain 503
const failing = createRoutes({ authenticate: async () => all.owner, pool: () => db, storage: { createSignedUrl: async () => { throw new HttpError(503, 'Couldn’t open the file just now. Try again.', { code: 'storage_unavailable' }); } } });
await refuses(failing.find((x) => /url\$/.test(x.path.source) && x.method === 'GET').handler({ request: { headers: {} }, params: { businessId: biz, id: up1.id } }), 503, 'storage_unavailable', null, 'storage outage');

// =============================================================================================================
// 5. Lists
// =============================================================================================================
const listOwner = await call('owner', 'GET', owner, undefined, `?entityType=grn&entityId=${grn1}`);
eq(listOwner.map((a) => a.id).sort(), [up1.id, okBig.id].sort(), 'the owner lists the receipt\'s visible files (soft-deleted one is hidden)');
ok(listOwner.every((a) => !('storagePath' in a) && !('storage_path' in a)), 'no storage paths in lists');
eq((await call('manager', 'GET', branchApi, undefined, `?entityType=grn&entityId=${grn2}`, ids.branchId)), [], 'a branch manager lists nothing for another branch\'s record');
eq((await call('manager', 'GET', branchApi, undefined, `?entityType=grn&entityId=${grn1}`, ids.branchId)).length, 2, 'and their own branch\'s files');
eq((await call('manager', 'GET', owner, undefined, `?entityType=invoice&entityId=${lonelyInvoice}`)), [], 'owner-only evidence is not listed to a manager');
eq((await call('owner', 'GET', owner, undefined, `?entityType=invoice&entityId=${lonelyInvoice}`)).length, 1, 'but is to the owner');
await refuses(call('owner', 'GET', owner, undefined, '?entityType=grn'), 400, 'bad_id', null, 'list needs a record id');

// =============================================================================================================
// 6. The real-storage adapter speaks the same shape (against a stub Supabase client: still no network)
// =============================================================================================================
const calls = [];
const stub = { storage: { from: (bucket) => ({
  createSignedUploadUrl: async (path) => { calls.push(['createSignedUploadUrl', bucket, path]); return { data: { token: 'tok-1', path }, error: null }; },
  uploadToSignedUrl: async (path, token, bytes, opts) => { calls.push(['uploadToSignedUrl', path, token, bytes.length, opts.contentType]); return { data: {}, error: null }; },
  createSignedUrl: async (path, secs) => { calls.push(['createSignedUrl', path, secs]); return { data: { signedUrl: `https://x.supabase.co/sign/${path}?t=1` }, error: null }; },
  remove: async (paths) => { calls.push(['remove', ...paths]); return { data: [], error: null }; },
}) } };
const real = supabaseStorage(stub);
const slot = await real.createSignedUpload({ path: `${biz}/grn/a.jpg`, contentType: 'image/jpeg', size: 5 });
await real.put(slot.path, slot.token, Buffer.from('12345'));
const signed = await real.createSignedUrl(`${biz}/grn/a.jpg`, 300);
await real.remove(`${biz}/grn/a.jpg`);
eq(calls.map((c) => c[0]), ['createSignedUploadUrl', 'uploadToSignedUrl', 'createSignedUrl', 'remove'], 'the adapter uses the signed-upload API of the private bucket');
eq(calls[0][1], 'inventory-evidence', 'bucket name'); eq(calls[1].slice(3), [5, 'image/jpeg'], 'content type travels with the upload');
ok(signed.url.startsWith('https://x.supabase.co/sign/'), 'signed URL returned');

console.log(`Attachments: ${count()} checks passed (disposable PGlite database, fake storage).`);
await db.close();
