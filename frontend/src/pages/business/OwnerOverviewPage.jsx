// Owner Overview: today's summary (what happened, what needs you), today's figures, and every overseen branch.
// The "Ask Cravio" chat bubble (components/assistant) floats on every owner page.
// Everything comes from /api/owner/briefing and /api/owner/overview, computed from recorded orders, guest requests
// and stock.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, Panel, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
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

const greeting = () => { const h = Number(new Date().toLocaleString('en-KE', { hour: 'numeric', hour12: false, timeZone: 'Africa/Nairobi' })); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const clock = (iso) => new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });

/** Today's summary: what happened and what needs you, from /api/owner/briefing. */
function TodayCard() {
  const { data: brief, error, loading, refresh } = useApi('/api/owner/briefing', { ttl: 60000 });
  if (error && !brief) return <OwnerError error={error} onRetry={refresh} what="today’s summary" />;
  if (loading && !brief) return <Panel title="Today"><SkeletonRows rows={3} thumb={false} label="Preparing today’s summary" /></Panel>;
  if (brief.empty) return null;
  return <article className="pa-brief" aria-labelledby="pa-brief-title">
    <div className="pa-brief-main">
      <p className="pa-eyebrow">Today · {brief.scope}</p>
      <h2 id="pa-brief-title" className="pa-headline">{brief.headline}</h2>
      <ul className="pa-points">{brief.points.map((point) => <li key={point}>{point}</li>)}</ul>
      <p className="pa-foot">Updated {clock(brief.generatedAt)} · Nairobi time · <button type="button" className="o-text-link" onClick={() => refresh()}>Refresh</button></p>
    </div>
    <div className="pa-brief-side">
      <h3 className="pa-subhead">{brief.attention.length ? 'Needs you' : 'All clear'}</h3>
      {brief.attention.length ? <ul className="pa-attention">{brief.attention.map((item, index) => <li key={index} className={`is-${item.tone}`}>
        <span className="pa-dot" aria-hidden="true" />
        <span className="pa-attention-text">{item.text}</span>
        {item.link && <Link className="o-btn is-quiet is-small" to={item.link}>Open<span className="visually-hidden">: {item.text}</span></Link>}
      </li>)}</ul> : <p className="pa-clear">Nothing is waiting on you right now.</p>}
    </div>
  </article>;
}

export default function OwnerOverviewPage() {
  const { account } = useAuth();
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  const branches = businesses.flatMap((business) => business.branches);
  const totals = useMemo(() => branches.reduce((sum, branch) => ({
    orders: sum.orders + (branch.today?.orders || 0), paid: sum.paid + (branch.today?.paidSales || 0),
    open: sum.open + (branch.today?.openOrders || 0), requests: sum.requests + (branch.today?.openRequests || 0),
  }), { orders: 0, paid: 0, open: 0, requests: 0 }), [branches]);
  const first = account?.name?.split(/\s+/)[0] || '';
  const date = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' });

  return <div className="biz-stack">
    <PageHeader title={`${greeting()}${first ? `, ${first}` : ''}`} description={date} />
    <TodayCard />
    {error && !data ? <OwnerError error={error} onRetry={refresh} what="your branches" />
      : loading && !data ? <Panel title="Branches"><SkeletonRows rows={3} thumb={false} label="Loading branches" /></Panel>
        : !businesses.length ? <EmptyState icon="store" tone="neutral" title="No business access yet">Ask the business owner or Cravio to grant access.</EmptyState>
          : <>
            <section className="biz-grid" aria-label="Today across your branches">
              <div className="o-stat"><p className="o-stat-label">Orders today</p><p className="o-stat-value">{totals.orders}</p><p className="o-stat-hint">Excluding cancelled</p></div>
              <div className="o-stat"><p className="o-stat-label">Paid today</p><p className="o-stat-value">{money(totals.paid)}</p><p className="o-stat-hint">Marked paid by staff</p></div>
              <div className="o-stat"><p className="o-stat-label">In progress</p><p className="o-stat-value">{totals.open}</p><p className="o-stat-hint">Not yet paid</p></div>
              <div className="o-stat"><p className="o-stat-label">Guest requests</p><p className="o-stat-value">{totals.requests}</p><p className="o-stat-hint">Waiter calls and bills</p></div>
            </section>
            {businesses.map((business) => <Panel key={business.id} title={business.name} count={business.branches.length}
              sub={`${roleName[business.role]} · updated ${clock(data.generatedAt)}`}
              actions={business.role === 'owner' && <Link className="o-btn is-quiet is-small" to="/owner/locations">Manage locations</Link>}>
              {business.branches.length ? <BranchRows branches={business.branches} />
                : <EmptyState icon="store" tone="neutral" title="No branches assigned">The business owner hasn’t assigned you any branches yet.</EmptyState>}
            </Panel>)}
          </>}
  </div>;
}
