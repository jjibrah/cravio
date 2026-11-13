// Pure helpers for the admin Users page: labels, filtering, sorting, time and guard rules.

export const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin', icon: 'internal', hint: 'Cravio team', description: 'Manages restaurants, users and support across Cravio.' },
  { value: 'owner', label: 'Owner', icon: 'restaurants', hint: 'Runs a restaurant', description: 'Sets up their restaurant, menu, tables and staff.' },
  { value: 'waiter', label: 'Waiter', icon: 'services', hint: 'Takes orders', description: 'Takes orders and serves tables on their phone.' },
];
export const roleLabel = (role) => ROLE_OPTIONS.find((option) => option.value === role)?.label || 'No role';
export const roleArticle = { admin: 'an admin', owner: 'an owner', waiter: 'a waiter' };

export const STATUS_LABEL = { active: 'Active', invited: 'Invited', suspended: 'Suspended' };

export const TABS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'admin', label: 'Admins', test: (user) => user.role === 'admin' },
  { id: 'owner', label: 'Owners', test: (user) => user.role === 'owner' },
  { id: 'waiter', label: 'Waiters', test: (user) => user.role === 'waiter' },
  { id: 'invited', label: 'Invited', test: (user) => user.status === 'invited' },
  { id: 'suspended', label: 'Suspended', test: (user) => user.status === 'suspended' },
];

export const SORTS = [
  { id: 'recent', label: 'Last active' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'newest', label: 'Newest first' },
  { id: 'role', label: 'Role' },
];

const time = (value) => (value ? Date.parse(value) : 0);
const roleOrder = { admin: 0, owner: 1, waiter: 2 };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const comparators = {
  recent: (a, b) => time(b.last_sign_in_at) - time(a.last_sign_in_at) || byName(a, b),
  name: byName,
  newest: (a, b) => time(b.created_at) - time(a.created_at) || byName(a, b),
  role: (a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || byName(a, b),
};

export function matchesSearch(user, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
}

export function tabCounts(users) {
  return Object.fromEntries(TABS.map((tab) => [tab.id, users.filter(tab.test).length]));
}

export function sortUsers(users, sort) {
  return [...users].sort(comparators[sort] || comparators.recent);
}

export function initials(name = '', email = '') {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts.length ? parts.slice(0, 2).map((part) => part[0]) : [email[0] || '?'];
  return letters.join('').toUpperCase();
}

export const firstName = (name) => name.split(/\s+/)[0] || name;

const exactFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const yearFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export const exactTime = (value) => (value ? exactFormat.format(new Date(value)) : '');

export function relativeTime(value, now = Date.now()) {
  if (!value) return '';
  const date = new Date(value);
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (date.getFullYear() === new Date(now).getFullYear()) return dayFormat.format(date);
  return yearFormat.format(date);
}

/**
 * Mirrors the backend guards. Returns null when allowed, or the reason it isn't.
 * action: 'role' | 'suspend' | 'reactivate' | 'resend' | 'rename'
 */
export function blockedReason(user, action, { activeAdmins = 2, nextRole } = {}) {
  if (!user) return 'Unknown user.';
  if (user.isPrimaryAdmin && !user.isSelf) return 'The primary admin can’t be suspended, demoted or edited by other admins.';
  if (user.isPrimaryAdmin && (action === 'role' || action === 'suspend')) return 'The primary admin always keeps admin access.';
  if (user.isSelf && action === 'role') return 'You can’t change your own role. Ask another admin.';
  if (user.isSelf && action === 'suspend') return 'You can’t suspend your own account.';
  const losesAdmin = user.role === 'admin' && user.status !== 'suspended'
    && ((action === 'role' && nextRole !== 'admin') || action === 'suspend');
  if (losesAdmin && activeAdmins <= 1) return 'Cravio needs at least one active admin. Make someone else an admin first.';
  if (action === 'resend' && user.status !== 'invited') return 'Only people who haven’t accepted their invite can be sent another.';
  return null;
}

export const activeAdminCount = (users) => users.filter((user) => user.role === 'admin' && user.status !== 'suspended').length;
