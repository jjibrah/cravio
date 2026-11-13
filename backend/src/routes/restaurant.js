// Owned by the onboarding work: restaurant setup, tables, menu, staff invites, go-live.
import { requireRole } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { serviceClient } from '../lib/supabase.js';
import {
  KINDS, RESTAURANT_COLUMNS, SKIPPABLE_STEPS, STEP_KEYS, THEMES, createRestaurantForOwner, email, findMembership,
  isMissingSchema, kenyanPhone, mediaUrl, missingForGoLive, openingHours, price, text,
} from '../lib/restaurants.js';
import { sendStaffInvites } from '../lib/staff-invites.js';
import { videoFields, videoOut, withVideoColumns } from '../lib/menu-media.js';
import { invalidateMenu, invalidateRestaurantMembers } from '../lib/cache.js';
import { LIMITS, hasMerchSchema, requireMerch } from '../lib/menu-merch.js';
import { pickMembership } from '../lib/restaurants.js';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PLACEHOLDER_NAME = 'New restaurant';
const MAX_TABLES = 200;
const INVITE_COLUMNS = 'id, name, email, phone, role, status, error, sent_at, user_id, created_at';
const BASE_ITEM_COLUMNS = 'id, category_id, name, description, price, currency, photo_url, position, available, source, created_at';
/** Item columns, plus the dish video columns (migration 003) and featured columns (004) once applied. */
const itemColumns = async (client) => {
  const columns = await withVideoColumns(client, BASE_ITEM_COLUMNS);
  return (await hasMerchSchema(client)) ? `${columns}, featured, featured_position` : columns;
};

/*
 * The onboarding flow as the app walks it: a skippable 'photos' step (cover + dish photos) follows 'items',
 * and the look section's old 'cover' step is gone. lib/restaurants.js still lists 'cover'; it stays a
 * known key so progress saved before the change (currentStep 'cover', skippedSteps ['cover']) still validates.
 */
const FLOW_STEPS = STEP_KEYS.includes('photos')
  ? STEP_KEYS.filter((key) => key !== 'cover')
  : STEP_KEYS.flatMap((key) => (key === 'cover' ? [] : key === 'items' ? ['items', 'photos'] : [key]));
const FLOW_SKIPPABLE = [...new Set([...SKIPPABLE_STEPS, 'photos'])];
const KNOWN_STEPS = new Set([...FLOW_STEPS, ...STEP_KEYS, 'done']);

function stepKey(value, label = 'step') {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !KNOWN_STEPS.has(value)) throw new HttpError(400, `Unknown ${label}.`);
  return value;
}

/* ---------- Serialisers: the API speaks camelCase ---------- */

const restaurantOut = (r) => r && ({
  id: r.id, name: r.name, kind: r.kind, area: r.area, address: r.address, lat: r.lat, lng: r.lng,
  openingHours: r.opening_hours, phone: r.phone, logoUrl: r.logo_url, coverUrl: r.cover_url, theme: r.theme,
  status: r.status, wentLiveAt: r.went_live_at,
});
const sectionOut = (s) => ({ id: s.id, name: s.name, position: s.position });
const tableOut = (t) => ({ id: t.id, number: t.number, label: t.label, sectionId: t.section_id });
const categoryOut = (c) => ({ id: c.id, name: c.name, position: c.position });
const itemOut = (i) => ({
  id: i.id, categoryId: i.category_id, name: i.name, description: i.description, price: Number(i.price),
  currency: i.currency, photoUrl: i.photo_url, position: i.position, available: i.available, source: i.source,
  ...videoOut(i),
  featured: Boolean(i.featured), featuredPosition: i.featured ? i.featured_position ?? null : null,
});
const inviteOut = (i) => ({ id: i.id, name: i.name, email: i.email, phone: i.phone, role: i.role, status: i.status, error: i.error, sentAt: i.sent_at });
const progressOut = (p) => ({
  currentStep: p?.current_step || null, completedSteps: p?.completed_steps || [], skippedSteps: p?.skipped_steps || [],
  data: p?.data || {}, updatedAt: p?.updated_at || null,
});

