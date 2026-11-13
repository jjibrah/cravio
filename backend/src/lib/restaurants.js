import { HttpError } from './http.js';
import { invalidateUser } from './cache.js';

/* Restaurants, membership and onboarding: shared by /api/me, /api/restaurant and the admin invite flow. */

export const RESTAURANT_COLUMNS = 'id, owner_id, name, kind, area, address, lat, lng, opening_hours, phone, logo_url, cover_url, theme, status, went_live_at, created_at, updated_at';

/** Onboarding steps in order. Keep in sync with frontend/src/lib/onboarding.js. */
// 'photos' (cover + dish photos) replaced the old 'cover' step; 'cover' stays valid so saved progress still resolves.
export const STEP_KEYS = ['name', 'kind', 'location', 'hours', 'logo', 'phone', 'tables', 'sections', 'staff',
  'menu-method', 'categories', 'items', 'photos', 'theme', 'preview', 'cover'];
export const SKIPPABLE_STEPS = ['logo', 'phone', 'sections', 'staff', 'photos', 'cover'];
export const KINDS = ['restaurant', 'cafe', 'bar_grill', 'hotel', 'fast_food'];
export const THEMES = ['classic', 'savanna', 'midnight', 'garden'];
const ROLE_RANK = { owner: 0, manager: 1, waiter: 2 };

/**
 * Creates a restaurant in 'onboarding' state and its owner membership, using a service-role client.
 * Called by the admin "invite owner" endpoint and by onboarding when an owner has no restaurant yet.
 * Owners have one restaurant for now: if this owner already has one, that one is returned unchanged.
 * @returns {Promise<{ id: string, name: string, status: string }>}
 */
export async function createRestaurantForOwner(service, { ownerId, name }) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  if (!ownerId) throw new HttpError(400, 'An owner is required to create a restaurant.');
  if (!cleanName) throw new HttpError(400, 'Enter the restaurant name.');

  let restaurant;
  const { data, error } = await service.from('restaurants')
    .insert({ owner_id: ownerId, name: cleanName, status: 'onboarding' })
    .select('id, name, status').single();
  if (error?.code === '23505') {
    const { data: existing, error: readError } = await service.from('restaurants')
      .select('id, name, status').eq('owner_id', ownerId).single();
    if (readError) throw readError;
    restaurant = existing;
  } else if (error) {
    throw error;
  } else {
    restaurant = data;
  }

  const { error: memberError } = await service.from('restaurant_members')
    .upsert({ restaurant_id: restaurant.id, user_id: ownerId, role: 'owner' }, { onConflict: 'restaurant_id,user_id' });
  if (memberError) throw memberError;
  const { error: progressError } = await service.from('onboarding_progress')
    .upsert({ restaurant_id: restaurant.id }, { onConflict: 'restaurant_id', ignoreDuplicates: true });
  if (progressError) throw progressError;
  invalidateUser(ownerId); // their cached sign-in context has no membership yet
  return { id: restaurant.id, name: restaurant.name, status: restaurant.status };
}

/** True when the error means migration 002 hasn't been applied yet. */
export function isMissingSchema(error) {
  return ['42P01', 'PGRST205', 'PGRST200'].includes(error?.code);
}

/**
 * The caller's primary membership and its restaurant (owner > manager > waiter), or null.
 * Uses the caller's client, so RLS decides what they can see.
 */
export async function findMembership(client, userId, roles = ['owner', 'manager', 'waiter']) {
  const { data, error } = await client.from('restaurant_members')
    .select(`role, created_at, restaurant:restaurants (${RESTAURANT_COLUMNS})`)
    .eq('user_id', userId).in('role', roles);
  if (error) throw error;
  const rows = (data || []).filter((row) => row.restaurant)
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.created_at.localeCompare(b.created_at));
  return rows[0] || null;
}

/** The primary membership (owner > manager > waiter, then oldest) among already-loaded rows, or null. */
export function pickMembership(rows, roles = ['owner', 'manager', 'waiter']) {
  return (rows || []).filter((row) => row.restaurant && roles.includes(row.role))
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.created_at.localeCompare(b.created_at))[0] || null;
}

/** A short area string for the sidebar: the area, or the first part of the address. */
export function shortLocation(restaurant) {
  const area = restaurant?.area?.trim();
  if (area) return area;
  return restaurant?.address?.split(',')[0]?.trim() || '';
}

export function placeFor(restaurant) {
  if (!restaurant) return null;
  return { id: restaurant.id, name: restaurant.name, status: restaurant.status, location: shortLocation(restaurant) };
}

/* ---------- Validation ---------- */

