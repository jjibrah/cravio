// One purchase order in the side sheet (P2-14): what it is, where it stands (timeline), and the next thing to do. The next thing
// depends on the status: Draft -> Submit for approval; Waiting for approval -> Approve (if you can) ; Approved -> Send to supplier;
// Sent / Part received / Received -> Close. Cancel (with a reason) is offered while nothing has been received.
// "Send to supplier" shows the order as a document with Send on WhatsApp and Print / Save as PDF.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDay, formatNumber, formatStamp, formatStockMoney, showPhone, unitWord, useInventoryWrite } from '../../lib/inventory';
import PoDocument from './PoDocument';
import { FormError, OIcon, SkeletonRows } from './parts';
import { Note, StatusBadge } from './PurchasingParts';

const VIA = { pdf: 'as a PDF or printout', whatsapp: 'on WhatsApp', email: 'by email', phone: 'by phone' };
const linesReceived = (order) => order.lines.filter((l) => Number(l.receivedBase) > 0 && Number(l.receivedBase) >= Number(l.qtyBase)).length;

/* ---------- send ---------- */

function SendView({ ctx, order, onSent, onBack }) {
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const doc = useApi(ctx.paths.purchaseOrderDocument(order.id), { ttl: 2000 });
  const data = doc.data;
  const link = data?.whatsapp?.link || null;

  async function mark(via, then) {
    const result = await run('POST', ctx.paths.purchaseOrderAction(order.id, 'send'), { via }, { step: `send-${via}` });
    if (!result) return false;
    onSent(result.order);
    notify(`Marked as sent ${VIA[via]}.`);
    then?.();
    return true;
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(data.text); notify('Message copied. Paste it into WhatsApp, SMS or email.'); } catch { notify('Could not copy. Select the order text and copy it yourself.'); }
  };

  return <div className="inv-form">
    <p className="o-field-hint">This is what your supplier gets. Choose how to send it, and the order is marked as sent.</p>
    {doc.error && !data ? <p className="o-field-error" role="alert">{doc.error.message || 'The order document could not be made.'}</p>
      : !data ? <SkeletonRows rows={4} thumb={false} label="Preparing the order" />
        : <>
          <PoDocument document={data.document} print />
          {!link && data.whatsapp?.note && <Note tone="warn">{data.whatsapp.note} <Link className="inv-link" to={`/owner/inventory/suppliers?supplier=${order.supplier.id}`}>Open supplier</Link></Note>}
          <div className="po-send-actions">
            {link ? <a className="o-btn is-primary" href={link} target="_blank" rel="noopener noreferrer" onClick={() => { void mark('whatsapp'); }}>
              <OIcon name="external" size={15} />Send on WhatsApp</a> : <button type="button" className="o-btn is-primary" disabled>Send on WhatsApp</button>}
            <button type="button" className="o-btn" disabled={busy} onClick={() => mark('pdf', () => window.print())}><OIcon name="printer" size={15} />Print or save as PDF</button>
            <button type="button" className="o-btn is-quiet" onClick={copy}><OIcon name="copy" size={15} />Copy message</button>
          </div>
          <p className="o-field-hint">Sent it another way, by phone or email? <button type="button" className="inv-link" disabled={busy} onClick={() => mark('phone')}>Mark it as sent</button>.</p>
        </>}
    <FormError error={error} />
    <div className="biz-form-actions"><button type="button" className="o-btn is-quiet" onClick={onBack}>Back to the order</button></div>
  </div>;
}

/* ---------- the order ---------- */

