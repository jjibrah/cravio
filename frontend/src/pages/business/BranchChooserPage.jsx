// /branch (no id) and legacy /owner/<page> links: send the account to the right branch workspace.
// One managed branch: straight there (keeping the page). Several: choose. None: home.
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { Loading, PageShell } from '../AuthPages';
import AccountPage from '../AccountPage';
import { OIcon } from '../../components/owner/ui';
import { homeFor, useAuth } from '../../lib/auth';
import { branchesWithRole } from '../../lib/branch';
import './business.css';

/** `legacyPage`: rendered at /owner/<legacyPage>/* for old owner links; the rest of the path is kept. */
export default function BranchChooserPage({ legacyPage = '' }) {
  const { session, initializing, account, accountLoading, accountError } = useAuth();
  const { '*': rest = '' } = useParams();
  const { search } = useLocation();
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (!account && (accountLoading || !accountError)) return <Loading />;
  if (!account && accountError) return <AccountPage />;
  const managed = branchesWithRole(account, 'manager');
  // Only legacy routes have their own splat; at /branch, '*' is the app-level splat ('branch') and is ignored.
  const page = legacyPage ? [legacyPage, rest].filter(Boolean).map((part) => `/${part}`).join('') : '';
  if (!managed.length) return <Navigate to={homeFor(account)} replace />;
  if (managed.length === 1) return <Navigate to={`/branch/${managed[0].id}${page}${search}`} replace />;
  return <PageShell>
    <h1>Choose a branch</h1>
    <p>You manage {managed.length} branches. Pick the one you’re working in; you can switch from the sidebar at any time.</p>
    <ul className="biz-choose">
      {managed.map((branch) => <li key={branch.id}><Link to={`/branch/${branch.id}${page}${search}`}>
        <span><strong>{branch.name}</strong>{branch.location && <><br /><small>{branch.location}</small></>}</span>
        <OIcon name="arrowRight" size={16} />
      </Link></li>)}
    </ul>
    {(account.businesses || []).length > 0 && <p><Link to="/owner">Go to the owner overview</Link></p>}
  </PageShell>;
}
