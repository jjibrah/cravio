import { useCallback, useEffect, useId, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../../lib/auth';
import { waiterSections } from '../../config/waiter';
import { Loading } from '../../pages/AuthPages';
import AccountPage from '../../pages/AccountPage';
import NotificationCenter from '../notifications/NotificationCenter';
import Icon from '../Icon';
import RefreshButton from '../RefreshButton';
import WaiterProfileSheet from './WaiterProfileSheet';
import { LiveProvider, useLive } from './LiveProvider';
import './waiter.css';
import './ops.css';

const RETURN_KEY = 'cravio-waiter-return';
const remember = (path) => { try { sessionStorage.setItem(RETURN_KEY, path); } catch { /* storage blocked */ } };
const recall = () => { try { const path = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); return path; } catch { return null; } };

/** Polite announcements for new attention items, and the Services count badge. */
function LiveAnnouncer() {
  const { announcement } = useLive();
  return <p className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>;
}
function ServicesBadge({ id }) {
  const { items } = useLive();
  const count = items.length;
  if (!count) return null;
  return <><span className="waiter-tab-badge" data-count={count > 99 ? '99+' : count} aria-hidden="true" /><span id={id} hidden>{count} need attention</span></>;
}

export default function WaiterLayout() {
  const { session, initializing, account, accountLoading, accountError, refreshVersion } = useAuth();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const badgeId = useId();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileId = useId();
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  useEffect(() => setProfileOpen(false), [pathname]);
  // A signed-out waiter who scanned a guest's QR comes back to that cart after signing in.
  const isWaiter = account?.role === 'waiter';
  useEffect(() => {
    if (!session || !isWaiter) return;
    const back = recall();
    if (back && back.startsWith('/waiter/') && back !== pathname + search) navigate(back, { replace: true });
  }, [session, isWaiter, navigate, pathname, search]);
  if (initializing) return <Loading />;
  if (!session) {
    if (pathname.startsWith('/waiter/cart/')) remember(pathname + search);
    return <Navigate to="/login" replace />;
  }
  if (!account && (accountLoading || !accountError)) return <Loading />;
  if (!account && accountError) return <AccountPage />;
  if (account.role !== 'waiter') return <Navigate to={homeFor(account)} replace />;
  const restaurantName = account.place?.name?.trim() || import.meta.env.VITE_RESTAURANT_NAME?.trim() || 'Your restaurant';
  const initials = account.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  return <LiveProvider><div className="page page-waiter waiter-app">
    <header className="waiter-header">
      <div className="waiter-restaurant"><span className="waiter-restaurant-name" title={restaurantName}>{restaurantName}</span><span className="waiter-restaurant-meta">Waiter</span></div>
      <div className="waiter-header-actions">
        <RefreshButton />
        <NotificationCenter presentation="sheet" />
        <button className="icon-button waiter-profile-button" aria-label="Open profile" aria-haspopup="dialog" aria-expanded={profileOpen} aria-controls={profileOpen ? profileId : undefined} onClick={() => setProfileOpen(true)}>
          <span aria-hidden="true">{initials}</span>
        </button>
      </div>
    </header>
    <main className="waiter-content" id="waiter-content"><Outlet key={refreshVersion} /></main>
    <LiveAnnouncer />
    <nav className="waiter-tabs" aria-label="Waiter navigation">
      {waiterSections.map((section) => <NavLink end key={section.path} to={`/waiter${section.path ? `/${section.path}` : ''}`} className={({ isActive }) => `waiter-tab${isActive ? ' is-active' : ''}`} aria-describedby={section.path === 'services' ? badgeId : undefined}>
        <span className="waiter-tab-icon"><Icon name={section.icon} size={22} />{section.path === 'services' && <ServicesBadge id={badgeId} />}</span><span>{section.label}</span>
      </NavLink>)}
    </nav>
    <WaiterProfileSheet id={profileId} account={account} open={profileOpen} onClose={closeProfile} />
  </div></LiveProvider>;
}