/** Turns Supabase errors into clear HTTP errors; unknown ones become a logged 503. */
function check(error, messages = {}) {
  if (!error) return;
  if (error instanceof HttpError) throw error;
  if (isMissingSchema(error)) throw new HttpError(503, 'Restaurant setup isn’t available yet. The database update hasn’t been applied.');
  if (error.code === '23505') throw new HttpError(409, messages.duplicate || 'That already exists.');
  if (error.code === '23514' || error.code === '22P02') throw new HttpError(400, messages.invalid || 'Some details are invalid. Check them and try again.');
  if (error.code === '42501') throw new HttpError(403, 'You do not have access to this.');
  throw error;
}

/**
 * Owner (or manager, whose profile role is also 'owner') and the restaurant they manage.
 * With `create`, an owner without a restaurant gets one, created with the service client.
 */
async function ownerContext(request, { create = false } = {}) {
  const context = await requireRole(request, 'owner');
  let membership;
  try {
    membership = context.memberships ? pickMembership(context.memberships, ['owner', 'manager'])
      : await findMembership(context.client, context.user.id, ['owner', 'manager']);
  } catch (error) { check(error); }
  if (!membership && create) {
    const invitedName = context.user.user_metadata?.restaurant_name;
    const service = serviceClient();
    try {
      await createRestaurantForOwner(service, { ownerId: context.user.id, name: invitedName || PLACEHOLDER_NAME });
      if (!invitedName) {
        const { data: own } = await service.from('restaurants').select('id').eq('owner_id', context.user.id).single();
        if (own) await service.from('onboarding_progress').update({ data: { namePlaceholder: true } }).eq('restaurant_id', own.id);
      }
      membership = await findMembership(context.client, context.user.id, ['owner', 'manager']);
    } catch (error) { check(error); }
  }
  if (!membership) throw new HttpError(404, 'Set up your restaurant first.');
  // Remembered so the write wrapper below can invalidate this restaurant's cached guest menu.
  request.cravioRestaurantId = membership.restaurant.id;
  return { ...context, role: membership.role, restaurant: membership.restaurant, restaurantId: membership.restaurant.id };
}

/** Featured on/off from PATCH /api/restaurant/items/:id. On appends to the end of the featured list. */
async function featuredFields(client, restaurantId, body, current) {
  if (body.featured === undefined) return {};
  if (typeof body.featured !== 'boolean') throw new HttpError(400, 'featured must be true or false.', { field: 'featured' });
  await requireMerch(client);
  if (!body.featured) return { featured: false, featured_position: null };
  if (current.featured) return {};
  const { data, error } = await client.from('menu_items').select('featured_position').eq('restaurant_id', restaurantId).eq('featured', true);
  check(error);
  if (data.length >= LIMITS.featured) throw new HttpError(400, `You can feature up to ${LIMITS.featured} dishes. Unfeature one first.`, { field: 'featured' });
  return { featured: true, featured_position: data.reduce((max, row) => Math.max(max, row.featured_position ?? -1), -1) + 1 };
}

async function loadState(client, restaurantId) {
  const ITEM_COLUMNS = await itemColumns(client);
  const scoped = (table, columns, order = 'position') => client.from(table).select(columns).eq('restaurant_id', restaurantId).order(order);
  const [restaurant, sections, tables, categories, items, invites, progress] = await Promise.all([
    client.from('restaurants').select(RESTAURANT_COLUMNS).eq('id', restaurantId).single(),
    scoped('restaurant_sections', 'id, name, position'),
    scoped('restaurant_tables', 'id, number, label, section_id', 'number'),
    scoped('menu_categories', 'id, name, position'),
    scoped('menu_items', ITEM_COLUMNS),
    scoped('staff_invites', INVITE_COLUMNS, 'created_at'),
    client.from('onboarding_progress').select('current_step, completed_steps, skipped_steps, data, updated_at').eq('restaurant_id', restaurantId).maybeSingle(),
  ]);
  for (const result of [restaurant, sections, tables, categories, items, invites, progress]) check(result.error);
  return {
    restaurant: restaurantOut(restaurant.data),
    sections: sections.data.map(sectionOut),
    tables: tables.data.map(tableOut),
    categories: categories.data.map(categoryOut),
    items: items.data.map(itemOut),
    invites: invites.data.map(inviteOut),
    progress: progressOut(progress.data),
    steps: { order: FLOW_STEPS, skippable: FLOW_SKIPPABLE },
  };
}

