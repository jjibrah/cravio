// Platform admin: businesses (and their branches, access and inventory health) and the access activity log.
// Every handler checks requireRole('admin') first. Changes are audited in access_events (lib/admin-business.js).
import { requireRole } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateUser } from '../lib/cache.js';
import { email as cleanEmail } from '../lib/restaurants.js';
import { serviceClient } from '../lib/supabase.js';
import { withDb } from '../lib/db.js';
import { welcomeUrl } from '../lib/staff-invites.js';
import { activity, addBranch, businessDetail, grantOwner, listBusinesses, renameBusiness, revokeAccess, setInventoryEnabled } from '../lib/admin-business.js';

const ID = '[0-9a-fA-F-]{36}';
const admin = (request) => requireRole(request, 'admin');

/** The account for an email: an existing one, or a newly invited one (they set a password from the email). */
async function accountFor(db, value, name) {
  const address = cleanEmail(value);
  const { rows } = await db.query('select id from auth.users where lower(email) = $1', [address]);
  if (rows[0]) return { id: rows[0].id, invited: false };
  const { data, error } = await serviceClient().auth.admin.inviteUserByEmail(address, {
    data: { name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : address.split('@')[0] }, redirectTo: welcomeUrl(),
  });
  if (error) {
    console.error('[admin-business] invite failed:', error.code || error.message);
    throw new HttpError(error.status === 429 ? 429 : 502, error.status === 429 ? 'Too many invites were sent just now. Wait a minute and try again.' : 'The invitation email could not be sent. Check the address and try again.');
  }
  return { id: data.user.id, invited: true };
}

export const routes = [
  { method: 'GET', path: '/api/admin/businesses', async handler({ request }) {
    await admin(request);
    return withDb((db) => listBusinesses(db));
  } },
  { method: 'GET', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})$`), async handler({ request, params }) {
    await admin(request);
    return withDb((db) => businessDetail(db, params.id));
  } },
  { method: 'PATCH', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})$`), async handler({ request, params, body }) {
    await admin(request);
    return withDb((db) => renameBusiness(db, params.id, body?.name), { transaction: true });
  } },
  { method: 'POST', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/owners$`), async handler({ request, params, body }) {
    const { user } = await admin(request);
    const result = await withDb(async (db) => {
      const account = await accountFor(db, body?.email, body?.name);
      await db.query('begin');
      try {
        const saved = await grantOwner(db, user.id, params.id, account.id);
        await db.query('commit');
        return { ...saved, invited: account.invited };
      } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
    });
    invalidateUser(result.userId);
    return result;
  } },
  { method: 'DELETE', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/access/(?<userId>${ID})$`), async handler({ request, params }) {
    const { user } = await admin(request);
    const result = await withDb((db) => revokeAccess(db, user.id, params.id, params.userId), { transaction: true });
    invalidateUser(params.userId);
    return result;
  } },
  { method: 'POST', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/branches$`), async handler({ request, params, body }) {
    const { user } = await admin(request);
    return withDb((db) => addBranch(db, user.id, params.id, body || {}), { transaction: true });
  } },
  { method: 'POST', path: new RegExp(`^/api/admin/businesses/(?<id>${ID})/inventory$`), async handler({ request, params, body }) {
    const context = await admin(request);
    return withDb((db) => setInventoryEnabled(db, context, params.id, body?.enabled, { reason: body?.reason }), { transaction: true });
  } },
  // Platform status for admin Settings: applied database updates and which features they switch on. Read-only.
  { method: 'GET', path: '/api/admin/system', async handler({ request }) {
    await admin(request);
    return withDb(async (db) => {
      const { rows: migrations } = await db.query('select name, applied_at from private.schema_migrations order by name');
      const exists = async (name) => (await db.query('select to_regclass($1) is not null as ok', [name])).rows[0].ok;
      const [business, inventory, support] = await Promise.all([exists('public.business_members'), exists('public.stock_items'), exists('public.support_requests')]);
      return {
        migrations: migrations.map((m) => ({ name: m.name, appliedAt: m.applied_at })),
        features: [
          { key: 'business', name: 'Businesses, branches and owner platform', on: business, needs: '008' },
          { key: 'inventory', name: 'Inventory, stock requests and dispatches', on: inventory, needs: '009' },
          { key: 'support', name: 'Support requests and complaints', on: support, needs: '006' },
          { key: 'ai', name: 'AI assistant (OpenRouter)', on: false, needs: null, note: 'Not connected. The assistant answers from records only.' },
        ],
        server: { node: process.version, timeZone: 'Africa/Nairobi' },
        checkedAt: new Date().toISOString(),
      };
    });
  } },
  { method: 'GET', path: '/api/admin/activity', async handler({ request, url }) {
    await admin(request);
    const before = url.searchParams.get('before');
    return { events: await withDb((db) => activity(db, { limit: 100, before: before && /^\d+$/.test(before) ? before : null })) };
  } },
];
