import { useCallback, useEffect, useReducer, useState } from 'react';
import { supabase } from './supabase';
import { invalidate, peek, revalidate, setCached, subscribe, swr } from './cache';
import { getActiveBranch } from './branch';

export { invalidate } from './cache';

/** Fired (on window) when something learns the account's feature flags may be out of date; AuthProvider re-reads /api/me. */
export const ACCOUNT_STALE = 'cravio:account-stale';

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}${path}`, {
    method,
    signal,
    headers: {
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(getActiveBranch() ? { 'X-Cravio-Branch': getActiveBranch() } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((error) => {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && data.details?.code === 'inventory_disabled' && typeof window !== 'undefined') {
    // The account we hold may say inventory is on: ask /api/me again (lib/auth.jsx listens).
    window.dispatchEvent(new Event(ACCOUNT_STALE));
  }
  if (!response.ok) throw new ApiError(response.status, data.error || 'Something went wrong. Please try again.', data.details);
  return data;
}

/*
 * What a write under `path` can make stale. Specific rules first; otherwise the write's own area
 * (`/api/ops/...` → every `/api/ops` key), and menu or restaurant edits also touch the live views.
 */
const STALE_AFTER = [
  [/^\/api\/ops\/requests\//, ['/api/ops/live', '/api/ops/tables']],
  [/^\/api\/ops\/orders/, ['/api/ops/live', '/api/ops/orders', '/api/ops/tables', '/api/ops/analytics']],
  [/^\/api\/restaurant\/onboarding\/progress/, ['/api/restaurant/onboarding']],
];
function invalidateAfter(path) {
  const clean = path.split('?')[0];
  const rule = STALE_AFTER.find(([pattern]) => pattern.test(clean));
  if (rule) { rule[1].forEach((prefix) => invalidate(prefix)); return; }
  const area = clean.split('/')[2];
  if (!area) return;
  invalidate(`/api/${area}`);
  if (area === 'restaurant') invalidate('/api/ops');
}

/**
 * Calls the Cravio backend as the signed-in user. Throws ApiError with the server's message.
 *
 * GETs can opt in to the stale-while-revalidate cache: `api(path, { cache: 'swr', ttl })` answers from
 * memory when it can (see lib/cache.js). `force: true` skips a cached answer (but joins a request already
 * in flight). Any other method marks what it can change stale (see STALE_AFTER), so cached screens refetch.
 */
const inFlight = new Map(); // `${branch}|${path}` -> promise, for plain GETs asked twice at once

export async function api(path, { method = 'GET', body, signal, cache, ttl, force, quiet } = {}) {
  if (cache === 'swr' && method === 'GET') {
    // `quiet`: a background poll (no "Updating…" pill); always goes to the network.
    if (quiet) return revalidate(path, () => request(path), { quiet: true });
    return swr(path, () => request(path), { ttl, force, signal });
  }
  if (method === 'GET') {
    // Two components asking for the same URL at the same moment share one request (unless one can abort it).
    if (signal) return request(path, { method, body, signal });
    const id = `${getActiveBranch() || ''}|${path}`;
    if (!inFlight.has(id)) inFlight.set(id, request(path).finally(() => inFlight.delete(id)));
    return inFlight.get(id);
  }
  try {
    return await request(path, { method, body, signal });
  } finally {
    invalidateAfter(path);
  }
}

/** Warms the cache for a GET without waiting for it (e.g. on hover). Errors are ignored. */
export function prefetchApi(path, { ttl = 30000 } = {}) {
  return api(path, { cache: 'swr', ttl }).catch(() => undefined);
}

/**
 * Reads `path` through the cache and keeps it current: { data, error, loading, refresh, reload, setData }.
 * Cached data renders immediately; stale data revalidates in the background; `invalidate()` on the path's
 * prefix (or any write through api()) refetches it. `refresh()` always goes to the network.
 * `reload` is an alias of `refresh` that accepts (and ignores) `{ quiet }`, matching `useResource`.
 */
export function useApi(path, { ttl = 30000, enabled = true } = {}) {
  const [, rerender] = useReducer((count) => count + 1, 0);
  const [status, setStatus] = useState({ key: path, error: null, fetching: false });
  const active = Boolean(path) && enabled;
  const entry = active ? peek(path) : undefined;
  const error = status.key === path ? status.error : null;

  const fetcher = useCallback(() => request(path), [path]);
  const run = useCallback((promise) => {
    setStatus({ key: path, error: null, fetching: true });
    return promise.then((data) => {
      setStatus((current) => (current.key === path ? { key: path, error: null, fetching: false } : current));
      return data;
    }, (problem) => {
      if (problem?.name !== 'AbortError') setStatus((current) => (current.key === path ? { key: path, error: problem, fetching: false } : current));
      return undefined;
    });
  }, [path]);

  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = subscribe(path, () => {
      const current = peek(path);
      // Invalidated (at 0) or dropped: fetch again; otherwise just show the new data.
      if (current && current.at === 0) run(revalidate(path, fetcher));
      rerender();
    });
    run(swr(path, fetcher, { ttl }));
    return unsubscribe;
  }, [active, path, ttl, fetcher, run]);

  const refresh = useCallback(() => (active ? run(revalidate(path, fetcher)) : Promise.resolve(undefined)), [active, path, fetcher, run]);
  const setData = useCallback((update) => {
    if (!active) return;
    const previous = peek(path)?.data;
    const next = typeof update === 'function' ? update(previous) : update;
    setCached(path, next);
  }, [active, path]);

  const data = entry?.data;
  return { data, error, loading: active && data === undefined && !error, fetching: status.fetching, refresh, reload: refresh, setData };
}
