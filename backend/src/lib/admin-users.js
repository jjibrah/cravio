// Helpers for the admin Users endpoints. Every function here takes the service
// client, so callers must check the caller's role (requireRole) first.
import { HttpError } from './http.js';

export const ROLES = ['admin', 'owner', 'waiter'];
export const STATUSES = ['active', 'invited', 'suspended'];
const PAGE_SIZE = 1000;
// Supabase bans are durations. 100 years is "until reactivated".
export const SUSPEND_DURATION = '876000h';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Logs the real error server-side and throws a safe, user-facing one. */
export function fail(action, error, message = 'Something went wrong. Please try again.', status = 503) {
  console.error(`[admin-users] ${action} failed:`, error?.code || '', error?.message || error);
  throw new HttpError(status, message);
}

/** True when PostgREST reports that a table (or relation) does not exist yet. */
export function isMissingTable(error) {
  return Boolean(error) && (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST200'
    || /does not exist|schema cache/i.test(error.message || ''));
}

// ---------- validation ----------

export function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) throw new HttpError(400, 'Enter an email address.', { field: 'email' });
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address, like name@restaurant.com.', { field: 'email' });
  return email;
}

export function cleanName(value, { field = 'name', label = 'name', required = true } = {}) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    if (!required) return '';
    throw new HttpError(400, `Enter a ${label}.`, { field });
  }
  if (name.length > 120) throw new HttpError(400, `Keep the ${label} under 120 characters.`, { field });
  return name;
}

export function cleanRole(value) {
  if (!ROLES.includes(value)) throw new HttpError(400, 'Choose a role: admin, owner or waiter.', { field: 'role' });
  return value;
}

export function cleanUuid(value, message, field) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, message, { field });
  return value.toLowerCase();
}

// ---------- reads ----------

export async function listAuthUsers(service) {
  const users = [];
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) fail('listUsers', error, 'Could not load users. Please try again.');
    users.push(...data.users);
    if (data.users.length < PAGE_SIZE) break;
  }
  return users;
}

let primaryCache = { email: null, at: 0 };
/** The reserved primary admin email (migration 001 RPC, falling back to SUPER_ADMIN_EMAIL). */
export async function primaryAdminEmail(service) {
  if (primaryCache.email && Date.now() - primaryCache.at < 60_000) return primaryCache.email;
  let email = null;
  const { data, error } = await service.rpc('primary_admin_email');
  if (!error && typeof data === 'string') email = data.toLowerCase();
  else if (error) console.warn('[admin-users] primary_admin_email unavailable, using SUPER_ADMIN_EMAIL:', error.code || error.message);
  email ||= process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase() || null;
  primaryCache = { email, at: Date.now() };
  return email;
}

async function loadProfiles(service) {
  const { data, error } = await service.from('profiles').select('id, name, role');
  if (error) fail('profiles', error, 'Could not load users. Please try again.');
  return new Map(data.map((profile) => [profile.id, profile]));
}

/** Restaurants per user. Tolerates the restaurant tables not existing yet (migration 002). */
async function loadRestaurantLinks(service) {
  const byUser = new Map();
  const add = (userId, restaurant, role) => {
    if (!userId || !restaurant) return;
    const list = byUser.get(userId) || [];
    if (!list.some((item) => item.id === restaurant.id)) list.push({ id: restaurant.id, name: restaurant.name, status: restaurant.status, role });
    byUser.set(userId, list);
  };
  const { data: restaurants, error } = await service.from('restaurants').select('id, name, status, owner_id');
  if (error) {
    if (!isMissingTable(error)) console.error('[admin-users] restaurants failed:', error.code, error.message);
    return byUser;
  }
  const byId = new Map(restaurants.map((restaurant) => [restaurant.id, restaurant]));
  for (const restaurant of restaurants) add(restaurant.owner_id, restaurant, 'owner');
  const { data: members, error: memberError } = await service.from('restaurant_members').select('restaurant_id, user_id, role');
  if (memberError) {
    if (!isMissingTable(memberError)) console.error('[admin-users] restaurant_members failed:', memberError.code, memberError.message);
    return byUser;
  }
  for (const member of members) add(member.user_id, byId.get(member.restaurant_id), member.role);
  return byUser;
}

export function statusOf(user, now = Date.now()) {
  if (user.banned_until && Date.parse(user.banned_until) > now) return 'suspended';
  if (!user.last_sign_in_at && (user.invited_at || !user.email_confirmed_at)) return 'invited';
  return 'active';
}

