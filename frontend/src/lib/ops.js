import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import usePolling from './usePolling';

/*
 * Live operations: API wrappers, formatters and plain-language labels shared by the owner pages
 * (and safe for the waiter app to import). Times show in the restaurant's local time, Africa/Nairobi.
 */

export const TIME_ZONE = 'Africa/Nairobi';

/* ---------- Formatters ---------- */

const kes = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 });

/** "Ksh 1,750". */
export const formatKes = (value) => `Ksh ${kes.format(Number(value) || 0)}`;
/** "Ksh 12.4K" for tight spaces such as chart axes. */
export const formatKesCompact = (value) => `Ksh ${compact.format(Number(value) || 0)}`;
/** "1,750". */
export const formatNumber = (value) => whole.format(Number(value) || 0);
/** "#92da2e". */
export const shortId = (order) => `#${order?.shortId || String(order?.id || '').slice(0, 6)}`;

const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "10:45". */
export const formatClock = (iso) => (iso ? clockFormat.format(new Date(iso)) : '');
/** "31 Oct". */
export const formatDate = (iso) => (iso ? dateFormat.format(new Date(iso)) : '');
/** "31 Oct 10:45". */
export const formatDateTime = (iso) => (iso ? `${formatDate(iso)} ${formatClock(iso)}` : '');
/** "Sat 8 Nov" for a YYYY-MM-DD Nairobi day. */
export const formatDayLabel = (ymd) => dayFormat.format(new Date(`${ymd}T12:00:00+03:00`));
/** Today's Nairobi date as YYYY-MM-DD, optionally shifted by whole days. */
export function nairobiDate(offsetDays = 0, now = Date.now()) {
  return isoDay.format(new Date(now + offsetDays * 86400000));
}

/** "Just now", "4 min ago", "2 h ago", "Yesterday", "11 days ago". */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (nairobiDate(-1, now) === isoDay.format(new Date(iso))) return 'Yesterday';
  const days = Math.max(2, Math.round(hours / 24));
  return `${days} days ago`;
}