function list(value, label, { max, itemMax = 40 }) {
  if (!Array.isArray(value)) throw new HttpError(400, `Send ${label} as a list.`);
  if (value.length > max) throw new HttpError(400, `Choose ${max} ${label} or fewer.`);
  const seen = new Set();
  const names = [];
  for (const entry of value) {
    const name = text(entry, `each of the ${label}`, { max: itemMax, required: true });
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

function idList(value, label, max = 50) {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, `Send the ${label} as a list of ids.`, { field: 'ids' });
  if (value.length > max) throw new HttpError(400, `Send up to ${max} ${label} at a time.`, { field: 'ids' });
  const uuid = new RegExp(`^${UUID}$`);
  if (value.some((id) => typeof id !== 'string' || !uuid.test(id))) throw new HttpError(400, `Each of the ${label} must be an id.`, { field: 'ids' });
  const ids = value.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, `Each of the ${label} can appear only once.`, { field: 'ids' });
  return ids;
}

/** Makes a restaurant's named rows (sections, categories) match `names`, in order. */
async function syncNamed(client, table, restaurantId, names, columns) {
  const { data: existing, error } = await client.from(table).select('id, name, position').eq('restaurant_id', restaurantId);
  check(error);
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]));
  const keep = new Set(names.map((name) => name.toLowerCase()));
  const remove = existing.filter((row) => !keep.has(row.name.toLowerCase())).map((row) => row.id);
  if (remove.length) check((await client.from(table).delete().in('id', remove)).error);
  for (const [position, name] of names.entries()) {
    const row = byName.get(name.toLowerCase());
    if (!row) check((await client.from(table).insert({ restaurant_id: restaurantId, name, position })).error, { duplicate: `“${name}” is already there.` });
    else if (row.position !== position || row.name !== name) check((await client.from(table).update({ name, position }).eq('id', row.id)).error);
  }
  const { data, error: readError } = await client.from(table).select(columns).eq('restaurant_id', restaurantId).order('position');
  check(readError);
  return data;
}

async function requireCategory(client, restaurantId, categoryId) {
  if (typeof categoryId !== 'string' || !new RegExp(`^${UUID}$`).test(categoryId)) throw new HttpError(400, 'Choose a category for this item.');
  const { data, error } = await client.from('menu_categories').select('id').eq('id', categoryId).eq('restaurant_id', restaurantId).maybeSingle();
  check(error);
  if (!data) throw new HttpError(400, 'That category no longer exists. Pick another one.');
  return data.id;
}

function itemFields(body, restaurantId, { partial = false } = {}) {
  const fields = {};
  const name = text(body.name, 'the item name', { max: 80, required: !partial });
  if (name !== undefined) { if (!name) throw new HttpError(400, 'Enter the item name.'); fields.name = name; }
  if (body.price !== undefined || !partial) fields.price = price(body.price);
  const description = text(body.description, 'the description', { max: 280 });
  if (description !== undefined) fields.description = description;
  const photo = mediaUrl(body.photoUrl, restaurantId, 'the photo');
  if (photo !== undefined) fields.photo_url = photo;
  if (body.available !== undefined) fields.available = Boolean(body.available);
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 10_000) throw new HttpError(400, 'Position is invalid.');
    fields.position = body.position;
  }
  if (!partial) fields.source = body.source === 'template' ? 'template' : 'manual';
  return fields;
}

