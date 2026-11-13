// Menu merchandising (migration 004): pairings, extras, featured dishes, deals, the menu design ("Studio")
// and the pricing of order lines that carry extras or a deal. Shared by routes/menu-merch.js (owners),
// routes/public-menu.js (guests), lib/operations.js (carts and orders) and the seed.
import { HttpError } from './http.js';
import { THEMES, capitalise, text } from './restaurants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const cents = (value) => Math.round(Number(value || 0) * 100);
const kes = (c) => c / 100;

/* ---------- Is migration 004 applied? ---------- */

export const MERCH_NOT_INSTALLED = 'Menu extras, pairings and deals aren’t available yet. The database update hasn’t been applied.';

let installed = null; // true once seen; false is re-checked after a minute
let checkedAt = 0;

/** True when migration 004's tables and columns exist. Cached (one probe per process, re-probed while missing). */
export async function hasMerchSchema(db) {
  if (installed === true) return true;
  if (installed === false && Date.now() - checkedAt < 60_000) return false;
  const [items, deals] = await Promise.all([
    db.from('menu_items').select('featured').limit(1),
    db.from('menu_deals').select('id').limit(1),
  ]);
  const error = items.error || deals.error;
  checkedAt = Date.now();
  if (!error) installed = true;
  else if (['42703', 'PGRST204', '42P01', 'PGRST205', 'PGRST200'].includes(error.code)) installed = false;
  else installed = null; // unrelated failure: decide next time
  return installed === true;
}

/** Throws 503 when 004 isn't applied. */
export async function requireMerch(db) {
  if (!(await hasMerchSchema(db))) throw new HttpError(503, MERCH_NOT_INSTALLED);
}

/* ---------- Limits ---------- */

export const LIMITS = { pairingsPerDish: 6, extrasPerDish: 12, extrasPerLine: 10, featured: 10, deals: 50, dealComponents: 10 };

/* ---------- Menu design ("Studio") ---------- */

/** Font keys the frontend maps to self-hosted fonts. */
export const DISPLAY_FONTS = {
  abril: 'Abril Fatface', playfair: 'Playfair Display', fraunces: 'Fraunces',
  'dm-serif': 'DM Serif Display', bebas: 'Bebas Neue', syne: 'Syne',
};
export const BODY_FONTS = { 'dm-sans': 'DM Sans', inter: 'Inter', lora: 'Lora', 'work-sans': 'Work Sans' };
export const LAYOUTS = ['grid', 'list', 'carousel'];
export const CARD_STYLES = ['photo-top', 'photo-side', 'text-only'];
export const SECTION_TYPES = ['featured', 'deals', 'category'];
export const SECTION_DEFAULTS = {
  featured: { layout: 'carousel', title: 'Featured' },
  deals: { layout: 'carousel', title: 'Pairs & deals' },
  category: { layout: 'list', title: null },
};
const MAX_SECTIONS = 40;

/** The design when the owner hasn't saved one. `theme: null` means the restaurant's theme. */
export const DEFAULT_DESIGN = Object.freeze({
  version: 1,
  theme: null,
  fonts: { display: 'playfair', body: 'dm-sans' },
  colors: { accent: null, background: null },
  header: { showLogo: true, showSearch: true, showCover: true },
  sections: [],
  cards: { style: 'photo-top', showDescription: true },
  footer: { showCta: true, tagline: null },
});

export const designOptions = () => ({
  themes: THEMES,
  fonts: {
    display: Object.entries(DISPLAY_FONTS).map(([key, label]) => ({ key, label })),
    body: Object.entries(BODY_FONTS).map(([key, label]) => ({ key, label })),
  },
  layouts: LAYOUTS,
  cardStyles: CARD_STYLES,
  sectionTypes: SECTION_TYPES,
  sectionDefaults: SECTION_DEFAULTS,
  limits: { sections: MAX_SECTIONS, sectionTitle: 40, tagline: 120 },
});

const bad = (field, message) => new HttpError(400, message, { field: `design.${field}` });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function objectAt(value, field) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw bad(field, `${capitalise(field)} must be an object.`);
  return value;
}

function boolAt(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw bad(field, `${field} must be true or false.`);
  return value;
}

