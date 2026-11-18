// Owner "Receive goods" (/owner/inventory/receive): the deliveries that are expected (orders sent to the supplier and not yet in), the
// receipts already made, and a way to receive something that has no order. Opening a delivery opens the receive sheet (ReceiveSheet);
// opening a receipt shows what came in and lets you reverse it or send goods back to the supplier.
import { useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { formatDay, formatNumber, formatStamp, formatStockMoney, purchasing, todayNairobi, unitName, useInventoryWrite } from '../../lib/inventory';
import { EmptyState, ErrorState, FormError, OIcon, OwnerFrame, Panel, SkeletonRows, TaskDrawer } from './parts';
import { MoneyBox, Note, StatusBadge } from './PurchasingParts';
import { Facts, PhotoField } from './ReceivingParts';
import ReceiveSheet from './ReceiveSheet';
import './receiving.css';

const RECEIPT_STATUS = { draft: { label: 'Draft', tone: 'off' }, posted: { label: 'Received', tone: 'ok' }, reversed: { label: 'Reversed', tone: 'out' } };
const placeName = (locations, id) => { const l = locations.find((x) => x.id === id); return l ? (l.kind === 'branch' ? l.name : 'Warehouse') : '–'; };

/* ---------- receive against an order ---------- */

function OrderSheet({ ctx, orderId, onClose, onDone }) {
  const detail = useApi(ctx.paths.purchaseOrder(orderId), { ttl: 2000 });
  const order = detail.data?.order;
  return <TaskDrawer open title={order ? `Receive ${order.number}` : 'Receive goods'} onClose={onClose} wide>
    {detail.error && !order ? <p className="o-field-error" role="alert">{detail.error.message || 'This order could not be loaded.'}</p>
      : !order ? <SkeletonRows rows={4} thumb={false} label="Loading the order" />
        : <ReceiveSheet key={order.id} mode="owner" ctx={ctx} order={order} onClose={onClose} onDone={onDone} />}
  </TaskDrawer>;
}

function Expected({ ctx, onReceive }) {
  const list = useApi(ctx.paths.purchaseOrders({ status: 'open', limit: 200 }), { ttl: 10000 });
  const today = todayNairobi();
  const orders = useMemo(() => [...(list.data?.orders || [])].sort((a, b) => String(a.expectedDate || '9999').localeCompare(String(b.expectedDate || '9999'))), [list.data]);
  return <Panel title="Expected deliveries" count={list.data ? orders.length : undefined} sub="Orders that are on their way, the soonest first. Press Receive when the goods arrive.">
    {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.refresh} what="expected deliveries" />
      : !list.data ? <SkeletonRows rows={3} thumb={false} label="Loading expected deliveries" />
        : !orders.length ? <EmptyState icon="services" tone="neutral" title="Nothing is on its way">
          Orders you send to a supplier show up here until they arrive. Something turned up without an order? Press “Receive without an order”.</EmptyState>
          : <ul className="rcv-cards expected-list">{orders.map((o) => {
            const late = o.expectedDate && o.expectedDate < today;
            return <li key={o.id} className="rcv-card">
              <div className="rcv-card-main"><strong>{o.number} · {o.supplierName}</strong>
                <small>To {placeName(ctx.data.locations, o.deliverToLocationId)} · {o.lineCount} {o.lineCount === 1 ? 'item' : 'items'}{o.total !== undefined ? ` · ${formatStockMoney(o.total)}` : ''}</small>
                <small>{o.expectedDate ? <>Expected <span className={late ? 'is-late' : undefined}>{formatDay(o.expectedDate)}{late ? ' (late)' : ''}</span></> : 'No date was given'}</small></div>
              <div className="rcv-card-side"><StatusBadge status={o.status} />
                <button type="button" className="o-btn is-primary" aria-label={`Receive ${o.number}`} onClick={() => onReceive(o.id)}>Receive</button></div>
            </li>;
          })}</ul>}
  </Panel>;
}

/* ---------- a receipt: look, reverse, send back ---------- */

function ReverseView({ ctx, receipt, onBack, onDone }) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  async function submit(event) {
    event.preventDefault();
    if (!reason.trim()) return setProblem('Say why you are reversing this receipt.');
    setProblem('');
    const result = await run('POST', ctx.paths.goodsReceiptAction(receipt.id, 'reverse'), { reason: reason.trim() }, { step: 'reverse' });
    if (result) onDone(result);
    return undefined;
  }
  return <form className="inv-form" onSubmit={submit} noValidate>
    <Note tone="warn">Reversing {receipt.number} takes the goods it added back out of stock and puts the amounts back on the order. It only works while the goods are still here:
      if some were already used, you will be told and nothing changes. If you only want to send goods back to the supplier, use “Return to supplier” instead.</Note>
    <div className="o-field"><label className="o-label" htmlFor="rev-why">Why are you reversing it?</label>
      <input id="rev-why" className="o-input" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="For example: entered by mistake" data-autofocus /></div>
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-danger-solid" disabled={busy}>{busy ? 'Reversing…' : 'Yes, reverse this receipt'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onBack} disabled={busy}>Keep it</button>
    </div>
  </form>;
}

