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
 * Everything lives in memory only; nothing is written to storage.
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

/** Sets the signed-in user the cache belongs to; a different user (or null) empties it. */
export function setCacheScope(next) {
  const value = next || null;
  if (value === scope) return;
  scope = value;
  clearCache();
}

export function clearCache() {
  generation += 1;
  const keys = [...entries.keys()];
  entries.clear();
  keys.forEach(notify);
}

/** The cached entry for `key` ({ data, at }) or undefined. */
export function peek(key) {
  const entry = entries.get(key);
  return hasData(entry) ? entry : undefined;
}

/** Writes data for `key` (e.g. an optimistic update or a polled snapshot) and tells subscribers. */
export function setCached(key, data) {
  const entry = entries.get(key);
  entries.set(key, { ...entry, data, at: Date.now() });
  notify(key);
}

/** Marks every key starting with `prefix` stale; subscribers revalidate. */
export function invalidate(prefix = '') {
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
export function revalidate(key, fetcher) {
  const entry = entries.get(key);
  if (entry?.promise) return entry.promise;
  const startedIn = generation;
  const promise = Promise.resolve().then(fetcher).then((data) => {
    if (startedIn === generation) {
      entries.set(key, { data, at: Date.now() });
      notify(key);
    }
    return data;
  }, (error) => {
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
  const entry = entries.get(key);
  if (!force && hasData(entry)) {
    if (!isFresh(entry, ttl)) revalidate(key, fetcher).catch(() => { /* the next read retries */ });
    return Promise.resolve(entry.data);
  }
  return abortable(revalidate(key, fetcher), signal);
}
