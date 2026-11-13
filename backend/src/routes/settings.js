// Settings: your own name (any role) and the owner's team (people who already joined the restaurant).
// Profiles and memberships aren't writable by users (RLS), so after checking the caller these use the service client.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { serviceClient } from '../lib/supabase.js';
import { invalidateRestaurantMembers, invalidateUser } from '../lib/cache.js';
import { cleanName } from '../lib/admin-users.js';
import { isMissingSchema } from '../lib/restaurants.js';
import { ownerContext } from './restaurant.js';

const MEMBER = /^\/api\/restaurant\/team\/(?<id>[0-9a-fA-F-]{36})$/;
const PROFILE_ROLE = { manager: 'owner', waiter: 'waiter' };

function failed(what, error, message) {
  if (error instanceof HttpError) throw error;
  if (isMissingSchema(error)) throw new HttpError(503, 'Team settings aren’t available yet. The database update hasn’t been applied.');
  console.error(`[settings] ${what} failed:`, error?.code || error?.message);
  throw new HttpError(503, message);
}

/** The people on the owner's restaurant: name, email, role, when they joined. */
async function loadTeam(service, restaurantId) {
  const { data: members, error } = await service.from('restaurant_members').select('user_id, role, created_at').eq('restaurant_id', restaurantId);
  if (error) failed('list members', error, 'Could not load your team. Please try again.');
  const ids = members.map((member) => member.user_id);
  const { data: profiles, error: profileError } = ids.length
    ? await service.from('profiles').select('id, name').in('id', ids) : { data: [] };
  if (profileError) failed('list profiles', profileError, 'Could not load your team. Please try again.');
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const users = await Promise.all(ids.map(async (id) => {
    const { data } = await service.auth.admin.getUserById(id);
    return data?.user || null;
  }));
  const rank = { owner: 0, manager: 1, waiter: 2 };
  return members.map((member, index) => {
    const user = users[index];
    const banned = user?.banned_until && new Date(user.banned_until) > new Date();
    return {
      userId: member.user_id, role: member.role, name: names.get(member.user_id) || user?.user_metadata?.name || user?.email || 'Team member',
      email: user?.email || null, joinedAt: member.created_at, lastSignInAt: user?.last_sign_in_at || null,
      status: banned ? 'suspended' : user?.last_sign_in_at ? 'active' : 'invited',
    };
  }).sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
}

/** Only the restaurant owner changes the team; managers can see it. */
async function teamTarget(request, params) {
  const context = await ownerContext(request);
  if (context.role !== 'owner') throw new HttpError(403, 'Only the restaurant owner can change the team.');
  if (params.id.toLowerCase() === context.user.id.toLowerCase()) throw new HttpError(400, 'You can’t change your own access here.');
  const service = serviceClient();
  const { data: member, error } = await service.from('restaurant_members').select('user_id, role')
    .eq('restaurant_id', context.restaurantId).eq('user_id', params.id).maybeSingle();
  if (error) failed('read member', error, 'Could not update your team. Please try again.');
  if (!member) throw new HttpError(404, 'That person is no longer on your team.');
  if (member.role === 'owner') throw new HttpError(400, 'The owner’s access can’t be changed here.');
  return { ...context, service, member };
}

export const routes = [
  {
    method: 'PATCH',
    path: '/api/me',
    async handler({ request, body }) {
      const { user } = await requireUser(request);
      const name = cleanName(body?.name, { label: 'name' });
      const service = serviceClient();
      const { error } = await service.from('profiles').update({ name }).eq('id', user.id);
      if (error) failed('rename self', error, 'Could not save your name. Please try again.');
      const { error: metaError } = await service.auth.admin.updateUserById(user.id, { user_metadata: { name } });
      if (metaError) console.error('[settings] rename user_metadata failed:', metaError.message);
      invalidateUser(user.id);
      return { name };
    },
  },
  {
    method: 'GET',
    path: '/api/restaurant/team',
    async handler({ request }) {
      const { restaurantId, role, user } = await ownerContext(request);
      return { members: await loadTeam(serviceClient(), restaurantId), canManage: role === 'owner', selfId: user.id };
    },
  },
  {
    method: 'PATCH',
    path: MEMBER,
    async handler({ request, params, body }) {
      const { service, member, restaurantId } = await teamTarget(request, params);
      if (!['waiter', 'manager'].includes(body?.role)) throw new HttpError(400, 'Choose Waiter or Manager.');
      if (body.role !== member.role) {
        const { error } = await service.from('restaurant_members').update({ role: body.role })
          .eq('restaurant_id', restaurantId).eq('user_id', member.user_id);
        if (error) failed('change member role', error, 'Could not change their role. Please try again.');
        const { error: roleError } = await service.auth.admin.updateUserById(member.user_id, { app_metadata: { role: PROFILE_ROLE[body.role] } });
        if (roleError) failed('member app role', roleError, 'Could not change their role. Please try again.');
        await service.from('profiles').update({ role: PROFILE_ROLE[body.role] }).eq('id', member.user_id);
        invalidateUser(member.user_id);
        invalidateRestaurantMembers(restaurantId);
      }
      return { members: await loadTeam(service, restaurantId) };
    },
  },
  {
    method: 'DELETE',
    path: MEMBER,
    async handler({ request, params }) {
      const { service, member, restaurantId } = await teamTarget(request, params);
      const { error } = await service.from('restaurant_members').delete().eq('restaurant_id', restaurantId).eq('user_id', member.user_id);
      if (error) failed('remove member', error, 'Could not remove them. Please try again.');
      // Their invite goes too, so they can be invited again later.
      await service.from('staff_invites').delete().eq('restaurant_id', restaurantId).eq('user_id', member.user_id);
      // Someone with no restaurant left loses their staff role, so they can't reach any dashboard.
      const { count } = await service.from('restaurant_members').select('user_id', { count: 'exact', head: true }).eq('user_id', member.user_id);
      if (!count) {
        await service.auth.admin.updateUserById(member.user_id, { app_metadata: { role: null } });
        await service.from('profiles').update({ role: null }).eq('id', member.user_id);
      }
      invalidateUser(member.user_id);
      invalidateRestaurantMembers(restaurantId);
      return { members: await loadTeam(service, restaurantId) };
    },
  },
];
