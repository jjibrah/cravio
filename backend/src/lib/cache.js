// Small in-process caches. One process, in memory: they reset on restart and aren't shared between
// instances. Before running more than one backend instance, either keep TTLs short (they are) or move
// invalidation to a shared channel (for example Postgres LISTEN/NOTIFY or Redis pub/sub).
import { createHash } from 'node:crypto';

/** A Map-based LRU with a per-entry TTL. */
export class TtlLru {
  constructor({ max = 500, ttlMs = 30_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.map.delete(key); return undefined; }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }

  delete(key) { return this.map.delete(key); }

  /** Deletes every entry whose value matches. */
  deleteWhere(predicate) {
    let removed = 0;
    for (const [key, entry] of this.map) if (predicate(entry.value, key)) { this.map.delete(key); removed += 1; }
    return removed;
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/* ---------- Signed-in context (lib/auth.js) ---------- */

export const AUTH_TTL_MS = 30_000;
/** token hash -> { user, profile, memberships, bannedUntil, client } */
export const authCache = new TtlLru({ max: 2000, ttlMs: AUTH_TTL_MS });

export const tokenKey = (token) => createHash('sha256').update(token).digest('base64url');

/**
 * Forget every cached session of a user. Call after anything that changes what requireUser resolves:
 * suspend/reactivate, role or name change, invites, membership changes.
 */
export function invalidateUser(userId) {
  if (!userId) return 0;
  authVersion += 1;
  nameCache.delete(userId);
  return authCache.deleteWhere((value) => value.user?.id === userId);
}

let authVersion = 0;
/** Bumped by every invalidation, so a context resolved while one happened isn't cached. */
export const currentAuthVersion = () => authVersion;

/** Forget cached sessions of every member of a restaurant (its name or status changed). */
export function invalidateRestaurantMembers(restaurantId) {
  if (!restaurantId) return 0;
  authVersion += 1;
  return authCache.deleteWhere((value) => (value.memberships || []).some((row) => row.restaurant?.id === restaurantId));
}

/** user id -> display name, for "taken by" labels on orders and requests (lib/operations.js namesFor). */
export const nameCache = new TtlLru({ max: 5000, ttlMs: 5 * 60_000 });

/* ---------- Public guest menu (routes/public-menu.js) ---------- */

export const MENU_TTL_MS = 60_000;
/** restaurant id -> prepared public menu (or a "not available" marker) */
export const menuCache = new TtlLru({ max: 500, ttlMs: MENU_TTL_MS });

const menuVersions = new Map();

/** Bumped by every invalidation, so a menu built while a write happened isn't cached. */
export const menuVersion = (restaurantId) => menuVersions.get(String(restaurantId).toLowerCase()) || 0;

/** Call after any write that changes what guests see: menu, design, deals, tables, restaurant details, go-live. */
export function invalidateMenu(restaurantId) {
  if (!restaurantId) return false;
  const key = String(restaurantId).toLowerCase();
  menuVersions.set(key, (menuVersions.get(key) || 0) + 1);
  if (menuVersions.size > 5000) menuVersions.clear(); // bounded; a reset only costs one rebuild
  return menuCache.delete(key);
}
