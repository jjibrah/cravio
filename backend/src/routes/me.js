import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { findMembership, isMissingSchema, pickMembership, placeFor } from '../lib/restaurants.js';

/** The caller's restaurant (owners and managers: theirs; waiters: from their membership). */
async function placeOf(client, userId, memberships) {
  try {
    // requireUser already loaded (and caches) the memberships; undefined means migration 002 isn't applied.
    if (memberships) return pickMembership(memberships)?.restaurant || null;
    return (await findMembership(client, userId))?.restaurant || null;
  } catch (error) {
    // Before migration 002 is applied there are no restaurants: behave as before.
    if (isMissingSchema(error)) return undefined;
    console.error('GET /api/me place lookup failed:', error.code || error.message);
    throw new HttpError(503, 'Could not load your account. Please try again.');
  }
}

/** Route modules export `routes`: [{ method, path: string | RegExp, handler(ctx) }]. */
export const routes = [
  {
    method: 'GET',
    path: '/api/me',
    async handler({ request }) {
      const { user, profile, client, memberships } = await requireUser(request);
      const restaurant = profile.role === 'owner' || profile.role === 'waiter' ? await placeOf(client, user.id, memberships) : null;
      const onboardingRequired = profile.role === 'owner' && restaurant !== undefined
        && (!restaurant || restaurant.status === 'onboarding');
      return {
        id: user.id, email: user.email, name: profile.name, role: profile.role,
        place: placeFor(restaurant || null),
        onboardingRequired,
      };
    },
  },
];
