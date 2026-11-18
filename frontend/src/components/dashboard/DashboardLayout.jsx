import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { homeFor, useAuth } from '../../lib/auth';
import { findBranch, getActiveBranch, setActiveBranch } from '../../lib/branch';
import { sectionForPath } from '../../config/dashboards';
import AccountPage from '../../pages/AccountPage';
import { Loading } from '../../pages/AuthPages';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import Icon from '../Icon';
import UpdatingPill from './UpdatingPill';
import AssistantBubble from '../assistant/AssistantBubble';
import './dashboard.css';

/**
 * Who may enter which area. The backend checks every request again; this only decides where to send people.
 *   admin  – profile role admin
 *   owner  – at least one business grant (owner or operations)
 *   branch – a manager role at the branch in the URL
 */
function allowed(area, account, branchId) {
  if (area === 'admin') return account.role === 'admin';
  if (area === 'owner') return (account.businesses || []).length > 0;
  if (area === 'branch') return findBranch(account, branchId)?.role === 'manager';
  return false;
}

export default function DashboardLayout({ role: area }) {
  const { session, initializing, account, accountLoading, accountError, refreshVersion } = useAuth();
  const { pathname } = useLocation();
  const { branchId } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  useEffect(() => setSidebarOpen(false), [pathname]);
  // Before the page below fetches anything, every API call must name this branch (and the cache must be emptied
  // on a switch). Done in a layout effect, then the page renders once the active branch matches the URL.
  const permitted = area === 'branch' && account && findBranch(account, branchId)?.role === 'manager' ? branchId : null;
  const [activeId, setActiveId] = useState(getActiveBranch);
  useLayoutEffect(() => {
    if (!permitted) return;
    setActiveBranch(permitted);
    setActiveId(permitted);
  }, [permitted]);
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (!account && (accountLoading || !accountError)) return <Loading />;
  if (!account && accountError) return <AccountPage />;
  if (account?.terms?.required) return <Navigate to="/terms/accept" replace />;
  if (!allowed(area, account, branchId)) return <Navigate to={area === 'branch' && (account.branches || []).length ? '/branch' : homeFor(account)} replace />;

  const branch = area === 'branch' ? findBranch(account, branchId) : null;
  if (area === 'branch' && activeId !== branch.id) return <Loading />;
  if (area === 'branch' && branch.status === 'onboarding') return <Navigate to="/onboarding" replace />;
  const base = area === 'branch' ? `/branch/${branch.id}` : `/${area}`;
  const scope = { area, base, branch, place: area === 'branch' ? branch : null };
  const section = sectionForPath(area, pathname, base);

  return <div className={`page page-${area === 'admin' ? 'admin' : 'owner'} dashboard${area === 'admin' ? ' has-strip' : ''}`}>
    <a className="skip-link" href="#dashboard-content">Skip to content</a>
    {area === 'admin' && <div className="internal-strip" role="note"><Icon name="internal" size={14} />Cravio internal · Admin workspace</div>}
    <Sidebar account={account} scope={scope} open={sidebarOpen} onClose={closeSidebar} />
    <div className="dashboard-body">
      <TopNav account={account} scope={scope} section={section} onOpenSidebar={() => setSidebarOpen(true)} />
      {/* key: a branch switch remounts every page, so no state from the previous branch survives. */}
      <main className="dashboard-content" id="dashboard-content" tabIndex={-1}><div className="dashboard-container">
        <Outlet key={`${branch?.id || area}:${refreshVersion}`} context={{ account, scope }} />
      </div></main>
    </div>
    <UpdatingPill />
    {area === 'owner' && <AssistantBubble />}
  </div>;
}
