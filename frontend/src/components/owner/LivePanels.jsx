import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../notifications/NotificationProvider';
import TableTile from '../tables/TableTile';
import { formatKes, formatNumber, formatRelative, menuApi, plural, tableStateLabel } from '../../lib/ops';
import { Bar, EmptyState, ErrorState, OIcon, Panel, SkeletonRows, TileSkeletonGrid } from './ui';

/** All tables as tiles, with live state; each links to its detail page. */
export function TablesPlan({ live }) {
  const { data, error, loading, reload } = live;
  const tables = data?.tables;
  const summary = data?.summary?.tables;
  return <Panel title="Tables" sub={summary ? [
    summary.bill && `${summary.bill} want${summary.bill === 1 ? 's' : ''} the bill`,
    summary.attention && `${summary.attention} need${summary.attention === 1 ? 's' : ''} help`,
    summary.ordering && `${summary.ordering} ordering`,
    `${summary.free} free`,
  ].filter(Boolean).join(' · ') : undefined}
    actions={<Link className="o-btn is-quiet is-small" to="/owner/tables">All tables<OIcon name="arrowRight" size={15} /></Link>}>
    <div className="o-panel-body">
      {loading && !data && <TileSkeletonGrid count={12} />}
      {error && !data && <ErrorState error={error} onRetry={reload} what="your tables" compact />}
      {tables && !tables.length && <EmptyState icon="table" title="No tables yet" action={<Link className="o-btn" to="/owner/tables">Add tables</Link>}>Add your tables to see who needs what at a glance.</EmptyState>}
      {tables && tables.length > 0 && <ul className="o-tile-grid o-plain-list" aria-label="Tables">
        {tables.map((table) => <li key={table.id}>
          <TableTile number={table.number} state={table.state} label={tableStateLabel(table)} href={`/owner/tables/${table.number}`}
            orders={table.openOrders} request={table.requestTypes?.[0]}
            meta={table.openOrders ? `${formatKes(table.unpaidTotal)} unpaid` : undefined} />
        </li>)}
      </ul>}
    </div>
  </Panel>;
}

/** Top 5 dishes for the range, with quantity and revenue. */
export function BestSellers({ analytics, rangeLabel = 'today' }) {
  const { data, error, loading, reload } = analytics;
  const list = data?.bestSellers;
  const max = Math.max(1, ...(list || []).map((item) => item.quantity));
  return <Panel title="Best sellers" sub={`Most ordered ${rangeLabel}`}>
    {loading && !data && <SkeletonRows rows={5} thumb={false} label="Loading best sellers" />}
    {error && !data && <ErrorState error={error} onRetry={reload} what="best sellers" compact />}
    {list && !list.length && <EmptyState icon="sparkle" tone="neutral" title="No orders yet">Your top dishes appear here once orders come in.</EmptyState>}
    {list && list.length > 0 && <ol className="o-rank-list">
      {list.map((item, index) => <li key={item.itemId || item.name}>
        <span className="o-rank">{index + 1}</span>
        <span className="o-rank-main">
          <span className="o-rank-name">{item.name}</span>
          <Bar value={item.quantity} max={max} />
        </span>
        <span className="o-rank-figures"><strong>{formatNumber(item.quantity)} sold</strong><span>{formatKes(item.revenue)}</span></span>
      </li>)}
    </ol>}
  </Panel>;
}

