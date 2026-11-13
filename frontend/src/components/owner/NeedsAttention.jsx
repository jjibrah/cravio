import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../notifications/NotificationProvider';
import { REQUEST_TYPES, confirmationOf, formatAge, formatKes, formatRelative, itemsSummary, opsApi, plural, shortId, useNewArrivals } from '../../lib/ops';
import { ErrorState, LiveBadge, OIcon, Panel, SkeletonRows } from './ui';

const ICON = { call_waiter: 'bell', bill: 'bill', payment: 'cash' };
const VISIBLE = 6;

/**
 * The main feature of the Overview, newest first, as compact rows:
 * - guest requests (Acknowledge, then Done);
 * - "Table 7 is ready to order": the guest tapped Ready to order and a waiter needs to go and confirm it at the
 *   table (view only, with a link to the table: confirming needs the guest's code, on the waiter's phone);
 * - confirmed orders to serve (Mark served). There is no accept step.
 * Fed by the /api/ops/live poll; actions apply locally at once, then reload. With nothing waiting it's a
 * one-line "All caught up".
 */
export default function NeedsAttention({ live, now, onOpenOrder }) {
  const { notify } = useNotifications();
  const { data, error, loading, reload, offset } = live;
  const [overrides, setOverrides] = useState({}); // id -> 'acknowledged' | 'resolved' | 'served'
  const [busy, setBusy] = useState({});
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setOverrides({}); }, [data]);

  const entries = useMemo(() => {
    if (!data) return null;
    const requests = (data.requests || []).filter((request) => overrides[request.id] !== 'resolved')
      .map((request) => ({ kind: 'request', id: request.id, at: request.createdAt, request: overrides[request.id] === 'acknowledged' ? { ...request, status: 'acknowledged' } : request }));
    const ready = (data.readyToOrder || []).map((cart) => ({ kind: 'ready', id: `cart:${cart.id}`, at: cart.readyAt, cart }));
    const orders = (data.orders || []).filter((order) => order.nextAction === 'serve' && overrides[order.id] !== 'served')
      .map((order) => ({ kind: 'order', id: order.id, at: order.takenAt || order.createdAt, order }));
    return [...requests, ...ready, ...orders].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [data, overrides]);
  const fresh = useNewArrivals(entries);
  const clock = now - offset;

  async function act(id, state, call, success) {
    setBusy((current) => ({ ...current, [id]: true }));
    setOverrides((current) => ({ ...current, [id]: state }));
    try {
      await call();
      notify(success);
    } catch (problem) {
      setOverrides((current) => { const next = { ...current }; delete next[id]; return next; });
      notify(problem.status === 409 ? `Someone else got to this first. ${problem.message}` : problem.message, { type: problem.status === 409 ? 'info' : 'error' });
    } finally {
      setBusy((current) => { const next = { ...current }; delete next[id]; return next; });
      reload();
    }
  }

  const count = entries?.length ?? null;
  if (entries && !entries.length) {
    return <section className="o-caught-up" aria-labelledby="needs-attention-title">
      <span className="o-caught-up-icon" aria-hidden="true"><OIcon name="check" size={15} strokeWidth={2.4} /></span>
      <h2 className="o-caught-up-title" id="needs-attention-title"><span className="visually-hidden">Needs attention: </span>All caught up</h2>
      <p className="o-caught-up-text">No guests waiting and no orders to serve. They’ll appear here on their own.</p>
      <LiveBadge error={error && data} />
    </section>;
  }

  const shown = entries && !expanded ? entries.slice(0, VISIBLE) : entries;
  const hidden = entries ? entries.length - (shown?.length || 0) : 0;
  return <Panel className="o-attn" title="Needs attention" count={count ?? undefined} titleId="needs-attention-title"
    sub={count ? 'Newest first' : undefined} actions={<LiveBadge error={error && data} />}>
    {loading && !data && <SkeletonRows rows={3} label="Loading what needs attention" />}
    {error && !data && <ErrorState error={error} onRetry={reload} what="live updates" />}
    {shown && shown.length > 0 && <ul className="o-attn-list" aria-live="polite" aria-relevant="additions">
      {shown.map((entry) => entry.kind === 'request'
        ? <RequestItem key={entry.id} request={entry.request} now={clock} isNew={fresh.has(entry.id)} busy={busy[entry.id]}
          onAcknowledge={() => act(entry.id, 'acknowledged', () => opsApi.acknowledge(entry.id), `Table ${entry.request.table.number}: marked as on the way.`)}
          onDone={() => act(entry.id, 'resolved', () => opsApi.resolve(entry.id), `Table ${entry.request.table.number}: done.`)} />
        : entry.kind === 'ready'
          ? <ReadyItem key={entry.id} cart={entry.cart} now={clock} isNew={fresh.has(entry.id)} />
          : <OrderItem key={entry.id} order={entry.order} now={clock} isNew={fresh.has(entry.id)} busy={busy[entry.id]} onOpen={() => onOpenOrder(entry.order)}
            onServe={() => act(entry.id, 'served', () => opsApi.advance(entry.id, entry.order.status), `Order ${shortId(entry.order)} marked served.`)} />)}
    </ul>}
    {entries && entries.length > VISIBLE && <div className="o-attn-more">
      <button type="button" className="o-text-btn" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? 'Show fewer' : `Show all (${entries.length})`}
      </button>
      {!expanded && <span className="o-attn-more-note">{hidden} more waiting</span>}
    </div>}
  </Panel>;
}

