import { api, useApi } from '../../lib/api';

/*
 * Shared bits for the owner's Products page and its editors: the merchandising API (docs/API.md §9 and §14),
 * the menu read through the SWR cache, small icons that ui.jsx doesn't have, and Ksh formatting.
 * Every write goes through api(), which marks /api/restaurant (and /api/ops) stale, so the menu refetches.
 */

export const MENU_PATH = '/api/restaurant/menu';

/** GET /api/restaurant/menu through the cache: categories, items (extras, pairings, stats), featured, deals, limits. */
export const useMenu = () => useApi(MENU_PATH, { ttl: 20000 });

const send = (method) => (path, body) => api(path, { method, body });
const post = send('POST');
const patch = send('PATCH');
const put = send('PUT');
const del = (path) => api(path, { method: 'DELETE' });

export const merchApi = {
  addCategory: (name) => post('/api/restaurant/categories', { name }),
  updateCategory: (id, body) => patch(`/api/restaurant/categories/${id}`, body),
  removeCategory: (id) => del(`/api/restaurant/categories/${id}`),
  orderCategories: (ids) => put('/api/restaurant/categories/order', { ids }),
  addItem: (body) => post('/api/restaurant/items', body),
  updateItem: (id, body) => patch(`/api/restaurant/items/${id}`, body),
  removeItem: (id) => del(`/api/restaurant/items/${id}`),
  orderItems: (categoryId, ids) => put('/api/restaurant/items/order', { categoryId, ids }),
  setFeatured: (itemIds) => put('/api/restaurant/featured', { itemIds }),
  setPairings: (id, itemIds, mirror) => put(`/api/restaurant/items/${id}/pairings`, { itemIds, mirror }),
  addExtra: (itemId, body) => post(`/api/restaurant/items/${itemId}/extras`, body),
  updateExtra: (id, body) => patch(`/api/restaurant/extras/${id}`, body),
  removeExtra: (id) => del(`/api/restaurant/extras/${id}`),
  orderExtras: (itemId, ids) => put(`/api/restaurant/items/${itemId}/extras/order`, { ids }),
  addDeal: (body) => post('/api/restaurant/deals', body),
  updateDeal: (id, body) => patch(`/api/restaurant/deals/${id}`, body),
  removeDeal: (id) => del(`/api/restaurant/deals/${id}`),
  orderDeals: (ids) => put('/api/restaurant/deals/order', { ids }),
};

const ksh = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
/** "Ksh 1,150". */
export const formatKsh = (value) => `Ksh ${ksh.format(Number(value) || 0)}`;
export const formatCount = (value) => whole.format(Number(value) || 0);
export const pluralize = (count, one, many = `${one}s`) => `${formatCount(count)} ${count === 1 ? one : many}`;
export const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

/** Parses "1,150" or "1150.5" to a number, or NaN. */
export const parseMoney = (text) => (String(text).trim() === '' ? NaN : Number(String(text).replace(/[,\s]/g, '')));

/** Moves the entry at `from` to `to` in a copy of `list`. */
export function moveIn(list, from, to) {
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

/** What a media filter means for a dish. */
export const MEDIA_FILTERS = {
  photo: (item) => Boolean(item.photoUrl),
  video: (item) => Boolean(item.videoUrl),
  none: (item) => !item.photoUrl && !item.videoUrl,
};

const PATHS = {
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z" />,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></>,
  grip: <><circle cx="9" cy="6" r="1.1" /><circle cx="15" cy="6" r="1.1" /><circle cx="9" cy="12" r="1.1" /><circle cx="15" cy="12" r="1.1" /><circle cx="9" cy="18" r="1.1" /><circle cx="15" cy="18" r="1.1" /></>,
  plusCircle: <><circle cx="12" cy="12" r="9.5" /><path d="M12 8v8M8 12h8" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  bag: <><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" /><path d="M3 6h18M16 10a4 4 0 0 1-8 0" /></>,
  tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="8" cy="8" r="1.5" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M16 2.5v4M8 2.5v4M3 10h18" /></>,
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
};

/** Icons the Products and Insights pages need beyond OIcon (ui.jsx is shared, so they live here). */
export function PIcon({ name, size = 18, strokeWidth = 1.8, filled = false, className, ...props }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{PATHS[name]}</svg>;
}

/** The "On sale" switch: words beside the track, so state is never colour alone. */
export function SaleSwitch({ on, onToggle, label, busy, onText = 'On sale', offText = 'Sold out', className = '' }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy}
    className={`o-switch pc-switch${on ? ' is-on' : ''} ${className}`} onClick={(event) => { event.stopPropagation(); onToggle(); }}>
    <span className="o-switch-track" aria-hidden="true"><span className="o-switch-thumb" /></span>
    <span className="o-switch-label">{on ? onText : offText}</span>
  </button>;
}

/** Featured star toggle. */
export function StarToggle({ on, onToggle, name, disabled }) {
  return <button type="button" className={`pc-star${on ? ' is-on' : ''}`} aria-pressed={on} disabled={disabled}
    aria-label={`Feature ${name}`} title={on ? 'Featured on your menu. Click to unfeature' : 'Feature on your menu'}
    onClick={(event) => { event.stopPropagation(); onToggle(); }}>
    <PIcon name="star" size={18} filled={on} strokeWidth={1.7} />
  </button>;
}