/** "Waiting 4 min" style age for live requests. */
export function formatAge(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'Under a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** Change against the previous period: { diff, percent, direction }. `percent` is null when the previous value is 0. */
export function delta(current, previous) {
  if (previous === null || previous === undefined) return null;
  const diff = (Number(current) || 0) - (Number(previous) || 0);
  const percent = previous > 0 ? Math.round((diff / previous) * 100) : null;
  return { diff, percent, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' };
}

export const plural = (count, one, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

/* ---------- Labels ---------- */

/**
 * The agreed flow (docs/ORDER-FLOW.md): Confirmed (with the guest, at the table) → Served → Paid.
 * `taken` is "Confirmed". Older `accepted` orders also read as Confirmed.
 */
export const ORDER_STAGES = [
  { key: 'taken', label: 'Confirmed' },
  { key: 'served', label: 'Served' },
  { key: 'paid', label: 'Paid' },
];
/** The stage an order is at: older `accepted` orders sit at Confirmed. */
export const stageOf = (status) => (status === 'accepted' ? 'taken' : status);
export const ORDER_STATUS = {
  taken: { label: 'Confirmed', filter: 'Confirmed' },
  accepted: { label: 'Confirmed', filter: 'Confirmed' },
  served: { label: 'Served', filter: 'Served' },
  paid: { label: 'Paid', filter: 'Paid' },
  cancelled: { label: 'Cancelled', filter: 'Cancelled' },
};
export const statusLabel = (status) => ORDER_STATUS[status]?.label || status;
export const NEXT_ACTION = {
  serve: { label: 'Mark served', short: 'Served', done: 'Marked as served.' },
  pay: { label: 'Mark paid', short: 'Paid', done: 'Marked as paid.' },
};

/**
 * How an order was confirmed: the guest's QR scanned, the code typed from their screen, or entered by a waiter
 * without the guest's phone. `null` for orders from before this was recorded.
 */
export const CONFIRMATION = {
  qr: { tag: 'Confirmed with the guest (QR)', how: 'QR', warn: false },
  code: { tag: 'Confirmed with the guest (typed code)', how: 'typed code', warn: false },
  manual: { tag: 'Entered by waiter, not confirmed by the guest', how: null, warn: true },
};
export const confirmationOf = (order) => CONFIRMATION[order?.confirmation] || null;

/** "+ Cheese, + Bacon" */
export const extrasText = (extras = []) => extras.map((extra) => `+ ${extra.name}`).join(', ');
/** "Classic beef burger, Chips, 2× Tusker" */
export const componentsText = (parts = []) => parts.map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ');
/** One order line in words: "2× Classic beef burger + Cheese" or "Burger meal: Classic beef burger, Chips, Stoney". */
export function lineText(line, { quantity = true } = {}) {
  const head = `${quantity && line.quantity > 1 ? `${line.quantity}× ` : ''}${line.name}`;
  if (line.kind === 'deal' && line.components?.length) return `${head}: ${componentsText(line.components)}`;
  return line.extras?.length ? `${head} ${extrasText(line.extras)}` : head;
}
export const PAY_METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'mpesa', label: 'M-Pesa' },
  { key: 'card', label: 'Card' },
  { key: 'other', label: 'Other' },
];
export const payMethodLabel = (key) => PAY_METHODS.find((method) => method.key === key)?.label || key;

/** What a guest request means, in words a person would say. */
export const REQUEST_TYPES = {
  call_waiter: { title: 'needs help', label: 'Needs help', detail: 'Called for a waiter', state: 'attention' },
  bill: { title: 'wants the bill', label: 'Wants the bill', detail: 'Asked for the bill', state: 'bill' },
  payment: { title: 'wants to pay', label: 'Wants to pay', detail: 'Ready to pay', state: 'bill' },
};

export const TABLE_STATES = {
  free: { label: 'Free' },
  ordering: { label: 'Ordering' },
  attention: { label: 'Needs help' },
  bill: { label: 'Wants the bill' },
};

/** The tile label for a table from /api/ops/live or /api/ops/tables. */
export function tableStateLabel(table) {
  if (table?.state === 'bill') return table.requestTypes?.includes('payment') && !table.requestTypes?.includes('bill') ? 'Wants to pay' : 'Wants the bill';
  return TABLE_STATES[table?.state]?.label || 'Free';
}

/** "2× Chicken wings + Cheese · Burger meal: Classic beef burger, Chips +2 more". */
export function itemsSummary(items = [], max = 2) {
  const shown = items.slice(0, max).map((line) => lineText(line)).join(' · ');
  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

export const tableName = (order) => (order?.table?.number ? `Table ${order.table.number}` : 'Takeaway');

/* ---------- API wrappers ---------- */

const post = (path, body) => api(path, { method: 'POST', body });

export const opsApi = {
  live: (since, signal) => api(`/api/ops/live${since ? `?since=${encodeURIComponent(since)}` : ''}`, { signal }),
  acknowledge: (id) => post(`/api/ops/requests/${id}/acknowledge`),
  resolve: (id) => post(`/api/ops/requests/${id}/resolve`),
  orders: (params = {}, signal) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return api(`/api/ops/orders${query.size ? `?${query}` : ''}`, { signal });
  },
  order: (id, signal) => api(`/api/ops/orders/${id}`, { signal }),
  advance: (id, from) => post(`/api/ops/orders/${id}/advance`, { from }),
  pay: (id, from, method, reference) => post(`/api/ops/orders/${id}/pay`, { from, method, ...(reference ? { reference } : {}) }),
  cancel: (id, from, reason) => post(`/api/ops/orders/${id}/cancel`, { from, ...(reason ? { reason } : {}) }),
  tables: (signal) => api('/api/ops/tables', { signal }),
  table: (number, signal) => api(`/api/ops/tables/${number}`, { signal }),
  addTables: (count) => post('/api/ops/tables', { count }),
  removeTable: (number) => api(`/api/ops/tables/${number}`, { method: 'DELETE' }),
  analytics: (range = 'today', signal) => api(`/api/ops/analytics?range=${range}`, { signal }),
  health: (signal) => api('/api/ops/health', { signal }),
};

export const menuApi = {
  load: (signal) => api('/api/restaurant/onboarding', { signal }),
  updateRestaurant: (patch) => api('/api/restaurant', { method: 'PATCH', body: patch }),
  addCategory: (name) => post('/api/restaurant/categories', { name }),
  updateCategory: (id, patch) => api(`/api/restaurant/categories/${id}`, { method: 'PATCH', body: patch }),
  removeCategory: (id) => api(`/api/restaurant/categories/${id}`, { method: 'DELETE' }),
  addItem: (item) => post('/api/restaurant/items', item),
  updateItem: (id, patch) => api(`/api/restaurant/items/${id}`, { method: 'PATCH', body: patch }),
  removeItem: (id) => api(`/api/restaurant/items/${id}`, { method: 'DELETE' }),
  reorderItems: (categoryId, ids) => api('/api/restaurant/items/order', { method: 'PUT', body: { categoryId, ids } }),
};

/* ---------- Hooks ---------- */

/**
 * Polls /api/ops/live every ~10s with the cursor. `data` is the last full snapshot; `offset` is the
 * clock correction (Date.now() − serverTime). `reload()` fetches everything again (after a mutation).
 */
export function useLive({ interval = 10000, enabled = true } = {}) {
  const cursor = useRef(null);
  const [offset, setOffset] = useState(0);
  const poll = usePolling(async (signal) => {
    const result = await opsApi.live(cursor.current, signal);
    setOffset(Date.now() - Date.parse(result.serverTime));
    cursor.current = result.cursor;
    return result.changed === false ? undefined : result;
  }, { interval, enabled });
  const { refresh } = poll;
  const loaded = useRef(false);
  if (poll.data) loaded.current = true;
  // usePolling skips its first refresh when a StrictMode remount races the aborted first run; kick it once.
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => { if (!loaded.current) refresh(); }, 80);
    return () => clearTimeout(timer);
  }, [enabled, refresh]);
  const reload = useCallback(() => { cursor.current = null; return refresh(); }, [refresh]);
  return { ...poll, reload, offset, cursor: poll.data?.cursor };
}