export function text(value, label, { max = 120, required = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') {
    if (required) throw new HttpError(400, `Enter ${label}.`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${capitalise(label)} must be text.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean && required) throw new HttpError(400, `Enter ${label}.`);
  if (clean.length > max) throw new HttpError(400, `${capitalise(label)} must be ${max} characters or fewer.`);
  return clean || null;
}

export function capitalise(value) { return value.charAt(0).toUpperCase() + value.slice(1); }

export function email(value) {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!clean) throw new HttpError(400, 'Enter an email address.');
  if (clean.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new HttpError(400, 'Enter a valid email address, like name@example.com.');
  return clean;
}

/** Lenient Kenyan phone check: accepts 07…, 01…, 7…, +254…, with spaces or dashes. Returns +254XXXXXXXXX. */
export function kenyanPhone(value, { required = false } = {}) {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw === '+254') {
    if (required) throw new HttpError(400, 'Enter a phone number.');
    return null;
  }
  const digits = raw.replace(/[\s\-().]/g, '');
  let local;
  if (/^\+254\d{9}$/.test(digits)) local = digits.slice(4);
  else if (/^254\d{9}$/.test(digits)) local = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) local = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) local = digits;
  else if (/^\+\d{7,15}$/.test(digits)) return digits; // other countries: keep as typed
  else throw new HttpError(400, 'Enter a phone number like +254 712 345 678.');
  if (!/^[17]/.test(local)) throw new HttpError(400, 'Kenyan numbers start with 7 or 1 after +254.');
  return `+254${local}`;
}

export function price(value) {
  const number = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new HttpError(400, 'Enter a price in KES.');
  if (number < 0) throw new HttpError(400, 'Price can’t be negative.');
  if (number > 99_999_999) throw new HttpError(400, 'That price is too high.');
  return Math.round(number * 100) / 100;
}

/**
 * A public URL of a file uploaded to this restaurant's folder of the restaurant-media bucket.
 * @param folder optional sub-folder the file must be in, e.g. 'deals' for '<restaurantId>/deals/…'
 */
export function mediaUrl(value, restaurantId, label, noun = 'image', folder = null) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) throw new HttpError(400, `${capitalise(label)} must be an uploaded ${noun}.`);
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, `${capitalise(label)} must be an uploaded ${noun}.`); }
  const base = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL) : null;
  const expected = `/storage/v1/object/public/restaurant-media/${restaurantId}/${folder ? `${folder}/` : ''}`;
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new HttpError(400, `${capitalise(label)} must be an uploaded ${noun}.`);
  if ((base && url.host !== base.host) || !url.pathname.startsWith(expected)) throw new HttpError(400, `${capitalise(label)} must be uploaded to this restaurant.`);
  return url.toString();
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** { preset: 'everyday'|'weekdays'|'custom', days: { mon: { open, from, to }, … } } */
export function openingHours(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Opening hours are invalid.');
  const preset = ['everyday', 'weekdays', 'custom'].includes(value.preset) ? value.preset : 'custom';
  const days = {};
  for (const day of DAYS) {
    const entry = value.days?.[day] || {};
    const open = Boolean(entry.open);
    const from = TIME.test(entry.from || '') ? entry.from : '08:00';
    const to = TIME.test(entry.to || '') ? entry.to : '22:00';
    if (open && from === to) throw new HttpError(400, 'Opening and closing times can’t be the same.');
    days[day] = { open, from, to };
  }
  if (!DAYS.some((day) => days[day].open)) throw new HttpError(400, 'Choose at least one day you’re open.');
  return { preset, days };
}

export function hasOpeningHours(hours) {
  return Boolean(hours?.days && DAYS.some((day) => hours.days[day]?.open));
}

export function stepKey(value, label = 'step') {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !(STEP_KEYS.includes(value) || value === 'done')) throw new HttpError(400, `Unknown ${label}.`);
  return value;
}

/** What blocks go-live. Each entry names the step that fixes it. */
export function missingForGoLive({ restaurant, tables, items }) {
  const missing = [];
  if (!restaurant.name?.trim()) missing.push({ step: 'name', message: 'Add your restaurant’s name.' });
  if (!restaurant.area?.trim() && !restaurant.address?.trim()) missing.push({ step: 'location', message: 'Add where you are.' });
  if (!hasOpeningHours(restaurant.opening_hours)) missing.push({ step: 'hours', message: 'Add your opening hours.' });
  if (!tables.length) missing.push({ step: 'tables', message: 'Add at least one table.' });
  if (!items.length) missing.push({ step: 'items', message: 'Add at least one item to your menu.' });
  if (!THEMES.includes(restaurant.theme)) missing.push({ step: 'theme', message: 'Pick a look for your menu.' });
  return missing;
}
