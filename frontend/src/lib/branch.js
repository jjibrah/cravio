/*
 * The branch (restaurant) the signed-in user is working in. Every staff API call sends it as X-Cravio-Branch
 * (lib/api.js) and the backend checks it against the caller's memberships, so the URL or this value alone
 * never grants anything. Switching branch empties the API cache, so no screen shows the previous branch's data.
 * Kept per tab in sessionStorage so a reload (or onboarding, which has no branch in its URL) stays put.
 */
import { setBranchScope } from './cache';

const KEY = 'cravio-branch';
const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
const write = (value) => { try { if (value) sessionStorage.setItem(KEY, JSON.stringify(value)); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } };
let stored = read(); // { user, id } — the branch belongs to the user who chose it
let active = stored?.id || null;
setBranchScope(active);

export const getActiveBranch = () => active;

/** Called on every sign-in state change: another user (or signing out) forgets the branch. */
export function bindBranchUser(userId) {
  if (stored?.user && stored.user === userId) return;
  stored = userId ? { user: userId, id: null } : null;
  active = null;
  write(null);
  setBranchScope(null);
}

export function setActiveBranch(id) {
  const next = id || null;
  if (next === active) return;
  active = next;
  stored = { user: stored?.user || null, id: next };
  write(next ? stored : null);
  setBranchScope(next);
}

/** Branches this account works at with the given role ('manager' | 'waiter'). */
export const branchesWithRole = (account, role) => (account?.branches || []).filter((branch) => branch.role === role);

/** The account's branch for an id, or null. */
export const findBranch = (account, id) => (account?.branches || []).find((branch) => branch.id === id) || null;

/** `/branch/<id>/<path>` for the active branch. */
export function branchPath(path = '', id = active) {
  const clean = String(path).replace(/^\/+/, '');
  return `/branch/${id}${clean ? `/${clean}` : ''}`;
}