/** A clock that ticks every `interval` ms, for "4 min ago" labels. */
export function useNow(interval = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

/** Loads once (and again when `deps` change); returns { data, error, loading, reload, setData }. */
export function useResource(load, deps = []) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const controller = useRef(null);
  const reload = useCallback(async ({ quiet = false } = {}) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    if (!quiet) setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await loadRef.current(current.signal);
      if (!current.signal.aborted) setState({ data, error: null, loading: false });
    } catch (error) {
      if (error.name !== 'AbortError' && !current.signal.aborted) setState((previous) => ({ ...previous, error, loading: false }));
    }
  }, []);
  useEffect(() => { reload(); return () => controller.current?.abort(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const setData = useCallback((update) => setState((previous) => ({ ...previous, data: typeof update === 'function' ? update(previous.data) : update })), []);
  return { ...state, reload, setData };
}

export function useMediaQuery(query) {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return Boolean(matches);
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Ids that appeared since the previous render of `list` (never on the first load). Cleared after `ms`. */
export function useNewArrivals(list, ms = 4000) {
  const seen = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  useEffect(() => {
    if (!list) return undefined;
    const ids = list.map((entry) => entry.id);
    if (seen.current === null) { seen.current = new Set(ids); return undefined; }
    const added = ids.filter((id) => !seen.current.has(id));
    ids.forEach((id) => seen.current.add(id));
    if (!added.length) return undefined;
    setFresh((current) => new Set([...current, ...added]));
    setTimeout(() => setFresh((current) => { const next = new Set(current); added.forEach((id) => next.delete(id)); return next; }), ms);
    return undefined;
  }, [list, ms]);
  return fresh;
}
