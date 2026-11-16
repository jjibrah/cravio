// `kind` picks the page-frame skeleton (see components/dashboard/PageFrame.jsx).
// Consecutive sections that share a `group` render together under that label.
export const dashboards = {
  admin: {
    label: 'Admin',
    sections: [
      { path: '', label: 'Overview', icon: 'overview', kind: 'overview', description: 'The health of every restaurant on Cravio at a glance.' },
      { path: 'businesses', group: 'Platform', label: 'Businesses', icon: 'restaurants', kind: 'table', columns: ['Business', 'Owner', 'Branches', 'Status'], description: 'Every customer business, its branches, owners and health.' },
      { path: 'performance', group: 'Platform', label: 'Performance', icon: 'performance', kind: 'insights', description: 'Usage and service performance across the platform.' },
      { path: 'money', group: 'Platform', label: 'Money', icon: 'money', kind: 'insights', description: 'Billing and revenue across customer restaurants.' },
      { path: 'terms', group: 'Platform', label: 'Terms & conditions', icon: 'complaints', kind: 'table', description: 'Write and publish the terms people accept when they create an account.' },
      { path: 'leads-requests', group: 'Support', label: 'Leads & requests', icon: 'leads', kind: 'table', columns: ['Name', 'Restaurant', 'Type', 'Received', 'Status'], description: 'Restaurants asking to join, and requests from existing customers.' },
      { path: 'complaints', group: 'Support', label: 'Complaints', icon: 'complaints', kind: 'table', columns: ['Case', 'Restaurant', 'Raised by', 'Opened', 'Status'], description: 'Issues raised by restaurants and guests, and where each one stands.' },
      { path: 'users', group: 'Access', label: 'Users', icon: 'team', kind: 'users', description: 'Everyone with a Cravio account: invite people, change roles and suspend access.' },
      { path: 'activity', group: 'Access', label: 'Activity', icon: 'performance', kind: 'table', description: 'Who gave, changed or removed access, and when.' },
    ],
  },
  // Branch manager: the restaurant's day-to-day operations (the previous owner dashboard), at /branch/:branchId.
  branch: {
    label: 'Branch',
    sections: [
      { path: '', label: 'Overview', icon: 'overview', kind: 'overview', description: 'Today’s service at a glance.' },
      { path: 'orders', label: 'Orders', icon: 'orders', kind: 'table', columns: ['Order', 'Table', 'Items', 'Server', 'Status', 'Total'], description: 'Every order, from the table to the bill.' },
      { path: 'tables', label: 'Tables', icon: 'tables', kind: 'floor', description: 'Your floor, table by table.' },
      { path: 'products', group: 'Menu', label: 'Products', icon: 'products', kind: 'products', description: 'Dishes and drinks, organised by category.' },
      { path: 'menu', group: 'Menu', label: 'Menu configuration', icon: 'menu', kind: 'menu', description: 'What guests see on the menu, and when they see it.' },
      { path: 'inventory', group: 'Operations', label: 'Inventory', icon: 'products', kind: 'inventory', description: 'Servings on hand, requests to the main center and deliveries.' },
      { path: 'insights', group: 'Analytics', label: 'Insights', icon: 'insights', kind: 'insights', description: 'Sales and service trends over time.' },
    ],
    contact: { path: 'contact-cravio', label: 'Contact Cravio', icon: 'contact', kind: 'support', description: 'Reach the Cravio team about anything in your restaurant.' },
  },
  // Owner / operations manager: oversight of the business's assigned branches, at /owner.
  owner: {
    label: 'Owner',
    sections: [
      { path: '', label: 'Overview', icon: 'overview', kind: 'business', description: 'Your daily briefing and every branch you oversee.' },
      { path: 'locations', group: 'Business', label: 'Locations', icon: 'restaurants', kind: 'business', description: 'Your branches: open one, or add a new location.' },
      { path: 'people', group: 'Business', label: 'People & access', icon: 'team', kind: 'business', description: 'Who can see and run which branches.' },
      { path: 'inventory', group: 'Business', label: 'Inventory', icon: 'products', kind: 'inventory', description: 'Main center stock, branch requests and dispatches.' },
    ],
  },
};

export const settingsSection = { path: 'settings', label: 'Settings', icon: 'settings', kind: 'settings', description: 'Your account, restaurant and preferences.' };

/** Placeholder product categories until menu data is connected. */
export const productCategories = [
  { id: 'all', label: 'All products', icon: 'layers' },
  { id: 'starters', label: 'Starters', icon: 'leaf' },
  { id: 'main-course', label: 'Main course', icon: 'utensils' },
  { id: 'desserts', label: 'Desserts', icon: 'dessert' },
  { id: 'drinks', label: 'Drinks', icon: 'drink' },
  { id: 'promotions', label: 'Promotions', icon: 'percent' },
];

export function sectionsFor(role) {
  const config = dashboards[role];
  // The owner interface has no restaurant settings page: branch settings live in each branch workspace.
  return [...config.sections, ...(config.contact ? [config.contact] : []), ...(role === 'owner' ? [] : [settingsSection])];
}

/** The section for a pathname under `base` (e.g. '/admin' or '/branch/<id>'). */
export function sectionForPath(role, pathname, base = `/${role}`) {
  return sectionsFor(role).find((section) => pathname.replace(/\/$/, '') === `${base}${section.path ? `/${section.path}` : ''}`) || dashboards[role].sections[0];
}

/** Legacy /owner/<page> paths that now belong to the branch workspace. */
export const LEGACY_BRANCH_PAGES = ['orders', 'tables', 'products', 'menu', 'insights', 'settings', 'contact-cravio'];

export function groupSections(sections) {
  return sections.reduce((groups, section) => {
    const last = groups[groups.length - 1];
    if (last && last.label === (section.group || null)) last.sections.push(section);
    else groups.push({ label: section.group || null, sections: [section] });
    return groups;
  }, []);
}