/** Items marked sold out, each with "Back in stock". */
export function SoldOut({ analytics }) {
  const { notify } = useNotifications();
  const { data, error, loading, reload, setData } = analytics;
  const [busy, setBusy] = useState({});
  const list = data?.soldOut;

  async function restock(item) {
    setBusy((current) => ({ ...current, [item.id]: true }));
    try {
      await menuApi.updateItem(item.id, { available: true });
      setData((current) => current && { ...current, soldOut: current.soldOut.filter((entry) => entry.id !== item.id) });
      notify(`${item.name} is back on the menu.`);
    } catch (problem) {
      notify(problem.message, { type: 'error' });
    } finally {
      setBusy((current) => { const next = { ...current }; delete next[item.id]; return next; });
    }
  }

  return <Panel title="Sold out" count={list ? list.length : undefined} sub="Hidden from guests until you bring them back"
    actions={<Link className="o-btn is-quiet is-small" to="/owner/products">Products<OIcon name="arrowRight" size={15} /></Link>}>
    {loading && !data && <SkeletonRows rows={2} thumb={false} label="Loading sold-out dishes" />}
    {error && !data && <ErrorState error={error} onRetry={reload} what="sold-out dishes" compact />}
    {list && !list.length && <EmptyState title="Everything is available" icon="check">Mark a dish sold out from Products when you run out.</EmptyState>}
    {list && list.length > 0 && <ul className="o-soldout-list">
      {list.map((item) => <li key={item.id}>
        <span className="o-soldout-main"><span className="o-soldout-name">{item.name}</span><span className="o-soldout-meta">{item.categoryName} · {formatKes(item.price)}</span></span>
        <button type="button" className="o-btn is-small" onClick={() => restock(item)} disabled={busy[item.id]} aria-label={`${item.name}: back in stock`}>
          {busy[item.id] ? 'Saving…' : 'Back in stock'}
        </button>
      </li>)}
    </ul>}
  </Panel>;
}

/**
 * Best sellers and sold-out dishes in one card. Each half collapses to a single line when it has
 * nothing to show, so a quiet day doesn't leave two big empty panels.
 */
export function MenuToday({ analytics, rangeLabel = 'today' }) {
  const { notify } = useNotifications();
  const { data, error, loading, reload, setData } = analytics;
  const [busy, setBusy] = useState({});
  const best = data?.bestSellers;
  const soldOut = data?.soldOut;
  const max = Math.max(1, ...(best || []).map((item) => item.quantity));

  async function restock(item) {
    setBusy((current) => ({ ...current, [item.id]: true }));
    try {
      await menuApi.updateItem(item.id, { available: true });
      setData((current) => current && { ...current, soldOut: current.soldOut.filter((entry) => entry.id !== item.id) });
      notify(`${item.name} is back on the menu.`);
    } catch (problem) {
      notify(problem.message, { type: 'error' });
    } finally {
      setBusy((current) => { const next = { ...current }; delete next[item.id]; return next; });
    }
  }

  const both = best?.length > 0 && soldOut?.length > 0;
  return <Panel className="o-menu-today" title="Menu today" sub={`What sold best ${rangeLabel}, and what guests can’t order`}
    actions={<Link className="o-btn is-quiet is-small" to="/owner/products">Products<OIcon name="arrowRight" size={15} /></Link>}>
    {loading && !data && <SkeletonRows rows={3} thumb={false} label="Loading the menu summary" />}
    {error && !data && <ErrorState error={error} onRetry={reload} what="the menu summary" compact />}
    {data && <div className={`o-menu-today-body${both ? ' is-split' : ''}`}>
      <section className="o-menu-part" aria-labelledby="menu-best-title">
        <h3 className="o-menu-part-title" id="menu-best-title">Best sellers</h3>
        {best?.length ? <ol className="o-rank-list">
          {best.map((item, index) => <li key={item.itemId || item.name}>
            <span className="o-rank">{index + 1}</span>
            <span className="o-rank-main">
              <span className="o-rank-name">{item.name}</span>
              <Bar value={item.quantity} max={max} />
            </span>
            <span className="o-rank-figures"><strong>{formatNumber(item.quantity)} sold</strong><span>{formatKes(item.revenue)}</span></span>
          </li>)}
        </ol> : <p className="o-line-empty"><OIcon name="sparkle" size={15} />No orders yet {rangeLabel}. Top dishes show here as orders come in.</p>}
      </section>
      <section className="o-menu-part" aria-labelledby="menu-soldout-title">
        <h3 className="o-menu-part-title" id="menu-soldout-title">Sold out{soldOut?.length ? <span className="o-count">{soldOut.length}</span> : null}</h3>
        {soldOut?.length ? <ul className="o-soldout-list">
          {soldOut.map((item) => <li key={item.id}>
            <span className="o-soldout-main"><span className="o-soldout-name">{item.name}</span><span className="o-soldout-meta">{item.categoryName} · {formatKes(item.price)}</span></span>
            <button type="button" className="o-btn is-small" onClick={() => restock(item)} disabled={busy[item.id]} aria-label={`${item.name}: back in stock`}>
              {busy[item.id] ? 'Saving…' : 'Back in stock'}
            </button>
          </li>)}
        </ul> : <p className="o-line-empty is-ok"><OIcon name="check" size={15} strokeWidth={2.2} />Everything is available.</p>}
      </section>
    </div>}
  </Panel>;
}

