import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { MANAGER_ROLES, branchRole, homePath, requestedBranch, selectMembership } from '../lib/access.js';
import { placeFor } from '../lib/restaurants.js';

/** The branch /api/me describes as "place": the requested one, else the only one; never a guess between several. */
function currentPlace(memberships, request) {
  try { return selectMembership(memberships, requestedBranch(request))?.restaurant || null; }
  catch (error) {
    if (error instanceof HttpError && error.details?.code === 'branch_required') return null;
    if (error instanceof HttpError && ['branch_forbidden', 'branch_invalid'].includes(error.details?.code)) return null;
    throw error;
  }
}

/** Route modules export `routes`: [{ method, path: string | RegExp, handler(ctx) }]. */
export const routes = [
  {
    method: 'GET',
    path: '/api/me',
    async handler({ request }) {
      const { user, profile, memberships, grants } = await requireUser(request);
      const staff = profile.role === 'owner' || profile.role === 'waiter';
      // undefined memberships: migration 002 isn't applied; behave as before (no places).
      const rows = staff && memberships ? memberships.filter((row) => row.restaurant) : [];
      const restaurant = staff && memberships ? currentPlace(rows, request) : staff ? undefined : null;
      // Onboarding: a legacy owner account whose (only) managed restaurant isn't live yet, or who has none.
      const managed = rows.filter((row) => MANAGER_ROLES.includes(row.role));
      const onboardingRequired = profile.role === 'owner' && memberships !== undefined && !grants?.length
        && (managed.length === 0 ? rows.length === 0 : managed.length === 1 && managed[0].restaurant.status === 'onboarding');
      const branches = rows.map((row) => ({
        ...placeFor(row.restaurant), role: branchRole(row.role), membershipRole: row.role,
      })).sort((a, b) => a.name.localeCompare(b.name));
      const businesses = (grants || []).map((grant) => ({ id: grant.businessId, name: grant.name, role: grant.role, branchIds: grant.branchIds }));
      return {
        id: user.id, email: user.email, name: profile.name, role: profile.role,
        place: placeFor(restaurant || null),
        onboardingRequired,
        branches,
        businesses,
        // false before migration 008: no owner/operations interface yet.
        businessAccessAvailable: grants !== undefined,
        home: homePath({ profileRole: profile.role, memberships: rows, grants, onboardingRequired }),
      };
    },
  },
];