function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) throw bad(field, `${field} must be one of ${allowed.join(', ')}.`);
  return value;
}

function hexColor(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) throw bad(field, `${field} must be a hex colour like #111110.`);
  const hex = value.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

function shortText(value, field, max) {
  try { return text(value, field, { max }) ?? null; } catch (error) { throw bad(field, error.message); }
}

/**
 * Validates a design sent by the owner and returns the normalised object to store.
 * Known keys are checked strictly (400 with details.field); unknown keys are dropped; missing keys get defaults.
 */
export function normalizeDesign(input) {
  if (!isObject(input)) throw new HttpError(400, 'Send the design as an object.', { field: 'design' });
  if (input.version !== undefined && input.version !== 1) throw bad('version', 'version must be 1.');
  const fonts = objectAt(input.fonts, 'fonts');
  const colors = objectAt(input.colors, 'colors');
  const header = objectAt(input.header, 'header');
  const cards = objectAt(input.cards, 'cards');
  const footer = objectAt(input.footer, 'footer');
  const d = DEFAULT_DESIGN;

  if (input.sections !== undefined && input.sections !== null && !Array.isArray(input.sections)) throw bad('sections', 'sections must be a list.');
  const rawSections = input.sections || [];
  if (rawSections.length > MAX_SECTIONS) throw bad('sections', `Use up to ${MAX_SECTIONS} sections.`);
  const seen = new Set();
  const sections = rawSections.map((section, index) => {
    const at = `sections[${index}]`;
    if (!isObject(section)) throw bad(at, 'Each section must be an object.');
    const type = oneOf(section.type, SECTION_TYPES, `${at}.type`, undefined);
    if (!type) throw bad(`${at}.type`, `${at}.type must be one of ${SECTION_TYPES.join(', ')}.`);
    let key = type;
    const out = { type };
    if (type === 'category') {
      if (!isUuid(section.categoryId)) throw bad(`${at}.categoryId`, 'A category section needs its categoryId.');
      out.categoryId = section.categoryId.toLowerCase();
      key = `category:${out.categoryId}`;
    }
    if (seen.has(key)) throw bad(at, type === 'category' ? 'Each category can appear once.' : `The ${type} section can appear once.`);
    seen.add(key);
    out.visible = boolAt(section.visible, `${at}.visible`, true);
    out.layout = oneOf(section.layout, LAYOUTS, `${at}.layout`, SECTION_DEFAULTS[type].layout);
    out.title = shortText(section.title, `${at}.title`, 40);
    return out;
  });

  return {
    version: 1,
    theme: oneOf(input.theme, THEMES, 'theme', null),
    fonts: {
      display: oneOf(fonts.display, Object.keys(DISPLAY_FONTS), 'fonts.display', d.fonts.display),
      body: oneOf(fonts.body, Object.keys(BODY_FONTS), 'fonts.body', d.fonts.body),
    },
    colors: { accent: hexColor(colors.accent, 'colors.accent'), background: hexColor(colors.background, 'colors.background') },
    header: {
      showLogo: boolAt(header.showLogo, 'header.showLogo', d.header.showLogo),
      showSearch: boolAt(header.showSearch, 'header.showSearch', d.header.showSearch),
      showCover: boolAt(header.showCover, 'header.showCover', d.header.showCover),
    },
    sections,
    cards: {
      style: oneOf(cards.style, CARD_STYLES, 'cards.style', d.cards.style),
      showDescription: boolAt(cards.showDescription, 'cards.showDescription', d.cards.showDescription),
    },
    footer: {
      showCta: boolAt(footer.showCta, 'footer.showCta', d.footer.showCta),
      tagline: shortText(footer.tagline, 'footer.tagline', 120),
    },
  };
}

/** A stored design (or null), normalised leniently: anything invalid falls back to the defaults. */
export function storedDesign(value) {
  if (!isObject(value)) return structuredClone(DEFAULT_DESIGN);
  try { return normalizeDesign(value); } catch { return structuredClone(DEFAULT_DESIGN); }
}

/**
 * The design as guests see it: defaults merged in, the theme filled from the restaurant, and sections in
 * display order. Deleted categories are dropped; featured and deals sections missing from a saved list come
 * first; categories missing from it are appended in category order.
 * @param categories [{ id, name }] in category order
 */
