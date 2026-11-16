// Admin Businesses (/admin/businesses): every customer business with its branches, owners, staff, 30-day usage
// and inventory health (counts only). Search (?q=), filter chips (?status=), sortable columns; a row opens the
// business (/admin/businesses/:id).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, ErrorState, OIcon, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import { KpiTiles, SortHeader, formatKsh, formatWhole, sortRows, timeAgo } from './platform-ui';
import './business.css';

export const BUSINESS_STATUS = { live: 'Live', onboarding: 'Setting up', empty: 'No branches' };
export function BusinessStatus({ status }) {
  return <span className={`o-status-chip is-${status === 'live' ? 'paid' : status === 'onboarding' ? 'taken' : 'cancelled'}`}>
    <span className="o-status-chip-dot" aria-hidden="true" />{BUSINESS_STATUS[status] || status}</span>;
}

/** Inventory health in words (counts only; the admin never sees the records). */
export function stockSummary(stock) {
  if (!stock) return { text: 'Not set up', tone: 'muted' };
  if (!stock.items) return { text: 'Not started', tone: 'muted' };
  const issues = [stock.out && `${stock.out} out`, stock.requestsWaiting && `${stock.requestsWaiting} requests`, stock.shortDeliveries30d && `${stock.shortDeliveries30d} short`].filter(Boolean);
  return issues.length ? { text: issues.join(' · '), tone: 'warn' } : { text: `${stock.items} items · OK`, tone: 'ok' };
}

const matches = (row, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.name, ...row.branches.map((b) => b.name), ...row.branches.map((b) => b.location), ...row.owners.map((o) => o.name), ...row.owners.map((o) => o.email)]
    .some((value) => value && value.toLowerCase().includes(needle));
};

