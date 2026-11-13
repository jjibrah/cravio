// One table: state, its QR (print, download, test), scans over 14 days, its orders, and removal.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import TableTile from '../../components/tables/TableTile';
import OrderDrawer from '../../components/owner/OrderDrawer';
import OrderRow from '../../components/owner/OrderRow';
import useOrderParam from '../../components/owner/useOrderParam';
import { QrSvg, downloadQrPng, printQr } from '../../components/owner/TableBits';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/tables.css';
import {
  REQUEST_TYPES, formatAge, formatDayLabel, formatKes, formatNumber, formatRelative, menuApi, opsApi, plural, tableStateLabel,
  useLive, useNow, useResource,
} from '../../lib/ops';

export default function TableDetailPage() {
  const { number } = useParams();
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const now = useNow(30000);
  const detail = useResource((signal) => opsApi.table(number, signal), [number]);
  const restaurant = useResource(async (signal) => (await menuApi.load(signal)).restaurant, []);
  const live = useLive();
  const [orderId, openOrder, closeOrder, preview] = useOrderParam();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const cursor = live.cursor;
  const first = useRef(true);
  useEffect(() => {
    if (!cursor) return;
    if (first.current) { first.current = false; return; }
    detail.reload({ quiet: true });
  }, [cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const title = document.title;
    document.title = `Table ${number} · Cravio`;
    return () => { document.title = title; };
  }, [number]);

  const data = detail.data;
  const table = data?.table;
  const url = table ? `${window.location.origin}${table.guestMenuPath}` : '';
  const restaurantName = restaurant.data?.name || '';

  async function remove() {
    setRemoving(true);
    setRemoveError('');
    try {
      await opsApi.removeTable(number);
      notify(`Table ${number} removed.`);
      navigate('/owner/tables', { replace: true });
    } catch (problem) {
      setRemoveError(problem.status === 409 ? `Table ${number} has unpaid orders. Settle them first.` : problem.message);
      setRemoving(false);
    }
  }

  const back = <Link className="o-back" to="/owner/tables"><OIcon name="arrowLeft" size={16} />Tables</Link>;

  if (detail.error && !data) {
    return <>{back}<header className="page-header"><div className="page-heading"><h1>Table {number}</h1></div></header>
      <div className="o-panel">{detail.error.status === 404
        ? <EmptyState icon="table" tone="neutral" title={`There’s no table ${number}`} action={<Link className="o-btn" to="/owner/tables">See all tables</Link>}>It may have been removed.</EmptyState>
        : <ErrorState error={detail.error} onRetry={detail.reload} what="this table" />}</div></>;
  }

  const scansByDay = data?.scansByDay || [];
  const maxScans = Math.max(1, ...scansByDay.map((day) => day.scans));
  const scans14 = scansByDay.reduce((sum, day) => sum + day.scans, 0);

  return <>
    {back}
    <header className="o-table-hero">
      {table ? <TableTile number={table.number} state={table.state} label={tableStateLabel({ ...table, requestTypes: data.requests?.map((r) => r.type) })} size="lg"
        meta={data.totals.openOrders ? plural(data.totals.openOrders, 'open order') : undefined} />
        : <span className="o-table-hero-skeleton sk" aria-hidden="true" />}
      <div className="o-table-hero-text">
        <h1>Table {number}</h1>
        <p>{table?.section?.name ? `${table.section.name} · ` : ''}{data ? `Last scan ${data.totals.lastScanAt ? formatRelative(data.totals.lastScanAt, now).toLowerCase() : 'never'}` : ' '}</p>
        {data?.requests?.length > 0 && <ul className="o-table-requests">
          {data.requests.map((request) => <li key={request.id} className={`is-${REQUEST_TYPES[request.type]?.state}`}>
            {REQUEST_TYPES[request.type]?.label} · waiting {formatAge(request.createdAt, now)}{request.status === 'acknowledged' ? ' · someone is on the way' : ''}
          </li>)}
        </ul>}
      </div>
      {table && <a className="o-btn is-primary o-table-hero-cta" href={url} target="_blank" rel="noopener noreferrer"><OIcon name="external" size={16} />Open this table’s menu</a>}
    </header>

    <div className="o-table-layout">
      <div className="o-table-col">
        <Panel title="QR code" sub="Guests scan this to open your menu at this table">
          <div className="o-panel-body o-qr-card-body">
            <div className="o-qr-card">
              {table ? <QrSvg url={url} label={`QR code for table ${number}`} /> : <span className="sk o-qr" aria-hidden="true" />}
              <span className="o-qr-caption">Table {number}</span>
            </div>
            <div className="o-qr-actions">
              <button type="button" className="o-btn" onClick={printQr} disabled={!table}><OIcon name="printer" size={16} />Print this QR</button>
              <button type="button" className="o-btn" disabled={!table} onClick={() => downloadQrPng({ url, number, restaurantName })
                .catch(() => notify('Couldn’t make the image. Try again.', { type: 'error' }))}><OIcon name="download" size={16} />Download PNG</button>
            </div>
            {table && <p className="o-qr-url" title={url}>{url.replace(/^https?:\/\//, '')}</p>}
          </div>
        </Panel>

        <Panel title="Remove table" sub="Its past orders stay in your records">
          <div className="o-panel-body">
            {!confirming && <button type="button" className="o-btn is-danger" onClick={() => { setConfirming(true); setRemoveError(''); }} disabled={!table}>
              <OIcon name="trash" size={16} />Remove table {number}</button>}
            {confirming && <div className="o-inline-form is-danger" role="group" aria-labelledby="remove-title">
              <p className="o-inline-title" id="remove-title">Remove table {number}?</p>
              <p className="o-inline-help">Its QR code will stop opening the menu at this table. You can add it again later.</p>
              {removeError && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{removeError}</span></p>}
              <div className="o-order-actions">
                <button type="button" className="o-btn is-danger-solid" onClick={remove} disabled={removing} autoFocus>{removing ? 'Removing…' : `Yes, remove table ${number}`}</button>
                <button type="button" className="o-btn is-quiet" onClick={() => setConfirming(false)} disabled={removing}>Keep it</button>
              </div>
            </div>}
          </div>
        </Panel>
      </div>

      <div className="o-table-col is-wide">
        <Panel title="Menu scans" sub="How often guests opened the menu here, last 14 days">
          <div className="o-panel-body">
            <dl className="o-table-figures">
              <div><dt>Last 14 days</dt><dd>{data ? formatNumber(scans14) : '–'}</dd></div>
              <div><dt>Last 7 days</dt><dd>{data ? formatNumber(data.totals.scans.last7Days) : '–'}</dd></div>
              <div><dt>All time</dt><dd>{data ? formatNumber(data.totals.scans.allTime) : '–'}</dd></div>
              <div><dt>Sales, 30 days</dt><dd>{data ? formatKes(data.totals.revenue.last30Days) : '–'}</dd></div>
            </dl>
            {data ? <figure className="o-spark">
              <div className="o-spark-bars" role="img" aria-label={`Scans per day: ${scansByDay.map((day) => `${formatDayLabel(day.date)} ${day.scans}`).join(', ')}`}>
                {scansByDay.map((day) => <span key={day.date} className="o-spark-bar" title={`${formatDayLabel(day.date)}: ${plural(day.scans, 'scan')}`}>
                  <span style={{ height: `${day.scans ? Math.max(6, (day.scans / maxScans) * 100) : 0}%` }} />
                </span>)}
              </div>
              <figcaption className="o-spark-axis" aria-hidden="true"><span>{formatDayLabel(scansByDay[0]?.date)}</span><span>Today</span></figcaption>
            </figure> : <div className="o-spark sk" style={{ height: 96 }} aria-hidden="true" />}
          </div>
        </Panel>

        <Panel title="Orders at this table" sub="The 10 most recent" actions={<Link className="o-btn is-quiet is-small" to={`/owner/orders?view=all&range=30d&table=${number}`}>All orders<OIcon name="arrowRight" size={14} /></Link>}>
          {!data && <SkeletonRows rows={3} thumb={false} label="Loading orders" />}
          {data && !data.recentOrders.length && <EmptyState icon="bill" tone="neutral" title="No orders here yet">Orders taken at table {number} appear here.</EmptyState>}
          {data && data.recentOrders.length > 0 && <ul className="o-order-list o-table-orders">
            {data.recentOrders.map((order) => <OrderRow key={order.id} order={order} now={now} onOpen={openOrder} showTable={false} />)}
          </ul>}
        </Panel>
      </div>
    </div>

    {table && <div className="o-print-qr" aria-hidden="true">
      {restaurantName && <p className="o-print-name">{restaurantName}</p>}
      <QrSvg url={url} label="" className="o-print-code" />
      <p className="o-print-table">Table {number}</p>
      <p className="o-print-hint">Scan to see the menu</p>
    </div>}

    <OrderDrawer orderId={orderId} preview={preview} onClose={closeOrder} onChanged={() => { detail.reload({ quiet: true }); live.reload(); }} />
  </>;
}