export function resolveDesign(value, { theme, categories }) {
  const design = storedDesign(value);
  const byId = new Map(categories.map((category) => [category.id, category]));
  const sectionOut = (section) => {
    const defaults = SECTION_DEFAULTS[section.type];
    const category = section.type === 'category' ? byId.get(section.categoryId) : null;
    return {
      key: section.type === 'category' ? `category:${section.categoryId}` : section.type,
      type: section.type,
      ...(category ? { categoryId: category.id } : {}),
      title: section.title || (category ? category.name : defaults.title),
      visible: section.visible !== false,
      layout: section.layout || defaults.layout,
    };
  };
  const kept = design.sections.filter((section) => section.type !== 'category' || byId.has(section.categoryId));
  const has = new Set(kept.map((section) => (section.type === 'category' ? section.categoryId : section.type)));
  const leading = ['featured', 'deals'].filter((type) => !has.has(type)).map((type) => ({ type }));
  const trailing = categories.filter((category) => !has.has(category.id)).map((category) => ({ type: 'category', categoryId: category.id }));
  return {
    ...design,
    theme: design.theme || (THEMES.includes(theme) ? theme : 'classic'),
    sections: [...leading, ...kept, ...trailing].map(sectionOut),
  };
}

/* ---------- Deals ---------- */

export const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * A deal's state and prices from its row, its component rows and the current dishes.
 * @param components [{ item_id, quantity, position }]
 * @param itemsById Map(id -> { id, name, price, available, photo_url })
 */
export function dealSummary(deal, components, itemsById, now = Date.now()) {
  const sorted = components.slice().sort((a, b) => a.position - b.position);
  let regular = 0;
  let units = 0;
  const issues = [];
  const items = sorted.map((component) => {
    const item = itemsById.get(component.item_id);
    units += component.quantity;
    if (item) regular += cents(item.price) * component.quantity;
    if (!item) issues.push({ code: 'item_missing', itemId: component.item_id, message: 'A dish in this deal was removed.' });
    else if (!item.available) issues.push({ code: 'item_unavailable', itemId: item.id, name: item.name, message: `${item.name} is sold out.` });
    return {
      itemId: component.item_id, name: item?.name || 'Removed dish', quantity: component.quantity,
      unitPrice: item ? Number(item.price) : 0, photoUrl: item?.photo_url || null, available: Boolean(item?.available),
    };
  });
  if (units < 2) issues.push({ code: 'too_few_items', message: 'A deal needs at least 2 dishes.' });
  const starts = deal.starts_at ? Date.parse(deal.starts_at) : null;
  const ends = deal.ends_at ? Date.parse(deal.ends_at) : null;
  let status = 'live';
  if (!deal.active) status = 'inactive';
  else if (starts && starts > now) status = 'scheduled';
  else if (ends && ends <= now) status = 'ended';
  else if (issues.length) status = 'unavailable';
  const price = cents(deal.price);
  const saving = Math.max(0, regular - price);
  return {
    id: deal.id, name: deal.name, description: deal.description || null,
    price: kes(price), regularPrice: kes(regular), saving: kes(saving),
    savingPercent: regular > 0 ? Math.round((saving / regular) * 100) : 0,
    currency: deal.currency || 'KES',
    active: deal.active, startsAt: iso(deal.starts_at), endsAt: iso(deal.ends_at),
    photoUrl: deal.photo_url || null,
    photoUrls: [...new Set(items.map((item) => item.photoUrl).filter(Boolean))].slice(0, 4),
    position: deal.position,
    items,
    units,
    status,
    visibleToGuests: status === 'live',
    issues,
  };
}

/** Loads deals with their components. `ids` limits the deals; without it, all of the restaurant's deals. */
export async function loadDeals(db, restaurantId, ids = null) {
  let dealQuery = db.from('menu_deals').select('id, name, description, price, currency, active, starts_at, ends_at, photo_url, position')
    .eq('restaurant_id', restaurantId);
  let componentQuery = db.from('menu_deal_items').select('deal_id, item_id, quantity, position').eq('restaurant_id', restaurantId);
  if (ids) { dealQuery = dealQuery.in('id', ids); componentQuery = componentQuery.in('deal_id', ids); }
  const [deals, components] = await Promise.all([dealQuery.order('position').order('created_at'), componentQuery]);
  if (deals.error) throw deals.error;
  if (components.error) throw components.error;
  const byDeal = new Map();
  for (const row of components.data) byDeal.set(row.deal_id, [...(byDeal.get(row.deal_id) || []), row]);
  return deals.data.map((deal) => ({ deal, components: byDeal.get(deal.id) || [] }));
}

