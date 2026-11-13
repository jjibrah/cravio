import { dashboards, productCategories, sectionsFor } from './dashboards';

/*
 * Global search index. Each source returns plain items; when live records
 * (orders, tables, products, restaurants…) arrive, add a source here and the
 * palette picks them up without UI changes.
 *
 * Item: { id, group, label, hint, icon, keywords, to | href | action }
 */

// Extra words people use for each page, so "sales" finds Orders and Insights.
const pageKeywords = {
  '': 'home dashboard summary today service',
  orders: 'sales sale orders bills receipts tickets checks transactions',
  tables: 'tables floor seating covers sections plan',
  products: 'products dishes items food drinks prices catalogue catalog',
  menu: 'menu configuration availability schedule guest qr publish',
  insights: 'insights reports analytics sales revenue trends performance',
  settings: 'settings account profile password preferences restaurant team notifications',
  'contact-cravio': 'help support contact cravio team question',
  restaurants: 'restaurants customers venues accounts owners',
  performance: 'performance usage uptime analytics platform',
  money: 'money billing invoices revenue payments subscriptions sales',
  'leads-requests': 'leads requests sign ups onboarding prospects',
  complaints: 'complaints issues cases support tickets problems',
  users: 'users people accounts admins owners waiters staff invite roles permissions suspend access team',
};

// Pages whose records can be searched once data is connected.
export const searchableScopes = {
  owner: ['orders', 'tables', 'products'],
  admin: ['users', 'restaurants', 'leads-requests', 'complaints'],
};

function pageItems(role) {
  return sectionsFor(role).map((section) => ({
    id: `page:${section.path || 'overview'}`,
    group: 'Pages',
    label: section.label,
    hint: section.description,
    icon: section.icon,
    keywords: pageKeywords[section.path] || '',
    to: `/${role}${section.path ? `/${section.path}` : ''}`,
  }));
}

function categoryItems(role) {
  if (role !== 'owner') return [];
  return productCategories.filter((category) => category.id !== 'all').map((category) => ({
    id: `category:${category.id}`,
    group: 'Product categories',
    label: category.label,
    hint: 'Products',
    icon: category.icon,
    keywords: 'category products menu',
    to: `/owner/products?category=${category.id}`,
  }));
}

function actionItems(role) {
  return [
    ...(role === 'owner' ? [{ id: 'action:guest-menu', group: 'Actions', label: 'Open guest menu', hint: 'Opens in a new tab', icon: 'qr', keywords: 'qr guest menu preview public', href: '/guest-menu' }] : []),
    { id: 'action:refresh', group: 'Actions', label: 'Refresh data', hint: 'Reload this page', icon: 'refresh', keywords: 'reload update sync', action: 'refresh' },
    { id: 'action:sign-out', group: 'Actions', label: 'Log out', hint: 'End this session', icon: 'logout', keywords: 'sign out logout exit', action: 'sign-out', destructive: true },
  ];
}

export function searchIndex(role) {
  return [...pageItems(role), ...categoryItems(role), ...actionItems(role)];
}

/** "Search Orders for “x”" rows: open the page with the query applied. */
export function scopedItems(role, query) {
  const sections = sectionsFor(role);
  return searchableScopes[role].map((path) => {
    const section = sections.find((item) => item.path === path);
    return {
      id: `scope:${path}`,
      group: 'Search records',
      label: `Search ${section.label.toLowerCase()} for “${query}”`,
      hint: `Opens ${section.label} with this search`,
      icon: section.icon,
      scope: { path, label: section.label, query },
      to: `/${role}/${path}?q=${encodeURIComponent(query)}`,
    };
  });
}

/*
 * Scores an item and records why it matched, so the palette can highlight the
 * matched characters or explain a keyword hit ("matches sales").
 */
function match(item, query) {
  const label = item.label.toLowerCase();
  const at = label.indexOf(query);
  const range = (start) => Array.from({ length: query.length }, (_, i) => start + i);
  if (label === query) return { score: 100, indices: range(0) };
  if (at === 0) return { score: 80, indices: range(0) };
  const wordStart = label.split('').findIndex((_, i) => (i === 0 || label[i - 1] === ' ') && label.startsWith(query, i));
  if (wordStart > 0) return { score: 65, indices: range(wordStart) };
  if (at > 0 && query.length >= 2) return { score: 50, indices: range(at) };
  const keyword = (item.keywords || '').toLowerCase().split(/\s+/).find((word) => word && word.startsWith(query));
  if (keyword && query.length >= 2) return { score: 40, keyword };
  if (query.length >= 3) {
    const indices = [];
    let position = 0;
    for (const character of query) {
      position = label.indexOf(character, position);
      if (position === -1) return null;
      indices.push(position);
      position += 1;
    }
    return { score: 10, indices };
  }
  return null;
}

/** Ranked matches grouped by kind, at most `perGroup` each. Destructive actions never outrank navigation. */
export function searchFor(role, rawQuery, perGroup = 5) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const hits = searchIndex(role)
    .map((item) => ({ item, ...match(item, query) }))
    .filter((hit) => hit.score)
    .map((hit) => (hit.item.destructive ? { ...hit, score: Math.min(hit.score, 5) } : hit))
    .sort((a, b) => b.score - a.score);
  const groups = new Map();
  for (const hit of hits) {
    const list = groups.get(hit.item.group) || [];
    if (list.length < perGroup) list.push(hit);
    groups.set(hit.item.group, list);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items, best: items[0].score }))
    .sort((a, b) => b.best - a.best);
}

export const searchPlaceholder = {
  owner: 'Search or jump to…',
  admin: 'Search or jump to…',
};

export const kindLabel = { Pages: 'Page', 'Product categories': 'Category', Actions: 'Action', 'Search records': 'Search', Recent: '' };

export const roleLabel = (role) => dashboards[role].label;