async function nextItemPosition(client, restaurantId, categoryId) {
  const { data, error } = await client.from('menu_items').select('position').eq('restaurant_id', restaurantId).eq('category_id', categoryId)
    .order('position', { ascending: false }).limit(1);
  check(error);
  return (data[0]?.position ?? -1) + 1;
}

function inviteFields(body, { partial = false } = {}) {
  const fields = {};
  const name = text(body.name, 'their name', { max: 120, required: !partial });
  if (name !== undefined) { if (!name) throw new HttpError(400, 'Enter their name.'); fields.name = name; }
  if (body.email !== undefined || !partial) fields.email = email(body.email);
  const phone = kenyanPhone(body.phone);
  if (phone !== undefined) fields.phone = phone;
  if (body.role !== undefined || !partial) {
    if (!['waiter', 'manager'].includes(body.role)) throw new HttpError(400, 'Choose Waiter or Manager.');
    fields.role = body.role;
  }
  return fields;
}

async function sendPending(restaurantId) {
  const service = serviceClient();
  const { data: pending, error } = await service.from('staff_invites').select(INVITE_COLUMNS)
    .eq('restaurant_id', restaurantId).in('status', ['queued', 'failed']).order('created_at');
  check(error);
  return (await sendStaffInvites(service, restaurantId, pending)).map(inviteOut);
}

async function readProgress(client, restaurantId) {
  const { data, error } = await client.from('onboarding_progress').select('current_step, completed_steps, skipped_steps, data, updated_at')
    .eq('restaurant_id', restaurantId).maybeSingle();
  check(error);
  return data;
}

const PROGRESS_DATA_KEYS = {
  menuMethod: (v) => ['manual', 'template'].includes(v),
  activeCategoryId: (v) => v === null || (typeof v === 'string' && new RegExp(`^${UUID}$`).test(v)),
  namePlaceholder: (v) => typeof v === 'boolean',
  tourCompleted: (v) => typeof v === 'boolean',
  checklistDismissed: (v) => typeof v === 'boolean',
};

/**
 * Every write here can change what guests see (menu, tables, details, go-live), so after it runs the
 * restaurant's cached public menu is dropped. Restaurant details and go-live also change what /api/me shows.
 */
