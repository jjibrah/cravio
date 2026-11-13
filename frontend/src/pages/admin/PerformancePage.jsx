// Admin Performance (/admin/performance): platform usage per restaurant over 7/30/90 days (?range=).
// Reads GET /api/admin/performance.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, ErrorState, OIcon, Segmented, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import {
  ChartSkeleton, KpiTiles, NotInstalled, RestaurantStatus, SeriesBars, SortHeader, formatWhole, sortRows, timeAgo, useLast,
} from './platform-ui';

const RANGES = [
  { value: '7d', label: '7 days', caption: 'the last 7 days' },
  { value: '30d', label: '30 days', caption: 'the last 30 days' },
  { value: '90d', label: '90 days', caption: 'the last 90 days' },
];
const METRICS = [
  { value: 'orders', label: 'Orders', name: 'Orders', unit: 'orders' },
  { value: 'scans', label: 'Scans', name: 'Menu scans', unit: 'scans' },
  { value: 'requests', label: 'Guest requests', name: 'Guest requests', unit: 'requests' },
];
const minutes = (value) => (value === null || value === undefined ? '—' : `${value.toLocaleString('en-KE', { maximumFractionDigits: 1 })} min`);

export default function PerformancePage({ section }) {
  const [params, setParams] = useSearchParams();
  const range = RANGES.some((r) => r.value === params.get('range')) ? params.get('range') : '30d';
  const meta = RANGES.find((r) => r.value === range);
  const { data: fresh, error, refresh } = useApi(`/api/admin/performance?range=${range}`, { ttl: 60000 });
  const { data, stale } = useLast(fresh);
  const [sort, setSort] = useState({ key: 'orders', dir: 'desc' });
  const [q, setQ] = useState('');
  const ready = data && data.range === range;

  const rows = useMemo(() => {
    const list = (data?.restaurants || []).filter((row) => !q || row.name.toLowerCase().includes(q.toLowerCase()) || (row.area || '').toLowerCase().includes(q.toLowerCase()));
    return sortRows(list, sort);
  }, [data, q, sort]);

  const t = ready ? data.totals : null;
  const tiles = t && [
    { key: 'orders', label: 'Orders', value: formatWhole(t.orders), sub: `${formatWhole(t.cancelled)} cancelled` },
    { key: 'scans', label: 'Menu scans', value: formatWhole(t.scans), sub: t.scans ? `${(t.orders / t.scans).toLocaleString('en-KE', { maximumFractionDigits: 2 })} orders per scan` : 'Guests opening a menu' },
    { key: 'active', label: 'Active restaurants', value: `${formatWhole(t.activeRestaurants)} / ${formatWhole(t.restaurants)}`, sub: 'With at least one order' },
    { key: 'serve', label: 'Time to serve', value: minutes(t.avgServeMinutes), sub: 'Average, order to served' },
    { key: 'answer', label: 'Guest request answer', value: minutes(t.avgAnswerMinutes), sub: `${formatWhole(t.guestRequests)} requests` },
  ];

  return <div className="in-page pl-page">
    <PageHeader title={section?.label || 'Performance'} description={section?.description}>
      <Segmented label="Time range" options={RANGES} value={range}
        onChange={(value) => setParams((current) => { const next = new URLSearchParams(current); if (value === '30d') next.delete('range'); else next.set('range', value); return next; }, { replace: true })} />
    </PageHeader>

    {error && !data ? <div className="o-panel"><ErrorState error={error} onRetry={refresh} what="performance" /></div>
      : <div className={`pl-stack in-body${stale ? ' is-stale' : ''}`} aria-busy={stale ? 'true' : 'false'}>
        {ready && !data.available.operations && <NotInstalled what="Orders, scans and guest requests" migration="003" />}
        <KpiTiles tiles={tiles} count={5} />
        {error && data && <p className="o-note is-error"><OIcon name="alert" size={16} /><span>{error.message}</span></p>}
        {ready ? <SeriesBars title="Day by day" series={data.series} metrics={METRICS} rangeLabel={`${meta.caption}, all restaurants`} />
          : <ChartSkeleton title="Day by day" bars={range === '7d' ? 7 : 30} />}

        <section className="in-panel pl-table-panel" aria-labelledby="pl-perf-title">
          <header className="in-panel-head">
            <div><h2 id="pl-perf-title">By restaurant</h2><p>Usage and service speed for each restaurant, {meta.caption}.</p></div>
            <div className="o-search pl-search is-compact"><OIcon name="search" size={16} />
              <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Find a restaurant" aria-label="Find a restaurant" autoComplete="off" /></div>
          </header>
          {!ready ? <SkeletonRows rows={5} thumb={false} label="Loading restaurants" />
            : !data.restaurants.length ? <EmptyState icon="utensils" title="No restaurants yet" action={<Link className="o-btn is-secondary" to="/admin/users">Invite an owner</Link>}>Numbers appear once restaurants start taking orders.</EmptyState>
              : !rows.length ? <p className="in-muted-note">Nothing matches “{q}”.</p>
                : <>
                  <div className="pl-table-scroll is-flush">
                    <table className="pl-table">
                      <caption className="visually-hidden">Performance by restaurant</caption>
                      <thead><tr>
                        <SortHeader label="Restaurant" column="name" sort={sort} onSort={setSort} />
                        <SortHeader label="Orders" column="orders" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Scans" column="scans" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Orders / scan" column="ordersPerScan" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Guest requests" column="guestRequests" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Time to serve" column="avgServeMinutes" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Active days" column="activeDays" sort={sort} onSort={setSort} numeric />
                        <SortHeader label="Last order" column="lastOrderAt" sort={sort} onSort={setSort} numeric />
                      </tr></thead>
                      <tbody>{rows.map((row) => <tr key={row.id}>
                        <th scope="row"><Link className="pl-cell-link" to={`/admin/restaurants?open=${row.id}`}><strong>{row.name}</strong>
                          <small><RestaurantStatus status={row.status} />{row.area ? ` ${row.area}` : ''}</small></Link></th>
                        <td className="is-num">{formatWhole(row.orders)}{row.cancelled > 0 && <small>{formatWhole(row.cancelled)} cancelled</small>}</td>
                        <td className="is-num">{formatWhole(row.scans)}</td>
                        <td className="is-num">{row.ordersPerScan === null ? '—' : row.ordersPerScan.toLocaleString('en-KE', { maximumFractionDigits: 2 })}</td>
                        <td className="is-num">{formatWhole(row.guestRequests)}{row.avgAnswerMinutes !== null && <small>answered in {minutes(row.avgAnswerMinutes)}</small>}</td>
                        <td className="is-num">{minutes(row.avgServeMinutes)}</td>
                        <td className="is-num">{formatWhole(row.activeDays)}</td>
                        <td className="is-num">{row.lastOrderAt ? timeAgo(row.lastOrderAt) : '—'}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                  <ul className="pl-cards">
                    {rows.map((row) => <li key={row.id}>
                      <Link className="pl-card" to={`/admin/restaurants?open=${row.id}`}>
                        <span className="pl-card-head"><strong>{row.name}</strong><RestaurantStatus status={row.status} /></span>
                        <dl>
                          <div><dt>Orders</dt><dd>{formatWhole(row.orders)}</dd></div>
                          <div><dt>Scans</dt><dd>{formatWhole(row.scans)}</dd></div>
                          <div><dt>Serve</dt><dd>{minutes(row.avgServeMinutes)}</dd></div>
                        </dl>
                      </Link>
                    </li>)}
                  </ul>
                </>}
        </section>
      </div>}
  </div>;
}
