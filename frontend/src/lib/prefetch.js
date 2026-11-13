/*
 * Route chunks and their warm-up. Each area of the app is its own chunk (see App.jsx); `prefetchRoute(path)`
 * starts loading the chunks a path needs (and, for pages that read through the API cache, their main GETs)
 * so a click a moment later renders without waiting. Loaders run once; a failed load can be retried.
 */
import { getCacheScope } from './cache';

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
  waiter: once(() => import('../components/waiter/WaiterLayout')),
  waiterTables: once(() => import('../pages/waiter/WaiterTablesPage')),
  waiterServices: once(() => import('../pages/waiter/WaiterServicesPage')),
  waiterMenu: once(() => import('../pages/waiter/WaiterMenuPage')),
  newOrder: once(() => import('../pages/waiter/NewOrderPage')),
  cartImport: once(() => import('../pages/waiter/CartImportPage')),
  welcome: once(() => import('../pages/onboarding/WelcomePage')),
  onboarding: once(() => import('../pages/onboarding/OnboardingPage')),
  guestMenu: once(() => import('../pages/GuestMenuPage')),
};

/** The GETs the owner Overview reads through the cache (OverviewPage uses the same keys). */
export const OVERVIEW_GETS = ['/api/ops/live', '/api/ops/analytics?range=today', '/api/ops/health', '/api/restaurant/onboarding'];

const OWNER_PAGES = { '': 'overview', orders: 'orders', tables: 'tables', products: 'products', menu: 'menuConfig', insights: 'insights' };
const WAITER_PAGES = { '': 'waiterTables', services: 'waiterServices', menu: 'waiterMenu', order: 'newOrder', cart: 'cartImport' };

/** Which chunks a pathname needs, or null for a path outside the app. */
export function chunksFor(pathname) {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1);
  const [area = '', page = '', detail] = parts;
  const signedIn = ['auth'];
  switch (area) {
    case '': return [...signedIn, 'authPages'];
    case 'guest-menu': return ['guestMenu'];
    case 'login': case 'forgot-password': case 'reset-password': return [...signedIn, 'authPages'];
    case 'account': return [...signedIn, 'account'];
    case 'welcome': return [...signedIn, 'welcome'];
    case 'onboarding': return [...signedIn, 'onboarding'];
    case 'owner': {
      const key = page === 'tables' && detail ? 'tableDetail' : OWNER_PAGES[page] || 'pageFrame';
      return [...signedIn, 'dashboard', key];
    }
    case 'admin': return [...signedIn, 'dashboard', page === 'users' ? 'users' : 'pageFrame'];
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
  if (data && getCacheScope() && pathname.replace(/\/+$/, '') === '/owner') {
    import('./api').then(({ prefetchApi }) => OVERVIEW_GETS.forEach((get) => prefetchApi(get))).catch(() => {});
  }
  return loading;
}

const saveData = () => Boolean(navigator.connection?.saveData) || /(^|-)2g$/.test(navigator.connection?.effectiveType || '');

/** While the browser is idle, warms the other main pages of the area the user is in (chunks only). */
export function prefetchArea(pathname) {
  if (saveData()) return;
  const area = pathname.split('/')[1];
  const paths = area === 'owner' ? ['/owner', '/owner/orders', '/owner/tables', '/owner/products', '/owner/menu', '/owner/insights']
    : area === 'waiter' ? ['/waiter', '/waiter/services', '/waiter/menu', '/waiter/order/new']
      : area === 'admin' ? ['/admin', '/admin/users']
        // After signing in, people land on the owner or waiter home.
        : area === 'login' ? ['/owner', '/waiter'] : [];
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
