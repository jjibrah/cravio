// Admin Users: list, invite, rename, change role, suspend, reactivate, resend invite.
// Every handler checks requireRole(request, 'admin') before touching the service client.
import { requireRole } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { serviceClient } from '../lib/supabase.js';
import { invalidateUser } from '../lib/cache.js';
import {
  STATUSES, SUSPEND_DURATION, assertAllowed, cleanEmail, cleanName, cleanRole, cleanUuid, countRows,
  fail, inviteRedirect, isMissingTable, listAuthUsers, loadDirectory, loadUser, matchesQuery,
} from '../lib/admin-users.js';

const USER = /^\/api\/admin\/users\/(?<id>[0-9a-f-]{36})$/;
const ACTION = (name) => new RegExp(`^\\/api\\/admin\\/users\\/(?<id>[0-9a-f-]{36})\\/${name}$`);

async function adminContext(request) {
  const context = await requireRole(request, 'admin');
  return { ...context, service: serviceClient() };
}

const roleLabel = { admin: 'an admin', owner: 'an owner', waiter: 'a waiter' };

/** Sets the role in app_metadata (fires the profile trigger) and on the profile itself. */
async function applyRole(service, id, role, name) {
  invalidateUser(id);
  const { error } = await service.auth.admin.updateUserById(id, { app_metadata: { role } });
  if (error) fail('set app_metadata.role', error, 'Could not change the role. Please try again.');
  // The auth trigger has already created or updated the profile row; set the fields explicitly as well.
  const { error: profileError } = await service.from('profiles').update({ role, ...(name ? { name } : {}) }).eq('id', id);
  if (profileError) fail('profile role', profileError, 'Could not change the role. Please try again.');
  invalidateUser(id); // again, in case a request re-cached the old role meanwhile
}

