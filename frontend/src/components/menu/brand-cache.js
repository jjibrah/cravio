/*
 * The restaurant's brand for the guest loading screen: remembered per restaurant (name, logo, cover, colours) so
 * a returning guest's first paint is already theirs, plus the handful of images worth waiting for before the
 * menu appears. Storage is optional: private mode or blocked storage just means a neutral first paint.
 */
import { designColors, isHex } from '../../lib/menu-design';

const KEY = (id) => `cravio-brand:v1:${id}`;
const url = (value) => (typeof value === 'string' && /^(https?:\/\/|\/)/i.test(value) && value.length < 2048 ? value : null);
const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : '');

/** The brand a loaded menu paints with. */
export function brandFromMenu(data) {
  const restaurant = data?.restaurant || {};
  const design = data?.design || { theme: restaurant.theme };
  const colors = designColors(design);
  const header = design.header || {};
  return {
    name: text(restaurant.name),
    logoUrl: header.showLogo === false ? null : url(restaurant.logoUrl),
    coverUrl: header.showCover === false ? null : url(restaurant.coverUrl),
    bg: colors.bg, surface: colors.surface, ink: colors.ink, muted: colors.muted, accent: colors.action, onAccent: colors.onAction,
  };
}

/** The remembered brand for a restaurant, or null. Never throws. */
export function readBrand(restaurantId) {
  if (!restaurantId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(KEY(restaurantId)) || 'null');
    if (!value || typeof value !== 'object') return null;
    const colors = ['bg', 'surface', 'ink', 'muted', 'accent', 'onAccent'];
    if (!colors.every((key) => isHex(value[key]))) return null;
    return { name: text(value.name), logoUrl: url(value.logoUrl), coverUrl: url(value.coverUrl), ...Object.fromEntries(colors.map((key) => [key, value[key]])) };
  } catch {
    return null;
  }
}

/** Remembers the brand (only when it changed). Never throws. */
export function writeBrand(restaurantId, brand) {
  if (!restaurantId || !brand) return;
  try {
    const value = JSON.stringify(brand);
    if (localStorage.getItem(KEY(restaurantId)) !== value) localStorage.setItem(KEY(restaurantId), value);
  } catch { /* storage full or blocked: the next visit starts neutral */ }
}

/** Cover, logo and the first `dishes` dish images or posters, in the order the menu shows them. */
export function criticalImages(data, dishes = 6) {
  const brand = brandFromMenu(data);
  const urls = [brand.coverUrl, brand.logoUrl].filter(Boolean);
  const design = data?.design || {};
  if (design.cards?.style === 'text-only') return urls;
  const items = data?.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const picture = (item) => url(item?.videoPosterUrl) || url(item?.photoUrl);
  const ordered = [];
  const sections = Array.isArray(design.sections) ? design.sections.filter((section) => section.visible !== false) : [];
  for (const section of sections) {
    if (ordered.length >= dishes) break;
    if (section.type === 'featured') {
      const featured = data.featuredItemIds?.length ? data.featuredItemIds.map((id) => byId.get(id)) : items.filter((item) => item.featured);
      featured.forEach((item) => ordered.push(picture(item)));
    } else if (section.type === 'deals') {
      (data.deals || []).forEach((deal) => ordered.push(url(deal.photoUrl) || url(deal.photoUrls?.[0])));
    } else {
      items.filter((item) => item.categoryId === section.categoryId).forEach((item) => ordered.push(picture(item)));
    }
  }
  if (!sections.length) items.forEach((item) => ordered.push(picture(item)));
  return [...new Set([...urls, ...ordered.filter(Boolean).slice(0, dishes)])];
}

/** Loads and decodes images; resolves when all settle or after `cap` ms, whichever is first. Never rejects. */
export function preloadImages(urls, cap) {
  if (typeof Image === 'undefined' || !urls.length) return Promise.resolve();
  const loads = urls.map((src) => new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).then(resolve);
    image.onerror = resolve;
    image.src = src;
  }));
  return Promise.race([Promise.all(loads), new Promise((resolve) => { setTimeout(resolve, cap); })]);
}