/* ---------- Order lines: parsing and pricing ---------- */

const lineError = (status, message, index, extra = {}) => new HttpError(status, message, { field: 'items', index, ...extra });

/**
 * Parses one requested line into { kind: 'item', itemId, quantity, note, extraIds } or
 * { kind: 'deal', dealId, quantity, note }. Throws 400 for malformed input.
 */
export function parseLine(entry, index, maxQuantity) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw lineError(400, `Line ${index + 1} is invalid.`, index);
  const quantity = entry.quantity === undefined ? 1 : entry.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) throw lineError(400, `Quantity must be between 1 and ${maxQuantity}.`, index);
  let note = null;
  try { note = text(entry.note, 'the note', { max: 140 }) ?? null; } catch (error) { throw lineError(400, error.message, index); }
  if (entry.dealId !== undefined && entry.dealId !== null) {
    if (entry.itemId !== undefined && entry.itemId !== null) throw lineError(400, `Line ${index + 1} must be a dish or a deal, not both.`, index);
    if (!isUuid(entry.dealId)) throw lineError(400, `Line ${index + 1} needs a deal.`, index);
    if (entry.extraIds !== undefined && entry.extraIds !== null && !(Array.isArray(entry.extraIds) && !entry.extraIds.length)) {
      throw lineError(400, 'Deals can’t have extras.', index);
    }
    return { kind: 'deal', dealId: entry.dealId.toLowerCase(), quantity, note };
  }
  if (!isUuid(entry.itemId)) throw lineError(400, `Line ${index + 1} needs a dish.`, index);
  let extraIds = [];
  if (entry.extraIds !== undefined && entry.extraIds !== null) {
    if (!Array.isArray(entry.extraIds)) throw lineError(400, 'extraIds must be a list of extra ids.', index);
    if (entry.extraIds.length > LIMITS.extrasPerLine) throw lineError(400, `Choose up to ${LIMITS.extrasPerLine} extras.`, index);
    if (entry.extraIds.some((id) => !isUuid(id))) throw lineError(400, 'Each extra must be an id.', index);
    extraIds = [...new Set(entry.extraIds.map((id) => id.toLowerCase()))];
  }
  return { kind: 'item', itemId: entry.itemId.toLowerCase(), quantity, note, extraIds };
}

/** The line as it is stored in guest_carts.items. */
export const storedLine = (line) => (line.kind === 'deal'
  ? { dealId: line.dealId, quantity: line.quantity, ...(line.note ? { note: line.note } : {}) }
  : { itemId: line.itemId, quantity: line.quantity, ...(line.note ? { note: line.note } : {}), ...(line.extraIds?.length ? { extraIds: line.extraIds } : {}) });

/**
 * Loads what's needed to price `wanted` lines (from parseLine) from the current menu, then resolves each
 * line to { line } (priced) or { problem: { status, message, reason, … } } (unavailable). Never throws for
 * menu state, so carts can be previewed; priceLines turns the first problem into an HTTP error.
 */
