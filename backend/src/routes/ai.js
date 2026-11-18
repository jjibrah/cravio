// AI allowance and usage API (P2-32; the screens are P2-34/35). Numbers only: no prompt or answer text is stored anywhere.
//   Platform admin   GET/PUT /api/admin/businesses/:id/ai              switches, monthly allowance (KES), usage this month + last 6 months
//   Business owner   GET     /api/owner/inventory/:biz/ai-usage        usage this month, effective limit, warning, 6-month history
//                    PUT     /api/owner/inventory/:biz/ai-limit        lower the owner cap (never above the admin allowance) / switch features off
// Owner side follows the inventory pattern: requireUser -> inventoryScope -> authorize (BEFORE the transaction so a denial is audited)
// -> one transaction -> once(commandId). Needs 'inv.settings.edit' (business owner only: branch managers and operations get 403).
// createRoutes() takes its dependencies so tests can run the real handlers against an in-memory database.
import { requireRole, requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { once } from '../inventory/commands.js';
import { authorize, inventoryScope } from '../inventory/permissions.js';
import { adminSet, adminView, ownerSet, ownerView } from '../ai/limits.js';

const ID = '[0-9a-fA-F-]{36}';
const MISSING_014 = new HttpError(503, 'AI usage needs database update 014, which hasn’t been applied yet.', { code: 'ai_schema_missing' });

export function createRoutes({
  authenticateAdmin = (request) => requireRole(request, 'admin'), authenticate = requireUser, pool = () => database(),
  transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }), now = () => new Date(),
} = {}) {
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (['42P01', '42703'].includes(error?.code) && /ai_/.test(String(error.message))) throw MISSING_014;
      throw error;
    }
  };

  const ownerScope = async (request, params) => {
    const context = await authenticate(request);
    const db = pool();
    const scope = await inventoryScope(db, context, String(params.businessId).toLowerCase());
    await authorize(db, scope, 'inv.settings.edit', { entity: 'ai_settings' });
    return { db, scope };
  };

  return [
    { method: 'GET', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/ai$`), async handler({ request, params }) {
      await authenticateAdmin(request);
      return safely(() => adminView(pool(), params.id.toLowerCase(), { now: now() }));
    } },
    { method: 'PUT', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/ai$`), handler: withBody(async ({ request, params, body }) => {
      const context = await authenticateAdmin(request);
      return safely(() => transact((tx) => adminSet(tx, context, params.id.toLowerCase(), body)));
    }) },
    { method: 'GET', path: new RegExp(`^/api/owner/inventory/(?<businessId>${ID})/ai-usage$`), async handler({ request, params }) {
      const { db, scope } = await ownerScope(request, params);
      return safely(() => ownerView(db, scope.businessId, { now: now() }));
    } },
    { method: 'PUT', path: new RegExp(`^/api/owner/inventory/(?<businessId>${ID})/ai-limit$`), handler: withBody(async ({ request, params, body }) => {
      const { scope } = await ownerScope(request, params);
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind: 'ai_limit' },
        () => ownerSet(tx, scope, scope.businessId, body))));
    }) },
  ];
}

export const routes = createRoutes();