/** What can still go back from one receipt line, in the unit it arrived in. */
const returnable = (l) => {
  const factor = Number(l.qty) > 0 ? Number(l.receivedBase) / Number(l.qty) : 0;
  return factor > 0 ? Math.max(0, Math.floor(((Number(l.receivedBase) - Number(l.returnedBase || 0)) / factor) * 10000) / 10000) : 0;
};

function ReturnView({ ctx, receipt, onBack, onDone, units }) {
  const lines = receipt.lines.filter((l) => Number(l.receivedBase) > 0 && returnable(l) > 0);
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState('');
  const [credit, setCredit] = useState('');
  const [photo, setPhoto] = useState(null);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState(null);
  const [run, { busy, error }] = useInventoryWrite();
  const chosen = lines.filter((l) => Number(qty[l.id]) > 0);
  const estimate = chosen.reduce((sum, l) => sum + Number(qty[l.id]) * Number(l.costPerUnit || 0), 0);
  const showCost = lines.some((l) => l.costPerUnit !== undefined);

  async function submit(event) {
    event.preventDefault();
    if (!chosen.length) return setProblem('Enter how much you are sending back.');
    const tooMuch = chosen.find((l) => Number(qty[l.id]) > returnable(l));
    if (tooMuch) return setProblem(`Only ${formatNumber(returnable(tooMuch))} ${unitName(tooMuch.unit, returnable(tooMuch), units)} of ${tooMuch.itemName} can still be sent back.`);
    if (!reason.trim()) return setProblem('Say why you are sending these goods back (for example: spoiled, wrong item).');
    setProblem('');
    const body = { grnId: receipt.id, reason: reason.trim(), lines: chosen.map((l) => ({ grnLineId: l.id, qty: String(Number(qty[l.id])), unit: l.unit })), ...(credit !== '' ? { creditAmount: String(Number(credit)) } : {}) };
    const made = await run('POST', ctx.paths.supplierReturns(), body, { step: 'return' });
    if (!made) return undefined;
    let photoProblem = '';
    if (photo) { try { await purchasing.upload(ctx.business.id, { entityType: 'return', entityId: made.return.id, file: photo }); } catch (failure) { photoProblem = failure.message; } }
    setResult({ made: made.return, photoProblem });
    onDone();
    return undefined;
  }

  if (result) return <div className="inv-form" aria-live="polite">
    <ul className="rcv-summary">{result.made.lines?.map((l) => <li key={l.id}><OIcon name="check" size={15} /><span>Sent back {l.qty ?? ''} {l.itemName}</span></li>)}
      {!result.made.lines?.length && <li><OIcon name="check" size={15} /><span>{result.made.number} was posted. The goods are out of stock.</span></li>}</ul>
    {result.made.creditTotal !== undefined && <Note tone="ok">Credit from the supplier: {formatStockMoney(result.made.creditTotal)}.</Note>}
    {result.photoProblem && <FormError error={`The return was saved, but its photo was not: ${result.photoProblem}`} />}
    <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onBack}>Done</button></div>
  </div>;

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">Choose what you are sending back to {receipt.supplier.name}. The goods come out of stock now.</p>
    {!lines.length ? <EmptyState icon="info" tone="neutral" title="Nothing left to send back">Everything from this receipt has been returned already.</EmptyState>
      : <ul className="rcv-lines">{lines.map((l) => <li key={l.id} className="rcv-line">
        <div className="rcv-line-head"><strong>{l.itemName}</strong><small>Arrived {l.received}</small></div>
        <div className="o-field"><span className="o-label">How much goes back?</span>
          <div className="inv-row"><label className="visually-hidden" htmlFor={`ret-${l.id}`}>{l.itemName} to send back</label>
            <input id={`ret-${l.id}`} className="o-input inv-qty" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={qty[l.id] ?? ''} onChange={(event) => setQty({ ...qty, [l.id]: event.target.value })} />
            <span className="inv-unit-text">{unitName(l.unit, qty[l.id], units)}</span></div>
          <p className="o-field-hint">Up to {formatNumber(returnable(l))} {unitName(l.unit, returnable(l), units)} can still be sent back.</p></div>
      </li>)}</ul>}
    {lines.length > 0 && <>
      <div className="o-field"><label className="o-label" htmlFor="ret-why">Why?</label>
        <input id="ret-why" className="o-input" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="For example: spoiled, wrong item" /></div>
      {showCost && <div className="o-field"><label className="o-label" htmlFor="ret-credit">Credit the supplier gives you <span className="o-optional">Optional</span></label>
        <MoneyBox id="ret-credit" label="Credit amount" value={credit} onChange={setCredit} placeholder={estimate ? String(Math.round(estimate * 100) / 100) : '0'} />
        <p className="o-field-hint">{estimate > 0 ? `If you leave this empty, the credit is what you paid for these goods: ${formatStockMoney(estimate)}.` : 'If you leave this empty, the credit is what you paid for these goods.'}</p></div>}
      <PhotoField id="ret-photo" label="Photo of the goods" file={photo} onChange={setPhoto} />
    </>}
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      {lines.length > 0 && <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending back…' : 'Send back to supplier'}</button>}
      <button type="button" className="o-btn is-quiet" onClick={onBack} disabled={busy}>Back</button>
    </div>
  </form>;
}