async function loadCreateRestaurant() {
  try {
    const module = await import('../lib/restaurants.js');
    if (typeof module.createRestaurantForOwner !== 'function') throw new Error('createRestaurantForOwner is not exported');
    return module.createRestaurantForOwner;
  } catch (error) {
    fail('load restaurants.js', error, 'Inviting owners isn’t available yet: restaurant setup is still being installed.');
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/admin/users',
    async handler({ request, url }) {
      const { user, service } = await adminContext(request);
      const q = url.searchParams.get('q')?.trim().slice(0, 120) || '';
      const role = url.searchParams.get('role') || '';
      const status = url.searchParams.get('status') || '';
      if (role && !['admin', 'owner', 'waiter'].includes(role)) throw new HttpError(400, 'Unknown role filter. Use admin, owner or waiter.');
      if (status && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown status filter. Use active, invited or suspended.');
      const all = await loadDirectory(service, user.id);
      const searched = all.filter((row) => matchesQuery(row, q));
      const users = searched.filter((row) => (!role || row.role === role) && (!status || row.status === status));
      return { users, counts: countRows(searched), total: all.length };
    },
  },
  {
    method: 'GET',
    path: '/api/admin/restaurants',
    async handler({ request }) {
      const { service } = await adminContext(request);
      const { data, error } = await service.from('restaurants').select('id, name, status').order('name');
      if (error) {
        if (isMissingTable(error)) return { restaurants: [] };
        fail('list restaurants', error, 'Could not load restaurants. Please try again.');
      }
      return { restaurants: data };
    },
  },
  {
    method: 'POST',
    path: '/api/admin/users/invite',
    async handler({ request, body }) {
      const { user: caller, service } = await adminContext(request);
      const email = cleanEmail(body?.email);
      const name = cleanName(body?.name);
      const role = cleanRole(body?.role);
      let restaurantName = '';
      let restaurantId = '';
      let createRestaurantForOwner;
      if (role === 'owner') {
        restaurantName = cleanName(body?.restaurantName, { field: 'restaurantName', label: 'restaurant name' });
        createRestaurantForOwner = await loadCreateRestaurant();
      }
      if (role === 'waiter') {
        restaurantId = cleanUuid(body?.restaurantId, 'Choose the restaurant this waiter works at.', 'restaurantId');
        const { data: restaurant, error } = await service.from('restaurants').select('id').eq('id', restaurantId).maybeSingle();
        if (error && !isMissingTable(error)) fail('find restaurant', error, 'Could not check that restaurant. Please try again.');
        if (!restaurant) throw new HttpError(400, 'That restaurant no longer exists. Choose another one.', { field: 'restaurantId' });
      }

      const existing = await listAuthUsers(service);
      if (existing.some((user) => user.email?.toLowerCase() === email)) {
        throw new HttpError(409, 'Someone with this email already has a Cravio account.', { field: 'email' });
      }

      const { data, error } = await service.auth.admin.inviteUserByEmail(email, { data: { name }, redirectTo: inviteRedirect() });
      if (error) {
        if (error.code === 'email_exists' || error.status === 422) throw new HttpError(409, 'Someone with this email already has a Cravio account.', { field: 'email' });
        if (error.status === 429 || error.code === 'over_email_send_rate_limit') fail('invite', error, 'Too many invites were sent just now. Wait a minute and try again.', 429);
        fail('invite', error, 'Could not send the invite. Please try again.');
      }
      const id = data.user.id;
      try {
        await applyRole(service, id, role, name);
        if (role === 'owner') await createRestaurantForOwner(service, { ownerId: id, name: restaurantName });
        if (role === 'waiter') {
          const { error: memberError } = await service.from('restaurant_members').insert({ restaurant_id: restaurantId, user_id: id, role: 'waiter' });
          if (memberError) throw memberError;
        }
        invalidateUser(id);
      } catch (setupError) {
        // Undo the half-created invite so the admin can simply try again.
        const { error: undoError } = await service.auth.admin.deleteUser(id);
        if (undoError) console.error('[admin-users] could not undo invite for', id, undoError.message);
        if (setupError instanceof HttpError) throw setupError;
        fail('invite setup', setupError, 'Could not finish the invite, so nothing was saved. Please try again.');
      }
      return { user: await loadUser(service, id, caller.id) };
    },
  },
  {
    method: 'PATCH',
    path: USER,
    async handler({ request, params, body }) {
      const { user: caller, service } = await adminContext(request);
      const hasRole = body && Object.hasOwn(body, 'role');
      const hasName = body && Object.hasOwn(body, 'name');
      if (!hasRole && !hasName) throw new HttpError(400, 'Send a new role or name.');
      const role = hasRole ? cleanRole(body.role) : null;
      const name = hasName ? cleanName(body.name) : null;
      const target = await loadUser(service, params.id, caller.id);

      if (hasName && name !== target.name) {
        await assertAllowed(service, { target, action: 'rename' });
        const { error } = await service.from('profiles').update({ name }).eq('id', target.id);
        if (error) fail('rename', error, 'Could not rename this user. Please try again.');
        const { error: metaError } = await service.auth.admin.updateUserById(target.id, { user_metadata: { name } });
        if (metaError) console.error('[admin-users] rename user_metadata failed:', metaError.message);
        invalidateUser(target.id);
      }
      if (hasRole && role !== target.role) {
        await assertAllowed(service, { target, action: 'role', nextRole: role });
        await applyRole(service, target.id, role);
      }
      const user = await loadUser(service, target.id, caller.id);
      return { user, message: hasRole && role !== target.role ? `${user.name} is now ${roleLabel[role]}.` : 'Changes saved.' };
    },
  },
  {
    method: 'POST',
    path: ACTION('suspend'),
    async handler({ request, params }) {
      const { user: caller, service } = await adminContext(request);
      const target = await loadUser(service, params.id, caller.id);
      if (target.status === 'suspended') throw new HttpError(409, `${target.name} is already suspended.`);
      await assertAllowed(service, { target, action: 'suspend' });
      const { error } = await service.auth.admin.updateUserById(target.id, { ban_duration: SUSPEND_DURATION });
      if (error) fail('suspend', error, 'Could not suspend this user. Please try again.');
      invalidateUser(target.id); // cached sessions must see the ban now, not in 30 seconds
      return { user: await loadUser(service, target.id, caller.id) };
    },
  },
  {
    method: 'POST',
    path: ACTION('reactivate'),
    async handler({ request, params }) {
      const { user: caller, service } = await adminContext(request);
      const target = await loadUser(service, params.id, caller.id);
      if (target.status !== 'suspended') throw new HttpError(409, `${target.name} isn’t suspended.`);
      await assertAllowed(service, { target, action: 'reactivate' });
      const { error } = await service.auth.admin.updateUserById(target.id, { ban_duration: 'none' });
      if (error) fail('reactivate', error, 'Could not reactivate this user. Please try again.');
      invalidateUser(target.id);
      return { user: await loadUser(service, target.id, caller.id) };
    },
  },
  {
    method: 'POST',
    path: ACTION('resend-invite'),
    async handler({ request, params }) {
      const { user: caller, service } = await adminContext(request);
      const target = await loadUser(service, params.id, caller.id);
      if (target.status !== 'invited') throw new HttpError(409, `${target.name} has already accepted their invite.`);
      await assertAllowed(service, { target, action: 'resend' });
      const { error } = await service.auth.admin.inviteUserByEmail(target.email, { data: { name: target.name }, redirectTo: inviteRedirect() });
      if (error) {
        if (error.status === 429 || error.code === 'over_email_send_rate_limit') fail('resend invite', error, 'An invite was sent very recently. Wait a minute and try again.', 429);
        fail('resend invite', error, 'Could not resend the invite. Please try again.');
      }
      return { user: await loadUser(service, target.id, caller.id), message: `Invite sent again to ${target.email}.` };
    },
  },
];