export default function BusinessesPage({ section }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, error, refresh, loading } = useApi('/api/admin/businesses', { ttl: 30000 });
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const q = params.get('q') || '';
  const status = params.get('status') || 'all';
  const set = (patch) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(patch).forEach(([key, value]) => { if (value && value !== 'all') next.set(key, value); else next.delete(key); });
    return next;
  }, { replace: true });

  const rows = data?.businesses || [];
  const searched = useMemo(() => rows.filter((row) => matches(row, q)), [rows, q]);
  const filter = (row) => status === 'all' || (status === 'no-owner' ? !row.owners.length : row.status === status);
  const visible = useMemo(() => sortRows(searched.filter(filter), sort, (row, key) => (key === 'owner' ? row.owners[0]?.name : key === 'branchCount' ? row.branches.length : row[key])),
    [searched, status, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const chips = [
    { value: 'all', label: 'All', count: searched.length },
    { value: 'live', label: 'Live', count: searched.filter((r) => r.status === 'live').length },
    { value: 'onboarding', label: 'Setting up', count: searched.filter((r) => r.status === 'onboarding').length },
    { value: 'no-owner', label: 'No owner', count: searched.filter((r) => !r.owners.length).length },
  ];
  const c = data?.counts;
  const tiles = c && [
    { key: 'b', label: 'Businesses', value: formatWhole(c.all), sub: `${formatWhole(c.live)} live · ${formatWhole(c.onboarding)} setting up` },
    { key: 'r', label: 'Branches', value: formatWhole(c.branches), sub: 'Restaurants on Cravio' },
    { key: 'o', label: 'Without an owner', value: formatWhole(c.noOwner), sub: c.noOwner ? 'Can’t use the owner platform' : 'Every business has one' },
    { key: 'p', label: 'Paid, 30 days', value: formatKsh(rows.reduce((sum, r) => sum + r.paid30d, 0)), sub: 'Across all branches' },
  ];

  return <div className="in-page pl-page ab-page">
    <PageHeader title={section?.label || 'Businesses'} description={section?.description}>
      <Link className="o-btn is-primary" to="/admin/users?invite=owner"><OIcon name="plus" size={16} />Invite an owner</Link>
    </PageHeader>
    {tiles && <KpiTiles tiles={tiles} count={4} label="Businesses at a glance" />}
    <div className="pl-toolbar">
      <div className="o-search pl-search">
        <OIcon name="search" size={16} />
        <input type="search" value={q} onChange={(event) => set({ q: event.target.value })} placeholder="Search business, branch, owner or area" aria-label="Search businesses" autoComplete="off" />
      </div>
      <div className="o-chips" role="radiogroup" aria-label="Filter businesses">
        {chips.map((chip) => <button key={chip.value} type="button" role="radio" aria-checked={status === chip.value} className="o-chip"
          onClick={() => set({ status: chip.value })}>{chip.label}<span className="o-chip-count">{data ? chip.count : '·'}</span></button>)}
      </div>
    </div>

    <section className="o-panel pl-table-panel" aria-label="Businesses">
      {error && !data ? <ErrorState error={error} onRetry={refresh} what="businesses" />
        : loading && !data ? <SkeletonRows rows={5} label="Loading businesses" />
          : !visible.length ? <EmptyState icon={q ? 'search' : 'store'} title={q ? `No businesses match “${q}”` : rows.length ? 'Nothing with this filter' : 'No businesses yet'}
            action={(q || status !== 'all') && <button type="button" className="o-btn is-secondary" onClick={() => set({ q: '', status: '' })}>Clear filters</button>}>
            {rows.length ? 'Try another search or filter.' : 'A business appears when you invite its owner.'}
          </EmptyState>
            : <>
              <div className="pl-table-scroll">
                <table className="pl-table ab-table">
                  <caption className="visually-hidden">Businesses, sorted by {sort.key}</caption>
                  <thead><tr>
                    <SortHeader label="Business" column="name" sort={sort} onSort={setSort} />
                    <SortHeader label="Owner" column="owner" sort={sort} onSort={setSort} />
                    <SortHeader label="Status" column="status" sort={sort} onSort={setSort} />
                    <SortHeader label="Branches" column="branchCount" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Staff" column="staff" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Orders 30d" column="orders30d" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Paid 30d" column="paid30d" sort={sort} onSort={setSort} numeric />
                    <th scope="col">Inventory</th>
                    <SortHeader label="Last order" column="lastOrderAt" sort={sort} onSort={setSort} numeric />
                  </tr></thead>
                  <tbody>{visible.map((row) => {
                    const stock = stockSummary(row.stock);
                    return <tr key={row.id} className="ab-row" onClick={(event) => { if (!event.target.closest('a, button')) navigate(`/admin/businesses/${row.id}`); }}>
                      <th scope="row"><Link className="pl-cell-link" to={`/admin/businesses/${row.id}`}>
                        <strong>{row.name}</strong><small>{row.branches.map((b) => b.name).join(', ') || 'No branches yet'}</small></Link></th>
                      <td className="pl-owner">{row.owners.length ? <><span>{row.owners[0].name}{row.owners.length > 1 ? ` +${row.owners.length - 1}` : ''}</span><small>{row.owners[0].email}</small></>
                        : <span className="ab-warn">No owner</span>}</td>
                      <td><BusinessStatus status={row.status} /></td>
                      <td className="is-num">{formatWhole(row.branches.length)}</td>
                      <td className="is-num">{formatWhole(row.staff)}</td>
                      <td className="is-num">{formatWhole(row.orders30d)}</td>
                      <td className="is-num">{formatKsh(row.paid30d)}</td>
                      <td><span className={`ab-stock is-${stock.tone}`}>{stock.text}</span></td>
                      <td className="is-num">{row.lastOrderAt ? timeAgo(row.lastOrderAt) : 'Never'}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <ul className="pl-cards">
                {visible.map((row) => <li key={row.id}>
                  <Link className="pl-card" to={`/admin/businesses/${row.id}`}>
                    <span className="pl-card-head"><strong>{row.name}</strong><BusinessStatus status={row.status} /></span>
                    <small>{row.owners[0]?.name || 'No owner'} · {row.branches.length} branch{row.branches.length === 1 ? '' : 'es'}</small>
                    <dl>
                      <div><dt>Orders 30d</dt><dd>{formatWhole(row.orders30d)}</dd></div>
                      <div><dt>Paid 30d</dt><dd>{formatKsh(row.paid30d)}</dd></div>
                      <div><dt>Inventory</dt><dd>{stockSummary(row.stock).text}</dd></div>
                    </dl>
                  </Link>
                </li>)}
              </ul>
              <p className="pl-foot">{visible.length === rows.length ? `${formatWhole(rows.length)} businesses` : `Showing ${formatWhole(visible.length)} of ${formatWhole(rows.length)} businesses`}</p>
            </>}
    </section>
  </div>;
}