function ReceiptSheet({ ctx, receiptId, onClose, onChanged }) {
  const detail = useApi(ctx.paths.goodsReceipt(receiptId), { ttl: 2000 });
  const returns = useApi(ctx.paths.supplierReturns({ grn: receiptId }), { ttl: 2000 });
  const { notify } = useNotifications();
  const [view, setView] = useState('detail'); // detail | reverse | return
  const receipt = detail.data?.receipt;
  const units = ctx.data.units || [];
  const refresh = () => { detail.refresh(); returns.refresh(); onChanged(); };
  const title = !receipt ? 'Receipt' : view === 'reverse' ? `Reverse ${receipt.number}` : view === 'return' ? `Return goods from ${receipt.number}` : receipt.number;
  return <TaskDrawer open title={title} onClose={onClose} wide>
    {detail.error && !receipt ? <p className="o-field-error" role="alert">{detail.error.message || 'This receipt could not be loaded.'}</p>
      : !receipt ? <SkeletonRows rows={4} thumb={false} label="Loading the receipt" />
        : view === 'reverse' ? <ReverseView ctx={ctx} receipt={receipt} onBack={() => setView('detail')} onDone={() => { notify(`${receipt.number} was reversed. The stock went back.`); refresh(); setView('detail'); }} />
          : view === 'return' ? <ReturnView ctx={ctx} receipt={receipt} units={units} onBack={() => { setView('detail'); refresh(); }} onDone={refresh} />
            : <div className="inv-form">
              <p><span className={`inv-badge is-${RECEIPT_STATUS[receipt.status]?.tone}`}>{RECEIPT_STATUS[receipt.status]?.label || receipt.status}</span></p>
              <Facts items={[['From', receipt.supplier.name], ['Arrived at', receipt.location?.name], ['Order', receipt.poNumber || 'No order'], ['Why no order', receipt.unplannedReason],
                ['Delivery note', receipt.deliveryNoteNo], ['Received', formatStamp(receipt.receivedAt)], ['Value', receipt.value !== undefined ? formatStockMoney(receipt.value) : null]]} />
              <ul className="rcv-lines" aria-label="What arrived">{receipt.lines.map((l) => <li key={l.id} className="rcv-line">
                <div className="rcv-line-head"><strong>{l.itemName}</strong><small>{l.received} received</small></div>
                {Number(l.rejectedBase) > 0 && <small className="o-field-hint">Rejected {l.rejected}{l.rejectReason ? `: ${l.rejectReason}` : ''}</small>}
                {Number(l.returnedBase) > 0 && (() => { const sent = Number(l.returnedBase) / (Number(l.receivedBase) / Number(l.qty || 1)); return <small className="o-field-hint">Sent back {formatNumber(sent)} {unitName(l.unit, sent, units)}</small>; })()}
                {l.costPerUnit !== undefined && <small className="o-field-hint">Cost {formatStockMoney(l.costPerUnit)} per {unitName(l.unit, 1, units)}</small>}
                {(l.batchNo || l.expiryDate) && <small className="o-field-hint">{[l.batchNo && `Batch ${l.batchNo}`, l.expiryDate && `Use by ${formatDay(l.expiryDate)}`].filter(Boolean).join(' · ')}</small>}
              </li>)}</ul>
              {(returns.data?.returns || []).length > 0 && <>
                <h3 className="inv-section" style={{ margin: '0 0 4px' }}>Sent back to the supplier</h3>
                <ul className="pur-list">{returns.data.returns.map((r) => <li key={r.id}><span className="pur-main"><strong>{r.number}</strong><small>{r.reason}{r.postedAt ? ` · ${formatStamp(r.postedAt)}` : ''}</small></span>
                  {r.creditTotal !== undefined && <span>Credit {formatStockMoney(r.creditTotal)}</span>}</li>)}</ul></>}
              {receipt.status === 'posted' && <div className="biz-form-actions">
                <button type="button" className="o-btn is-primary" onClick={() => setView('return')}>Return to supplier</button>
                <button type="button" className="o-btn is-danger" onClick={() => setView('reverse')}>Reverse this receipt</button></div>}
              {receipt.status === 'reversed' && <Note>This receipt was reversed, so it no longer counts. Enter the delivery again if it did arrive.</Note>}
            </div>}
  </TaskDrawer>;
}