const OK_WORD = { ok: 'Good', warning: 'Needs a look' };

/** Compact status rows from /api/ops/health. */
export function SystemHealth({ health, now }) {
  const { data, error, loading, reload } = health;
  const check = (key) => data?.checks?.find((entry) => entry.key === key);
  const rows = data ? [
    { key: 'menu', label: 'Guest menu', status: check('menu')?.status || (data.menu?.live ? 'ok' : 'warning'), detail: data.menu?.live ? `Live · ${plural(data.menu.availableItems, 'dish', 'dishes')} available` : 'Not live yet' },
    { key: 'scans', label: 'Last menu scan', status: check('scans')?.status || 'ok', detail: data.lastScanAt ? formatRelative(data.lastScanAt, now) : 'No scans yet' },
    { key: 'orders', label: 'Last order', status: check('orders')?.status || 'ok', detail: data.lastOrderAt ? formatRelative(data.lastOrderAt, now) : 'No orders yet' },
    { key: 'staff', label: 'Staff', status: check('staff')?.status || 'ok', detail: `${data.staff?.active ?? 0} active${data.staff?.invited ? `, ${data.staff.invited} invited` : ''}` },
    { key: 'invites', label: 'Pending invites', status: data.pendingInvites?.failed ? 'warning' : 'ok', detail: data.pendingInvites?.failed ? `${data.pendingInvites.failed} couldn’t be sent` : data.pendingInvites?.total ? `${data.pendingInvites.total} on the way` : 'None' },
    { key: 'database', label: 'Database', status: check('database')?.status || (data.database?.ok ? 'ok' : 'warning'), detail: data.database?.ok ? `Answering in ${data.database.latencyMs} ms` : 'Not answering' },
  ] : null;
  const warnings = rows?.filter((row) => row.status !== 'ok').length || 0;
  return <Panel title="System health" sub={rows ? (warnings ? `${warnings} thing${warnings === 1 ? '' : 's'} to look at` : 'Everything is working') : undefined}>
    {loading && !data && <SkeletonRows rows={4} thumb={false} label="Checking system health" />}
    {error && !data && <ErrorState error={error} onRetry={reload} what="system health" compact />}
    {rows && <ul className="o-health-list">
      {rows.map((row) => <li key={row.key} className={`is-${row.status}`}>
        <span className="o-health-dot" aria-hidden="true" />
        <span className="o-health-label">{row.label}</span>
        <span className="o-health-detail">{row.detail}</span>
        <span className="o-health-word">{OK_WORD[row.status] || row.status}</span>
      </li>)}
    </ul>}
  </Panel>;
}

/** Three headline numbers for today (from analytics range=today). */
export function TodayStrip({ analytics }) {
  const totals = analytics.data?.totals;
  const items = [
    ['Sales today', totals ? formatKes(totals.sales) : null],
    ['Orders today', totals ? formatNumber(totals.orders) : null],
    ['Open bills', totals ? formatKes(totals.openBills?.amount || 0) : null, totals ? plural(totals.openBills?.count || 0, 'bill') : null],
    ['Menu scans today', totals ? formatNumber(totals.menuScans) : null],
  ];
  return <dl className="o-today">
    {items.map(([label, value, sub]) => <div key={label} className="o-today-item">
      <dt>{label}</dt>
      <dd>{value ?? <span className="sk" style={{ display: 'inline-block', width: 72, height: 22 }} aria-hidden="true" />}{sub && <span className="o-today-sub">{sub}</span>}</dd>
    </div>)}
  </dl>;
}
