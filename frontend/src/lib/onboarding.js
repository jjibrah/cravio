import { supabase } from './supabase';
import { DAYS, WEEKDAYS } from './format';

/* Onboarding flow definition, themes, templates and helpers. Step keys match the flow in backend/src/routes/restaurant.js. */

export const SECTIONS = [
  { key: 'basics', label: 'Basics' },
  { key: 'tables', label: 'Tables' },
  { key: 'staff', label: 'Staff' },
  { key: 'menu', label: 'Menu' },
  { key: 'look', label: 'Look' },
];

export const STEPS = [
  { key: 'name', section: 'basics' },
  { key: 'kind', section: 'basics' },
  { key: 'location', section: 'basics' },
  { key: 'hours', section: 'basics' },
  { key: 'logo', section: 'basics', skippable: true },
  { key: 'phone', section: 'basics', skippable: true },
  { key: 'tables', section: 'tables' },
  { key: 'sections', section: 'tables', skippable: true },
  { key: 'staff', section: 'staff', skippable: true },
  { key: 'menu-method', section: 'menu' },
  { key: 'categories', section: 'menu' },
  { key: 'items', section: 'menu' },
  { key: 'photos', section: 'menu', skippable: true },
  { key: 'theme', section: 'look' },
  { key: 'preview', section: 'look' },
];
export const STEP_KEYS = STEPS.map((step) => step.key);
export const stepIndex = (key) => STEP_KEYS.indexOf(key);
export const stepByKey = (key) => STEPS.find((step) => step.key === key);
/** Steps that left the flow, mapped to where they live now. 'cover' became part of 'photos'. */
export const LEGACY_STEPS = { cover: 'photos' };
export const currentStepKey = (key) => LEGACY_STEPS[key] || key;
/** The last step of each section gets a line of encouragement after it. */
export const sectionEnds = new Set(['phone', 'sections', 'staff', 'photos', 'preview']);

// Pure helpers live in Supabase-free modules (the guest menu imports those directly); re-exported for older imports.
export { KINDS, kindLabel, DAYS, hoursSummary, formatPrice, formatKsh } from './format';
export { THEMES, themeFor, themeStyle } from './menu-design';

export function hoursFor(preset, from = '08:00', to = '22:00', current) {
  const days = {};
  for (const [day] of DAYS) {
    const open = preset === 'everyday' ? true : preset === 'weekdays' ? WEEKDAYS.has(day) : current?.days?.[day]?.open ?? true;
    days[day] = preset === 'custom' && current?.days?.[day] ? { ...current.days[day] } : { open, from, to };
  }
  return { preset, days };
}

export const SECTION_SUGGESTIONS = ['Indoor', 'Outdoor', 'Rooftop', 'Terrace', 'VIP', 'Bar'];
export const CATEGORY_SUGGESTIONS = ['Breakfast', 'Starters', 'Mains', 'Sides', 'Snacks', 'Drinks', 'Desserts'];

/** Suggested dishes. Prices are placeholders the owner confirms; nothing is saved until they do. */
export const TEMPLATE = [
  { name: 'Nyama choma (½ kg)', category: 'Mains', price: 900 },
  { name: 'Pilau', category: 'Mains', price: 450 },
  { name: 'Fried tilapia', category: 'Mains', price: 850 },
  { name: 'Githeri', category: 'Mains', price: 300 },
  { name: 'Ugali', category: 'Sides', price: 100 },
  { name: 'Sukuma wiki', category: 'Sides', price: 120 },
  { name: 'Chapati', category: 'Sides', price: 50 },
  { name: 'Kachumbari', category: 'Sides', price: 100 },
  { name: 'Chips masala', category: 'Sides', price: 350 },
  { name: 'Mandazi', category: 'Snacks', price: 40 },
  { name: 'Samosa', category: 'Snacks', price: 60 },
  { name: 'Chai', category: 'Drinks', price: 80 },
  { name: 'Fresh juice', category: 'Drinks', price: 200 },
  { name: 'Soda (300 ml)', category: 'Drinks', price: 100 },
  { name: 'Mineral water (500 ml)', category: 'Drinks', price: 80 },
];
export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATE.map((dish) => dish.category))];

/** Lenient Kenyan phone check, mirrors the server. Returns an error message or ''. */
export function phoneError(value) {
  const digits = value.replace(/[\s\-().]/g, '');
  if (!digits || digits === '+254') return '';
  if (/^(\+254|254|0)?[17]\d{8}$/.test(digits)) return '';
  if (/^\+(?!254)\d{7,15}$/.test(digits)) return '';
  return 'Enter a number like +254 712 345 678.';
}

export const possessive = (name) => (/s$/i.test(name.trim()) ? `${name.trim()}’` : `${name.trim()}’s`);