/** The public row shape shared by every endpoint. */
export function toRow(user, { profile, restaurants = [], primaryEmail, selfId }) {
  const email = user.email?.toLowerCase() || '';
  const isPrimaryAdmin = Boolean(primaryEmail) && email === primaryEmail;
  const name = profile?.name || user.user_metadata?.name || email.split('@')[0] || 'User';
  return {
    id: user.id,
    email,
    name,
    role: isPrimaryAdmin ? 'admin' : (profile?.role ?? null),
    status: statusOf(user),
    restaurant: restaurants[0] ? { id: restaurants[0].id, name: restaurants[0].name, status: restaurants[0].status } : null,
    restaurants,
    created_at: user.created_at || null,
    invited_at: user.invited_at || null,
    last_sign_in_at: user.last_sign_in_at || null,
    banned_until: statusOf(user) === 'suspended' ? user.banned_until : null,
    isPrimaryAdmin,
    isSelf: user.id === selfId,
  };
}

/** Every user, joined with profile and restaurant data. */
export async function loadDirectory(service, selfId) {
  const [users, profiles, links, primaryEmail] = await Promise.all([
    listAuthUsers(service), loadProfiles(service), loadRestaurantLinks(service), primaryAdminEmail(service),
  ]);
  return users.map((user) => toRow(user, { profile: profiles.get(user.id), restaurants: links.get(user.id) || [], primaryEmail, selfId }));
}

/** One user row, or a 404. */
export async function loadUser(service, id, selfId) {
  const { data, error } = await service.auth.admin.getUserById(id);
  if (error || !data?.user) {
    if (error && error.status !== 404 && !/not found/i.test(error.message || '')) fail('getUserById', error, 'Could not load this user. Please try again.');
    throw new HttpError(404, 'That user no longer exists.');
  }
  const [{ data: profile, error: profileError }, links, primaryEmail] = await Promise.all([
    service.from('profiles').select('id, name, role').eq('id', id).maybeSingle(),
    loadRestaurantLinks(service),
    primaryAdminEmail(service),
  ]);
  if (profileError) fail('profile', profileError, 'Could not load this user. Please try again.');
  return toRow(data.user, { profile, restaurants: links.get(id) || [], primaryEmail, selfId });
}

export function countRows(rows) {
  const counts = { all: rows.length, admin: 0, owner: 0, waiter: 0, invited: 0, suspended: 0 };
  for (const row of rows) {
    if (row.role && counts[row.role] !== undefined) counts[row.role] += 1;
    if (row.status === 'invited') counts.invited += 1;
    if (row.status === 'suspended') counts.suspended += 1;
  }
  return counts;
}

export function matchesQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return row.name.toLowerCase().includes(needle) || row.email.includes(needle)
    || Boolean(row.restaurant?.name?.toLowerCase().includes(needle));
}

// ---------- guards ----------

/** Admins who can still sign in (not suspended), excluding `exceptId`. */
async function otherActiveAdmins(service, exceptId) {
  const { data, error } = await service.from('profiles').select('id').eq('role', 'admin').neq('id', exceptId);
  if (error) fail('admin count', error, 'Could not check admin access. Please try again.');
  let active = 0;
  for (const { id } of data) {
    const { data: found } = await service.auth.admin.getUserById(id);
    if (found?.user && statusOf(found.user) !== 'suspended') active += 1;
    if (active) break;
  }
  return active;
}

/**
 * Throws 403/409 when `action` is not allowed on `target` by the caller.
 * action: 'rename' | 'role' | 'suspend' | 'reactivate' | 'resend'
 */
export async function assertAllowed(service, { target, action, nextRole }) {
  if (target.isPrimaryAdmin && !target.isSelf) {
    throw new HttpError(403, 'The primary admin account can’t be suspended, demoted or edited by other admins.');
  }
  if (target.isPrimaryAdmin && (action === 'role' || action === 'suspend')) {
    throw new HttpError(403, 'The primary admin account always keeps admin access.');
  }
  if (target.isSelf && action === 'role') throw new HttpError(403, 'You can’t change your own role. Ask another admin.');
  if (target.isSelf && action === 'suspend') throw new HttpError(403, 'You can’t suspend your own account.');

  const losesAdmin = target.role === 'admin' && target.status !== 'suspended'
    && ((action === 'role' && nextRole !== 'admin') || action === 'suspend');
  if (losesAdmin && !(await otherActiveAdmins(service, target.id))) {
    throw new HttpError(409, 'Cravio needs at least one active admin. Make someone else an admin first.');
  }
}

export function inviteRedirect() {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/welcome`;
}
