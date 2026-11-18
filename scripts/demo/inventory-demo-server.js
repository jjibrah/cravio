// LOCAL DEMO API for the new inventory screens. Nothing here touches the shared database or Supabase.
//
//   * An in-memory PGlite database with every committed migration plus every proposed inventory migration (012..020).
//   * The golden dataset (Golden Eats: Westlands, Karen, Warehouse; a week of orders, receipts, transfers, wastage, counts).
//   * Extra demo rows made through the REAL route handlers so every screen has something to show.
//   * The REAL route modules (createRoutes) on 127.0.0.1:5189, with a fake `authenticate` that maps a demo token to a context built from the DB.
//
// Run on its own:   node scripts/demo/inventory-demo-server.js     (normally started by inventory-demo-browser.js)
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadGolden } from '../../backend/tests/inv/golden.js';
import { fakeStorage } from '../../backend/tests/inv/helpers.js';
import { HttpError, readJson, sendJson } from '../../backend/src/lib/http.js';
import { MANAGER_ROLES, branchRole, homePath, requestedBranch, selectMembership } from '../../backend/src/lib/access.js';
import { placeFor } from '../../backend/src/lib/restaurants.js';
import { createRoutes as inventoryOwner } from '../../backend/src/routes/inventory-owner.js';
import { createRoutes as inventoryRecipes } from '../../backend/src/routes/inventory-recipes.js';
import { createRoutes as inventoryBranch } from '../../backend/src/routes/inventory-branch.js';
import { createRoutes as notifications } from '../../backend/src/routes/notifications.js';
import { createRoutes as inventorySuppliers } from '../../backend/src/routes/inventory-suppliers.js';
import { createRoutes as ai } from '../../backend/src/routes/ai.js';
import { createRoutes as inventoryAttachments } from '../../backend/src/routes/inventory-attachments.js';
import { createRoutes as inventoryPurchasing } from '../../backend/src/routes/inventory-purchasing.js';
import { createRoutes as inventoryApprovals } from '../../backend/src/routes/inventory-approvals.js';
import { createRoutes as inventoryEmergency } from '../../backend/src/routes/inventory-emergency.js';
import { createRoutes as inventoryWastage } from '../../backend/src/routes/inventory-wastage.js';
import { createRoutes as inventoryDistribution } from '../../backend/src/routes/inventory-distribution.js';
import { createRoutes as inventoryAdjustments } from '../../backend/src/routes/inventory-adjustments.js';
import { createRoutes as inventoryCounts } from '../../backend/src/routes/inventory-counts.js';

export const DEMO_PORT = Number(process.env.DEMO_API_PORT || 5189);
export const TOKENS = Object.freeze({ owner: 'demo-owner', owner2: 'demo-owner-2', westlands: 'demo-manager-westlands', karen: 'demo-manager-karen' });

const log = (...a) => { if (process.env.DEMO_QUIET !== '1') console.log(...a); };