/** Encouragement after each section, using the restaurant's real name. */
export function cheer(sectionKey, name) {
  const n = name?.trim() || 'Your restaurant';
  return {
    basics: `Nice, ${n} is taking shape 🎉`,
    tables: `Tables sorted. ${n} has a floor plan 🙌`,
    staff: `Your team is ready to join ${n} 👋`,
    menu: `Looking delicious. ${possessive(n)} menu is in 😋`,
    look: `${n} looks the part ✨`,
  }[sectionKey];
}

export const MAX_UPLOAD = 5 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',');

export function imageFileError(file) {
  if (!file) return 'Choose an image.';
  if (!IMAGE_TYPES[file.type]) return 'That file isn’t a supported image. Use JPG, PNG, WebP, GIF or AVIF.';
  if (file.size > MAX_UPLOAD) return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`;
  return '';
}

/** Uploads straight to Supabase Storage as the signed-in user: `<restaurantId>/<kind>/<uuid>.<ext>`. */
export async function uploadImage(restaurantId, kind, file) {
  const problem = imageFileError(file);
  if (problem) throw new Error(problem);
  const path = `${restaurantId}/${kind}/${crypto.randomUUID()}.${IMAGE_TYPES[file.type]}`;
  const { error } = await supabase.storage.from('restaurant-media').upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) {
    const message = String(error.message || '');
    if (/exceeded|too large|size/i.test(message)) throw new Error('That image is over 5 MB. Choose a smaller one.');
    if (/mime|type/i.test(message)) throw new Error('That file type isn’t allowed. Use JPG, PNG or WebP.');
    if (/bucket not found/i.test(message)) throw new Error('Photo storage isn’t set up yet. Skip this for now and add it later.');
    if (/row-level security|unauthori[sz]ed|403/i.test(message)) throw new Error('You don’t have permission to upload here. Sign in again and retry.');
    throw new Error('The upload didn’t finish. Check your connection and try again.');
  }
  return supabase.storage.from('restaurant-media').getPublicUrl(path).data.publicUrl;
}

export const guestMenuUrl = (restaurantId, table) => `${window.location.origin}/guest-menu?r=${encodeURIComponent(restaurantId)}${table ? `&t=${encodeURIComponent(table)}` : ''}`;

/**
 * What's left to set up after go-live, in the recommended order: photos first, because the guest menu is
 * photo-led. Each entry links back to the onboarding step that does it (`step: null` is the dashboard tour).
 * The Overview shows the first unfinished one as its single call to action, and the rest as a pipeline.
 */
export function checklistFor(state) {
  if (!state?.restaurant) return [];
  const { restaurant, sections, items, invites, progress } = state;
  const failed = invites.filter((invite) => invite.status === 'failed').length;
  const withPhotos = items.filter((item) => item.photoUrl || item.videoUrl).length;
  return [
    {
      key: 'photos', step: 'photos', short: 'Dish photos', label: 'Add photos of your dishes', action: 'Add dish photos',
      why: 'Your menu is built around photos: each dish shows one right beside its price.',
      hint: items.length ? `${withPhotos} of ${items.length} dish${items.length === 1 ? ' has' : 'es have'} a photo.` : '',
      done: items.length > 0 && withPhotos === items.length,
    },
    {
      key: 'cover', step: 'photos', short: 'Cover photo', label: 'Add a cover photo', action: 'Add a cover photo',
      why: 'It’s the first thing guests see when they scan your QR code.', done: Boolean(restaurant.coverUrl),
    },
    {
      key: 'logo', step: 'logo', short: 'Logo', label: 'Add your logo', action: 'Add your logo',
      why: 'It sits on your cover, so guests know they’re in the right place.', done: Boolean(restaurant.logoUrl),
    },
    {
      key: 'phone', step: 'phone', short: 'Contact', label: 'Add a contact number', action: 'Add a number',
      why: 'So guests and Cravio can reach you when it matters.', done: Boolean(restaurant.phone),
    },
    {
      key: 'staff', step: 'staff', short: 'Staff', label: failed ? 'Fix staff invites' : 'Invite your staff', action: failed ? 'Fix invites' : 'Invite staff',
      why: failed ? `${failed} invite${failed === 1 ? '' : 's'} couldn’t be sent. Check the details and try again.` : 'Waiters and managers get their own sign-in, so orders reach the right person.',
      hint: !failed && invites.length ? `${invites.length} invited.` : '',
      done: invites.length > 0 && !failed,
    },
    {
      key: 'sections', step: 'sections', short: 'Sections', label: 'Name your sections', action: 'Name sections',
      why: 'Indoor, outdoor, rooftop: waiters find the right table faster.', done: sections.length > 0,
    },
    {
      key: 'tour', step: null, short: 'Tour', label: 'Take the dashboard tour', action: 'Start the tour',
      why: 'Three stops, under a minute, and you’ll know where everything is.', done: Boolean(progress?.data?.tourCompleted),
    },
  ];
}
