import { HttpError } from './http.js';
import { AUTH_TTL_MS, authCache, currentAuthVersion, tokenKey } from './cache.js';
import { RESTAURANT_COLUMNS, isMissingSchema } from './restaurants.js';
import { configured, serviceClient, userClient, verifierClient } from './supabase.js';

/*
 * Who is calling. Resolving a token used to cost three sequential round trips to Supabase on every request
 * (auth.getUser, the profile, then the membership). Now:
 * - The token is verified with auth.getClaims: locally against the project's cached JWKS when the project
 *   signs with an asymmetric key. When it uses a shared secret (HS256), getClaims can't verify locally, so
 *   we call auth.getUser instead (one round trip, which also returns banned_until).
 * - The profile and the memberships load in parallel with that check (PostgREST verifies the same token
 *   independently, and nothing is used unless the token check passes).
 * - The resolved context is cached for 30 seconds (never past the token's expiry) under a hash of the token.
 *   invalidateUser(userId) in lib/cache.js drops it at once; the admin suspend, reactivate, role, rename and
 *   invite endpoints and membership changes call it, so a suspension still takes effect immediately.
 */

const UNSIGNED = () => new HttpError(401, 'Your session expired. Please sign in again.');

function decodePart(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

/** Header and payload of a JWT, unverified (only to route the check and start queries early). */
function peek(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  return header && payload && typeof payload.sub === 'string' ? { header, payload } : null;
}

const userFrom = (source) => ({
  id: source.id ?? source.sub,
  email: source.email ?? null,
  user_metadata: source.user_metadata || {},
  app_metadata: source.app_metadata || {},
});

/** Verifies the token. Returns { user, bannedUntil, checkedBan } or throws 401. */
async function verify(token, header) {
  const verifier = verifierClient();
  const asymmetric = header.alg && !String(header.alg).startsWith('HS') && header.kid && typeof verifier.auth.getClaims === 'function';
  if (asymmetric) {
    const { data, error } = await verifier.auth.getClaims(token);
    if (error || !data?.claims?.sub) throw UNSIGNED();
    return { user: userFrom(data.claims), bannedUntil: null, checkedBan: false };
  }
  const { data, error } = await verifier.auth.getUser(token);
  if (error || !data?.user) throw UNSIGNED();
  return { user: userFrom(data.user), bannedUntil: data.user.banned_until || null, checkedBan: true };
}

/** banned_until from the Auth admin API (only needed when the token was verified locally). */
async function bannedUntilOf(userId) {
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(userId);
    if (error) throw error;
    return data?.user?.banned_until || null;
  } catch (error) {
    console.error('[auth] ban check failed:', error.code || error.message);
    throw new HttpError(503, 'Could not load your account. Please try again.');
  }
}

/** Membership rows with their restaurant, or undefined before migration 002. */
async function loadMemberships(client, userId) {
  const { data, error } = await client.from('restaurant_members')
    .select(`role, created_at, restaurant:restaurants (${RESTAURANT_COLUMNS})`).eq('user_id', userId);
  if (error) {
    if (isMissingSchema(error)) return undefined;
    throw error;
  }
  return (data || []).filter((row) => row.restaurant);
}

async function resolve(token) {
  const parts = peek(token);
  if (!parts) throw UNSIGNED();
  if (parts.payload.exp && parts.payload.exp * 1000 <= Date.now()) throw UNSIGNED();
  const client = userClient(token);
  const sub = parts.payload.sub;

  // Start everything at once; the token check gates the result.
  const profilePromise = Promise.resolve(client.from('profiles').select('name, role').eq('id', sub).single());
  const membershipsPromise = loadMemberships(client, sub);
  // Don't leave rejections unhandled if verification fails first.
  membershipsPromise.catch(() => {});
  const checked = await verify(token, parts.header);
  const [profileResult, memberships, bannedUntil] = await Promise.all([
    profilePromise,
    membershipsPromise.catch((error) => { console.error('[auth] memberships failed:', error.code || error.message); throw new HttpError(503, 'Could not load your account. Please try again.'); }),
    checked.checkedBan ? checked.bannedUntil : bannedUntilOf(sub),
  ]);
  if (profileResult.error) throw new HttpError(503, 'Could not load your account. Please try again.');
  return { user: checked.user, profile: profileResult.data, memberships, bannedUntil, client, exp: parts.payload.exp };
}

/** Validates the bearer token and loads the caller's profile with their own RLS permissions. */
export async function requireUser(request) {
  const match = request.headers.authorization?.match(/^Bearer (\S+)$/i);
  if (!match) throw new HttpError(401, 'Please sign in to continue.');
  if (!configured) throw new HttpError(503, 'Authentication is not configured on the server.');
  const token = match[1];
  const key = tokenKey(token);
  let entry = authCache.get(key);
  if (!entry) {
    const version = currentAuthVersion();
    entry = await resolve(token);
    const ttl = Math.min(AUTH_TTL_MS, entry.exp ? entry.exp * 1000 - Date.now() : AUTH_TTL_MS);
    if (ttl > 0 && version === currentAuthVersion()) authCache.set(key, entry, ttl);
  }
  // A suspended user's access token stays valid until it expires; refuse it now.
  if (entry.bannedUntil && new Date(entry.bannedUntil) > new Date()) throw new HttpError(403, 'Your access has been suspended. Contact your Cravio administrator.');
  return { user: entry.user, token, client: entry.client, profile: entry.profile, memberships: entry.memberships };
}

export async function requireRole(request, ...roles) {
  const context = await requireUser(request);
  if (!roles.includes(context.profile.role)) throw new HttpError(403, 'You do not have access to this.');
  return context;
}