export async function resolveLines(db, restaurantId, wanted, { merch } = {}) {
  const dealIds = [...new Set(wanted.filter((l) => l.kind === 'deal').map((l) => l.dealId))];
  const extraIds = [...new Set(wanted.flatMap((l) => l.extraIds || []))];
  const itemIds = [...new Set(wanted.filter((l) => l.kind === 'item').map((l) => l.itemId))];
  const needsMerch = dealIds.length > 0 || extraIds.length > 0;
  const installed = merch ?? (needsMerch ? await hasMerchSchema(db) : false);

  // With deals in the list, read the whole (small) menu once rather than chase component ids in a second trip.
  const itemsQuery = dealIds.length && installed
    ? db.from('menu_items').select('id, name, price, available, photo_url').eq('restaurant_id', restaurantId)
    : itemIds.length ? db.from('menu_items').select('id, name, price, available, photo_url').eq('restaurant_id', restaurantId).in('id', itemIds) : null;
  const [items, extras, deals] = await Promise.all([
    itemsQuery ? itemsQuery.then((r) => { if (r.error) throw r.error; return r.data; }) : [],
    extraIds.length && installed ? db.from('menu_item_extras').select('id, item_id, name, price, available').eq('restaurant_id', restaurantId).in('id', extraIds)
      .then((r) => { if (r.error) throw r.error; return r.data; }) : [],
    dealIds.length && installed ? loadDeals(db, restaurantId, dealIds) : [],
  ]);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const extrasById = new Map(extras.map((extra) => [extra.id, extra]));
  const dealsById = new Map(deals.map((entry) => [entry.deal.id, entry]));
  const now = Date.now();

  return wanted.map((line, index) => {
    if (line.kind === 'deal') {
      if (!installed) return { problem: { status: 503, message: MERCH_NOT_INSTALLED, reason: 'not_installed', index } };
      const entry = dealsById.get(line.dealId);
      if (!entry) return { problem: { status: 400, message: 'That deal is no longer on the menu.', reason: 'missing', index, dealId: line.dealId } };
      const summary = dealSummary(entry.deal, entry.components, itemsById, now);
      if (summary.status !== 'live') {
        const soldOut = summary.issues.find((issue) => issue.code === 'item_unavailable');
        return {
          problem: {
            status: 409, index, dealId: line.dealId, reason: soldOut ? 'sold_out' : 'deal_unavailable', name: summary.name, unitPrice: summary.price,
            message: soldOut ? `${summary.name} isn’t available: ${soldOut.name} is sold out.` : `${summary.name} isn’t available right now.`,
            ...(soldOut ? { itemId: soldOut.itemId } : {}),
          },
        };
      }
      const unit = cents(summary.price);
      return {
        line: {
          kind: 'deal', itemId: null, dealId: summary.id, name: summary.name, unitPrice: kes(unit), extras: [], extrasTotal: 0,
          unitTotal: kes(unit), quantity: line.quantity, note: line.note, lineTotal: kes(unit * line.quantity),
          components: summary.items.map(({ itemId, name, quantity, unitPrice }) => ({ itemId, name, quantity, unitPrice })),
          regularPrice: summary.regularPrice,
        },
        stored: line,
      };
    }
    const item = itemsById.get(line.itemId);
    if (!item) return { problem: { status: 400, message: 'One of the dishes is no longer on the menu.', reason: 'missing', index, itemId: line.itemId } };
    const known = { name: item.name, unitPrice: Number(item.price) };
    if (!item.available) return { problem: { status: 409, message: `${item.name} is sold out.`, reason: 'sold_out', index, itemId: item.id, ...known } };
    if (line.extraIds.length && !installed) return { problem: { status: 503, message: MERCH_NOT_INSTALLED, reason: 'not_installed', index } };
    const chosen = [];
    for (const id of line.extraIds) {
      const extra = extrasById.get(id);
      if (!extra || extra.item_id !== item.id) return { problem: { status: 400, message: `One of the extras for ${item.name} is no longer on the menu.`, reason: 'extra_missing', index, itemId: item.id, extraId: id, ...known } };
      if (!extra.available) return { problem: { status: 409, message: `${extra.name} (for ${item.name}) is sold out.`, reason: 'extra_sold_out', index, itemId: item.id, extraId: id, ...known } };
      chosen.push({ id: extra.id, name: extra.name, price: Number(extra.price) });
    }
    const base = cents(item.price);
    const add = chosen.reduce((sum, extra) => sum + cents(extra.price), 0);
    return {
      line: {
        kind: 'item', itemId: item.id, dealId: null, name: item.name, unitPrice: kes(base), extras: chosen, extrasTotal: kes(add),
        unitTotal: kes(base + add), quantity: line.quantity, note: line.note, lineTotal: kes((base + add) * line.quantity),
      },
      stored: line,
    };
  });
}

/** "+ Cheese, + Bacon" for a line, or ''. */
export const extrasLabel = (extras) => (extras || []).map((extra) => `+ ${extra.name}`).join(', ');
