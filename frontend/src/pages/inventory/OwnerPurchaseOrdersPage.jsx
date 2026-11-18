// Owner Purchase orders (/owner/inventory/purchase-orders): "Suggested orders" for what is running low, and every order by status.
// One main action: New purchase order. An order opens in the side sheet (PoSheet): edit a draft, submit, approve, send, cancel, close.
// /owner/inventory/purchase-orders?po=<id> opens that order (notification links land here).
import { useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { api, useApi } from '../../lib/api';
import { PO_STATUS, PO_STATUS_ORDER, formatDay, formatNumber, formatStockMoney, useInventoryWrite } from '../../lib/inventory';
import PoDetail, { SendView, useOrder } from './PoDetail';
import PoEditor from './PoEditor';
import { EmptyState, ErrorState, FormError, OIcon, OwnerFrame, Panel, SkeletonRows, TaskDrawer } from './parts';
import { Note, StatusBadge } from './PurchasingParts';
import './purchasing.css';

/* ---------- suggested orders ---------- */

function Suggested({ ctx, onCreated }) {
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const places = ctx.data.locations.filter((l) => l.capabilities?.includes('inv.purchase.create'));
  const [place, setPlace] = useState(ctx.data.warehouse?.id || '');
  const id = useId();
  const result = useApi(place ? ctx.paths.reorderSuggestions(place) : null, { ttl: 15000 });
  const data = result.data;
  if (!data || result.error) return null; // nothing to suggest, or not allowed to see suggestions: the panel simply isn't there
  const { suggestions = [], bySupplier = [], withoutSupplier = [] } = data;
  if (!suggestions.length) return null;
  const names = (ids) => ids.map((itemId) => suggestions.find((s) => s.itemId === itemId)?.name).filter(Boolean);
  const canCreate = ctx.can.purchaseCreate && bySupplier.length > 0;

  async function create(body, step) {
    const made = await run('POST', ctx.paths.createFromSuggestions, { locationId: place, ...body }, { step });
    if (!made) return;
    const orders = made.orders || [];
    notify(`${orders.length} draft ${orders.length === 1 ? 'order' : 'orders'} created. Check each one, then submit it.`);
    (made.skipped || []).forEach((s) => notify(s.message));
    result.refresh();
    onCreated(orders);
  }

  return <Panel title="Suggested orders" count={bySupplier.length || undefined} sub="Items running low, grouped by the supplier we would order from."
    actions={places.length > 1 ? <><label className="visually-hidden" htmlFor={id}>Order for</label>
      <select id={id} className="o-select" value={place} onChange={(event) => setPlace(event.target.value)}>
        {places.map((l) => <option key={l.id} value={l.id}>{l.kind === 'branch' ? l.name : 'Warehouse'}</option>)}
      </select></> : null}>
    <ul className="po-suggest">{bySupplier.map((group) => <li key={group.supplierId}>
      <span><strong>Order from {group.supplierName}</strong>
        <small>{group.itemIds.length} {group.itemIds.length === 1 ? 'item' : 'items'}: {names(group.itemIds).join(', ')}{group.estimatedTotal ? ` · about ${formatStockMoney(group.estimatedTotal)}` : ''}</small></span>
      {canCreate && bySupplier.length > 1 && <button type="button" className="o-btn is-small" disabled={busy} aria-label={`Create order from ${group.supplierName}`}
        onClick={() => create({ supplierId: group.supplierId }, `create-${group.supplierId}`)}>Create order</button>}
    </li>)}</ul>
    {withoutSupplier.length > 0 && <div style={{ padding: '0 16px' }}><Note tone="warn">{names(withoutSupplier.map((w) => w.itemId)).join(', ') || withoutSupplier.map((w) => w.name).join(', ')} {withoutSupplier.length === 1 ? 'has' : 'have'} no supplier or price yet, so {withoutSupplier.length === 1 ? 'it isn’t' : 'they aren’t'} included. Add a price on the Suppliers page.</Note></div>}
    <details className="po-why"><summary>Why these items?</summary>
      <ul>{suggestions.map((s) => <li key={s.itemId}>{s.explain}</li>)}</ul></details>
    {error && <div style={{ padding: '0 16px' }}><FormError error={error} /></div>}
    {canCreate && <div className="po-foot">
      <span className="inv-unit-text">One draft order is made for each supplier. Nothing is sent until you submit it.</span>
      <button type="button" className="o-btn" disabled={busy} onClick={() => create({}, 'create-all')}>{busy ? 'Creating…' : 'Create orders'}</button>
    </div>}
  </Panel>;
}

/* ---------- the side sheet ---------- */

function PoSheet({ ctx, orderId, onClose, onChanged, onOpen }) {
  const detail = useOrder(ctx, orderId);
  const [view, setView] = useState(orderId ? 'detail' : 'edit'); // detail | edit | send
  const order = detail.data?.order;
  const setOrder = (next) => detail.setData?.({ order: next });
  const title = view === 'send' ? `Send ${order?.number || 'order'}` : !orderId ? 'New purchase order' : view === 'edit' ? `Edit ${order?.number || 'order'}` : order ? `${order.number}` : 'Purchase order';
  const back = () => setView('detail');

  return <TaskDrawer open title={title} onClose={onClose} wide>
    {view === 'edit' && (!orderId || order) && <PoEditor ctx={ctx} order={orderId ? order : null}
      onSaved={(saved) => { onChanged(); if (!orderId) onOpen(saved.id); else { setOrder(saved); detail.refresh(); back(); } }} onCancel={orderId ? back : onClose} />}
    {view === 'send' && order && <SendView ctx={ctx} order={order} onSent={(next) => { setOrder(next); onChanged(); }} onBack={back} />}
    {view === 'detail' && (detail.error && !order ? <p className="o-field-error" role="alert">{detail.error.message || 'This order could not be loaded.'}</p>
      : !order ? <SkeletonRows rows={5} thumb={false} label="Loading order" />
        : <PoDetail ctx={ctx} order={order} onOrder={setOrder} onChanged={onChanged} onEdit={() => setView('edit')} onSend={() => setView('send')} />)}
  </TaskDrawer>;
}

/* ---------- the list ---------- */

const chipLabel = { all: 'All' };

function OrdersBody({ ctx, task, setTask }) {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [older, setOlder] = useState([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const list = useApi(ctx.paths.purchaseOrders({ limit: 200 }), { ttl: 10000 });
  const places = useMemo(() => new Map(ctx.data.locations.map((l) => [l.id, l.kind === 'branch' ? l.name : 'Warehouse'])), [ctx.data.locations]);
  const loaded = list.data?.orders;
  const all = useMemo(() => [...(loaded || []), ...older], [loaded, older]);
  const [cursor, setCursor] = useState(null);
  useEffect(() => { setCursor(list.data?.nextBefore || null); setOlder([]); }, [list.data]);

  const counts = useMemo(() => { const c = {}; for (const o of all) c[o.status] = (c[o.status] || 0) + 1; return c; }, [all]);
  const term = search.trim().toLowerCase();
  const rows = all.filter((o) => (status === 'all' || o.status === status) && (!term || `${o.number} ${o.supplierName}`.toLowerCase().includes(term)));
  const wanted = params.get('po');
  const open = task || (wanted ? { id: wanted } : null);
  const close = () => { setTask(null); if (params.get('po')) setParams({}, { replace: true }); };
  const hasMore = Boolean(cursor);

  async function showOlder() {
    setLoadingOlder(true);
    try {
      const more = await api(ctx.paths.purchaseOrders({ limit: 200, before: cursor }));
      setOlder((current) => [...current, ...(more.orders || [])]);
      setCursor(more.nextBefore || null);
    } finally { setLoadingOlder(false); }
  }

  const showCost = all.some((o) => o.total !== undefined);
  const chips = ['all', ...PO_STATUS_ORDER.filter((s) => counts[s] || s === status)];
  const afterCreate = (orders) => { list.refresh(); if (orders.length === 1) setTask({ id: orders[0].id }); else setStatus('draft'); };

  return <>
    <Suggested ctx={ctx} onCreated={afterCreate} />
    <Panel title="Purchase orders" count={loaded ? all.length : undefined} sub="Select an order to see where it stands and what to do next.">
      {list.error && !loaded ? <ErrorState error={list.error} onRetry={list.refresh} what="purchase orders" />
        : !loaded ? <SkeletonRows rows={5} thumb={false} label="Loading purchase orders" />
          : !all.length ? <EmptyState icon="order" tone="neutral" title="No purchase orders yet">
            {ctx.can.purchaseCreate ? 'Press New purchase order to order from a supplier. Items running low appear under Suggested orders.' : 'Orders are made by the business owner.'}</EmptyState>
            : <>
              <div className="pur-chips" role="group" aria-label="Filter by status">
                {chips.map((s) => <button key={s} type="button" className="pur-chip" aria-pressed={status === s} onClick={() => setStatus(s)}>
                  {chipLabel[s] || PO_STATUS[s].label}<small>{s === 'all' ? all.length : counts[s] || 0}</small></button>)}
              </div>
              <div className="inv-toolbar">
                <label className="visually-hidden" htmlFor="po-search">Search orders</label>
                <input id="po-search" className="o-input inv-search" type="search" placeholder="Search by order number or supplier" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              {!rows.length ? <EmptyState icon="search" tone="neutral" title="No orders match" action={<button type="button" className="o-btn is-secondary" onClick={() => { setStatus('all'); setSearch(''); }}>Show all orders</button>}>
                Try another status or search.</EmptyState>
                : <div className="inv-table-wrap"><table className="inv-table inv-cards">
                  <thead><tr><th scope="col">Order</th><th scope="col">Deliver to</th><th scope="col">Needed by</th><th scope="col" className="is-num">Lines</th>{showCost && <th scope="col" className="is-num">Total</th>}<th scope="col">Status</th></tr></thead>
                  <tbody>{rows.map((o) => <tr key={o.id}>
                    <th scope="row"><button type="button" className="inv-link" onClick={() => setTask({ id: o.id })}>{o.number}</button><small>{o.supplierName}</small></th>
                    <td data-label="Deliver to">{places.get(o.deliverToLocationId) || '–'}</td>
                    <td data-label="Needed by">{o.expectedDate ? formatDay(o.expectedDate) : <span className="is-muted">–</span>}</td>
                    <td className="is-num" data-label="Lines">{formatNumber(o.lineCount)}</td>
                    {showCost && <td className="is-num" data-label="Total">{o.total !== undefined ? formatStockMoney(o.total) : '–'}</td>}
                    <td data-label="Status"><StatusBadge status={o.status} />{o.selfApproved ? <> <span className="inv-badge is-off">Self-approved</span></> : null}</td>
                  </tr>)}</tbody>
                </table></div>}
              {hasMore && <div className="inv-more"><button type="button" className="o-btn" onClick={showOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Show older orders'}</button></div>}
            </>}
    </Panel>
    {open && <PoSheet key={open.id || 'new'} ctx={ctx} orderId={open.id} onClose={close} onChanged={list.refresh} onOpen={(id) => setTask({ id })} />}
  </>;
}

export default function OwnerPurchaseOrdersPage() {
  const [task, setTask] = useState(null);
  return <OwnerFrame title="Purchase orders" description="Order from your suppliers and follow each order until it arrives."
    actions={(ctx) => ctx.can.purchaseCreate && <button type="button" className="o-btn is-primary" onClick={() => setTask({ id: null })}><OIcon name="plus" size={15} />New purchase order</button>}>
    {(ctx) => <OrdersBody ctx={ctx} task={task} setTask={setTask} />}
  </OwnerFrame>;
}
