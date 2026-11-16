// Owner / operations overview: every branch the account oversees, with today's recorded activity.
// Figures come from /api/owner/overview, computed from orders and requests the branches recorded; nothing is estimated.
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, Panel, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import { useApi } from '../../lib/api';
import { BranchStatus, OwnerError, WorkspaceLink, money, roleName, timeAgo } from './shared';
import './business.css';

export function BranchRows({ branches }) {
  return <ul className="biz-branches">
    {branches.map((branch) => <li className="biz-branch" key={branch.id}>
      <div className="biz-branch-name">
        <Link to={`/owner/branches/${branch.id}`}>{branch.name}</Link>
        <span className="biz-branch-sub"><BranchStatus status={branch.status} />{branch.location && <span>{branch.location}</span>}</span>
      </div>
      {branch.today ? <>
        <dl className="biz-figure"><dt>Orders today</dt><dd>{branch.today.orders}</dd></dl>
        <dl className="biz-figure"><dt>Paid today</dt><dd>{money(branch.today.paidSales)}</dd></dl>
        <dl className="biz-figure"><dt>Open requests</dt><dd className={branch.today.openRequests ? 'is-alert' : ''}>{branch.today.openRequests}</dd></dl>
        <dl className="biz-figure"><dt>Last order</dt><dd>{timeAgo(branch.today.lastOrderAt)}</dd></dl>
      </> : <><span /><span /><span /><span /></>}
      <div className="biz-branch-actions">
        <Link className="o-btn is-quiet is-small" to={`/owner/branches/${branch.id}`}>Details</Link>
        <WorkspaceLink branch={branch} />
      </div>
    </li>)}
  </ul>;
}

export default function OwnerOverviewPage({ section }) {
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  const branches = businesses.flatMap((business) => business.branches);
  const totals = branches.reduce((sum, branch) => ({
    orders: sum.orders + (branch.today?.orders || 0), paid: sum.paid + (branch.today?.paidSales || 0),
    open: sum.open + (branch.today?.openOrders || 0), requests: sum.requests + (branch.today?.openRequests || 0),
  }), { orders: 0, paid: 0, open: 0, requests: 0 });

  return <div className="biz-stack">
    <PageHeader title={section.label} description={section.description} />
    {error && !data ? <OwnerError error={error} onRetry={refresh} what="your branches" />
      : loading && !data ? <Panel title="Branches"><SkeletonRows rows={3} thumb={false} label="Loading branches" /></Panel>
        : !businesses.length ? <EmptyState icon="store" tone="neutral" title="No business access yet">Your account isn’t linked to a business. Ask the business owner or Cravio to grant access.</EmptyState>
          : <>
            <section className="biz-grid" aria-label={`Today across ${branches.length} branch${branches.length === 1 ? '' : 'es'}`}>
              <div className="o-stat"><p className="o-stat-label">Orders today</p><p className="o-stat-value">{totals.orders}</p><p className="o-stat-hint">Excluding cancelled</p></div>
              <div className="o-stat"><p className="o-stat-label">Paid today</p><p className="o-stat-value">{money(totals.paid)}</p><p className="o-stat-hint">Orders staff marked paid</p></div>
              <div className="o-stat"><p className="o-stat-label">Orders in progress</p><p className="o-stat-value">{totals.open}</p><p className="o-stat-hint">Taken, accepted or served</p></div>
              <div className="o-stat"><p className="o-stat-label">Open guest requests</p><p className="o-stat-value">{totals.requests}</p><p className="o-stat-hint">Waiter calls and bills</p></div>
            </section>
            {businesses.map((business) => <Panel key={business.id} title={business.name} count={business.branches.length}
              sub={`${roleName[business.role]} · today in Nairobi time · updated ${new Date(data.generatedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}`}
              actions={business.role === 'owner' && <Link className="o-btn is-quiet is-small" to="/owner/locations">Manage locations</Link>}>
              {business.branches.length ? <BranchRows branches={business.branches} />
                : <EmptyState icon="store" tone="neutral" title="No branches assigned">The business owner hasn’t assigned you any branches yet.</EmptyState>}
            </Panel>)}
            <p className="biz-meta">Stock levels and branch stock requests will appear here once the inventory rules are agreed (decisions D03–D07).</p>
          </>}
  </div>;
}
