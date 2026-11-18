// Receive a delivery: against an order (owner at the warehouse or a branch, or the branch manager for orders sent to their branch),
// or without an order (owner, with a reason). Step 1 is what arrived (everything still due is filled in; you only change what is
// different), step 2 (owner) is the supplier's invoice. The stock goes up when you press Add to stock. The server does the arithmetic;
// here we only show amounts in plain words and warn early. Over-delivery comes back as a question, never silently.
import { useId, useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { branchPaths, formatDay, formatNumber, formatStockMoney, INVOICE_LABEL, percentMore, purchasing, todayNairobi, unitChoices, unitName, useInventoryWrite } from '../../lib/inventory';
import { FormError, OIcon, QuantityInput } from './parts';
import { Chips, Choice, PhotoField } from './ReceivingParts';
import { ItemPicker, MoneyBox, Note } from './PurchasingParts';

const REJECT_REASONS = ['Damaged', 'Wrong item', 'Past its date', 'Poor quality', 'Other'];
let counter = 0;
const nextKey = () => `r${(counter += 1)}`;
const clean = (n) => String(Math.round(Number(n) * 10000) / 10000);

/** Lines for an order: what is still due on each, in the unit it was ordered in. A line that is complete is left out. */
export function linesFromOrder(order, withPrice) {
  const open = (order.lines || []).filter((l) => Number(l.outstandingBase) > 0);
  return (open.length ? open : order.lines || []).map((l) => {
    const due = Number(l.unitFactor) > 0 ? clean(Number(l.outstandingBase) / Number(l.unitFactor)) : '0';
    const list = withPrice && l.unitPrice !== undefined && l.unitPrice !== null ? clean(l.unitPrice) : null;
    return { key: nextKey(), poLineId: l.id, itemId: l.itemId, name: l.itemName, unit: l.unit, ordered: `${l.qty} ${unitName(l.unit, l.qty)}`, orderedText: l.quantity,
      dueText: l.outstanding, dueQty: due, qty: due, rejected: '', reason: '', reasonText: '', price: list ?? '', listPrice: list, batchNo: '', expiry: '', units: null };
  });
}

/* ---------- one line ---------- */

function Line({ line, onChange, showPrice, units }) {
  const id = useId();
  const set = (patch) => onChange({ ...line, ...patch });
  const over = line.dueText && Number(line.qty) > 0 && line.poLineId && Number(line.qty) > Number(line.dueQty ?? Infinity);
  const move = line.listPrice !== null && line.price !== '' ? percentMore(line.price, line.listPrice) : null;
  const choices = line.units;
  const unitText = unitName(line.unit, line.qty, units);
  return <li className="rcv-line">
    <div className="rcv-line-head"><strong>{line.name}</strong>
      <small>{line.poLineId ? `Ordered ${line.orderedText || line.ordered}${line.dueText ? ` · still due ${line.dueText}` : ''}` : 'Not on an order'}</small></div>
    <div className="rcv-line-grid">
      <div className="o-field"><span className="o-label" id={`${id}-q`}>Received</span>
        <QuantityInput id={`${id}-qty`} label={`${line.name} received`} value={line.qty} onChange={(value) => set({ qty: value })} unit={unitText} choices={choices} onUnit={(unit) => set({ unit })} placeholder="0" />
      </div>
      <div className="o-field"><span className="o-label" id={`${id}-r`}>Rejected <span className="o-optional">Optional</span></span>
        <QuantityInput id={`${id}-rej`} label={`${line.name} rejected`} value={line.rejected} onChange={(value) => set({ rejected: value })} unit={unitText} choices={choices} onUnit={(unit) => set({ unit })} placeholder="0" />
      </div>
    </div>
    {Number(line.rejected) > 0 && <>
      <Chips label="Why was it rejected?" options={REJECT_REASONS} value={line.reason} onChange={(reason) => set({ reason })} />
      {line.reason === 'Other' && <div className="o-field"><label className="o-label" htmlFor={`${id}-why`}>What was wrong?</label>
        <input id={`${id}-why`} className="o-input" value={line.reasonText} maxLength={200} onChange={(event) => set({ reasonText: event.target.value })} /></div>}
    </>}
    {over && <p className="rcv-variance" role="status">That is more than is still due. You will be asked to confirm it.</p>}
    {showPrice && <div className="o-field"><label className="o-label" htmlFor={`${id}-price`}>Price for each {unitName(line.unit, 1, units)}</label>
      <MoneyBox id={`${id}-price`} label={`${line.name} price`} value={line.price} onChange={(price) => set({ price })} suffix={`per ${unitName(line.unit, 1, units)}`} />
      {move !== null && move !== 0 && <p className={`rcv-variance${move < 0 ? ' is-down' : ''}`} role="status">
        {move > 0 ? `${formatNumber(move)}% more than ${line.poLineId ? 'the order price' : 'the list price'} (${formatStockMoney(line.listPrice)}). The owner is told if it is a lot.` : `${formatNumber(Math.abs(move))}% less than the order price.`}</p>}
    </div>}
    <details className="rcv-more"><summary>More details (batch, expiry date)</summary>
      <div className="rcv-line-grid">
        <div className="o-field"><label className="o-label" htmlFor={`${id}-batch`}>Batch number <span className="o-optional">Optional</span></label>
          <input id={`${id}-batch`} className="o-input" value={line.batchNo} maxLength={60} onChange={(event) => set({ batchNo: event.target.value })} /></div>
        <div className="o-field"><label className="o-label" htmlFor={`${id}-exp`}>Use-by date <span className="o-optional">Optional</span></label>
          <input id={`${id}-exp`} className="o-input" type="date" value={line.expiry} onChange={(event) => set({ expiry: event.target.value })} /></div>
      </div>
    </details>
  </li>;
}

/* ---------- the sheet ---------- */

const rejectWord = (l) => (l.reason === 'Other' ? l.reasonText.trim() : l.reason);

export default function ReceiveSheet({ mode = 'owner', ctx, order = null, onClose, onDone }) {
  const ids = useId();
  const { notify } = useNotifications();
  const owner = mode === 'owner';
  const units = ctx?.data?.units || [];
  const showPrice = owner && ctx?.can?.costView !== false;
  const [step, setStep] = useState(1);
  const [lines, setLines] = useState(() => (order ? linesFromOrder(order, owner) : []));
  const [note, setNote] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [placeId, setPlaceId] = useState(ctx?.data?.warehouse?.id || '');
  const [unplannedReason, setUnplannedReason] = useState('');
  const [problem, setProblem] = useState('');
  const [invoice, setInvoice] = useState({ kind: 'later', no: '', date: todayNairobi(), etims: '', amount: '', vat: '', reason: '' });
  const [photo, setPhoto] = useState(null);
  const [done, setDone] = useState(null); // { receipt, warnings, invoiceError }
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const suppliers = ctx?.suppliers || [];
  const setLine = (next) => setLines((current) => current.map((l) => (l.key === next.key ? next : l)));
  const places = (ctx?.data?.locations || []).filter((l) => l.capabilities?.includes('inv.purchase.create') || l.capabilities?.includes('inv.stock.record'));
  const confirm = error?.code === 'over_delivery' ? error : null;
  const shownError = confirm ? null : error;
  const place = order ? order.deliverTo?.name : (places.find((l) => l.id === placeId)?.kind === 'branch' ? places.find((l) => l.id === placeId)?.name : 'Warehouse');
  const items = ctx?.data?.items || [];
  const usedIds = useMemo(() => lines.map((l) => l.itemId), [lines]);

  function addItem(item) {
    const choices = unitChoices(item, units);
    const unit = item.displayUnit || item.baseUnit;
    setLines((current) => [...current, { key: nextKey(), poLineId: null, itemId: item.id, name: item.name, unit, orderedText: '', dueText: '', qty: '', rejected: '', reason: '', reasonText: '', price: '', listPrice: null, batchNo: '', expiry: '', units: choices }]);
  }

  const counted = lines.filter((l) => Number(l.qty) > 0 || Number(l.rejected) > 0);
  function checkLines() {
    if (!order) {
      if (!supplierId) return 'Choose who delivered it.';
      if (!unplannedReason.trim()) return 'Say why there is no order (for example: the supplier brought extra, or a one-off buy).';
    }
    if (!counted.length) return order ? 'Enter how much arrived, or how much you rejected.' : 'Add the items that arrived and how much of each.';
    for (const l of counted) {
      if (Number(l.qty) < 0 || Number(l.rejected) < 0) return `${l.name}: amounts can’t be negative.`;
      if (Number(l.rejected) > 0 && !rejectWord(l)) return `${l.name}: say why you rejected some.`;
    }
    return '';
  }
  function checkInvoice() {
    if (invoice.kind === 'later') return '';
    if (invoice.kind === 'none') return invoice.reason.trim() ? (Number(invoice.amount) >= 0 && invoice.amount !== '' ? '' : 'Enter the amount you owe for this delivery.') : 'You said there is no invoice. Say why (for example: market stall, only an M-Pesa message).';
    if (!invoice.no.trim()) return 'Enter the invoice number.';
    if (!invoice.date) return 'Enter the invoice date.';
    if (invoice.kind === 'etims' && !invoice.etims.trim()) return 'An eTIMS invoice has an eTIMS number. Enter it, or choose “Other invoice or receipt”.';
    if (invoice.amount === '' || !(Number(invoice.amount) >= 0)) return 'Enter the invoice total.';
    return '';
  }

  function next(event) {
    event.preventDefault();
    const issue = checkLines();
    setProblem(issue);
    if (!issue) setStep(2);
  }

  async function post(confirmOver = false) {
    clearError();
    const issue = checkLines() || (owner ? checkInvoice() : '');
    setProblem(issue);
    if (issue) return;
    const body = {
      post: true, deliveryNoteNo: note.trim() || undefined, confirmOverDelivery: confirmOver || undefined,
      ...(order ? { poId: order.id } : { supplierId, locationId: placeId || undefined, unplannedReason: unplannedReason.trim() }),
      lines: counted.map((l) => ({
        ...(l.poLineId ? { poLineId: l.poLineId } : { itemId: l.itemId }), unit: l.unit, receivedQty: String(Number(l.qty) || 0),
        ...(Number(l.rejected) > 0 ? { rejectedQty: String(Number(l.rejected)), rejectReason: rejectWord(l) } : {}),
        ...(showPrice && l.price !== '' && (l.listPrice === null || Number(l.price) !== Number(l.listPrice)) ? { unitCost: String(Number(l.price)) } : {}),
        ...(l.batchNo.trim() ? { batchNo: l.batchNo.trim() } : {}), ...(l.expiry ? { expiryDate: l.expiry } : {}),
      })),
    };
    const path = owner ? ctx.paths.goodsReceipts() : branchPaths.goodsReceipts;
    const result = await run('POST', path, body, { step: `receive-${confirmOver}` });
    if (!result) return;
    const outcome = { receipt: result.receipt, warnings: result.warnings || [], invoiceError: null };
    setDone(outcome);
    onDone?.(result.receipt);
    if (owner && invoice.kind !== 'later') await saveInvoice(outcome);
  }

  async function saveInvoice(outcome = done) {
    const body = {
      supplierId: order?.supplier?.id || supplierId, poId: order?.id, grnIds: [outcome.receipt.id], invoiceStatus: invoice.kind,
      ...(invoice.kind === 'none' ? { noInvoiceReason: invoice.reason.trim() } : { invoiceNo: invoice.no.trim(), invoiceDate: invoice.date }),
      ...(invoice.kind === 'etims' ? { etimsInvoiceNo: invoice.etims.trim() } : {}), amount: String(Number(invoice.amount) || 0), vat: String(Number(invoice.vat) || 0),
    };
    const saved = await run('POST', ctx.paths.supplierInvoices, body, { step: 'invoice' });
    if (!saved) { setDone({ ...outcome, invoiceError: 'The stock was added, but the invoice was not saved.' }); return; }
    let photoNote = null;
    if (photo) {
      try { await purchasing.upload(ctx.business.id, { entityType: 'invoice', entityId: saved.invoice.id, file: photo }); } catch (failure) { photoNote = failure.message || 'The photo could not be saved.'; }
    }
    setDone({ ...outcome, invoice: saved.invoice, invoiceError: photoNote ? `The invoice was saved, but its photo was not: ${photoNote}` : null, photoFailed: Boolean(photoNote) });
    notify('Invoice saved.');
  }

  /* ----- finished ----- */
  if (done) {
    const receipt = done.receipt;
    const where = receipt.location?.name || place || 'the Warehouse';
    const added = receipt.lines.filter((l) => Number(l.receivedBase) > 0);
    const turned = receipt.lines.filter((l) => Number(l.rejectedBase) > 0);
    return <div className="inv-form" aria-live="polite">
      <p className="o-field-hint"><strong>{receipt.number}</strong> is posted. {receipt.poNumber ? `It is against ${receipt.poNumber}.` : 'It is not against an order.'}</p>
      <ul className="rcv-summary">
        {added.map((l) => <li key={l.id}><OIcon name="check" size={15} /><span>Added {l.received} {l.itemName} to {where.toLowerCase() === 'warehouse' ? 'the Warehouse' : where}</span></li>)}
        {turned.map((l) => <li key={`r${l.id}`}><OIcon name="info" size={15} /><span>Rejected {l.rejected} {l.itemName}{l.rejectReason ? ` (${l.rejectReason})` : ''}. It was not added to stock.</span></li>)}
        {!added.length && <li><OIcon name="info" size={15} /><span>Nothing was added to stock.</span></li>}
      </ul>
      {done.warnings.map((w, i) => <Note key={i} tone="warn">{w.message}</Note>)}
      {done.invoice && <Note tone="ok">Invoice saved: {INVOICE_LABEL[done.invoice.invoiceStatus]}{done.invoice.invoiceNo ? ` ${done.invoice.invoiceNo}` : ''}, {formatStockMoney(done.invoice.amount)}.</Note>}
      {done.invoiceError && <>
        <FormError error={done.invoiceError} />
        {error && <FormError error={error} />}
        {!done.invoice && <button type="button" className="o-btn" disabled={busy} onClick={() => saveInvoice(done)}>{busy ? 'Saving…' : 'Try saving the invoice again'}</button>}
      </>}
      <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
    </div>;
  }

  const showSteps = owner;
  return <form className="inv-form inv-record" onSubmit={step === 1 && owner ? next : (event) => { event.preventDefault(); post(false); }} noValidate>
    {showSteps && <p className="rcv-steps">Step {step} of 2: {step === 1 ? 'What arrived' : 'Supplier invoice'}</p>}
    {order && <p className="o-field-hint"><strong>{order.supplier?.name}</strong> to {order.deliverTo?.name}{order.expectedDate ? ` · expected ${formatDay(order.expectedDate)}` : ''}. Everything still due is filled in: change only what is different.</p>}

    {step === 1 && <>
      {!order && <>
        <div className="o-field"><label className="o-label" htmlFor={`${ids}-sup`}>Who delivered it?</label>
          <select id={`${ids}-sup`} className="o-select" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} data-autofocus>
            <option value="">Choose a supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
        {places.length > 1 && <div className="o-field"><label className="o-label" htmlFor={`${ids}-at`}>Where did it arrive?</label>
          <select id={`${ids}-at`} className="o-select" value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
            {places.map((l) => <option key={l.id} value={l.id}>{l.kind === 'branch' ? l.name : 'Warehouse'}</option>)}</select></div>}
        <div className="o-field"><label className="o-label" htmlFor={`${ids}-why`}>Why is there no order?</label>
          <input id={`${ids}-why`} className="o-input" value={unplannedReason} maxLength={300} placeholder="For example: the supplier brought extra" onChange={(event) => setUnplannedReason(event.target.value)} /></div>
        <ItemPicker items={items.filter((i) => !i.archived)} exclude={usedIds} onPick={addItem} label="Add what arrived" />
      </>}
      {lines.length > 0 && <ul className="rcv-lines" aria-label="What arrived">
        {lines.map((line) => <Line key={line.key} line={line} onChange={setLine} showPrice={showPrice} units={units} />)}
      </ul>}
      <div className="o-field"><label className="o-label" htmlFor={`${ids}-note`}>Delivery note number <span className="o-optional">Optional</span></label>
        <input id={`${ids}-note`} className="o-input" value={note} maxLength={60} onChange={(event) => setNote(event.target.value)} /></div>
      <p className="o-field-hint">Count only what you are keeping under Received. Rejected goods are written down with the reason but are not added to stock.</p>
    </>}

    {step === 2 && owner && <>
      <Choice legend="Did the supplier give you an invoice?" value={invoice.kind} onChange={(kind) => { setInvoice((current) => ({ ...current, kind })); setProblem(''); }}
        options={[{ value: 'etims', label: 'eTIMS invoice', hint: 'Has an eTIMS number' }, { value: 'other', label: 'Other invoice or receipt', hint: 'Any other paper' },
          { value: 'none', label: 'No invoice', hint: 'Say why' }, { value: 'later', label: 'I’ll add it later', hint: 'Stock is added now' }]} />
      {invoice.kind !== 'later' && <>
        {invoice.kind !== 'none' && <div className="rcv-line-grid">
          <div className="o-field"><label className="o-label" htmlFor={`${ids}-ino`}>Invoice number</label>
            <input id={`${ids}-ino`} className="o-input" value={invoice.no} maxLength={60} onChange={(event) => setInvoice({ ...invoice, no: event.target.value })} /></div>
          <div className="o-field"><label className="o-label" htmlFor={`${ids}-idate`}>Invoice date</label>
            <input id={`${ids}-idate`} className="o-input" type="date" value={invoice.date} onChange={(event) => setInvoice({ ...invoice, date: event.target.value })} /></div>
          {invoice.kind === 'etims' && <div className="o-field"><label className="o-label" htmlFor={`${ids}-etims`}>eTIMS number</label>
            <input id={`${ids}-etims`} className="o-input" value={invoice.etims} maxLength={60} onChange={(event) => setInvoice({ ...invoice, etims: event.target.value })} /></div>}
        </div>}
        {invoice.kind === 'none' && <div className="o-field"><label className="o-label" htmlFor={`${ids}-nor`}>Why is there no invoice?</label>
          <input id={`${ids}-nor`} className="o-input" value={invoice.reason} maxLength={300} placeholder="For example: market stall, only an M-Pesa message" onChange={(event) => setInvoice({ ...invoice, reason: event.target.value })} /></div>}
        <div className="rcv-line-grid">
          <div className="o-field"><label className="o-label" htmlFor={`${ids}-iamt`}>{invoice.kind === 'none' ? 'Amount you owe' : 'Invoice total'}</label>
            <MoneyBox id={`${ids}-iamt`} label="Invoice total" value={invoice.amount} onChange={(amount) => setInvoice({ ...invoice, amount })} /></div>
          <div className="o-field"><label className="o-label" htmlFor={`${ids}-ivat`}>VAT on it <span className="o-optional">Optional</span></label>
            <MoneyBox id={`${ids}-ivat`} label="VAT" value={invoice.vat} onChange={(vat) => setInvoice({ ...invoice, vat })} /></div>
        </div>
        <PhotoField id={`${ids}-photo`} label="Photo of the invoice" file={photo} onChange={setPhoto} accept="image/*,application/pdf" camera={false}
          hint="Take a clear photo of the whole page. It is kept with the receipt." />
      </>}
    </>}

    {confirm && <div className="inv-confirm" role="alert">
      <span>{confirm.message}</span>
      <div className="inv-confirm-actions">
        <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => post(true)}>Yes, I accept the extra</button>
        <button type="button" className="o-btn" disabled={busy} onClick={() => { clearError(); setStep(1); }}>Let me check the count</button>
      </div>
    </div>}
    <FormError error={problem || shownError} />
    <div className="biz-form-actions">
      {step === 1 && owner ? <button type="submit" className="o-btn is-primary">Next: supplier invoice</button>
        : <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Adding…' : 'Add to stock'}</button>}
      {step === 2 ? <button type="button" className="o-btn is-quiet" onClick={() => { setStep(1); clearError(); }} disabled={busy}>Back</button>
        : <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>}
    </div>
  </form>;
}
