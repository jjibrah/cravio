import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import usePolling from '../../lib/usePolling';
import { useNotifications } from '../notifications/NotificationProvider';
import { useAuth } from '../../lib/auth';

/*
 * One /api/ops/live poll for the whole waiter app (every 10 s, cursor-based, paused while hidden), shared by the
 * tabs and the Services badge. Mutations apply the returned object locally straight away, then re-fetch in full.
 * Errors back off 10 → 20 → 40 → 60 s and show a quiet "Reconnecting…".
 */

const LiveContext = createContext(null);
const BACKOFF = [0, 20000, 40000, 60000];
const FRESH_FOR = 12000;

const tableNo = (thing) => thing?.table?.number;
const label = (request) => ({ call_waiter: 'Call waiter', bill: 'Bill', payment: 'Wants to pay' }[request.type] || request.typeLabel);

/**
 * Everything that needs a waiter, newest first: guest requests, guests ready to order (go and confirm it with
 * them), confirmed orders to serve, and served orders to settle.
 */
export function attentionItems(data) {
  if (!data) return [];
  const list = [];
  for (const request of data.requests || []) list.push({ key: `r:${request.id}`, kind: 'request', at: request.createdAt, table: tableNo(request), request });
  for (const cart of data.readyToOrder || []) list.push({ key: `c:${cart.id}`, kind: 'ready', at: cart.readyAt, table: cart.tableNumber ?? undefined, cart });
  for (const order of data.orders || []) {
    if (order.nextAction === 'serve') list.push({ key: `o:${order.id}:confirmed`, kind: 'serve', at: order.takenAt || order.createdAt, table: tableNo(order), order });
    if (order.status === 'served') list.push({ key: `o:${order.id}:served`, kind: 'pay', at: order.servedAt || order.updatedAt, table: tableNo(order), order });
  }
  return list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const describe = (item) => {
  const where = item.table ? `Table ${item.table}` : 'Takeaway';
  if (item.kind === 'request') return `${where}: ${label(item.request)}`;
  if (item.kind === 'ready') return `${item.table ? `Table ${item.table}` : 'A guest'} is ready to order`;
  if (item.kind === 'serve') return `${where}: confirmed, to serve`;
  return `${where}: served, waiting to pay`;
};

export function LiveProvider({ children }) {
  const { notify } = useNotifications();
  const cursor = useRef(null);
  const failures = useRef(0);
  const nextTry = useRef(0);
  const seen = useRef(null);
  const [live, setLive] = useState(null);
  const [offset, setOffset] = useState(0);
  const [fresh, setFresh] = useState({});
  const [announcement, setAnnouncement] = useState('');
  const [reconnecting, setReconnecting] = useState(false);

  const take = useCallback((data) => {
    const items = attentionItems(data);
    if (seen.current) {
      const added = items.filter((item) => !seen.current.has(item.key));
      if (added.length) {
        const now = Date.now();
        setFresh((current) => ({ ...current, ...Object.fromEntries(added.map((item) => [item.key, now])) }));
        setAnnouncement(`New: ${added.map(describe).join('. ')}`);
      }
    }
    seen.current = new Set(items.map((item) => item.key));
    setLive(data);
  }, []);

  const load = useCallback(async (signal) => {
    if (Date.now() < nextTry.current) return undefined;
    try {
      const data = await api(`/api/ops/live${cursor.current ? `?since=${encodeURIComponent(cursor.current)}` : ''}`, { signal });
      failures.current = 0;
      nextTry.current = 0;
      setReconnecting(false);
      cursor.current = data.cursor;
      if (data.serverTime) setOffset(Date.now() - Date.parse(data.serverTime));
      if (data.changed === false) return undefined;
      take(data);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      failures.current += 1;
      nextTry.current = Date.now() + BACKOFF[Math.min(failures.current, BACKOFF.length - 1)];
      setReconnecting(true);
      throw error;
    }
  }, [take]);

  const { error, loading, refresh } = usePolling(load, { interval: 10000 });

  /** Full re-fetch (no cursor), e.g. after the waiter's own change. */
  const refreshNow = useCallback(() => {
    cursor.current = null;
    nextTry.current = 0;
    refresh();
    setTimeout(() => { if (cursor.current === null) refresh(); }, 1200);
  }, [refresh]);

  // The header's Refresh button re-fetches everything.
  const { refreshVersion } = useAuth();
  useEffect(() => { if (refreshVersion) refreshNow(); }, [refreshVersion, refreshNow]);

  // Fresh highlights fade after a few seconds.
  useEffect(() => {
    const keys = Object.keys(fresh);
    if (!keys.length) return undefined;
    const timer = setTimeout(() => setFresh((current) => Object.fromEntries(Object.entries(current).filter(([, at]) => Date.now() - at < FRESH_FOR))), FRESH_FOR + 100);
    return () => clearTimeout(timer);
  }, [fresh]);

  const patchLive = useCallback((fn) => setLive((current) => {
    if (!current) return current;
    const next = fn(current);
    seen.current = new Set(attentionItems(next).map((item) => item.key));
    return next;
  }), []);
  const putOrder = useCallback((order) => patchLive((current) => {
    const open = ['taken', 'accepted', 'served'].includes(order.status);
    const others = (current.orders || []).filter((item) => item.id !== order.id);
    return { ...current, orders: open ? [...others, order] : others };
  }), [patchLive]);
  const putRequest = useCallback((request) => patchLive((current) => {
    const others = (current.requests || []).filter((item) => item.id !== request.id);
    return { ...current, requests: request.status === 'resolved' ? others : [...others, request] };
  }), [patchLive]);

  /** Runs a staff action: local update, API call, success note; 409 refreshes with a note; other errors throw. */
  const run = useCallback(async (call, { optimistic, success } = {}) => {
    const undo = live;
    if (optimistic) optimistic();
    try {
      const result = await call();
      if (result?.order) putOrder(result.order);
      if (result?.request) putRequest(result.request);
      if (success) notify(typeof success === 'function' ? success(result) : success);
      refreshNow();
      return result;
    } catch (actionError) {
      if (undo) setLive(undo);
      if (actionError.status === 409 || actionError.status === 404) {
        notify(`${actionError.message} The list is up to date now.`, { type: 'info', duration: 6000 });
        refreshNow();
        return null;
      }
      throw actionError;
    }
  }, [live, notify, putOrder, putRequest, refreshNow]);

  const actions = useMemo(() => ({
    acknowledge: (request) => run(() => api(`/api/ops/requests/${request.id}/acknowledge`, { method: 'POST' }), {
      optimistic: () => putRequest({ ...request, status: 'acknowledged', acknowledgedAt: new Date().toISOString() }),
      success: `Table ${tableNo(request)}: they know you’re on the way`,
    }),
    resolve: (request) => run(() => api(`/api/ops/requests/${request.id}/resolve`, { method: 'POST' }), {
      optimistic: () => putRequest({ ...request, status: 'resolved' }),
      success: `Table ${tableNo(request)}: ${label(request).toLowerCase()} done`,
    }),
    advance: (order) => run(() => api(`/api/ops/orders/${order.id}/advance`, { method: 'POST', body: { from: order.status } }), {
      success: `Order #${order.shortId} marked served`,
    }),
    pay: (order, method, reference) => run(() => api(`/api/ops/orders/${order.id}/pay`, { method: 'POST', body: { method, from: order.status, ...(reference ? { reference } : {}) } }), {
      success: `Order #${order.shortId} paid`,
    }),
    cancel: (order) => run(() => api(`/api/ops/orders/${order.id}/cancel`, { method: 'POST', body: { from: order.status } }), {
      success: `Order #${order.shortId} cancelled`,
    }),
    /** After Confirm order: show the order at once and clear that guest's "ready to order" item. */
    created: (order, cartCode) => {
      putOrder(order);
      // The claimed cart drops out of readyToOrder on the next live refresh.
      refreshNow();
    },
  }), [run, putOrder, putRequest, patchLive, refreshNow]);

  const items = useMemo(() => attentionItems(live), [live]);
  const value = useMemo(() => ({
    live, items, offset, loading: loading && !live, error: live ? null : error, reconnecting: reconnecting && Boolean(error),
    fresh, announcement, refreshNow, actions,
  }), [live, items, offset, loading, error, reconnecting, fresh, announcement, refreshNow, actions]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  const context = useContext(LiveContext);
  if (!context) throw new Error('useLive needs LiveProvider (WaiterLayout).');
  return context;
}

/** Re-renders every `every` ms so "2 min" labels stay current between polls. */
export function useTicker(every = 15000) {
  const [, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick((n) => n + 1), every); return () => clearInterval(timer); }, [every]);
}

/** "Just now", "4 min", "1 h 5 min", using the server clock offset. */
export function ageText(at, offset = 0) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - offset - Date.parse(at)) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