/** Builds the database, seeds it and returns { db, routes, info, close }. Does not listen. */
export async function buildDemo() {
  log('Building the in-memory database (all migrations + golden dataset)...');
  const g = await loadGolden();
  const { db, ids, users, restaurantIds, itemIds, locIds, helpers } = g;
  const biz = ids.businessId;
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0];

  // ---- people --------------------------------------------------------------------------------------------------------------------
  const owner2 = await helpers.addOwner('amina.owner@demo.test');
  const who = { owner: users.owner, owner2, westlands: users.manager, karen: g.branchB.managerId };
  const names = { owner: 'Wanjiru Kamau (Owner)', owner2: 'Amina Hassan (Co-owner)', westlands: 'Brian Otieno (Westlands manager)', karen: 'Grace Njeri (Karen manager)' };
  const emails = { owner: 'owner@demo.test', owner2: 'amina.owner@demo.test', westlands: 'brian.westlands@demo.test', karen: 'grace.karen@demo.test' };
  for (const key of Object.keys(who)) {
    await db.query('update auth.users set email = $2 where id = $1', [who[key], emails[key]]);
    await db.query('update public.profiles set name = $2 where id = $1', [who[key], names[key]]);
  }
  await db.query('update public.businesses set name = $2 where id = $1', [biz, 'Golden Eats (demo)']).catch(() => {});
  // The Warehouse and branches are already live; the AI allowance so recipe suggestions work (numbers only, the model call is canned).
  await db.query(`insert into public.ai_business_settings (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [biz]);
  await db.query(`insert into public.ai_limits (business_id, monthly_budget_kes, warn_pct) values ($1, 500, 80) on conflict (business_id) do update set monthly_budget_kes = 500`, [biz]);

  // ---- authentication: a demo token -> the context lib/auth.js requireUser() would build -------------------------------------------
  const tokenToUser = Object.fromEntries(Object.entries(TOKENS).map(([key, token]) => [token, who[key]]));
  async function contextFor(userId) {
    const profile = await one('select name, role from public.profiles where id = $1', [userId]);
    const email = (await one('select email from auth.users where id = $1', [userId])).email;
    const memberships = (await q(`select m.role, m.created_at, to_jsonb(r) as restaurant from public.restaurant_members m join public.restaurants r on r.id = m.restaurant_id where m.user_id = $1`, [userId]));
    const grants = (await q(`select b.business_id, b.role, bs.name from public.business_members b join public.businesses bs on bs.id = b.business_id where b.user_id = $1`, [userId]))
      .map((row) => ({ businessId: row.business_id, name: row.name, role: row.role, branchIds: row.role === 'owner' ? null : [] }));
    return { user: { id: userId, email, user_metadata: {}, app_metadata: {} }, profile, memberships, grants };
  }
  const authenticate = async (request) => {
    const match = request.headers.authorization?.match(/^Bearer (\S+)$/i);
    if (!match) throw new HttpError(401, 'Please sign in to continue.');
    const userId = tokenToUser[match[1]];
    if (!userId) throw new HttpError(401, 'Your session expired. Please sign in again.');
    return contextFor(userId);
  };

  // ---- the real route modules ------------------------------------------------------------------------------------------------------
  const storage = fakeStorage();
  // A canned stand-in for the AI provider: metered through the real gateway, but no network.
  const aiEnv = { OPENROUTER_API_KEY: 'demo-key', OPENROUTER_MODEL: 'demo/model', AI_PRICE_TABLE: '{"demo/model":{"in":1,"out":1}}', AI_USD_TO_KES: '130' };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'demo-gen', model: 'demo/model',
    choices: [{ message: { content: JSON.stringify({ lines: [{ name: 'Beef mince', quantity: 150, unit: 'g' }, { name: 'Burger bun', quantity: 1, unit: 'piece' }, { name: 'Cheese', quantity: 20, unit: 'g' }, { name: 'Lettuce', quantity: 15, unit: 'g' }], note: 'Demo suggestion (canned answer, no real AI was called).' }) } }],
    usage: { prompt_tokens: 600, completion_tokens: 150 } }) });
  const common = { authenticate, pool: () => db, transact: (fn) => db.transaction(fn) };
  const routes = [
    ...inventoryOwner(common), ...inventoryRecipes({ ...common, ai: { env: aiEnv, fetchImpl } }), ...inventoryBranch(common),
    ...notifications({ authenticate, pool: common.pool }), ...inventorySuppliers(common), ...ai({ ...common, authenticateAdmin: authenticate }),
    ...inventoryAttachments({ authenticate, pool: common.pool, storage }), ...inventoryPurchasing(common), ...inventoryApprovals(common),
    ...inventoryEmergency({ ...common, storage }), ...inventoryWastage({ ...common, storage }), ...inventoryDistribution(common),
    ...inventoryAdjustments({ ...common, storage }), ...inventoryCounts(common),
  ];

  // /api/me for the demo accounts (the real handler needs Supabase to resolve the token).
  routes.unshift({ method: 'GET', path: '/api/me', async handler({ request }) {
    const { user, profile, memberships, grants } = await authenticate(request);
    const rows = memberships.filter((row) => row.restaurant);
    let restaurant = null;
    try { restaurant = selectMembership(rows, requestedBranch(request))?.restaurant || null; } catch (error) { if (!(error instanceof HttpError)) throw error; }
    const branches = rows.map((row) => ({ ...placeFor(row.restaurant), businessId: row.restaurant.business_id, role: branchRole(row.role), membershipRole: row.role })).sort((a, b) => a.name.localeCompare(b.name));
    const businesses = grants.map((grant) => ({ id: grant.businessId, name: grant.name, role: grant.role, branchIds: grant.branchIds }));
    return { id: user.id, email: user.email, name: profile.name, role: profile.role, place: placeFor(restaurant), onboardingRequired: false, branches, businesses,
      businessAccessAvailable: true, terms: null, home: homePath({ profileRole: profile.role, memberships: rows, grants, onboardingRequired: false }) };
  } });

  // ---- seed through the real handlers ---------------------------------------------------------------------------------------------
  const call = async (token, method, pathname, body, { branch = null, query = '' } = {}) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = typeof route.path === 'string' ? (route.path === pathname ? { groups: {} } : null) : route.path.exec(pathname);
      if (!m) continue;
      const headers = { authorization: `Bearer ${token}` };
      if (branch) headers['x-cravio-branch'] = branch;
      return route.handler({ request: { headers }, params: { ...(m.groups || {}) }, body: method === 'GET' ? undefined : (body ?? {}), url: new URL(`http://x${pathname}${query}`) });
    }
    throw new Error(`No route for ${method} ${pathname}`);
  };
  const uuid = () => crypto.randomUUID();
  const own = (who_, method, suffix, body, opt) => call(TOKENS[who_], method, `/api/owner/inventory/${biz}${suffix}`, body, opt);
  const mgr = (who_, method, suffix, body, opt) => call(TOKENS[who_], method, `/api/inventory${suffix}`, body, { ...opt, branch: restaurantIds[who_ === 'westlands' ? 'A' : 'B'] });
  const seeded = [];
  const step = async (label, fn) => { try { const r = await fn(); seeded.push(`ok    ${label}`); return r; } catch (e) { seeded.push(`SKIP  ${label}: ${e.message}`); return null; } };

  // Supplier price lists (per kg / per litre / per piece).
  const suppliers = {};
  for (const [key, name, phone] of [['farm', 'Farm Fresh Ltd', '254712345678'], ['butcher', 'Nairobi Prime Butchery', '254722000111'], ['grocer', 'Green Grocers Wholesale', '254733000222']]) {
    suppliers[key] = (await one(`insert into public.suppliers (business_id, name, phone) values ($1, $2, $3) returning id`, [biz, name, phone])).id;
  }
  const price = (supplier, itemKey, unit, factor, p) => db.query(`insert into public.supplier_prices (business_id, supplier_id, item_id, unit, unit_factor, price, price_per_base, effective_from)
    values ($1, $2, $3, $4, $5, $6, $7, '2026-01-01')`, [biz, supplier, itemIds[itemKey], unit, factor, p, (p / factor).toFixed(6)]);
  await price(suppliers.butcher, 'chicken', 'kg', 1000, 420); await price(suppliers.butcher, 'mince', 'kg', 1000, 650);
  await price(suppliers.farm, 'potato', 'kg', 1000, 90); await price(suppliers.farm, 'tomato', 'kg', 1000, 110); await price(suppliers.farm, 'lettuce', 'kg', 1000, 160);
  await price(suppliers.grocer, 'rice', 'kg', 1000, 160); await price(suppliers.grocer, 'oil', 'l', 1000, 320); await price(suppliers.grocer, 'cheese', 'kg', 1000, 850);
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // Purchase orders: one waiting for the owner (made by the co-owner), one approved and sent to Westlands (an expected delivery), one draft.
  await step('PO waiting for the owner to approve (Amina -> Wanjiru)', async () => {
    const made = await own('owner2', 'POST', '/purchase-orders', { supplierId: suppliers.butcher, notes: 'Weekend stock-up', expectedDate: days(3), lines: [{ itemId: itemIds.chicken, qty: 40, unit: 'kg' }, { itemId: itemIds.mince, qty: 25, unit: 'kg' }] });
    await own('owner2', 'POST', `/purchase-orders/${made.order.id}/submit`, {});
  });
  await step('PO approved and sent, due at Westlands (expected delivery)', async () => {
    const made = await own('owner', 'POST', '/purchase-orders', { supplierId: suppliers.farm, deliverToLocationId: locIds.A, notes: 'Deliver before 10am', expectedDate: days(1), lines: [{ itemId: itemIds.potato, qty: 60, unit: 'kg' }, { itemId: itemIds.tomato, qty: 20, unit: 'kg' }] });
    const sub = await own('owner', 'POST', `/purchase-orders/${made.order.id}/submit`, {});
    if (sub.order.status === 'pending_approval') await own('owner2', 'POST', `/purchase-orders/${made.order.id}/approve`, { note: 'Fine' });
    await own('owner', 'POST', `/purchase-orders/${made.order.id}/send`, { via: 'whatsapp' });
  });
  await step('PO draft (Green Grocers)', () => own('owner', 'POST', '/purchase-orders', { supplierId: suppliers.grocer, expectedDate: days(5), lines: [{ itemId: itemIds.rice, qty: 100, unit: 'kg' }, { itemId: itemIds.oil, qty: 40, unit: 'l' }] }));

  // Distribution: Westlands asks for stock (waits for the owner); Karen's request is approved and dispatched (in transit, code to scan).
  await step('Westlands stock request (open, waiting for the owner)', () => mgr('westlands', 'POST', '/requests', { lines: [{ itemId: itemIds.mince, quantity: 10, unit: 'kg' }, { itemId: itemIds.cheese, quantity: 4, unit: 'kg' }], note: 'Weekend rush', priority: 'urgent', neededBy: days(2), commandId: uuid() }));
  await step('Karen stock request approved and dispatched (in transit)', async () => {
    const made = await mgr('karen', 'POST', '/requests', { lines: [{ itemId: itemIds.rice, quantity: 10, unit: 'kg' }, { itemId: itemIds.oil, quantity: 5, unit: 'l' }], note: 'Running low', commandId: uuid() });
    const id = made.request.id;
    await own('owner', 'POST', `/requests/${id}/review`, { decision: 'approve', note: 'Go ahead', commandId: uuid() });
    await own('owner', 'POST', `/requests/${id}/prepare`, {});
    return own('owner', 'POST', `/requests/${id}/dispatch`, { driver: 'Joseph', vehicle: 'KDG 123A', commandId: uuid() });
  });
  await step('A delivery to Westlands received short (a discrepancy to resolve)', async () => {
    const made = await mgr('westlands', 'POST', '/requests', { lines: [{ itemId: itemIds.bun, quantity: 100, unit: 'piece' }], commandId: uuid() });
    const id = made.request.id;
    await own('owner', 'POST', `/requests/${id}/review`, { decision: 'approve', commandId: uuid() });
    await own('owner', 'POST', `/requests/${id}/prepare`, {});
    const sent = await own('owner', 'POST', `/requests/${id}/dispatch`, { driver: 'Peter', vehicle: 'KCB 456B', commandId: uuid() });
    await mgr('westlands', 'POST', `/transfers/${sent.transfer.id}/receive`, { lines: [{ itemId: itemIds.bun, received: 92, unit: 'piece' }], note: '8 buns crushed in the box', commandId: uuid() });
  });

  // An emergency purchase by Karen (above the default: the owner approves every buy).
  await step('Emergency purchase by Karen (waiting for the owner)', async () => {
    const made = await mgr('karen', 'POST', '/emergency', { reason: 'Chicken ran out during lunch service, 30 covers booked', supplierId: suppliers.butcher, lines: [{ itemId: itemIds.chicken, qty: 8, price: 430, unit: 'kg' }], commandId: uuid() });
    await mgr('karen', 'POST', `/emergency/${made.purchase?.id || made.id}/submit`, {});
  });

  // Wastage by Westlands (the manager records; large amounts wait for approval according to the rules).
  await step('Wastage recorded at Westlands', async () => {
    const reasons = (await mgr('westlands', 'GET', '/reason-codes')).reasons;
    const spoiled = reasons.find((r) => r.code === 'spoiled') || reasons[0];
    return mgr('westlands', 'POST', '/wastage', { itemId: itemIds.tomato, quantity: 200, unit: 'g', reasonCodeId: spoiled.id, note: 'Found soft at opening', commandId: uuid() });
  });

  const info = {
    business: { id: biz, name: 'Golden Eats (demo)' },
    branches: { westlands: { id: restaurantIds.A, name: 'Westlands', locationId: locIds.A }, karen: { id: restaurantIds.B, name: 'Karen', locationId: locIds.B }, warehouse: { locationId: locIds.W } },
    people: Object.fromEntries(Object.keys(who).map((k) => [k, { token: TOKENS[k], userId: who[k], name: names[k], email: emails[k] }])),
    seeded,
  };
  return { db, routes, info, authenticate, call, close: () => db.close() };
}