function RequestItem({ request, now, isNew, busy, onAcknowledge, onDone }) {
  const type = REQUEST_TYPES[request.type] || REQUEST_TYPES.call_waiter;
  const acknowledged = request.status === 'acknowledged';
  const number = request.table.number;
  return <li className={`o-attn-item is-${type.state}${isNew ? ' is-new' : ''}${acknowledged ? ' is-acknowledged' : ''}`}>
    <span className="o-attn-icon" aria-hidden="true"><OIcon name={ICON[request.type]} size={17} /></span>
    <div className="o-attn-text">
      <span className="o-attn-title">Table {number} {type.title}{isNew && <span className="o-attn-new">New</span>}</span>
      <span className="o-attn-meta">
        <span>{type.detail}</span><span aria-hidden="true">·</span>
        <span>Waiting {formatAge(request.createdAt, now)}</span>
        {acknowledged && <span className="o-attn-flag"><OIcon name="walk" size={12} />{request.acknowledgedBy?.name ? `${request.acknowledgedBy.name} is on the way` : 'Someone is on the way'}</span>}
      </span>
    </div>
    <div className="o-attn-actions">
      {acknowledged
        ? <button type="button" className="o-btn is-primary" onClick={onDone} disabled={busy}
          aria-label={`Done with table ${number}`}><OIcon name="check" size={15} strokeWidth={2.2} />Done</button>
        : <>
          <button type="button" className="o-text-btn" onClick={onDone} disabled={busy} aria-label={`Done with table ${number}`}>Done</button>
          <button type="button" className="o-btn is-primary" onClick={onAcknowledge} disabled={busy}
            aria-label={`Acknowledge table ${number}`}>Acknowledge</button>
        </>}
    </div>
  </li>;
}

/** A guest tapped "Ready to order": a waiter goes to the table, scans their code and confirms it with them. */
function ReadyItem({ cart, now, isNew }) {
  const where = cart.tableNumber ? `Table ${cart.tableNumber}` : 'A guest without a table';
  return <li className={`o-attn-item is-ready${isNew ? ' is-new' : ''}`}>
    <span className="o-attn-icon" aria-hidden="true"><OIcon name="order" size={17} /></span>
    <div className="o-attn-text">
      <span className="o-attn-title">{where} is ready to order{isNew && <span className="o-attn-new">New</span>}</span>
      <span className="o-attn-meta">
        <span>{plural(cart.itemCount, 'item')}</span><span aria-hidden="true">·</span>
        <strong>{formatKes(cart.total)}</strong><span aria-hidden="true">·</span>
        <span>Waiting {formatAge(cart.readyAt, now)}</span><span aria-hidden="true">·</span>
        <span>A waiter confirms it at the table</span>
      </span>
    </div>
    {cart.tableNumber && <div className="o-attn-actions">
      <Link className="o-btn is-quiet" to={`/owner/tables/${cart.tableNumber}`} aria-label={`Open table ${cart.tableNumber}`}>Open table</Link>
    </div>}
  </li>;
}

/** A confirmed order waiting to be served. */
function OrderItem({ order, now, isNew, busy, onServe, onOpen }) {
  const how = confirmationOf(order);
  return <li className={`o-attn-item is-order${isNew ? ' is-new' : ''}`}>
    <span className="o-attn-icon" aria-hidden="true"><OIcon name="order" size={17} /></span>
    <button type="button" className="o-attn-text o-attn-open" onClick={onOpen} aria-label={`Confirmed order to serve for ${order.table ? `table ${order.table.number}` : 'takeaway'}, ${formatKes(order.total)}. Open details`}>
      <span className="o-attn-title">Confirmed · to serve · {order.table ? `Table ${order.table.number}` : 'Takeaway'} <span className="o-attn-id">{shortId(order)}</span>{isNew && <span className="o-attn-new">New</span>}</span>
      <span className="o-attn-meta">
        <strong>{formatKes(order.total)}</strong><span aria-hidden="true">·</span>
        <span className="o-attn-items">{itemsSummary(order.items, 2)}</span><span aria-hidden="true">·</span>
        <span>{formatRelative(order.takenAt || order.createdAt, now)}</span>
        {how?.warn && <span className="o-tag is-warning">Not confirmed by the guest</span>}
      </span>
    </button>
    <div className="o-attn-actions">
      <button type="button" className="o-btn is-primary" onClick={onServe} disabled={busy}
        aria-label={`Mark order ${shortId(order)} served`}><OIcon name="check" size={15} strokeWidth={2.2} />Mark served</button>
    </div>
  </li>;
}
