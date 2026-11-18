// Approvals API (P2-10 core, migration 017).
//   Owner side, base /api/owner/inventory/:businessId:
//     GET    /approvals                 the inbox (?status=pending|decided|approved|rejected|cancelled|all &subject=...): what the caller may decide
//     GET    /approvals/:id             one approval
//     POST   /approvals/:id/decide      { decision: 'approve'|'reject', note, commandId }   maker-checker applies (D2-5)
//     GET    /approval-rules            the owner's limits (inv.settings.edit)
//     PUT    /approval-rules            create or replace one rule { subject, locationId, categoryId, perTransactionKes, perDayKes, perWeekKes, variancePct, varianceKes, active }
//     DELETE /approval-rules/:ruleId
//   Branch side: GET /api/inventory/approvals  (X-Cravio-Branch names the branch) the caller's own requests and what became of them.
// Pattern for every write: requireUser -> inventoryScope (pool) -> authorize (pool, BEFORE the transaction so a refused attempt's 'denied' audit row
// isn't rolled back) -> one transaction -> once(commandId) -> service (which audits). createRoutes() takes its dependencies so tests run the real handlers.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withDb } from '../lib/db.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { requestedBranch, selectMembership, STAFF_ROLES } from '../lib/access.js';
import { once } from '../inventory/commands.js';
import { authorize, denyAndAudit, inventoryScope } from '../inventory/permissions.js';
import { decide, deleteRule, getApproval, history, inbox, listRules, mine, setRule } from '../inventory/approvals.js';

const ID = '[0-9a-fA-F-]{36}';
const base = `/api/owner/inventory/(?<businessId>${ID})`;
const path = (suffix = '') => new RegExp(`^${base}${suffix}$`);

const MISSING_SCHEMA = new HttpError(503, 'Approvals need database updates 012 and 017, which haven’t been applied yet.', { code: 'inventory_schema_missing' });
const MISSING_CODES = ['42P01', '42703', '42883'];
const NO_BRANCH = () => new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });

export function createRoutes({ authenticate = requireUser, pool = () => database(), transact = (fn) => withDb(fn, { transaction: true, feature: 'stock' }) } = {}) {
  const safely = async (fn) => {
    try { return await fn(); } catch (error) {
      if (MISSING_CODES.includes(error?.code)) throw MISSING_SCHEMA;
      throw error;
    }
  };

  async function open(request, params) {
    const context = await authenticate(request);
    const db = pool();
    const scope = await safely(() => inventoryScope(db, context, String(params.businessId).toLowerCase()));
    return { db, scope };
  }
  /** Owners and operations managers use the owner screens; a branch manager holds inv.view but isn't an approver (they use the branch route). */
  async function oversight(db, scope, entity) {
    await safely(() => authorize(db, scope, 'inv.view', { entity }));
    if (!scope.roles.includes('owner') && !scope.roles.includes('operations')) throw await denyAndAudit(db, scope, 'inv.view', { entity });
  }
  const read = (fn) => async ({ request, params, url }) => {
    const { db, scope } = await open(request, params);
    await oversight(db, scope, 'approval');
    return safely(() => fn(db, scope, params, url?.searchParams || new URLSearchParams()));
  };
  const settings = (kind, run) => withBody(async ({ request, params, body }) => {
    const { db, scope } = await open(request, params);
    await safely(() => authorize(db, scope, 'inv.settings.edit', { entity: kind }));
    return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind }, () => run(tx, scope, params, body))));
  });

  return [
    // ----- Owner / operations: inbox and decisions -----
    { method: 'GET', path: path('/approvals'), handler: read((db, scope, _p, q) => inbox(db, scope,
      { status: q.get('status') || undefined, subject: q.get('subject') || undefined, limit: q.get('limit') || undefined })) },
    { method: 'GET', path: path(`/approvals/(?<id>${ID})`), handler: read(async (db, scope, params) => {
      const approval = await getApproval(db, scope.businessId, params.id);
      await authorize(db, scope, approval.approverCapability, { locationId: approval.locationId, entity: 'approval' });
      return { approval, history: (await history(db, scope, { subject: approval.subject, subjectId: approval.subjectId })).approvals };
    }) },
    { method: 'POST', path: path(`/approvals/(?<id>${ID})/decide`), handler: withBody(async ({ request, params, body }) => {
      const { db, scope } = await open(request, params);
      await oversight(db, scope, 'approval');
      // The capability needed depends on the approval, so look it up first and authorize (auditing a refusal) before the write transaction.
      const approval = await safely(() => getApproval(db, scope.businessId, params.id));
      await safely(() => authorize(db, scope, approval.approverCapability, { locationId: approval.locationId, entity: 'approval', entityId: approval.id }));
      return safely(() => transact((tx) => once(tx, { commandId: body.commandId, businessId: scope.businessId, actorId: scope.userId, kind: 'approval_decide' },
        () => decide(tx, scope, params.id, { decision: body.decision, note: body.note }))));
    }) },

    // ----- Owner: the limits -----
    { method: 'GET', path: path('/approval-rules'), handler: async ({ request, params, url }) => {
      const { db, scope } = await open(request, params);
      await safely(() => authorize(db, scope, 'inv.settings.edit', { entity: 'approval_rule' }));
      return safely(() => listRules(db, scope, { subject: url?.searchParams?.get('subject') || undefined }));
    } },
    { method: 'PUT', path: path('/approval-rules'), handler: settings('approval_rule_set', (db, scope, _p, body) => { const { commandId, ...rule } = body; return setRule(db, scope, rule); }) },
    { method: 'DELETE', path: path(`/approval-rules/(?<ruleId>${ID})`), handler: settings('approval_rule_delete', (db, scope, params) => deleteRule(db, scope, params.ruleId)) },

    // ----- Branch manager: my own requests -----
    { method: 'GET', path: /^\/api\/inventory\/approvals$/, handler: async ({ request, url }) => {
      const context = await authenticate(request);
      const db = pool();
      let restaurantId = requestedBranch(request);
      if (!restaurantId) {
        const membership = selectMembership(context.memberships, null, STAFF_ROLES);
        if (!membership) throw new HttpError(409, 'Choose which branch you are working in. Send the X-Cravio-Branch header.', { code: 'branch_required' });
        restaurantId = String(membership.restaurant.id).toLowerCase();
      }
      const row = (await db.query('select business_id from public.restaurants where id = $1', [restaurantId])).rows[0];
      if (!row) throw NO_BRANCH();
      const scope = await safely(() => inventoryScope(db, context, row.business_id));
      const location = scope.locations.find((l) => l.kind === 'branch' && l.restaurantId === restaurantId) || null;
      await safely(() => authorize(db, scope, 'inv.view', { locationId: location?.id || null, entity: 'approval' }));
      if (!location) throw NO_BRANCH();
      const q = url?.searchParams || new URLSearchParams();
      return safely(() => mine(db, scope, { status: q.get('status') || undefined, subject: q.get('subject') || undefined, limit: q.get('limit') || undefined, locationId: location.id }));
    } },
  ];
}

export const routes = createRoutes();
