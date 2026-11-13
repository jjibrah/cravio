/*
 * Pure formatting helpers: money, opening hours, restaurant kinds. No Supabase and no React, so the guest menu
 * can use them without pulling in the signed-in client. lib/onboarding.js re-exports these for older imports.
 */

const kes = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });

/** Money everywhere: "Ksh 1,650" (other currencies keep their code). */
export const formatPrice = (value, currency = 'KES') => `${currency === 'KES' ? 'Ksh' : currency} ${kes.format(Number(value) || 0)}`;

/** Guest-facing money, as on printed Kenyan menus: "Ksh 1,650". */
export const formatKsh = (value, currency = 'KES') => `${currency === 'KES' ? 'Ksh' : currency} ${kes.format(Number(value) || 0)}`;

export const KINDS = [
  { key: 'restaurant', label: 'Restaurant', hint: 'Sit-down dining', icon: 'utensils' },
  { key: 'cafe', label: 'Café', hint: 'Coffee, breakfast, light meals', icon: 'cup' },
  { key: 'bar_grill', label: 'Bar & grill', hint: 'Drinks and nyama', icon: 'flame' },
  { key: 'hotel', label: 'Hotel', hint: 'Restaurant inside a hotel', icon: 'bed' },
  { key: 'fast_food', label: 'Fast food', hint: 'Quick service and takeaway', icon: 'bag' },
];
export const kindLabel = (key) => KINDS.find((kind) => kind.key === key)?.label || '';

export const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];
export const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
const DAY_NAMES = Object.fromEntries(DAYS);
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const toMinutes = (time) => {
  const [h, m] = String(time || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

/** "8am", "10:30pm" from "08:00" / "22:30". */
export const clock = (time) => {
  const minutes = toMinutes(time);
  if (minutes === null) return '';
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
};

/** "Every day, 8am–10pm", "Mon–Fri, 8am–10pm", or "Open 5 days a week". */
export function hoursSummary(hours) {
  if (!hours?.days) return '';
  const open = DAYS.filter(([day]) => hours.days[day]?.open);
  if (!open.length) return 'Closed';
  const times = new Set(open.map(([day]) => `${hours.days[day].from}-${hours.days[day].to}`));
  const range = times.size === 1 ? `${clock(hours.days[open[0][0]].from)}–${clock(hours.days[open[0][0]].to)}` : '';
  const label = open.length === 7 ? 'Every day' : open.length === 5 && open.every(([day]) => WEEKDAYS.has(day)) ? 'Mon–Fri' : `Open ${open.length} day${open.length === 1 ? '' : 's'} a week`;
  return range ? `${label}, ${range}` : label;
}

/** One row per day for an hours table: [{ key, name, text, today }]. */
export function weekHours(hours, now = new Date()) {
  if (!hours?.days) return [];
  const today = DAY_KEYS[now.getDay()];
  return DAYS.map(([key, name]) => {
    const day = hours.days[key];
    return { key, name, today: key === today, text: day?.open ? `${clock(day.from)}–${clock(day.to)}` : 'Closed' };
  });
}

/** { open, label }: "Open now · until 10pm", "Closed · opens 8am", "Closed · opens Monday 8am"; null when hours are unknown. */
export function openStatus(hours, now = new Date()) {
  if (!hours?.days) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const span = (key) => {
    const day = hours.days[key];
    if (!day?.open) return null;
    const from = toMinutes(day.from);
    const to = toMinutes(day.to);
    if (from === null || to === null) return null;
    return { from, to: to <= from ? to + 1440 : to, day };
  };
  // Yesterday's late hours may still be running (e.g. 6pm–2am).
  const yesterday = span(DAY_KEYS[(now.getDay() + 6) % 7]);
  if (yesterday && minutes + 1440 < yesterday.to) return { open: true, label: `Open now · until ${clock(yesterday.day.to)}` };
  const current = span(DAY_KEYS[now.getDay()]);
  if (current && minutes >= current.from && minutes < current.to) return { open: true, label: `Open now · until ${clock(current.day.to)}` };
  if (current && minutes < current.from) return { open: false, label: `Closed · opens ${clock(current.day.from)}` };
  for (let offset = 1; offset <= 7; offset++) {
    const key = DAY_KEYS[(now.getDay() + offset) % 7];
    const next = span(key);
    if (next) return { open: false, label: `Closed · opens ${offset === 1 ? 'tomorrow' : DAY_NAMES[key]} ${clock(next.day.from)}` };
  }
  return { open: false, label: 'Closed' };
}
