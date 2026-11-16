// Owner / operations-manager interface API (/api/owner/*). Needs migration 008; before it, every route
// answers 503 with code business_schema_missing. Authorization happens in lib/business.js (SQL checks of the
// caller's business grant) for every read and write; the caller's id always comes from the verified token.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateUser } from '../lib/cache.js';
import { email as cleanEmail } from '../lib/restaurants.js';
import { serviceClient } from '../lib/supabase.js';
import { welcomeUrl } from '../lib/staff-invites.js';
import { database } from '../inventory/database.js';
import { addBranchStaff, branchDetail, createBranch, overview, people, revokeOperations, setOperations } from '../lib/business.js';

const ID = '[0-9a-fA-F-]{36}';
const PROFILE_ROLE = { manager: 'owner', waiter: 'waiter' };

async function ownerUser(request) {
  const context = await requireUser(request);
  if (context.grants === undefined) throw new HttpError(503, 'The owner interface needs database update 008, which hasn’t been applied yet.', { code: 'business_schema_missing' });
  if (context.profile.role === 'admin') throw new HttpError(403, 'Platform admins use the admin workspace.');
  return context;
}

async function withDb(fn, { transaction = false } = {}) {
  const client = await database().connect();
  try {
    if (!transaction) return await fn(client);
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    if (transaction) await client.query('rollback').catch(() => {});
    if (error instanceof HttpError) throw error;
    if (['42P01', '42703'].includes(error.code)) throw new HttpError(503, 'The owner interface needs database update 008, which hasn’t been applied yet.', { code: 'business_schema_missing' });
    if (error.code === '23505') throw new HttpError(409, 'That already exists.');
    if (['23503', '23514', '22P02'].includes(error.code)) throw new HttpError(400, 'Some details are invalid. Check them and try again.');
    throw error;
  } finally { client.release(); }
}

/** An existing account's id by email, or a newly invited account (they set a password from the email). */
async function accountFor(db, value, name) {
  const address = cleanEmail(value);
  const { rows } = await db.query('select id from auth.users where lower(email) = $1', [address]);
  if (rows[0]) return { id: rows[0].id, invited: false };
  const { data, error } = await serviceClient().auth.admin.inviteUserByEmail(address, {
    data: { name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : address.split('@')[0] },
    redirectTo: welcomeUrl(),
  });
  if (error) {
    console.error('[owner] invite failed:', error.code || error.message);
    throw new HttpError(502, 'The invitation email could not be sent. Check the address and try again.');
  }
  return { id: data.user.id, invited: true };
}

export const routes = [
  {
    method: 'GET', path: '/api/owner/overview',
    async handler({ request }) {
      const { user } = await ownerUser(request);
      return withDb((db) => overview(db, user.id));
    },
  },
  {
    method: 'GET', path: new RegExp(`^/api/owner/branches/(?<id>${ID})$`),
    async handler({ request, params }) {
      const { user } = await ownerUser(request);
      return withDb((db) => branchDetail(db, user.id, params.id));
    },
  },
  {
    method: 'POST', path: new RegExp(`^/api/owner/businesses/(?<id>${ID})/branches$`),
    async handler({ request, params, body }) {
      const { user } = await ownerUser(request);
      const branch = await withDb((db) => createBranch(db, user.id, params.id, body || {}), { transaction: true });
      invalidateUser(user.id);
      return branch;
    },
  },
  {
    method: 'GET', path: new RegExp(`^/api/owner/businesses/(?<id>${ID})/people$`),
    async handler({ request, params }) {
      const { user } = await ownerUser(request);
      return withDb((db) => people(db, user.id, params.id));
    },
  },
  {
    // Grant operations access (by email; invites a new account if needed) and set its branches.
    method: 'POST', path: new RegExp(`^/api/owner/businesses/(?<id>${ID})/operations$`),
    async handler({ request, params, body }) {
      const { user } = await ownerUser(request);
      const result = await withDb(async (db) => {
        // Check the caller's ownership before anything is sent to the email address.
        await people(db, user.id, params.id).then((p) => { if (!p.canManageAccess) throw new HttpError(403, 'Only the business owner can do this.'); });
        const account = await accountFor(db, body?.email, body?.name);
        await db.query('begin');
        try {
          const saved = await setOperations(db, user.id, params.id, account.id, body?.branchIds);
          await db.query('commit');
          return { ...saved, invited: account.invited };
        } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
      });
      invalidateUser(result.userId);
      return result;
    },
  },
  {
    method: 'PUT', path: new RegExp(`^/api/owner/businesses/(?<id>${ID})/operations/(?<userId>${ID})$`),
    async handler({ request, params, body }) {
      const { user } = await ownerUser(request);
      const saved = await withDb((db) => setOperations(db, user.id, params.id, params.userId, body?.branchIds), { transaction: true });
      invalidateUser(params.userId);
      return saved;
    },
  },
  {
    method: 'DELETE', path: new RegExp(`^/api/owner/businesses/(?<id>${ID})/operations/(?<userId>${ID})$`),
    async handler({ request, params }) {
      const { user } = await ownerUser(request);
      await withDb((db) => revokeOperations(db, user.id, params.id, params.userId), { transaction: true });
      invalidateUser(params.userId);
    },
  },
  {
    // Add a branch manager or waiter (by email; invites a new account if needed).
    method: 'POST', path: new RegExp(`^/api/owner/branches/(?<id>${ID})/staff$`),
    async handler({ request, params, body }) {
      const { user } = await ownerUser(request);
      const role = body?.role;
      const result = await withDb(async (db) => {
        const detail = await branchDetail(db, user.id, params.id);
        if (detail.businessRole !== 'owner') throw new HttpError(403, 'Only the business owner can add branch staff.');
        if (!['manager', 'waiter'].includes(role)) throw new HttpError(400, 'Choose Branch manager or Waiter.');
        const account = await accountFor(db, body?.email, body?.name);
        await db.query('begin');
        try {
          const saved = await addBranchStaff(db, user.id, params.id, account.id, role);
          await db.query('commit');
          return { ...saved, invited: account.invited };
        } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
      });
      // Branch staff need a profile role to sign in to the staff apps. An existing role is never lowered.
      const service = serviceClient();
      const { data: profile } = await service.from('profiles').select('role').eq('id', result.userId).maybeSingle();
      if (!profile?.role) {
        await service.auth.admin.updateUserById(result.userId, { app_metadata: { role: PROFILE_ROLE[role] } });
        await service.from('profiles').update({ role: PROFILE_ROLE[role] }).eq('id', result.userId);
      }
      invalidateUser(result.userId);
      return result;
    },
  },
];
