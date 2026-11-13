// Admin Money (/admin/money): paid revenue across restaurants for this month, 30 or 90 days (?range=),
// with the previous period for comparison, payment methods and a per-restaurant table. Reads GET /api/admin/money.
// Revenue is what restaurants took from guests through Cravio (paid orders), not Cravio's own billing.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { Bar, EmptyState, ErrorState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import {
  ChartSkeleton, Delta, KpiTiles, NotInstalled, RestaurantStatus, SeriesBars, SortHeader, formatKsh, formatWhole, sortRows, useLast,
} from './platform-ui';

const RANGES = [
  { value: 'month', label: 'This month', caption: 'this month', previous: 'the same days before' },
  { value: '30d', label: '30 days', caption: 'the last 30 days', previous: 'the 30 days before' },
  { value: '90d', label: '90 days', caption: 'the last 90 days', previous: 'the 90 days before' },
];
const METRICS = [
  { value: 'revenue', label: 'Revenue', name: 'Paid revenue', money: true, unit: 'paid' },
  { value: 'paidOrders', label: 'Paid orders', name: 'Paid orders', unit: 'paid orders' },
];
const METHOD_LABELS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', other: 'Other' };

export default function MoneyPage({ section }) {
  const [params, setParams] = useSearchParams();
  const range = RANGES.some((r) => r.value === params.get('range')) ? params.get('range') : 'month';
  const meta = RANGES.find((r) => r.value === range);
  const { data: fresh, error, refresh } = useApi(`/api/admin/money?range=${range}`, { ttl: 60000 });
  const { data, stale } = useLast(fresh);
  const [sort, setSort] = useState({ key: 'revenue', dir: 'desc' });
  const ready = data && data.range === range;
  const rows = useMemo(() => sortRows(data?.restaurants || [], sort), [data, sort]);

  const t = ready ? data.totals : null;
  const tiles = t && [
    { key: 'revenue', label: 'Paid revenue', value: formatKsh(t.revenue), delta: <Delta value={t.revenue} previous={t.previousRevenue} label={meta.previous} />, sub: 'Paid orders, all restaurants' },
    { key: 'orders', label: 'Paid orders', value: formatWhole(t.paidOrders), sub: `${formatWhole(t.payingRestaurants)} restaurants took payments` },
    { key: 'ticket', label: 'Average bill', value: t.avgTicket === null ? '—' : formatKsh(t.avgTicket), sub: 'Per paid order' },
    { key: 'open', label: 'Unpaid right now', value: formatKsh(t.openValue), sub: 'Open orders started in this period' },
  ];
  const methodTotal = ready ? data.methods.reduce((sum, m) => sum + m.amount, 0) : 0;
  const maxRevenue = Math.max(0, ...rows.map((r) => r.revenue));

  return <div className="in-page pl-page">
    <PageHeader title={section?.label || 'Money'} description={section?.description}>
      <Segmented label="Time range" options={RANGES} value={range}
        onChange={(value) => setParams((current) => { const next = new URLSearchParams(current); if (value === 'month') next.delete('range'); else next.set('range', value); return next; }, { replace: true })} />
    </PageHeader>

    {error && !data ? <div className="o-panel"><ErrorState error={error} onRetry={refresh} what="money" /></div>
      : <div className={`pl-stack in-body${stale ? ' is-stale' : ''}`} aria-busy={stale ? 'true' : 'false'}>
        {ready && !data.available.operations && <NotInstalled what="Orders and payments" migration="003" />}
        <KpiTiles tiles={tiles} count={4} />
        {error && data && <p className="o-note is-error"><OIcon name="alert" size={16} /><span>{error.message}</span></p>}

        <div className="pl-grid-money">
          {ready ? <SeriesBars title="Revenue by day" series={data.series} metrics={METRICS} rangeLabel={meta.caption} />
            : <ChartSkeleton title="Revenue by day" bars={30} />}
          <Panel title="Payment methods" sub={`Confirmed payments, ${meta.caption}`}>
            {!ready ? <SkeletonRows rows={3} thumb={false} label="Loading payment methods" />
              : !data.methods.length ? <EmptyState icon="cash" title="No payments yet">Payments show here once staff mark orders paid.</EmptyState>
                : <ul className="pl-methods">
                  {data.methods.map((m) => <li key={m.method}>
                    <span className="pl-method-head"><strong>{METHOD_LABELS[m.method] || m.method}</strong>
                      <span>{formatKsh(m.amount)} <small>{methodTotal ? Math.round((m.amount / methodTotal) * 100) : 0}%</small></span></span>
                    <Bar value={m.amount} max={methodTotal} />
                    <small>{formatWhole(m.count)} payment{m.count === 1 ? '' : 's'}</small>
                  </li>)}
                </ul>}
          </Panel>
        </div>

        <section className="in-panel pl-table-panel" aria-labelledby="pl-money-title">
          <header className="in-panel-head"><div><h2 id="pl-money-title">By restaurant</h2><p>Paid revenue and open bills for each restaurant, {meta.caption}.</p></div></header>
          {!ready ? <SkeletonRows rows={5} thumb={false} label="Loading restaurants" />
            : !rows.length ? <EmptyState icon="utensils" title="No restaurants yet" action={<Link className="o-btn is-secondary" to="/admin/users">Invite an owner</Link>}>Revenue appears once restaurants mark orders paid.</EmptyState>
              : <>
                <div className="pl-table-scroll is-flush">
                  <table className="pl-table">
                    <caption className="visually-hidden">Revenue by restaurant</caption>
                    <thead><tr>
                      <SortHeader label="Restaurant" column="name" sort={sort} onSort={setSort} />
                      <SortHeader label="Paid revenue" column="revenue" sort={sort} onSort={setSort} numeric />
                      <th scope="col" className="pl-share-col"><span className="visually-hidden">Share</span></th>
                      <SortHeader label="Paid orders" column="paidOrders" sort={sort} onSort={setSort} numeric />
                      <SortHeader label="Average bill" column="avgTicket" sort={sort} onSort={setSort} numeric />
                      <SortHeader label="Unpaid now" column="openValue" sort={sort} onSort={setSort} numeric />
                      <SortHeader label="Cancelled" column="cancelledValue" sort={sort} onSort={setSort} numeric />
                    </tr></thead>
                    <tbody>{rows.map((row) => <tr key={row.id}>
                      <th scope="row"><Link className="pl-cell-link" to={`/admin/restaurants?open=${row.id}`}><strong>{row.name}</strong>
                        <small><RestaurantStatus status={row.status} />{row.area ? ` ${row.area}` : ''}</small></Link></th>
                      <td className="is-num"><strong>{formatKsh(row.revenue)}</strong></td>
                      <td className="pl-share-col"><Bar value={row.revenue} max={maxRevenue} /></td>
                      <td className="is-num">{formatWhole(row.paidOrders)}</td>
                      <td className="is-num">{row.avgTicket === null ? '—' : formatKsh(row.avgTicket)}</td>
                      <td className="is-num">{row.openOrders ? <>{formatKsh(row.openValue)}<small>{formatWhole(row.openOrders)} open</small></> : '—'}</td>
                      <td className="is-num">{row.cancelledValue ? formatKsh(row.cancelledValue) : '—'}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
                <ul className="pl-cards">
                  {rows.map((row) => <li key={row.id}>
                    <Link className="pl-card" to={`/admin/restaurants?open=${row.id}`}>
                      <span className="pl-card-head"><strong>{row.name}</strong><span className="pl-card-amount">{formatKsh(row.revenue)}</span></span>
                      <Bar value={row.revenue} max={maxRevenue} />
                      <dl>
                        <div><dt>Paid orders</dt><dd>{formatWhole(row.paidOrders)}</dd></div>
                        <div><dt>Average</dt><dd>{row.avgTicket === null ? '—' : formatKsh(row.avgTicket)}</dd></div>
                        <div><dt>Unpaid</dt><dd>{row.openValue ? formatKsh(row.openValue) : '—'}</dd></div>
                      </dl>
                    </Link>
                  </li>)}
                </ul>
              </>}
        </section>
      </div>}
  </div>;
}
