// Evidence attachments API (P2-06, migration 016).
//   Owner side, /api/owner/inventory/:businessId/attachments: upload (POST), list a record's files (GET ?entityType=&entityId=), get a 5-minute
//   link to open one (GET /:id/url).
//   Branch side, /api/inventory/attachments (X-Cravio-Branch names the branch): the same three, limited to records of that branch's own location.
// Who may do what is decided by inventory/attachments.js from the RECORD's location (never from anything the browser claims).
// Upload body: JSON { entityType, entityId, locationId?, file: { name, type, base64 } }. A photo is downscaled in the browser first (about 1600 px,
// a few hundred KB); the largest file is 8 MB, which is about 10.7 MB of base64, so these routes declare a 12 MB body limit (server.js reads
// route.bodyLimit; every other route keeps the 1 MB default).
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database and a fake storage.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { database } from '../lib/pool.js';
import { withBody } from '../lib/operations.js';
import { requestedBranch, selectMembership, STAFF_ROLES, businessOfBranch } from '../lib/access.js';
import { inventoryScope } from '../inventory/permissions.js';
import { list, signedUrl, supabaseStorage, upload } from '../inventory/attachments.js';

const ID = '[0-9a-fA-F-]{36}';
export const BODY_LIMIT = 12_000_000;

const MISSING_SCHEMA = new HttpError(503, 'Attachments need database updates 012 to 016, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });

let realStorage = null;
const defaultStorage = () => (realStorage ||= supabaseStorage());

export function createRoutes({ authenticate = requireUser, pool = () => database(), storage = defaultStorage, now = () => new Date() } = {}) {
  void now;
  const store = () => (typeof storage === 'function' ? storage() : storage);
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };

  async function openOwner(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    return { db, scope, restrictToLocationId: null };
  }

  async function openBranch(request) {
    const context = await authenticate(request);
    const db = pool();
    let restaurantId = requestedBranch(request);
    if (!restaurantId) {
      const membership = selectMembership(context.memberships, null, STAFF_ROLES);
      if (!membership) throw new HttpError(409, 'Choose which branch you are working in. Send the X-Cravio-Branch header.', { code: 'branch_required' });
      restaurantId = String(membership.restaurant.id).toLowerCase();
    }
    const row = await businessOfBranch(db, context, restaurantId);
    if (!row) throw NO_BRANCH();
    const scope = await safely(() => inventoryScope(db, context, row.business_id));
    const location = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId);
    // Only people who work at this branch (or oversee it) may act through it.
    if (!location || !(scope.locationCaps.get(location.id)?.size)) throw NO_BRANCH();
    return { db, scope, restrictToLocationId: location.id };
  }

  const uploadHandler = (open) => withBody(async ({ request, params, body }) => {
    const { db, scope, restrictToLocationId } = await open(request, params);
    return safely(() => upload(db, scope, { entityType: body.entityType, entityId: body.entityId, locationId: body.locationId, file: body.file, storage: store(), restrictToLocationId }));
  });
  const listHandler = (open) => async ({ request, params, url }) => {
    const { db, scope, restrictToLocationId } = await open(request, params);
    const q = url?.searchParams || new URLSearchParams();
    return safely(() => list(db, scope, { entityType: q.get('entityType'), entityId: q.get('entityId'), restrictToLocationId }));
  };
  const urlHandler = (open) => async ({ request, params }) => {
    const { db, scope, restrictToLocationId } = await open(request, params);
    return safely(() => signedUrl(db, scope, params.id, { storage: store(), restrictToLocationId }));
  };

  const owner = new RegExp(`^/api/owner/inventory/(?<businessId>${ID})/attachments`);
  const ownerPath = (suffix = '') => new RegExp(`${owner.source}${suffix}$`);
  return [
    { method: 'POST', path: ownerPath(), bodyLimit: BODY_LIMIT, handler: uploadHandler(openOwner) },
    { method: 'GET', path: ownerPath(), handler: listHandler(openOwner) },
    { method: 'GET', path: ownerPath(`/(?<id>${ID})/url`), handler: urlHandler(openOwner) },
    { method: 'POST', path: /^\/api\/inventory\/attachments$/, bodyLimit: BODY_LIMIT, handler: uploadHandler((request) => openBranch(request)) },
    { method: 'GET', path: /^\/api\/inventory\/attachments$/, handler: listHandler((request) => openBranch(request)) },
    { method: 'GET', path: new RegExp(`^/api/inventory/attachments/(?<id>${ID})/url$`), handler: urlHandler((request) => openBranch(request)) },
  ];
}

export const routes = createRoutes();
