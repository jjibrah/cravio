/*
 * Route chunks and their warm-up. Each area of the app is its own chunk (see App.jsx); `prefetchRoute(path)`
 * starts loading the chunks a path needs (and, for pages that read through the API cache, their main GETs)
 * so a click a moment later renders without waiting. Loaders run once; a failed load can be retried.
 */
import { getCacheScope } from './cache';
import { getActiveBranch } from './branch';

// `loader.module` holds the module once it has loaded, so App can render it without suspending.
const once = (load) => {
  let promise;
  const loader = () => (promise ??= load().then((module) => { loader.module = module; return module; }, (error) => { promise = undefined; throw error; }));
  loader.module = null;
  return loader;
};

export const chunks = {
  auth: once(() => import('./auth')),
  authPages: once(() => import('../pages/AuthPages')),
  account: once(() => import('../pages/AccountPage')),
  dashboard: once(() => import('../components/dashboard/DashboardLayout')),
  pageFrame: once(() => import('../components/dashboard/PageFrame')),
  overview: once(() => import('../pages/owner/OverviewPage')),
  orders: once(() => import('../pages/owner/OrdersPage')),
  tables: once(() => import('../pages/owner/TablesPage')),
  tableDetail: once(() => import('../pages/owner/TableDetailPage')),
  products: once(() => import('../pages/ProductsPage')),
  menuConfig: once(() => import('../pages/owner/MenuConfigPage')),
  insights: once(() => import('../pages/owner/InsightsPage')),
  users: once(() => import('../pages/admin/UsersPage')),
  settings: once(() => import('../pages/settings/SettingsPage')),
  contact: once(() => import('../pages/owner/ContactPage')),
  adminOverview: once(() => import('../pages/admin/AdminOverviewPage')),
  adminBusinesses: once(() => import('../pages/admin/BusinessesPage')),
  adminBusiness: once(() => import('../pages/admin/BusinessDetailPage')),
  adminActivity: once(() => import('../pages/admin/ActivityPage')),
  adminPerformance: once(() => import('../pages/admin/PerformancePage')),
  adminMoney: once(() => import('../pages/admin/MoneyPage')),
  adminRequests: once(() => import('../pages/admin/RequestsPage')),
  waiter: once(() => import('../components/waiter/WaiterLayout')),
  waiterTables: once(() => import('../pages/waiter/WaiterTablesPage')),
  waiterServices: once(() => import('../pages/waiter/WaiterServicesPage')),
  waiterMenu: once(() => import('../pages/waiter/WaiterMenuPage')),
  newOrder: once(() => import('../pages/waiter/NewOrderPage')),
  cartImport: once(() => import('../pages/waiter/CartImportPage')),
  welcome: once(() => import('../pages/onboarding/WelcomePage')),
  onboarding: once(() => import('../pages/onboarding/OnboardingPage')),
  guestMenu: once(() => import('../pages/GuestMenuPage')),
  ownerOverview: once(() => import('../pages/business/OwnerOverviewPage')),
  ownerLocations: once(() => import('../pages/business/LocationsPage')),
  ownerPeople: once(() => import('../pages/business/PeoplePage')),
  ownerBranch: once(() => import('../pages/business/BranchDetailPage')),
  branchChooser: once(() => import('../pages/business/BranchChooserPage')),
  branchInventory: once(() => import('../pages/stock/BranchInventoryPage')),
  ownerInventory: once(() => import('../pages/stock/OwnerInventoryPage')),
  ownerStock: once(() => import('../pages/inventory/OwnerStockPage')),
  ownerItems: once(() => import('../pages/inventory/OwnerItemsPage')),
  ownerRecipes: once(() => import('../pages/inventory/OwnerRecipesPage')),
  branchStock: once(() => import('../pages/inventory/BranchStockPage')),
  branchHistory: once(() => import('../pages/inventory/BranchHistoryPage')),
  branchRecipes: once(() => import('../pages/inventory/BranchRecipesPage')),
  ownerHistory: once(() => import('../pages/inventory/OwnerHistoryPage')),
  receiveCode: once(() => import('../pages/stock/ReceiveCodePage')),
  terms: once(() => import('../components/legal/TermsPage')),
  termsAccept: once(() => import('../components/legal/TermsAcceptPage')),
  adminTerms: once(() => import('../pages/admin/AdminTermsPage')),
};

/** The GETs the owner Overview reads through the cache (OverviewPage uses the same keys). */
export const OVERVIEW_GETS = ['/api/ops/live', '/api/ops/analytics?range=today', '/api/ops/health', '/api/restaurant/onboarding'];

const BRANCH_PAGES = { '': 'overview', orders: 'orders', tables: 'tables', products: 'products', menu: 'menuConfig', insights: 'insights', settings: 'settings', 'contact-cravio': 'contact', inventory: 'branchInventory' };
const OWNER_PAGES = { '': 'ownerOverview', locations: 'ownerLocations', people: 'ownerPeople', branches: 'ownerBranch', inventory: 'ownerInventory' };
const ADMIN_PAGES = { '': 'adminOverview', businesses: 'adminBusinesses', activity: 'adminActivity', terms: 'adminTerms', performance: 'adminPerformance', money: 'adminMoney', 'leads-requests': 'adminRequests', complaints: 'adminRequests', users: 'users', settings: 'settings' };
const WAITER_PAGES = { '': 'waiterTables', services: 'waiterServices', menu: 'waiterMenu', order: 'newOrder', cart: 'cartImport' };

