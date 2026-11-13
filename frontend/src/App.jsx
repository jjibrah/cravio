import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useOutletContext } from 'react-router-dom';
import { NotificationProvider } from './components/notifications/NotificationProvider';
import LoadingScreen from './components/loading/LoadingScreen';
import PageSkeleton from './components/loading/PageSkeleton';
import { dashboards, sectionsFor } from './config/dashboards';
import { waiterSections } from './config/waiter';
import { chunks, listenForIntent, prefetchArea } from './lib/prefetch';

/*
 * Every area is its own chunk (lib/prefetch.js lists them), so the first load only fetches what the
 * current page needs. The Supabase client lives with AuthProvider, so the landing page and the guest
 * menu never download it. The full-screen loader covers the first load; inside the owner, admin and
 * waiter shells a light skeleton covers a page whose code is still loading, so the shell stays put.
 */

/**
 * A route component from a chunk loader. If the chunk has already loaded (main.jsx waits for the first
 * route's chunks; hover prefetches the rest) it renders straight away; otherwise it suspends via
 * React.lazy. The choice is made once per mount, so a component never switches type and remounts.
 */
function page(loader, name = 'default') {
  const Lazy = lazy(() => loader().then((module) => ({ default: module[name] })));
  function Page(props) {
    const [Loaded] = useState(() => loader.module?.[name] || null);
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  Page.displayName = `Page(${name})`;
  return Page;
}
const GuestMenuPage = page(chunks.guestMenu);
const AuthProvider = page(chunks.auth, 'AuthProvider');
const LoginPage = page(chunks.authPages, 'LoginPage');
const ForgotPasswordPage = page(chunks.authPages, 'ForgotPasswordPage');
const ResetPasswordPage = page(chunks.authPages, 'ResetPasswordPage');
const PageShell = page(chunks.authPages, 'PageShell');
const AccountPage = page(chunks.account);
const DashboardLayout = page(chunks.dashboard);
const PageFrame = page(chunks.pageFrame);
const OverviewPage = page(chunks.overview);
const OrdersPage = page(chunks.orders);
const TablesPage = page(chunks.tables);
const TableDetailPage = page(chunks.tableDetail);
const ProductsPage = page(chunks.products);
const MenuConfigPage = page(chunks.menuConfig);
const InsightsPage = page(chunks.insights);
const UsersPage = page(chunks.users);
const SettingsPage = page(chunks.settings);
const ContactPage = page(chunks.contact);
const AdminOverviewPage = page(chunks.adminOverview);
const RestaurantsPage = page(chunks.adminRestaurants);
const PerformancePage = page(chunks.adminPerformance);
const MoneyPage = page(chunks.adminMoney);
const RequestsPage = page(chunks.adminRequests);
const WaiterLayout = page(chunks.waiter);
const WaiterTablesPage = page(chunks.waiterTables);
const WaiterServicesPage = page(chunks.waiterServices);
const WaiterMenuPage = page(chunks.waiterMenu);
const NewOrderPage = page(chunks.newOrder);
const CartImportPage = page(chunks.cartImport);
const WelcomePage = page(chunks.welcome);
const OnboardingPage = page(chunks.onboarding);

const configured = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
const waiterPages = { '': WaiterTablesPage, services: WaiterServicesPage, menu: WaiterMenuPage };

/** Picks the page for a dashboard section; anything without a real page yet falls back to a page frame. */
const ADMIN_PAGES = { '': AdminOverviewPage, restaurants: RestaurantsPage, performance: PerformancePage, money: MoneyPage, 'leads-requests': RequestsPage, complaints: RequestsPage };
function DashboardPage({ section }) {
  const { account } = useOutletContext() || {};
  const owner = account?.role === 'owner';
  const admin = account?.role === 'admin';
  let Page = PageFrame;
  if (section.kind === 'settings') Page = SettingsPage;
  else if (section.kind === 'products' && owner) Page = ProductsPage;
  else if (section.kind === 'users') Page = UsersPage;
  else if (admin && ADMIN_PAGES[section.path]) Page = ADMIN_PAGES[section.path];
  else if (owner && section.kind === 'overview') Page = OverviewPage;
  else if (owner && section.path === 'orders') Page = OrdersPage;
  else if (owner && section.path === 'tables') Page = TablesPage;
  else if (owner && section.path === 'menu') Page = MenuConfigPage;
  else if (owner && section.path === 'insights') Page = InsightsPage;
  else if (owner && section.kind === 'support') Page = ContactPage;
  return <Page section={section} />;
}

const inShell = (element, variant) => <Suspense fallback={<PageSkeleton variant={variant} />}>{element}</Suspense>;

function SignedInApp() {
  return <AuthProvider><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />
    {Object.keys(dashboards).map((role) => <Route key={role} path={`/${role}`} element={<DashboardLayout role={role} />}>
      {sectionsFor(role).map((section) => section.path
        ? <Route key={section.path} path={section.path} element={inShell(<DashboardPage section={section} />)} />
        : <Route key="overview" index element={inShell(<DashboardPage section={section} />)} />)}
      {role === 'owner' && <Route path="tables/:number" element={inShell(<TableDetailPage />)} />}
      <Route path="*" element={<Navigate to={`/${role}`} replace />} />
    </Route>)}
    <Route path="/waiter" element={<WaiterLayout />}>
      {waiterSections.map((section) => {
        const Page = waiterPages[section.path];
        return section.path
          ? <Route key={section.path} path={section.path} element={inShell(<Page section={section} />, 'waiter')} />
          : <Route key="tables" index element={inShell(<Page section={section} />, 'waiter')} />;
      })}
      <Route path="order/new" element={inShell(<NewOrderPage />, 'waiter')} />
      <Route path="cart/:code" element={inShell(<CartImportPage />, 'waiter')} />
      <Route path="*" element={<Navigate to="/waiter" replace />} />
    </Route>
    <Route path="/welcome" element={<WelcomePage />} />
    <Route path="/onboarding/*" element={<OnboardingPage />} />
    <Route path="/account" element={<AccountPage />} />
    <Route path="*" element={<Navigate to="/login" replace />} />
  </Routes></AuthProvider>;
}

function SetupRequired() {
  return <PageShell><h1>Setup required</h1><p>Configure the frontend Supabase environment values, then restart the app.</p></PageShell>;
}

/** Warms routes on hover or focus, and the rest of the current area once the browser is idle. */
function Warmup() {
  const area = useLocation().pathname.split('/')[1];
  useEffect(() => listenForIntent(document), []);
  useEffect(() => prefetchArea(`/${area}`), [area]);
  return null;
}

export default function App() {
  return <BrowserRouter><NotificationProvider>
    <Warmup />
    <Suspense fallback={<LoadingScreen delay={400} />}>
      <Routes>
        {/* There is no public landing page: the app opens on sign-in, which sends signed-in users home. */}
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/guest-menu" element={<GuestMenuPage />} />
        <Route path="*" element={configured ? <SignedInApp /> : <SetupRequired />} />
      </Routes>
    </Suspense>
  </NotificationProvider></BrowserRouter>;
}