function Receipts({ ctx, onOpen }) {
  const list = useApi(ctx.paths.goodsReceipts({ limit: 50 }), { ttl: 10000 });
  const receipts = list.data?.receipts;
  return <Panel title="Receipts" count={receipts ? receipts.length : undefined} sub="Everything received. Open one to see what came in, reverse it or send goods back.">
    {list.error && !receipts ? <ErrorState error={list.error} onRetry={list.refresh} what="receipts" />
      : !receipts ? <SkeletonRows rows={3} thumb={false} label="Loading receipts" />
        : !receipts.length ? <EmptyState icon="order" tone="neutral" title="Nothing received yet">When you receive a delivery it is listed here.</EmptyState>
          : <ul className="rcv-cards">{receipts.map((r) => {
            const info = RECEIPT_STATUS[r.status] || { label: r.status, tone: 'off' };
            return <li key={r.id} className="rcv-card">
              <div className="rcv-card-main"><strong>{r.number} · {r.supplierName}</strong>
                <small>{r.poNumber ? `Against ${r.poNumber}` : 'No order'} · {r.lineCount} {r.lineCount === 1 ? 'item' : 'items'} · {placeName(ctx.data.locations, r.locationId)}</small>
                <small>{formatStamp(r.receivedAt)}</small></div>
              <div className="rcv-card-side"><span className={`inv-badge is-${info.tone}`}>{info.label}</span>
                <button type="button" className="o-btn" aria-label={`Open ${r.number}`} onClick={() => onOpen(r.id)}>Open</button></div>
            </li>;
          })}</ul>}
  </Panel>;
}

/* ---------- the page ---------- */

function ReceiveBody({ ctx, task, setTask }) {
  const suppliers = useApi(ctx.can.purchaseCreate ? ctx.paths.suppliers() : null, { ttl: 30000 });
  const [refreshKey, setRefreshKey] = useState(0);
  const withSuppliers = useMemo(() => ({ ...ctx, suppliers: (suppliers.data?.suppliers || []).filter((s) => s.status === 'active') }), [ctx, suppliers.data]);
  const changed = () => setRefreshKey((n) => n + 1);
  const close = () => { setTask(null); changed(); };
  return <>
    <Expected key={`e${refreshKey}`} ctx={ctx} onReceive={(id) => setTask({ type: 'order', id })} />
    <Receipts key={`r${refreshKey}`} ctx={ctx} onOpen={(id) => setTask({ type: 'receipt', id })} />
    {task?.type === 'order' && <OrderSheet ctx={withSuppliers} orderId={task.id} onClose={close} onDone={changed} />}
    {task?.type === 'unplanned' && <TaskDrawer open title="Receive without an order" onClose={close} wide>
      <ReceiveSheet mode="owner" ctx={withSuppliers} order={null} onClose={close} onDone={changed} /></TaskDrawer>}
    {task?.type === 'receipt' && <ReceiptSheet ctx={ctx} receiptId={task.id} onClose={close} onChanged={changed} />}
  </>;
}

export function OwnerReceivePage() {
  const [task, setTask] = useState(null);
  return <OwnerFrame title="Receive goods" description="Check in what arrives against what you ordered."
    actions={(ctx) => ctx.can.purchaseCreate && <button type="button" className="o-btn is-secondary" onClick={() => setTask({ type: 'unplanned' })}><OIcon name="plus" size={15} />Receive without an order</button>}>
    {(ctx) => <ReceiveBody ctx={ctx} task={task} setTask={setTask} />}
  </OwnerFrame>;
}

export default OwnerReceivePage;