/** Plain HTTP front for the routes: same dispatch as backend/src/server.js, plus /demo/info and a stand-in for Supabase auth. */
export async function startDemoServer({ port = DEMO_PORT } = {}) {
  const demo = await buildDemo();
  const { routes, info } = demo;
  const findRoute = (method, pathname) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      if (typeof route.path === 'string' && route.path === pathname) return { route, params: {} };
      if (route.path instanceof RegExp) { const m = pathname.match(route.path); if (m) return { route, params: m.groups || {} }; }
    }
    return null;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Cravio-Visitor, X-Cravio-Branch, If-None-Match, apikey, x-client-info');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'ETag');
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'OPTIONS') { await sendJson(response, 204); return; }
      if (url.pathname === '/health') { await sendJson(response, 200, { status: 'ok', demo: true }); return; }
      if (url.pathname === '/demo/info') { await sendJson(response, 200, info); return; }
      if (url.pathname.startsWith('/auth/v1/')) {   // supabase-js never reaches the real Supabase in demo mode
        await sendJson(response, 200, { id: 'demo', aud: 'authenticated', role: 'authenticated', email: 'demo@demo.test' }); return;
      }
      const found = findRoute(request.method, url.pathname);
      if (!found) {
        await sendJson(response, 404, { error: `Not available in demo mode: ${request.method} ${url.pathname}. Only the inventory screens run in this demo.` });
        return;
      }
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) ? await readJson(request, found.route.bodyLimit) : undefined;
      const result = await found.route.handler({ request, response, url, params: found.params, body });
      if (!response.writableEnded && !response.headersSent) {
        await sendJson(response, response.statusCode !== 200 ? response.statusCode : result === undefined ? 204 : 200, result, request);
      }
      if (process.env.DEMO_LOG_REQUESTS === '1') console.log(`[demo-api] ${request.method} ${url.pathname} ${response.statusCode}`);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof HttpError) { await sendJson(response, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) }, request); return; }
      console.error(`[demo-api] ${request.method} ${url.pathname} failed:`, error.message);
      await sendJson(response, 503, { error: 'Something went wrong. Please try again.' }, request);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const close = async () => { await new Promise((r) => server.close(r)); await demo.close().catch(() => {}); };
  return { ...demo, server, port, close };
}

export function banner(info, port = DEMO_PORT) {
  const lines = ['', '==================== CRAVIO INVENTORY DEMO API ====================',
    `API:        http://127.0.0.1:${port}   (in-memory database, no Supabase, no shared DB)`,
    `Business:   ${info.business.name}  ${info.business.id}`,
    `Branches:   Westlands ${info.branches.westlands.id}  |  Karen ${info.branches.karen.id}  |  Warehouse`,
    'Logins (bearer tokens):',
    ...Object.values(info.people).map((p) => `  ${p.token.padEnd(24)} ${p.name}`),
    'Demo data:', ...info.seeded.map((s) => `  ${s}`),
    '===================================================================', ''];
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const demo = await startDemoServer();
  console.log(banner(demo.info, demo.port));
  const stop = async () => { await demo.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
