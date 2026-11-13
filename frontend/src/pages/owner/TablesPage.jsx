// Owner tables: every table as a tile with live state, scans and today's takings; top tables; QR tools.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import TableTile from '../../components/tables/TableTile';
import { AddTablesButton } from '../../components/owner/TableBits';
import { Bar, EmptyState, ErrorState, LiveBadge, OIcon, Panel, SkeletonRows, TileSkeletonGrid } from '../../components/owner/ui';
import '../../components/owner/tables.css';
import { formatKes, nairobiDate, opsApi, plural, tableStateLabel, useLive, useResource } from '../../lib/ops';

/** Paid orders taken today, summed per table number. */
async function todaysRevenue(signal) {
  const totals = {};
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const result = await opsApi.orders({ status: 'paid', from: nairobiDate(0), limit: 100, offset }, signal);
    for (const order of result.orders) if (order.table?.number) totals[order.table.number] = (totals[order.table.number] || 0) + order.total;
    if (!result.hasMore) break;
    offset += result.orders.length;
  }
  return totals;
}

export default function TablesPage({ section }) {
  const tables = useResource((signal) => opsApi.tables(signal), []);
  const revenue = useResource(todaysRevenue, []);
  const analytics = useResource((signal) => opsApi.analytics('7d', signal), []);
  const live = useLive();
  const [testOpen, setTestOpen] = useState(false);

  // Live state: re-read the tables whenever something changes.
  const cursor = live.cursor;
  const first = useRef(true);
  useEffect(() => {
    if (!cursor) return;
    if (first.current) { first.current = false; return; }
    tables.reload({ quiet: true });
    revenue.reload({ quiet: true });
  }, [cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = tables.data?.tables;
  const liveByNumber = useMemo(() => new Map((live.data?.tables || []).map((table) => [table.number, table])), [live.data]);
  const highest = list?.reduce((max, table) => Math.max(max, table.number), 0) || 0;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const counts = list?.reduce((acc, table) => ({ ...acc, [table.state]: (acc[table.state] || 0) + 1 }), {});

  return <>
    <PageHeader title={section.label} description={section.description}>
      <Link className="o-btn" to="/onboarding/qr"><OIcon name="printer" size={16} />Print all QR codes</Link>
      <AddTablesButton highest={highest} onAdded={() => { tables.reload({ quiet: true }); live.reload(); }} />
    </PageHeader>

    <div className="o-tables-layout">
      <Panel className="o-tables-main" title={list ? plural(list.length, 'table') : 'Your tables'}
        sub={counts ? ['bill', 'attention', 'ordering', 'free'].filter((key) => counts[key]).map((key) => `${counts[key]} ${{ bill: 'waiting to pay', attention: 'need help', ordering: 'ordering', free: 'free' }[key]}`).join(' · ') : undefined}
        actions={<LiveBadge error={live.error && live.data} />}>
        <div className="o-panel-body">
          {tables.loading && !list && <TileSkeletonGrid count={12} />}
          {tables.error && !list && <ErrorState error={tables.error} onRetry={tables.reload} what="your tables" compact />}
          {list && !list.length && <EmptyState icon="table" title="No tables yet">Add your tables to get a QR code for each one.</EmptyState>}
          {list && list.length > 0 && <ul className="o-tile-grid o-plain-list" aria-label="Tables">
            {list.map((table) => {
              const state = liveByNumber.get(table.number) || table;
              const today = revenue.data?.[table.number] || 0;
              return <li key={table.id}>
                <TableTile number={table.number} state={state.state} label={tableStateLabel(state)} href={`/owner/tables/${table.number}`}
                  meta={`${plural(table.scans?.last7Days || 0, 'scan')} · ${today ? formatKes(today) : 'Ksh 0'} today`} />
              </li>;
            })}
          </ul>}
          <p className="o-tables-legend"><span>Scans: last 7 days.</span> <span>Takings: paid orders today.</span></p>
        </div>
      </Panel>

      <div className="o-tables-side">
        <TopList title="Top 5 by scans" sub="Last 7 days" analytics={analytics} list={analytics.data?.topTablesByScans} value={(row) => row.scans} format={(row) => plural(row.scans, 'scan')} />
        <TopList title="Top 5 by revenue" sub="Last 7 days" analytics={analytics} list={analytics.data?.topTablesByRevenue} value={(row) => row.revenue} format={(row) => formatKes(row.revenue)} />
        <Panel title="Test your QR codes" sub="Open any table’s menu, as a guest would see it"
          actions={<button type="button" className="o-btn is-small" aria-expanded={testOpen} aria-controls="qr-test-list" onClick={() => setTestOpen((value) => !value)}>{testOpen ? 'Hide' : 'Show'}</button>}>
          {testOpen && <ul className="o-qr-test-list" id="qr-test-list">
            {(list || []).map((table) => <li key={table.id}>
              <a href={`${origin}${table.guestMenuPath}`} target="_blank" rel="noopener noreferrer" className="o-qr-test-link">
                <span>Table {table.number}</span><span className="o-qr-test-hint">Open menu<OIcon name="external" size={14} /></span>
              </a>
            </li>)}
          </ul>}
        </Panel>
      </div>
    </div>
  </>;
}

function TopList({ title, sub, analytics, list, value, format }) {
  const max = Math.max(1, ...(list || []).map(value));
  return <Panel title={title} sub={sub}>
    {analytics.loading && !analytics.data && <SkeletonRows rows={3} thumb={false} label={`Loading ${title.toLowerCase()}`} />}
    {analytics.error && !analytics.data && <ErrorState error={analytics.error} onRetry={analytics.reload} what="table rankings" compact />}
    {list && !list.length && <p className="o-muted-line">Nothing yet in the last 7 days.</p>}
    {list && list.length > 0 && <ol className="o-top-list">
      {list.map((row) => <li key={row.tableId || row.number}>
        <Link to={`/owner/tables/${row.number}`} className="o-top-link">
          <span className="o-top-number">{row.number}</span>
          <span className="o-top-main"><span className="o-top-name">Table {row.number}</span><Bar value={value(row)} max={max} /></span>
          <span className="o-top-value">{format(row)}</span>
        </Link>
      </li>)}
    </ol>}
  </Panel>;
}