function Timeline({ order, you }) {
  const who = (id) => (id && you && String(id).toLowerCase() === String(you).toLowerCase() ? ' by you' : '');
  const lines = order.lines || [];
  const done = linesReceived(order);
  const pct = lines.length ? Math.round((lines.filter((l) => Number(l.qtyBase) > 0).reduce((sum, l) => sum + Math.min(1, Number(l.receivedBase) / Number(l.qtyBase)), 0) / lines.length) * 100) : 0;
  const status = order.status;
  const submitted = Boolean(order.approvedAt) || ['pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed'].includes(status);
  return <ol className="po-timeline" aria-label="What has happened">
    <li><strong>Created</strong>{who(order.createdBy)}<small>{formatStamp(order.createdAt)}</small></li>
    {status === 'draft' && <li className="is-pending"><strong>Not submitted yet</strong><small>Submit it when the lines are right.</small></li>}
    {submitted && <li><strong>Submitted for approval</strong></li>}
    {status === 'pending_approval' && <li className="is-pending"><strong>Waiting for approval</strong><small>Someone who can approve orders has been told.</small></li>}
    {order.approvedAt && <li><strong>Approved{who(order.approvedBy)}</strong>{order.selfApproved && <small>Self-approved: no one else could approve it.</small>}<small>{formatStamp(order.approvedAt)}</small></li>}
    {order.sentAt && <li><strong>Sent to supplier</strong><small>{formatStamp(order.sentAt)}{order.sentVia ? `, ${VIA[order.sentVia] || order.sentVia}` : ''}</small></li>}
    {['approved', 'sent'].includes(status) && <li className="is-pending"><strong>{status === 'approved' ? 'Ready to send' : 'Waiting for delivery'}</strong></li>}
    {(order.receiving !== 'none' || ['partially_received', 'received'].includes(status)) && <li><strong>{status === 'received' ? 'Everything received' : `Received ${done} of ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}</strong>
      <span className="po-progress" role="img" aria-label={`${pct}% received`}><span style={{ width: `${pct}%` }} /></span>
      {(order.receipts || []).map((r) => <small key={r.id}>{r.number}{r.receivedAt ? `, ${formatStamp(r.receivedAt)}` : ''}</small>)}</li>}
    {status === 'closed' && <li><strong>Closed</strong>{order.notes && <small>{order.notes.split('\n').find((l) => l.startsWith('Closed:')) || ''}</small>}</li>}
    {status === 'cancelled' && <li className="is-stop"><strong>Cancelled</strong><small>{formatStamp(order.cancelledAt)}{order.cancelReason ? `: ${order.cancelReason}` : ''}</small></li>}
  </ol>;
}

export default function PoDetail({ ctx, order, onOrder, onEdit, onSend, onChanged }) {
  const { account } = useAuth() || {};
  const { notify } = useNotifications();
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const [ask, setAsk] = useState(null); // 'cancel' | 'close' | 'reject'
  const [reason, setReason] = useState('');
  const [banner, setBanner] = useState(null);
  const create = ctx.can.purchaseCreate;
  const approve = ctx.can.purchaseApprove;
  const showMoney = ctx.can.costView && order.totals;
  const status = order.status;
  const canCancel = create && ['draft', 'pending_approval', 'approved', 'sent'].includes(status);
  const canClose = create && ['approved', 'sent', 'partially_received', 'received'].includes(status);
  const open = (kind) => { clearError(); setReason(''); setAsk(kind); };

  async function act(action, body, message, step) {
    const result = await run('POST', ctx.paths.purchaseOrderAction(order.id, action), body, { step: step || action });
    if (!result) return null;
    onOrder(result.order);
    onChanged();
    setAsk(null);
    if (message) notify(message);
    (result.warnings || []).forEach((w) => notify(w.message));
    return result.order;
  }
  async function submit() {
    const next = await act('submit', {}, null);
    if (!next) return;
    setBanner(next.status === 'approved' && next.selfApproved
      ? { tone: 'ok', text: 'Approved — you are the only approver, so it was approved straight away.' }
      : next.status === 'approved' ? { tone: 'ok', text: 'Approved.' }
        : { tone: 'info', text: 'Waiting for approval. The people who approve orders have been told.' });
  }

  const primary = !create && !approve ? null
    : status === 'draft' && create ? <button type="button" className="o-btn is-primary" onClick={submit} disabled={busy || !order.lines.length}>Submit for approval</button>
      : status === 'pending_approval' && approve ? <button type="button" className="o-btn is-primary" onClick={async () => { if (await act('approve', {}, null)) setBanner({ tone: 'ok', text: 'Approved. You can send it to the supplier now.' }); }} disabled={busy}>Approve order</button>
        : ['approved', 'sent'].includes(status) && create ? <button type="button" className="o-btn is-primary" onClick={onSend}><OIcon name="external" size={15} />{status === 'sent' ? 'Send again' : 'Send to supplier'}</button>
          : null;

  return <div className="inv-form">
    <p><StatusBadge status={status} /> {order.selfApproved && <span className="inv-badge is-off">Self-approved</span>}</p>
    {banner && <Note tone={banner.tone}>{banner.text}</Note>}
    <dl className="pur-facts">
      <div className="pur-fact"><dt>Supplier</dt><dd>{order.supplier.name}{order.supplier.phone ? <small>{showPhone(order.supplier.phone)}</small> : null}</dd></div>
      <div className="pur-fact"><dt>Deliver to</dt><dd>{order.deliverTo.name}{order.expectedDate ? <small>Needed by {formatDay(order.expectedDate)}</small> : null}</dd></div>
      {showMoney && <div className="pur-fact"><dt>Total</dt><dd>{formatStockMoney(order.totals.total)}<small>incl. VAT {formatStockMoney(order.totals.vat)}</small></dd></div>}
    </dl>

    <div className="inv-table-wrap po-lines-table"><table className="inv-table inv-cards">
      <thead><tr><th scope="col">Item</th><th scope="col" className="is-num">Ordered</th>{showMoney && <th scope="col" className="is-num">Price</th>}{showMoney && <th scope="col" className="is-num">Total</th>}<th scope="col" className="is-num">Received</th></tr></thead>
      <tbody>{order.lines.map((l) => <tr key={l.id}>
        <th scope="row">{l.itemName}</th>
        <td className="is-num" data-label="Ordered">{formatNumber(l.qty)} {unitWord(l.unit, Number(l.qty), ctx.data.units)}<small>{l.quantity}</small></td>
        {showMoney && <td className="is-num" data-label="Price">{formatStockMoney(l.unitPrice)} per {unitWord(l.unit, 1, ctx.data.units)}</td>}
        {showMoney && <td className="is-num inv-nowrap" data-label="Total">{formatStockMoney(l.lineTotal)}</td>}
        <td className="is-num" data-label="Received">{Number(l.receivedBase) > 0 ? l.received : <span className="is-muted">Nothing yet</span>}</td>
      </tr>)}</tbody>
    </table></div>
    {order.notes && <p className="o-field-hint">{order.notes}</p>}

    <section className="inv-section" aria-label="Progress"><h3>Progress</h3><Timeline order={order} you={account?.id} /></section>

    {!create && !approve && <p className="o-field-hint">You can look at this order but not change it.</p>}
    <FormError error={error} />
    {ask === 'cancel' || ask === 'close' || ask === 'reject' ? <div className="inv-confirm" role="alertdialog" aria-label={ask === 'cancel' ? 'Cancel this order?' : ask === 'close' ? 'Close this order?' : 'Send this order back?'}>
      <label className="o-label" htmlFor="po-reason">{ask === 'cancel' ? 'Why are you cancelling this order?' : ask === 'close' ? (status === 'received' ? 'Note (optional)' : 'Why are you closing it before everything arrived?') : 'Why are you sending it back?'}</label>
      <textarea id="po-reason" className="o-input" rows={2} maxLength={300} value={reason} data-autofocus onChange={(event) => setReason(event.target.value)} />
      {ask === 'cancel' && ['sent'].includes(status) && <span>This order was already sent. Let the supplier know it is cancelled.</span>}
      <span className="biz-form-actions" style={{ margin: 0 }}>
        {ask === 'cancel' && <button type="button" className="o-btn is-danger-solid is-small" disabled={busy || !reason.trim()} onClick={() => act('cancel', { reason: reason.trim() }, 'Order cancelled.')}>Yes, cancel the order</button>}
        {ask === 'close' && <button type="button" className="o-btn is-danger-solid is-small" disabled={busy || (status !== 'received' && !reason.trim())} onClick={() => act('close', { reason: reason.trim() }, 'Order closed.')}>Yes, close the order</button>}
        {ask === 'reject' && <button type="button" className="o-btn is-danger-solid is-small" disabled={busy || !reason.trim()} onClick={() => act('reject', { reason: reason.trim() }, 'Order sent back to draft.')}>Send it back</button>}
        <button type="button" className="o-btn is-quiet is-small" onClick={() => setAsk(null)} disabled={busy}>Keep the order</button>
      </span>
    </div> : <div className="biz-form-actions">
      {primary}
      {status === 'draft' && create && <button type="button" className="o-btn" onClick={onEdit}><OIcon name="edit" size={15} />Edit</button>}
      {status === 'pending_approval' && (approve || create) && <button type="button" className="o-btn" onClick={() => open('reject')}>Send back</button>}
      {canClose && <button type="button" className="o-btn" onClick={() => open('close')}>Close order</button>}
      {canCancel && <button type="button" className="o-btn is-danger" onClick={() => open('cancel')}>Cancel order</button>}
    </div>}
  </div>;
}

export { SendView };
/** Loads one order for the sheet. */
export function useOrder(ctx, id) { return useApi(id ? ctx.paths.purchaseOrder(id) : null, { ttl: 3000 }); }
