// v2 access resolution: which branch a request acts on, and what business-level oversight the caller has.
//
// Branch (restaurant) access comes ONLY from restaurant_members, exactly as before:
//   owner | manager  -> branch manager (legacy owner accounts land here)
//   waiter           -> waiter
// Business access comes ONLY from business_members (migration 008): 'owner' sees every branch of the business,
// 'operations' sees the branches listed for them. Profile role 'owner' never implies business access.
//
// A request names its branch with the X-Cravio-Branch header. Without it, a caller with exactly one eligible
// branch uses that one; a caller with several must choose (409 branch_required), so nobody silently acts on the
// wrong restaurant.
import { HttpError } from './http.js';
import { isMissingSchema } from './restaurants.js';

export const BRANCH_HEADER = 'x-cravio-branch';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RANK = { owner: 0, manager: 1, waiter: 2 };
export const MANAGER_ROLES = ['owner', 'manager'];
export const STAFF_ROLES = ['owner', 'manager', 'waiter'];

/** The branch id a request asks for, or null. Throws 400 for a malformed value. */
export function requestedBranch(request) {
  const raw = request?.headers?.[BRANCH_HEADER];
  if (raw === undefined || raw === '') return null;
  const value = Array.isArray(raw) ? raw[0] : String(raw).trim();
  if (!UUID_RE.test(value)) throw new HttpError(400, 'The selected branch is invalid. Choose a branch again.', { code: 'branch_invalid' });
  return value.toLowerCase();
}

const byRank = (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || String(a.created_at).localeCompare(String(b.created_at));

/**
 * Picks the membership a request acts on. Pure: memberships are the caller's restaurant_members rows
 * (each with .restaurant), requested is a branch id or null, roles are the roles the action accepts.
 * Returns the membership, or null when the caller has no eligible branch at all.
 */
export function selectMembership(memberships, requested, roles = STAFF_ROLES) {
  const rows = (memberships || []).filter((row) => row.restaurant);
  if (requested) {
    const row = rows.find((candidate) => String(candidate.restaurant.id).toLowerCase() === requested);
    if (!row) throw new HttpError(403, 'You don’t have access to this branch.', { code: 'branch_forbidden' });
    if (!roles.includes(row.role)) throw new HttpError(403, 'Your role at this branch can’t do this.', { code: 'role_forbidden' });
    return row;
  }
  const eligible = rows.filter((row) => roles.includes(row.role)).sort(byRank);
  if (eligible.length <= 1) return eligible[0] || null;
  throw new HttpError(409, 'Choose which branch you are working in.', {
    code: 'branch_required', branches: eligible.map((row) => ({ id: row.restaurant.id, name: row.restaurant.name, role: row.role })),
  });
}

/** Branch role label used by the app: 'manager' (owner or manager membership) or 'waiter'. */
export const branchRole = (membershipRole) => (MANAGER_ROLES.includes(membershipRole) ? 'manager' : membershipRole === 'waiter' ? 'waiter' : null);

/**
 * Business grants of a user, read with their own RLS client. Returns undefined before migration 008
 * (the app then offers no owner/operations interface), otherwise
 * [{ businessId, name, role: 'owner'|'operations', branchIds: string[] | null }] where null means every branch.
 */
export async function loadBusinessGrants(client, userId) {
  const { data, error } = await client.from('business_members')
    .select('business_id, role, business:businesses (id, name)').eq('user_id', userId);
  if (error) {
    if (isMissingSchema(error) || error.code === '42703') return undefined;
    throw error;
  }
  if (!data?.length) return [];
  const operations = data.filter((row) => row.role === 'operations').map((row) => row.business_id);
  let assigned = [];
  if (operations.length) {
    const result = await client.from('business_member_branches').select('business_id, restaurant_id')
      .eq('user_id', userId).in('business_id', operations);
    if (result.error) throw result.error;
    assigned = result.data;
  }
  return data.filter((row) => row.business).map((row) => ({
    businessId: row.business_id, name: row.business.name, role: row.role,
    branchIds: row.role === 'owner' ? null : assigned.filter((a) => a.business_id === row.business_id).map((a) => a.restaurant_id),
  }));
}

/**
 * Where the app should land a signed-in user. Pure.
 * Business grant -> /owner. Otherwise branch management -> /branch/:id (one branch) or /branch (choose).
 * Otherwise waiter -> /waiter. Admin -> /admin. Nothing -> /account.
 */
export function homePath({ profileRole, memberships, grants, onboardingRequired }) {
  if (profileRole === 'admin') return '/admin';
  if (onboardingRequired) return '/onboarding';
  if (grants?.length) return '/owner';
  const managed = (memberships || []).filter((row) => row.restaurant && MANAGER_ROLES.includes(row.role));
  if (managed.length === 1) return `/branch/${managed[0].restaurant.id}`;
  if (managed.length > 1) return '/branch';
  if ((memberships || []).some((row) => row.restaurant && row.role === 'waiter')) return '/waiter';
  return '/account';
}
