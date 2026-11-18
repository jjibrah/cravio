/*
 * A small stale-while-revalidate cache for GET responses, keyed by request path.
 *
 * - `swr(key, fetcher, { ttl })` answers from memory at once. Within `ttl` it doesn't touch the network;
 *   after it, it still answers from memory and revalidates in the background.
 * - Identical requests in flight are shared (one network call).
 * - The cache belongs to one signed-in user: `setCacheScope(userId)` clears it when the user changes
 *   or signs out, and a response that lands after the switch is dropped.
 * - `invalidate('/api/ops')` marks every key with that prefix stale and tells subscribers, which revalidate.
 *
 * Memory is the cache. Inventory GETs (see `persisted`) are also written to sessionStorage, keyed by user + branch + URL, so
 * a reload or a revisit shows the last answer at once (up to PERSIST_TTL old) and refreshes it in the background. Writes
 * (`invalidate`) drop the stored copies too; signing out, or a different user, wipes them.
 * `subscribeBusy` tells the UI when such a background refresh is running (the "Updating…" pill).
 */

const entries = new Map(); // key -> { data?, at, promise? }  (at = 0 means stale)
const listeners = new Map(); // key -> Set<fn>
let scope = null;
let generation = 0;

const hasData = (entry) => Boolean(entry) && Object.prototype.hasOwnProperty.call(entry, 'data');

function notify(key) {
  listeners.get(key)?.forEach((listener) => listener());
}

export const getCacheScope = () => scope;

/* ---------- sessionStorage copies (inventory GETs only) ---------- */

const STORE = 'cravio-swr:';
const PERSIST_TTL = 10 * 60 * 1000;
const PERSIST_MAX = 400000; // characters; bigger answers stay in memory only
const persisted = (key) => /^\/api\/(owner\/inventory|inventory)(\/|\?|$)/.test(key);
const storeKey = (key) => `${STORE}${scope}|${branchScope}|${key}`;
const storeKeys = () => { try { return Object.keys(sessionStorage).filter((name) => name.startsWith(STORE)); } catch { return []; } };

function readStored(key) {
  if (!scope || !persisted(key)) return undefined;
  try {
    const raw = sessionStorage.getItem(storeKey(key));
    if (!raw) return undefined;
    const { at, data } = JSON.parse(raw);
    if (!(Date.now() - at < PERSIST_TTL)) { sessionStorage.removeItem(storeKey(key)); return undefined; }
    return { data, at };
  } catch { return undefined; }
}

function writeStored(key, data, at) {
  if (!scope || !persisted(key)) return;
  try {
    const text = JSON.stringify({ at, data });
    if (text.length <= PERSIST_MAX) sessionStorage.setItem(storeKey(key), text); else sessionStorage.removeItem(storeKey(key));
  } catch { /* storage full or blocked: memory still works */ }
}

function dropStored(prefix, { all = false } = {}) {
  const head = `${STORE}${scope}|${branchScope}|`;
  try {
    for (const name of storeKeys()) if (all || name.startsWith(head + prefix)) sessionStorage.removeItem(name);
  } catch { /* storage blocked */ }
}

/* The entry for `key`, brought in from sessionStorage when memory has none. */
function lookup(key) {
  let entry = entries.get(key);
  if (!entry) {
    const stored = readStored(key);
    if (stored) { entry = stored; entries.set(key, entry); }
  }
  return entry;
}

/* ---------- background refreshes, for the "Updating…" pill ---------- */

const busy = new Set();
const busyListeners = new Set();
const setBusy = (key, on) => {
  if (on === busy.has(key)) return;
  if (on) busy.add(key); else busy.delete(key);
  busyListeners.forEach((listener) => listener());
};
/** For useSyncExternalStore: how many cached inventory screens are refreshing behind data already shown. */
export const subscribeBusy = (listener) => { busyListeners.add(listener); return () => busyListeners.delete(listener); };
export const busyCount = () => busy.size;

/** Sets the signed-in user the cache belongs to; a different user (or null) empties it. */
export function setCacheScope(next) {
  const value = next || null;
  if (value === scope) return;
  // Stored copies of another user (or of nobody, after sign-out) must not outlive the switch.
  try { for (const name of storeKeys()) if (!value || !name.startsWith(`${STORE}${value}|`)) sessionStorage.removeItem(name); } catch { /* storage blocked */ }
  scope = value;
  clearCache();
}

let branchScope = null;
/** Sets the branch the cached answers belong to; a different branch empties the cache (lib/branch.js). */
export function setBranchScope(next) {
  const value = next || null;
  if (value === branchScope) return;
  branchScope = value;
  clearCache();
}

export function clearCache() {
  generation += 1;
  const keys = [...entries.keys()];
  entries.clear();
  busy.clear();
  busyListeners.forEach((listener) => listener());
  keys.forEach(notify);
}

/** The cached entry for `key` ({ data, at }) or undefined. */
export function peek(key) {
  const entry = lookup(key);
  return hasData(entry) ? entry : undefined;
}

/** Writes data for `key` (e.g. an optimistic update or a polled snapshot) and tells subscribers. */
export function setCached(key, data) {
  const entry = entries.get(key);
  const at = Date.now();
  entries.set(key, { ...entry, data, at });
  writeStored(key, data, at);
  notify(key);
}

/** Marks every key starting with `prefix` stale; subscribers revalidate. */
export function invalidate(prefix = '') {
  dropStored(prefix);
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    if (hasData(entry)) entry.at = 0; else if (!entry.promise) entries.delete(key);
    notify(key);
  }
}

export function subscribe(key, listener) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(listener);
  return () => {
    const set = listeners.get(key);
    set?.delete(listener);
    if (set && !set.size) listeners.delete(key);
  };
}

export const isFresh = (entry, ttl) => hasData(entry) && entry.at > 0 && Date.now() - entry.at < ttl;
export const isFetching = (key) => Boolean(entries.get(key)?.promise);

/** Fetches `key` now, sharing a request already in flight. Resolves with the new data. */
export function revalidate(key, fetcher, { quiet = false } = {}) {
  const entry = lookup(key);
  if (entry?.promise) return entry.promise;
  const startedIn = generation;
  // Only a refresh behind data already on screen counts as "updating"; a first load has its skeleton.
  const background = !quiet && hasData(entry) && persisted(key);
  if (background) setBusy(key, true);
  const promise = Promise.resolve().then(fetcher).then((data) => {
    if (background) setBusy(key, false);
    if (startedIn === generation) {
      const at = Date.now();
      entries.set(key, { data, at });
      writeStored(key, data, at);
      notify(key);
    }
    return data;
  }, (error) => {
    if (background) setBusy(key, false);
    if (startedIn === generation) {
      const current = entries.get(key);
      if (current?.promise === promise) {
        delete current.promise;
        if (!hasData(current)) entries.delete(key);
      }
    }
    throw error;
  });
  entries.set(key, { ...entry, at: entry?.at ?? 0, promise });
  return promise;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Stale-while-revalidate read. Cached data comes back at once (and is revalidated in the background
 * once older than `ttl`); with nothing cached, or with `force`, it waits for the network.
 * `signal` only stops this caller from waiting; a shared request carries on for the others.
 */
export function swr(key, fetcher, { ttl = 30000, force = false, signal } = {}) {
  const entry = lookup(key);
  if (!force && hasData(entry)) {
    if (!isFresh(entry, ttl)) revalidate(key, fetcher).catch(() => { /* the next read retries */ });
    return Promise.resolve(entry.data);
  }
  return abortable(revalidate(key, fetcher), signal);
}
