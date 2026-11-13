/*
 * The guest menu's design ("Studio") on the frontend: themes, the allowed fonts and how they load, the default
 * design, how sections resolve, and the CSS variables a design turns into. Mirrors backend/src/lib/menu-merch.js
 * (docs/API.md §15). Pure: no Supabase, no React, safe for the guest page.
 *
 * Fonts are self-hosted (@fontsource) and loaded on demand with dynamic import, so a font's files download only
 * when a menu (or the Studio's type picker) uses it, and the dashboard bundle doesn't grow.
 */

export const THEMES = [
  { key: 'classic', label: 'Classic', hint: 'Clean white, crisp type', bg: '#ffffff', surface: '#f6f5f2', ink: '#111110', muted: '#6f6b63', accent: '#d9431e', action: '#111110', font: 'var(--font)', headingWeight: 650, radius: 12 },
  { key: 'savanna', label: 'Savanna', hint: 'Warm cream and terracotta', bg: '#f7f0e4', surface: '#efe4d2', ink: '#2b1d14', muted: '#7a6450', accent: '#b4532a', action: '#b4532a', font: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', headingWeight: 600, radius: 6 },
  { key: 'midnight', label: 'Midnight', hint: 'Dark and golden, for evenings', bg: '#141312', surface: '#211f1c', ink: '#f4efe6', muted: '#a59d90', accent: '#d6a85c', action: '#d6a85c', font: 'var(--font)', headingWeight: 600, radius: 14 },
  { key: 'garden', label: 'Garden', hint: 'Fresh greens, soft corners', bg: '#f1f5ef', surface: '#e3ebdf', ink: '#17301f', muted: '#5a6e5f', accent: '#2f7a4b', action: '#2f7a4b', font: 'var(--font)', headingWeight: 650, radius: 20 },
];
export const themeFor = (key) => THEMES.find((theme) => theme.key === key) || THEMES[0];
export const themeStyle = (theme) => ({
  '--m-bg': theme.bg, '--m-surface': theme.surface, '--m-ink': theme.ink, '--m-muted': theme.muted,
  '--m-accent': theme.accent, '--m-font': theme.font, '--m-heading-weight': theme.headingWeight, '--m-radius': `${theme.radius}px`,
});

/* ---------- Fonts ---------- */

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Display fonts set the section headings. `italic`: headings are set in italic (true italic files where the font
 * has them, a synthesised slant for Abril Fatface, which the concept uses that way). `weight`: heading weight.
 */
export const DISPLAY_FONTS = [
  { key: 'abril', label: 'Abril Fatface', family: `'Abril Fatface', ${SERIF}`, weight: 400, italic: 'synthetic', load: () => import('@fontsource/abril-fatface/400.css') },
  { key: 'playfair', label: 'Playfair Display', family: `'Playfair Display Variable', ${SERIF}`, weight: 800, italic: true, load: () => Promise.all([import('@fontsource-variable/playfair-display/wght.css'), import('@fontsource-variable/playfair-display/wght-italic.css')]) },
  { key: 'fraunces', label: 'Fraunces', family: `'Fraunces Variable', ${SERIF}`, weight: 800, italic: true, load: () => Promise.all([import('@fontsource-variable/fraunces/wght.css'), import('@fontsource-variable/fraunces/wght-italic.css')]) },
  { key: 'dm-serif', label: 'DM Serif Display', family: `'DM Serif Display', ${SERIF}`, weight: 400, italic: true, load: () => Promise.all([import('@fontsource/dm-serif-display/400.css'), import('@fontsource/dm-serif-display/400-italic.css')]) },
  { key: 'bebas', label: 'Bebas Neue', family: `'Bebas Neue', Impact, ${SANS}`, weight: 400, italic: false, load: () => import('@fontsource/bebas-neue/400.css') },
  { key: 'syne', label: 'Syne', family: `'Syne Variable', ${SANS}`, weight: 800, italic: false, load: () => import('@fontsource-variable/syne/wght.css') },
];
export const BODY_FONTS = [
  { key: 'dm-sans', label: 'DM Sans', family: `'DM Sans Variable', ${SANS}`, load: () => import('@fontsource-variable/dm-sans/wght.css') },
  { key: 'inter', label: 'Inter', family: `'Inter Variable', ${SANS}`, load: () => import('@fontsource-variable/inter/wght.css') },
  { key: 'lora', label: 'Lora', family: `'Lora Variable', ${SERIF}`, load: () => import('@fontsource-variable/lora/wght.css') },
  { key: 'work-sans', label: 'Work Sans', family: `'Work Sans Variable', ${SANS}`, load: () => import('@fontsource-variable/work-sans/wght.css') },
];
export const displayFont = (key) => DISPLAY_FONTS.find((font) => font.key === key) || DISPLAY_FONTS[1];
export const bodyFont = (key) => BODY_FONTS.find((font) => font.key === key) || BODY_FONTS[0];

const loading = new Map();
/** Loads a font's files once. Never rejects: a failed load just leaves the fallback stack. */
export function loadFont(font) {
  if (!font?.load) return Promise.resolve();
  if (!loading.has(font.key)) loading.set(font.key, font.load().catch(() => { loading.delete(font.key); }));
  return loading.get(font.key);
}
export const loadDesignFonts = (design) => Promise.all([loadFont(displayFont(design?.fonts?.display)), loadFont(bodyFont(design?.fonts?.body))]);
export const loadAllFonts = () => Promise.all([...DISPLAY_FONTS, ...BODY_FONTS].map(loadFont));

/* ---------- Schema ---------- */

export const LAYOUTS = ['grid', 'list', 'carousel'];
export const CARD_STYLES = ['photo-top', 'photo-side', 'text-only'];
export const SECTION_DEFAULTS = {
  featured: { layout: 'carousel', title: 'Featured' },
  deals: { layout: 'carousel', title: 'Pairs & deals' },
  category: { layout: 'list', title: null },
};
export const LIMITS = { sections: 40, sectionTitle: 40, tagline: 120 };

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

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHex = (value) => typeof value === 'string' && HEX.test(value.trim());
export function normalizeHex(value) {
  if (!isHex(value)) return null;
  const hex = value.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const shortText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * Any stored or half-built design, completed with the defaults. Lenient (never throws): invalid values fall back,
 * so an old or hand-edited design never breaks the menu. The server validates strictly on save.
 */
export function normalizeDesign(input) {
  const d = DEFAULT_DESIGN;
  const source = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const sections = [];
  for (const section of Array.isArray(source.sections) ? source.sections : []) {
    if (!section || !SECTION_DEFAULTS[section.type]) continue;
    const key = section.type === 'category' ? `category:${section.categoryId}` : section.type;
    if (section.type === 'category' && !section.categoryId) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push({
      type: section.type,
      ...(section.type === 'category' ? { categoryId: section.categoryId } : {}),
      visible: bool(section.visible, true),
      layout: pick(section.layout, LAYOUTS, SECTION_DEFAULTS[section.type].layout),
      title: shortText(section.title, LIMITS.sectionTitle),
    });
  }
  return {
    version: 1,
    theme: THEMES.some((theme) => theme.key === source.theme) ? source.theme : null,
    fonts: {
      display: pick(source.fonts?.display, DISPLAY_FONTS.map((font) => font.key), d.fonts.display),
      body: pick(source.fonts?.body, BODY_FONTS.map((font) => font.key), d.fonts.body),
    },
    colors: { accent: normalizeHex(source.colors?.accent), background: normalizeHex(source.colors?.background) },
    header: {
      showLogo: bool(source.header?.showLogo, d.header.showLogo),
      showSearch: bool(source.header?.showSearch, d.header.showSearch),
      showCover: bool(source.header?.showCover, d.header.showCover),
    },
    sections: sections.slice(0, LIMITS.sections),
    cards: { style: pick(source.cards?.style, CARD_STYLES, d.cards.style), showDescription: bool(source.cards?.showDescription, d.cards.showDescription) },
    footer: { showCta: bool(source.footer?.showCta, d.footer.showCta), tagline: shortText(source.footer?.tagline, LIMITS.tagline) },
  };
}

/** Same section key the server uses: featured, deals, category:<id>. */
export const sectionKey = (section) => (section.type === 'category' ? `category:${section.categoryId}` : section.type);

/**
 * Display order, as guests get it (docs/API.md §15): saved sections in order, minus deleted categories; featured
 * and deals put first when missing; categories missing from the list appended in category order.
 */
export function resolveSections(sections = [], categories = []) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const kept = sections.filter((section) => section.type !== 'category' || byId.has(section.categoryId));
  const has = new Set(kept.map((section) => (section.type === 'category' ? section.categoryId : section.type)));
  const leading = ['featured', 'deals'].filter((type) => !has.has(type)).map((type) => ({ type }));
  const trailing = categories.filter((category) => !has.has(category.id)).map((category) => ({ type: 'category', categoryId: category.id }));
  return [...leading, ...kept, ...trailing].map((section) => {
    const defaults = SECTION_DEFAULTS[section.type];
    const category = section.type === 'category' ? byId.get(section.categoryId) : null;
    return {
      key: sectionKey(section),
      type: section.type,
      ...(category ? { categoryId: category.id } : {}),
      title: section.title || (category ? category.name : defaults.title),
      savedTitle: section.title || null,
      visible: section.visible !== false,
      layout: section.layout || defaults.layout,
    };
  });
}

/** A design as guests see it: defaults merged, theme filled from the restaurant, sections resolved. */
export function resolveDesign(design, { theme, categories = [] } = {}) {
  const normal = normalizeDesign(design);
  return {
    ...normal,
    theme: normal.theme || (THEMES.some((t) => t.key === theme) ? theme : 'classic'),
    sections: resolveSections(normal.sections, categories),
  };
}

/** Back from resolved sections (the Studio's editable list) to what's saved. */
export const sectionsToSave = (resolved) => resolved.map((section) => ({
  type: section.type,
  ...(section.type === 'category' ? { categoryId: section.categoryId } : {}),
  visible: section.visible,
  layout: section.layout,
  title: section.type === 'category' ? section.savedTitle || null : section.savedTitle ?? null,
}));

/** Stable string for "has this design changed?" comparisons. */
export const designKey = (design) => JSON.stringify(normalizeDesign(design));

/* ---------- Colour ---------- */

function rgb(hex) {
  const value = normalizeHex(hex);
  if (!value) return null;
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
}
const toHex = (channels) => `#${channels.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
/** Mixes `a` into `b` by `amount` (0–1). */
export function mix(a, b, amount) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return b;
  return toHex(x.map((c, i) => c * amount + y[i] * (1 - amount)));
}
export function luminance(hex) {
  const channels = rgb(hex);
  if (!channels) return 0;
  const [r, g, b] = channels.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** The more readable of near-black and white on `background`. */
export const readableOn = (background, dark = '#111110', light = '#ffffff') => (contrast(background, dark) >= contrast(background, light) ? dark : light);

/**
 * The colours a resolved design paints with: the theme's, with the owner's background and accent laid over.
 * A custom background picks its own ink (dark or light) so text stays readable.
 */
export function designColors(design) {
  const theme = themeFor(design?.theme);
  const background = normalizeHex(design?.colors?.background);
  let { bg, surface, ink, muted } = theme;
  if (background) {
    bg = background;
    const dark = luminance(background) < 0.22;
    ink = dark ? '#f4efe6' : contrast(background, theme.ink) >= 7 ? theme.ink : '#111110';
    muted = mix(ink, bg, 0.62);
    surface = mix(ink, bg, dark ? 0.08 : 0.045);
  }
  const action = normalizeHex(design?.colors?.accent) || theme.action;
  return { theme, bg, surface, ink, muted, action, onAction: readableOn(action, theme.key === 'midnight' && !normalizeHex(design?.colors?.accent) ? '#141312' : '#111110') };
}

/** CSS custom properties for the guest menu (every guest class reads --mv-*). */
export function designVars(design) {
  const colors = designColors(design);
  const display = displayFont(design?.fonts?.display);
  const body = bodyFont(design?.fonts?.body);
  return {
    '--mv-bg': colors.bg, '--mv-surface': colors.surface, '--mv-ink': colors.ink, '--mv-muted': colors.muted,
    '--mv-accent': colors.action, '--mv-action': colors.action, '--mv-on-action': colors.onAction,
    '--mv-font': body.family, '--mv-display': display.family, '--mv-display-weight': display.weight,
    '--mv-display-style': display.italic ? 'italic' : 'normal',
    '--mv-display-synthesis': display.italic === 'synthetic' ? 'style' : 'none',
    '--mv-heading-weight': colors.theme.headingWeight, '--mv-radius': `${colors.theme.radius}px`,
  };
}