function invalidating(route) {
  if (route.method === 'GET') return route;
  return {
    ...route,
    async handler(context) {
      try {
        return await route.handler(context);
      } finally {
        const id = context.request.cravioRestaurantId;
        if (id) {
          invalidateMenu(id);
          if (route.path === '/api/restaurant' || route.path === '/api/restaurant/go-live') invalidateRestaurantMembers(id);
        }
      }
    },
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/restaurant/onboarding',
    async handler({ request }) {
      const { client, restaurantId, role } = await ownerContext(request, { create: true });
      return { ...(await loadState(client, restaurantId)), role };
    },
  },
  {
    method: 'PATCH',
    path: '/api/restaurant',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const fields = {};
      const name = text(body.name, 'your restaurant’s name', { max: 120, required: body.name !== undefined });
      if (name !== undefined) fields.name = name;
      if (body.kind !== undefined) {
        if (!KINDS.includes(body.kind)) throw new HttpError(400, 'Choose what kind of place it is.');
        fields.kind = body.kind;
      }
      const area = text(body.area, 'the area', { max: 120 });
      if (area !== undefined) fields.area = area;
      const address = text(body.address, 'the street or building', { max: 240 });
      if (address !== undefined) fields.address = address;
      for (const [key, min, max] of [['lat', -90, 90], ['lng', -180, 180]]) {
        if (body[key] === undefined) continue;
        if (body[key] === null) { fields[key] = null; continue; }
        if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < min || body[key] > max) throw new HttpError(400, 'The map location is invalid.');
        fields[key] = body[key];
      }
      const hours = openingHours(body.openingHours);
      if (hours !== undefined) fields.opening_hours = hours;
      const phone = kenyanPhone(body.phone);
      if (phone !== undefined) fields.phone = phone;
      const logo = mediaUrl(body.logoUrl, restaurantId, 'the logo');
      if (logo !== undefined) fields.logo_url = logo;
      const cover = mediaUrl(body.coverUrl, restaurantId, 'the cover photo');
      if (cover !== undefined) fields.cover_url = cover;
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) throw new HttpError(400, 'Pick one of the looks.');
        fields.theme = body.theme;
      }
      if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
      const { data, error } = await client.from('restaurants').update(fields).eq('id', restaurantId).select(RESTAURANT_COLUMNS).single();
      check(error);
      if (fields.name) {
        const progress = await readProgress(client, restaurantId);
        if (progress?.data?.namePlaceholder) {
          check((await client.from('onboarding_progress').update({ data: { ...progress.data, namePlaceholder: false } }).eq('restaurant_id', restaurantId)).error);
        }
      }
      return { restaurant: restaurantOut(data) };
    },
  },
  {
    method: 'PUT',
    path: '/api/restaurant/onboarding/progress',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const current = await readProgress(client, restaurantId);
      const completed = new Set(current?.completed_steps || []);
      const skipped = new Set(current?.skipped_steps || []);
      const complete = stepKey(body.complete, 'completed step');
      const skip = stepKey(body.skip, 'skipped step');
      const reopen = stepKey(body.reopen, 'step');
      if (complete) { completed.add(complete); skipped.delete(complete); }
      if (skip) {
        if (!FLOW_SKIPPABLE.includes(skip)) throw new HttpError(400, 'This step is needed to go live, so it can’t be skipped.');
        skipped.add(skip); completed.delete(skip);
      }
      if (reopen) { completed.delete(reopen); }
      const data = { ...(current?.data || {}) };
      if (body.data !== undefined) {
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new HttpError(400, 'Progress details are invalid.');
        for (const [key, value] of Object.entries(body.data)) {
          if (!PROGRESS_DATA_KEYS[key]?.(value)) throw new HttpError(400, `Progress detail “${key}” is invalid.`);
          data[key] = value;
        }
      }
      const row = {
        restaurant_id: restaurantId,
        current_step: body.currentStep === undefined ? current?.current_step ?? null : stepKey(body.currentStep, 'current step'),
        completed_steps: [...completed], skipped_steps: [...skipped], data,
      };
      const { data: saved, error } = await client.from('onboarding_progress').upsert(row, { onConflict: 'restaurant_id' })
        .select('current_step, completed_steps, skipped_steps, data, updated_at').single();
      check(error);
      return { progress: progressOut(saved) };
    },
  },
  {
    method: 'PUT',
    path: '/api/restaurant/tables',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const count = body.count;
      if (!Number.isInteger(count) || count < 1) throw new HttpError(400, 'You need at least one table.');
      if (count > MAX_TABLES) throw new HttpError(400, `You can add up to ${MAX_TABLES} tables here. Contact Cravio for more.`);
      const { data: existing, error } = await client.from('restaurant_tables').select('id, number').eq('restaurant_id', restaurantId);
      check(error);
      const extra = existing.filter((table) => table.number > count).map((table) => table.id);
      if (extra.length) {
        // A live restaurant can't drop a table that still has an unpaid order (orders arrive in migration 003).
        const { count: busy, error: busyError } = await client.from('orders').select('id', { count: 'exact', head: true })
          .in('table_id', extra).in('status', ['taken', 'accepted', 'served']);
        if (busyError && !isMissingSchema(busyError)) check(busyError);
        if (busy) throw new HttpError(409, 'Some of the tables you’re removing still have unpaid orders. Finish or cancel them first.');
      }
      if (extra.length) check((await client.from('restaurant_tables').delete().in('id', extra)).error);
      const have = new Set(existing.map((table) => table.number));
      const missing = [];
      for (let number = 1; number <= count; number++) if (!have.has(number)) missing.push({ restaurant_id: restaurantId, number });
      if (missing.length) check((await client.from('restaurant_tables').insert(missing)).error);
      const { data, error: readError } = await client.from('restaurant_tables').select('id, number, label, section_id').eq('restaurant_id', restaurantId).order('number');
      check(readError);
      return { tables: data.map(tableOut) };
    },
  },
  {
    method: 'PUT',
    path: '/api/restaurant/sections',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const names = list(body.names, 'sections', { max: 12 });
      return { sections: (await syncNamed(client, 'restaurant_sections', restaurantId, names, 'id, name, position')).map(sectionOut) };
    },
  },
  {
    method: 'PUT',
    path: '/api/restaurant/categories',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const names = list(body.names, 'categories', { max: 20 });
      if (!names.length) throw new HttpError(400, 'Pick at least one category.');
      const categories = await syncNamed(client, 'menu_categories', restaurantId, names, 'id, name, position');
      const { data: items, error } = await client.from('menu_items').select(await itemColumns(client)).eq('restaurant_id', restaurantId).order('position');
      check(error);
      return { categories: categories.map(categoryOut), items: items.map(itemOut) };
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/categories',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const name = text(body.name, 'a category name', { max: 40, required: true });
      const { count, error: countError } = await client.from('menu_categories').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId);
      check(countError);
      if (count >= 20) throw new HttpError(400, 'You can have up to 20 categories.');
      const { data, error } = await client.from('menu_categories').insert({ restaurant_id: restaurantId, name, position: count })
        .select('id, name, position').single();
      check(error, { duplicate: `You already have a “${name}” category.` });
      return { category: categoryOut(data) };
    },
  },
  {
    method: 'PATCH',
    path: new RegExp(`^/api/restaurant/categories/(?<id>${UUID})$`),
    async handler({ request, body, params }) {
      const { client, restaurantId } = await ownerContext(request);
      const fields = {};
      const name = text(body.name, 'a category name', { max: 40, required: body.name !== undefined });
      if (name) fields.name = name;
      if (body.position !== undefined) {
        if (!Number.isInteger(body.position) || body.position < 0) throw new HttpError(400, 'Position is invalid.');
        fields.position = body.position;
      }
      if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
      const { data, error } = await client.from('menu_categories').update(fields).eq('id', params.id).eq('restaurant_id', restaurantId)
        .select('id, name, position').maybeSingle();
      check(error, { duplicate: `You already have a “${name}” category.` });
      if (!data) throw new HttpError(404, 'That category no longer exists.');
      return { category: categoryOut(data) };
    },
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/api/restaurant/categories/(?<id>${UUID})$`),
    async handler({ request, params }) {
      const { client, restaurantId } = await ownerContext(request);
      check((await client.from('menu_categories').delete().eq('id', params.id).eq('restaurant_id', restaurantId)).error);
    },
  },
  {
    // Reorder categories: send every category id in the new order.
    method: 'PUT',
    path: '/api/restaurant/categories/order',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const ids = idList(body.ids, 'categories');
      const { data: existing, error } = await client.from('menu_categories').select('id, position').eq('restaurant_id', restaurantId);
      check(error);
      const known = new Set(existing.map((row) => row.id));
      if (ids.length !== existing.length || ids.some((id) => !known.has(id))) {
        throw new HttpError(400, 'Send every category once, in the new order. Refresh and try again.', { field: 'ids' });
      }
      const current = new Map(existing.map((row) => [row.id, row.position]));
      const changes = ids.map((id, position) => ({ id, position })).filter(({ id, position }) => current.get(id) !== position);
      for (const result of await Promise.all(changes.map(({ id, position }) => client.from('menu_categories').update({ position }).eq('id', id).eq('restaurant_id', restaurantId)))) check(result.error);
      const { data, error: readError } = await client.from('menu_categories').select('id, name, position').eq('restaurant_id', restaurantId).order('position');
      check(readError);
      return { categories: data.map(categoryOut) };
    },
  },
  {
    // Reorder a category's items, or move items into it: the listed ids end up in categoryId, in this order.
    // Items already in the category but not listed keep their relative order after the listed ones.
    method: 'PUT',
    path: '/api/restaurant/items/order',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const categoryId = await requireCategory(client, restaurantId, body.categoryId);
      const ids = idList(body.ids, 'items', 200);
      const columns = await itemColumns(client);
      const { data: listed, error } = await client.from('menu_items').select('id').eq('restaurant_id', restaurantId).in('id', ids);
      check(error);
      if (listed.length !== ids.length) throw new HttpError(400, 'One of those items no longer exists. Refresh and try again.', { field: 'ids' });
      const { data: rest, error: restError } = await client.from('menu_items').select('id').eq('restaurant_id', restaurantId)
        .eq('category_id', categoryId).order('position').order('name');
      check(restError);
      const order = [...ids, ...rest.map((row) => row.id).filter((id) => !ids.includes(id))];
      for (const result of await Promise.all(order.map((id, position) => client.from('menu_items')
        .update({ category_id: categoryId, position }).eq('id', id).eq('restaurant_id', restaurantId)))) check(result.error);
      const { data, error: readError } = await client.from('menu_items').select(columns).eq('restaurant_id', restaurantId).eq('category_id', categoryId).order('position');
      check(readError);
      return { categoryId, items: data.map(itemOut) };
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/items',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const categoryId = await requireCategory(client, restaurantId, body.categoryId);
      const fields = itemFields(body, restaurantId);
      Object.assign(fields, videoFields(body, restaurantId));
      if (fields.position === undefined) fields.position = await nextItemPosition(client, restaurantId, categoryId);
      const { data, error } = await client.from('menu_items').insert({ ...fields, restaurant_id: restaurantId, category_id: categoryId })
        .select(await itemColumns(client)).single();
      check(error);
      return { item: itemOut(data) };
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/items/bulk',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Choose at least one item.');
      if (body.items.length > 60) throw new HttpError(400, 'Add up to 60 items at a time.');
      const positions = new Map();
      const rows = [];
      for (const [index, entry] of body.items.entries()) {
        let fields;
        try {
          const categoryId = await requireCategory(client, restaurantId, entry?.categoryId);
          fields = { ...itemFields(entry || {}, restaurantId), restaurant_id: restaurantId, category_id: categoryId };
          if (!positions.has(categoryId)) positions.set(categoryId, await nextItemPosition(client, restaurantId, categoryId));
          fields.position = positions.get(categoryId);
          positions.set(categoryId, fields.position + 1);
        } catch (error) {
          if (error instanceof HttpError) throw new HttpError(400, `${entry?.name ? `“${String(entry.name).slice(0, 80)}”` : `Item ${index + 1}`}: ${error.message}`, { index });
          throw error;
        }
        rows.push(fields);
      }
      const { data, error } = await client.from('menu_items').insert(rows).select(await itemColumns(client));
      check(error);
      return { items: data.map(itemOut) };
    },
  },
  {
    method: 'PATCH',
    path: new RegExp(`^/api/restaurant/items/(?<id>${UUID})$`),
    async handler({ request, body, params }) {
      const { client, restaurantId } = await ownerContext(request);
      const fields = itemFields(body, restaurantId, { partial: true });
      const columns = await itemColumns(client);
      const { data: current, error: readError } = await client.from('menu_items').select(columns).eq('id', params.id).eq('restaurant_id', restaurantId).maybeSingle();
      check(readError);
      if (!current) throw new HttpError(404, 'That item no longer exists.');
      Object.assign(fields, videoFields(body, restaurantId, current));
      Object.assign(fields, await featuredFields(client, restaurantId, body, current));
      if (body.categoryId !== undefined) {
        fields.category_id = await requireCategory(client, restaurantId, body.categoryId);
        // Moving to another category without a position puts the item at the end of it.
        if (fields.category_id !== current.category_id && fields.position === undefined) fields.position = await nextItemPosition(client, restaurantId, fields.category_id);
      }
      if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
      const { data, error } = await client.from('menu_items').update(fields).eq('id', params.id).eq('restaurant_id', restaurantId)
        .select(columns).maybeSingle();
      check(error);
      if (!data) throw new HttpError(404, 'That item no longer exists.');
      return { item: itemOut(data) };
    },
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/api/restaurant/items/(?<id>${UUID})$`),
    async handler({ request, params }) {
      const { client, restaurantId } = await ownerContext(request);
      check((await client.from('menu_items').delete().eq('id', params.id).eq('restaurant_id', restaurantId)).error);
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/invites',
    async handler({ request, body }) {
      const { client, restaurantId } = await ownerContext(request);
      const fields = inviteFields(body);
      const { count, error: countError } = await client.from('staff_invites').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId);
      check(countError);
      if (count >= 50) throw new HttpError(400, 'You can queue up to 50 invites here.');
      const { data, error } = await client.from('staff_invites').insert({ ...fields, restaurant_id: restaurantId }).select(INVITE_COLUMNS).single();
      check(error, { duplicate: `${fields.email} is already on your list.`, invalid: 'Check the email address.' });
      return { invite: inviteOut(data) };
    },
  },
  {
    method: 'PATCH',
    path: new RegExp(`^/api/restaurant/invites/(?<id>${UUID})$`),
    async handler({ request, body, params }) {
      const { client, restaurantId } = await ownerContext(request);
      const fields = inviteFields(body, { partial: true });
      if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to save.');
      const { data: existing, error: readError } = await client.from('staff_invites').select('status').eq('id', params.id).eq('restaurant_id', restaurantId).maybeSingle();
      check(readError);
      if (!existing) throw new HttpError(404, 'That invite no longer exists.');
      if (existing.status === 'sent') throw new HttpError(400, 'This invite has already been sent, so it can’t be changed.');
      const { data, error } = await client.from('staff_invites').update(fields).eq('id', params.id).eq('restaurant_id', restaurantId)
        .select(INVITE_COLUMNS).single();
      check(error, { duplicate: `${fields.email} is already on your list.` });
      return { invite: inviteOut(data) };
    },
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/api/restaurant/invites/(?<id>${UUID})$`),
    async handler({ request, params }) {
      const { client, restaurantId } = await ownerContext(request);
      const { data: existing, error: readError } = await client.from('staff_invites').select('status').eq('id', params.id).eq('restaurant_id', restaurantId).maybeSingle();
      check(readError);
      if (existing?.status === 'sent') throw new HttpError(400, 'This person has already been invited. Remove their access from your team settings instead.');
      check((await client.from('staff_invites').delete().eq('id', params.id).eq('restaurant_id', restaurantId)).error);
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/invites/send',
    async handler({ request }) {
      const { restaurant, restaurantId } = await ownerContext(request);
      if (restaurant.status !== 'live') throw new HttpError(400, 'Invites go out when your restaurant goes live, so nobody joins an empty restaurant.');
      return { invites: await sendPending(restaurantId) };
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/go-live',
    async handler({ request }) {
      const { client, restaurantId } = await ownerContext(request);
      const state = await loadState(client, restaurantId);
      const missing = missingForGoLive({
        restaurant: { ...state.restaurant, opening_hours: state.restaurant.openingHours }, tables: state.tables, items: state.items,
      });
      if (missing.length) throw new HttpError(400, 'A few things are needed before you go live.', { missing });

      // Status isn't writable by users (column grants), so the server sets it after the checks above.
      const service = serviceClient();
      if (state.restaurant.status !== 'live') {
        const { error } = await service.from('restaurants').update({ status: 'live', went_live_at: new Date().toISOString() }).eq('id', restaurantId);
        check(error);
      }
      const completed = new Set([...state.progress.completedSteps, 'preview']);
      check((await client.from('onboarding_progress').upsert({
        restaurant_id: restaurantId, current_step: 'done', completed_steps: [...completed],
        skipped_steps: state.progress.skippedSteps, data: state.progress.data,
      }, { onConflict: 'restaurant_id' })).error);

      const sent = await sendPending(restaurantId);
      const next = await loadState(client, restaurantId);
      return { ...next, sent };
    },
  },
].map(invalidating);
