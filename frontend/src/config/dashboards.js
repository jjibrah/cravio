// `kind` picks the page-frame skeleton (see components/dashboard/PageFrame.jsx).
// Consecutive sections that share a `group` render together under that label.
export const dashboards = {
  admin: {
    label: 'Admin',
    sections: [
      { path: '', label: 'Overview', icon: 'overview', kind: 'overview', description: 'The health of every restaurant on Cravio at a glance.' },
      { path: 'restaurants', group: 'Platform', label: 'Restaurants', icon: 'restaurants', kind: 'table', columns: ['Restaurant', 'Owner', 'Location', 'Status', 'Joined'], description: 'Every customer restaurant, its status and its owner.' },
      { path: 'performance', group: 'Platform', label: 'Performance', icon: 'performance', kind: 'insights', description: 'Usage and service performance across the platform.' },
      { path: 'money', group: 'Platform', label: 'Money', icon: 'money', kind: 'insights', description: 'Billing and revenue across customer restaurants.' },
      { path: 'leads-requests', group: 'Support', label: 'Leads & requests', icon: 'leads', kind: 'table', columns: ['Name', 'Restaurant', 'Type', 'Received', 'Status'], description: 'Restaurants asking to join, and requests from existing customers.' },
      { path: 'complaints', group: 'Support', label: 'Complaints', icon: 'complaints', kind: 'table', columns: ['Case', 'Restaurant', 'Raised by', 'Opened', 'Status'], description: 'Issues raised by restaurants and guests, and where each one stands.' },
      { path: 'users', group: 'Access', label: 'Users', icon: 'team', kind: 'users', description: 'Everyone with a Cravio account: invite people, change roles and suspend access.' },
    ],
  },
  owner: {
    label: 'Owner',
    sections: [
      { path: '', label: 'Overview', icon: 'overview', kind: 'overview', description: 'Today’s service at a glance.' },
      { path: 'orders', label: 'Orders', icon: 'orders', kind: 'table', columns: ['Order', 'Table', 'Items', 'Server', 'Status', 'Total'], description: 'Every order, from the table to the bill.' },
      { path: 'tables', label: 'Tables', icon: 'tables', kind: 'floor', description: 'Your floor, table by table.' },
      { path: 'products', group: 'Menu', label: 'Products', icon: 'products', kind: 'products', description: 'Dishes and drinks, organised by category.' },
      { path: 'menu', group: 'Menu', label: 'Menu configuration', icon: 'menu', kind: 'menu', description: 'What guests see on the menu, and when they see it.' },
      { path: 'insights', group: 'Analytics', label: 'Insights', icon: 'insights', kind: 'insights', description: 'Sales and service trends over time.' },
    ],
    contact: { path: 'contact-cravio', label: 'Contact Cravio', icon: 'contact', kind: 'support', description: 'Reach the Cravio team about anything in your restaurant.' },
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
  return [...config.sections, ...(config.contact ? [config.contact] : []), settingsSection];
}

export function sectionForPath(role, pathname) {
  return sectionsFor(role).find((section) => pathname.replace(/\/$/, '') === `/${role}${section.path ? `/${section.path}` : ''}`) || dashboards[role].sections[0];
}

export function groupSections(sections) {
  return sections.reduce((groups, section) => {
    const last = groups[groups.length - 1];
    if (last && last.label === (section.group || null)) last.sections.push(section);
    else groups.push({ label: section.group || null, sections: [section] });
    return groups;
  }, []);
}