/** Which chunks a pathname needs, or null for a path outside the app. */
export function chunksFor(pathname) {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1);
  const [area = '', page = '', detail] = parts;
  const signedIn = ['auth'];
  switch (area) {
    case '': return [...signedIn, 'authPages'];
    case 'guest-menu': return ['guestMenu'];
    case 'terms': return page === 'accept' ? [...signedIn, 'termsAccept'] : ['terms'];
    case 'login': case 'forgot-password': case 'reset-password': return [...signedIn, 'authPages'];
    case 'account': return [...signedIn, 'account'];
    case 'welcome': return [...signedIn, 'welcome'];
    case 'onboarding': return [...signedIn, 'onboarding'];
    case 'receive': return [...signedIn, 'receiveCode'];
    case 'owner': {
      // Inventory: today's page while the feature is off, the new screen when on (App.jsx InventoryRoute).
      if (page === 'inventory') return [...signedIn, 'dashboard', 'ownerInventory', { items: 'ownerItems', recipes: 'ownerRecipes', history: 'ownerHistory' }[detail] || 'ownerStock'];
      if (BRANCH_PAGES[page] && page) return [...signedIn, 'branchChooser']; // legacy link, redirected to a branch
      return [...signedIn, 'dashboard', OWNER_PAGES[page] || 'pageFrame'];
    }
    case 'branch': {
      if (!page) return [...signedIn, 'branchChooser'];
      // /branch/<id>/<section>/<detail>
      const [section = '', sub] = [detail, parts[3]];
      const key = section === 'tables' && sub ? 'tableDetail' : BRANCH_PAGES[section] || 'pageFrame';
      // With inventory on, branch Stock/History/Recipes use the new pages (also warm them).
      return [...signedIn, 'dashboard', key, ...({ recipes: ['branchRecipes'], inventory: ['branchStock', 'branchHistory'] }[section] || [])];
    }
    case 'admin': return [...signedIn, 'dashboard', page === 'businesses' && detail ? 'adminBusiness' : ADMIN_PAGES[page] || 'pageFrame'];
    case 'waiter': return [...signedIn, 'waiter', WAITER_PAGES[page] || 'waiterTables'];
    default: return null;
  }
}

/**
 * Starts loading what `path` needs. Safe to call often (hover, focus): chunks load once, and data is
 * only fetched for a signed-in user when the cached copy is older than its ttl.
 */
export function prefetchRoute(path, { data = true } = {}) {
  let pathname;
  try { pathname = new URL(path, window.location.origin).pathname; } catch { return Promise.resolve(); }
  const keys = chunksFor(pathname);
  if (!keys) return Promise.resolve();
  const loading = Promise.all(keys.map((key) => chunks[key]())).catch(() => undefined);
  // lib/api pulls in the Supabase client, so it's imported on demand to keep it out of the entry chunk.
  // Branch overview data only for the branch already active (its header goes with the request).
  if (data && getCacheScope() && getActiveBranch() && pathname.replace(/\/+$/, '') === `/branch/${getActiveBranch()}`) {
    import('./api').then(({ prefetchApi }) => OVERVIEW_GETS.forEach((get) => prefetchApi(get))).catch(() => {});
  }
  return loading;
}

const saveData = () => Boolean(navigator.connection?.saveData) || /(^|-)2g$/.test(navigator.connection?.effectiveType || '');

/** While the browser is idle, warms the other main pages of the area the user is in (chunks only). */
export function prefetchArea(pathname) {
  if (saveData()) return;
  const area = pathname.split('/')[1];
  const branch = pathname.split('/')[2];
  const paths = area === 'branch' && branch ? ['', '/orders', '/tables', '/products', '/menu', '/insights'].map((page) => `/branch/${branch}${page}`)
    : area === 'owner' ? ['/owner', '/owner/locations', '/owner/people']
    : area === 'waiter' ? ['/waiter', '/waiter/services', '/waiter/menu', '/waiter/order/new']
      : area === 'admin' ? ['/admin', '/admin/users']
        // After signing in, people land on the owner or waiter home.
        : area === 'login' ? ['/owner', '/branch/x', '/waiter'] : [];
  if (!paths.length) return;
  const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 1));
  let index = 0;
  let stopped = false;
  const step = () => {
    if (stopped || index >= paths.length) return;
    prefetchRoute(paths[index++], { data: false });
    idle(step, { timeout: 2000 });
  };
  const timer = window.setTimeout(() => idle(step, { timeout: 2000 }), 1500);
  return () => { stopped = true; window.clearTimeout(timer); };
}

/** Warms routes when the pointer rests on, or keyboard focus reaches, a same-origin app link. */
export function listenForIntent(root = document) {
  const onIntent = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.target === '_blank' || anchor.origin !== window.location.origin) return;
    prefetchRoute(anchor.pathname);
  };
  root.addEventListener('pointerover', onIntent, { passive: true });
  root.addEventListener('focusin', onIntent);
  return () => {
    root.removeEventListener('pointerover', onIntent);
    root.removeEventListener('focusin', onIntent);
  };
}
