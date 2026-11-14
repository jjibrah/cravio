import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from '../../lib/auth';
import { sectionForPath } from '../../config/dashboards';
import AccountPage from '../../pages/AccountPage';
import { Loading } from '../../pages/AuthPages';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import Icon from '../Icon';
import './dashboard.css';

export default function DashboardLayout({ role }) {
  const { session, initializing, account, accountLoading, accountError, refreshVersion } = useAuth();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  useEffect(() => setSidebarOpen(false), [pathname]);
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (!account && (accountLoading || !accountError)) return <Loading />;
  if (!account && accountError) return <AccountPage />;
  if (account.role !== role) return <Navigate to={homeFor(account)} replace />;
  // Contract with /api/me: owners whose restaurant isn't set up yet go through onboarding first.
  if (role === 'owner' && account.onboardingRequired && !['/owner/inventory', '/owner/management', '/owner/assistant'].includes(pathname)) return <Navigate to="/onboarding" replace />;
  const section = sectionForPath(role, pathname);

  return <div className={`page page-${role} dashboard${role === 'admin' ? ' has-strip' : ''}`}>
    <a className="skip-link" href="#dashboard-content">Skip to content</a>
    {role === 'admin' && <div className="internal-strip" role="note"><Icon name="internal" size={14} />Cravio internal · Admin workspace</div>}
    <Sidebar account={account} open={sidebarOpen} onClose={closeSidebar} />
    <div className="dashboard-body">
      <TopNav account={account} section={section} onOpenSidebar={() => setSidebarOpen(true)} />
      <main className="dashboard-content" id="dashboard-content" tabIndex={-1}><div className="dashboard-container"><Outlet key={refreshVersion} context={{ account }} /></div></main>
    </div>
  </div>;
}
