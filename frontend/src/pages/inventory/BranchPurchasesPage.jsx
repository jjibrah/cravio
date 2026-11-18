// Branch "Purchases" (/branch/:id/inventory/purchases): emergency buys for when you can't wait for the warehouse. Each card says
// where the purchase stands and what to do next. The steps, in order: New purchase (what, from whom, why; the screen says at once
// whether the owner will be asked) -> I've bought it (what you really paid, how, the invoice, a photo) -> Goods arrived (what you
// really got; stock goes up). Everything the server refuses comes back in plain words.
import { useEffect, useId, useMemo, useState } from 'react';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { EMERGENCY_STATUS, INVOICE_LABEL, branchPaths, formatNumber, formatStamp, formatStockMoney, normaliseMpesa, normalisePin, normalisePhone, unitName, uploadFile, useInventoryWrite } from '../../lib/inventory';
import { EmergencyDetail, EmergencyStatus } from './EmergencyParts';
import { EmptyState, ErrorState, FormError, OIcon, Panel, QuantityInput, SkeletonRows, TaskDrawer } from './parts';
import { ItemPicker, MoneyBox, Note, PhoneField } from './PurchasingParts';
import { Choice, PhotoField } from './ReceivingParts';
import './receiving.css';

let counter = 0;
const nextKey = () => `e${(counter += 1)}`;
const usualUnit = (item) => item?.units?.[0]?.code || item?.displayUnit || item?.baseUnit || '';
const clean = (n) => String(Math.round(Number(n) * 100) / 100);

/** One line under the amount: will this be approved straight away or will the owner be asked? Read from the server's limits. */
export function limitLine(limits, total) {
  if (!limits) return null;
  if (!limits.hasLimit) return { tone: 'ask', text: 'No limit has been set for this branch yet, so the owner will be asked.' };
  const preview = limits.preview;
  if (total > 0 && preview) {
    if (preview.needsApproval) return { tone: 'ask', text: `Over your limit — the owner will be asked.${preview.reasons?.length ? ` ${preview.reasons.join(' ')}` : ''}` };
    const left = limits.leftTodayKes !== null && limits.leftTodayKes !== undefined ? `${formatStockMoney(limits.leftTodayKes)} left today` : limits.leftWeekKes !== null && limits.leftWeekKes !== undefined ? `${formatStockMoney(limits.leftWeekKes)} left this week` : 'Within your limit';
    return { tone: 'ok', text: `${left} — this purchase will be approved straight away.` };
  }
  return { tone: 'info', text: limits.message };
}

/* ---------- step 1: a new purchase ---------- */

function NewPurchase({ onClose, onChanged }) {
  const ids = useId();
  const { notify } = useNotifications();
  const items = useApi(branchPaths.snapshot({ all: true }), { ttl: 10000 });
  const suppliers = useApi(branchPaths.emergencySuppliers(''), { ttl: 30000 });
  const [lines, setLines] = useState([]);
  const [supplier, setSupplier] = useState('');
  const [fresh, setFresh] = useState({ name: '', phone: '', pin: '' });
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState('');
  const [draft, setDraft] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const total = lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const [asked, setAsked] = useState(0);
  useEffect(() => { const t = setTimeout(() => setAsked(Math.round(total * 100) / 100), 350); return () => clearTimeout(t); }, [total]);
  const limits = useApi(branchPaths.emergencyLimits(asked > 0 ? asked : ''), { ttl: 2000 });
  const line = limitLine(limits.data, asked);
  const setLine = (key, patch) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const catalogue = (items.data?.items || []).filter((i) => !i.archived);
  const adding = supplier === '__new';

  function addItem(item) { setLines((current) => [...current, { key: nextKey(), item, qty: '', unit: usualUnit(item), price: '' }]); }

  function check() {
    if (!lines.length) return 'Add what you need to buy.';
    for (const l of lines) {
      if (!(Number(l.qty) > 0)) return `${l.item.name}: enter how much you will buy.`;
      if (!(Number(l.price) > 0)) return `${l.item.name}: enter your best guess of the price. The owner needs an amount to check.`;
    }
    if (!supplier) return 'Say who you are buying from, or add the shop or trader.';
    if (adding) {
      if (!fresh.name.trim()) return 'Enter the name of the shop or trader.';
      if (!normalisePhone(fresh.phone)) return 'Enter their phone number (for example 0712 345 678) so the owner can follow up.';
      if (fresh.pin.trim() && !normalisePin(fresh.pin)) return 'That KRA PIN doesn’t look right. Leave it empty if you don’t have it.';
    }
    if (!reason.trim()) return 'Say why this can’t wait for a normal order (for example: chicken ran out, 30 covers booked).';
    return '';
  }

  async function send(event) {
    event.preventDefault();
    const issue = draft ? '' : check();
    setProblem(issue);
    if (issue) return;
    clearError();
    let id = draft;
    if (!id) {
      const body = {
        reason: reason.trim(),
        ...(adding ? { newSupplier: { name: fresh.name.trim(), phone: fresh.phone.trim(), ...(fresh.pin.trim() ? { kraPin: fresh.pin.trim() } : {}) } } : { supplierId: supplier }),
        lines: lines.map((l) => ({ itemId: l.item.id, qty: String(Number(l.qty)), unit: l.unit, price: String(Number(l.price)) })),
      };
      const made = await run('POST', branchPaths.emergency(), body, { step: 'create' });
      if (!made) return;
      id = made.id; setDraft(id); onChanged();
    }
    const sent = await run('POST', branchPaths.emergencyAction(id, 'submit'), {}, { step: 'submit' });
    if (!sent) return;
    onChanged();
    const authorised = sent.status === 'authorised';
    setOutcome({ number: sent.number, authorised, message: sent.evaluation?.limits?.message });
    notify(authorised ? `${sent.number} is approved. Go ahead and buy it.` : `${sent.number} was sent to the owner.`);
  }

  if (outcome) return <div className="inv-form" aria-live="polite">
    <Note tone="ok">{outcome.authorised ? `${outcome.number} is approved. Go ahead and buy it. When you have paid, come back and press “I’ve bought it”.` : `${outcome.number} was sent to the owner. You will be told when they decide. Until then, don’t buy it.`}</Note>
    {outcome.authorised && outcome.message && <p className="o-field-hint">{outcome.message}</p>}
    <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
  </div>;

  return <form className="inv-form inv-record" onSubmit={send} noValidate>
    <fieldset className="inv-form" disabled={busy || Boolean(draft)} style={{ border: 0, padding: 0, margin: 0 }}>
      <ItemPicker items={catalogue} exclude={lines.map((l) => l.item.id)} onPick={addItem} label="What do you need to buy?" placeholder="Type to find an item" />
      {items.loading && <SkeletonRows rows={1} thumb={false} label="Loading items" />}
      {lines.length > 0 && <ul className="rcv-lines" aria-label="What you will buy">{lines.map((l) => <li key={l.key} className="rcv-line">
        <div className="rcv-line-head"><strong>{l.item.name}</strong>
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.item.name}`}>Remove</button></div>
        <div className="rcv-line-grid">
          <div className="o-field"><span className="o-label">How much?</span>
            <QuantityInput id={`${l.key}-q`} label={`${l.item.name} amount`} value={l.qty} onChange={(qty) => setLine(l.key, { qty })} unit={l.unit}
              choices={(l.item.units || []).map((u) => ({ value: u.code, label: u.plural }))} onUnit={(unit) => setLine(l.key, { unit })} placeholder="0" /></div>
          <div className="o-field"><label className="o-label" htmlFor={`${l.key}-p`}>Best guess of the price for one {unitName(l.unit, 1, [])}</label>
            <MoneyBox id={`${l.key}-p`} label={`${l.item.name} price`} value={l.price} onChange={(price) => setLine(l.key, { price })} suffix={`per ${unitName(l.unit, 1, [])}`} /></div>
        </div>
        {Number(l.qty) > 0 && Number(l.price) > 0 && <p className="o-field-hint">About {formatStockMoney(Number(l.qty) * Number(l.price))}</p>}
      </li>)}</ul>}

      <div className="o-field"><label className="o-label" htmlFor={`${ids}-sup`}>Who are you buying from?</label>
        <select id={`${ids}-sup`} className="o-select" value={supplier} onChange={(event) => setSupplier(event.target.value)}>
          <option value="">Choose a supplier…</option>
          {(suppliers.data?.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="__new">New supplier: a shop or trader not on the list</option>
        </select></div>
      {adding && <div className="rcv-line">
        <div className="o-field"><label className="o-label" htmlFor={`${ids}-sn`}>Name of the shop or trader</label>
          <input id={`${ids}-sn`} className="o-input" value={fresh.name} maxLength={120} onChange={(event) => setFresh({ ...fresh, name: event.target.value })} /></div>
        <PhoneField id={`${ids}-sp`} value={fresh.phone} onChange={(phone) => setFresh({ ...fresh, phone })} label="Their phone number" required />
        <div className="o-field"><label className="o-label" htmlFor={`${ids}-pin`}>KRA PIN <span className="o-optional">Optional</span></label>
          <input id={`${ids}-pin`} className="o-input" value={fresh.pin} maxLength={11} placeholder="A123456789B" onChange={(event) => setFresh({ ...fresh, pin: event.target.value })} /></div>
      </div>}

      <div className="o-field"><label className="o-label" htmlFor={`${ids}-why`}>Why can’t this wait?</label>
        <input id={`${ids}-why`} className="o-input" value={reason} maxLength={300} placeholder="For example: chicken ran out, 30 covers booked" onChange={(event) => setReason(event.target.value)} /></div>
    </fieldset>

    {line && <p className={`rcv-limit is-${line.tone}`} role="status" aria-live="polite">{line.text}</p>}
    {total > 0 && <p className="o-field-hint">Estimate in total: <strong>{formatStockMoney(total)}</strong></p>}
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending…' : draft ? 'Try sending again' : 'Send purchase'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- step 2: I've bought it ---------- */

function Bought({ purchase, onChanged }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [prices, setPrices] = useState(() => Object.fromEntries(purchase.lines.map((l) => [l.id, clean(l.estimatedUnitPrice)])));
  const [method, setMethod] = useState('cash');
  const [code, setCode] = useState('');
  const [reference, setReference] = useState('');
  const [invoice, setInvoice] = useState('other');
  const [number, setNumber] = useState('');
  const [why, setWhy] = useState('');
  const [photo, setPhoto] = useState(null);
  const [problem, setProblem] = useState('');
  const [photoProblem, setPhotoProblem] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  const total = purchase.lines.reduce((sum, l) => sum + Number(l.qty) * (Number(prices[l.id]) || 0), 0);
  const codeBad = method === 'mpesa' && code.trim() !== '' && !normaliseMpesa(code);

  async function submit(event) {
    event.preventDefault();
    for (const l of purchase.lines) if (!(Number(prices[l.id]) > 0)) return setProblem(`Enter the price you paid for ${l.itemName}.`);
    if (method === 'mpesa' && !normaliseMpesa(code)) return setProblem('Enter the M-Pesa code from the message: 10 capital letters and numbers, like SHK7Q2X9LM.');
    const ref = method === 'mpesa' ? normaliseMpesa(code) : reference.trim();
    if (invoice === 'none') {
      if (!why.trim()) return setProblem('With no invoice, say why (for example: market trader, no receipts).');
      if (!ref) return setProblem('With no invoice, enter the payment reference: the M-Pesa code, or the number on the cash slip.');
      if (!photo) return setProblem('With no invoice, take a photo of the goods or the shop’s slip.');
    } else if (!number.trim()) return setProblem(invoice === 'etims' ? 'Enter the eTIMS invoice number printed on the receipt.' : 'Enter the number on the invoice or receipt.');
    setProblem('');
    const body = {
      paymentMethod: method, ...(ref ? { paymentReference: ref } : {}), invoiceStatus: invoice,
      ...(invoice === 'none' ? { noInvoiceReason: why.trim() } : { invoiceNo: number.trim() }),
      prices: purchase.lines.map((l) => ({ lineId: l.id, price: String(Number(prices[l.id])) })),
    };
    const done = await run('POST', branchPaths.emergencyAction(purchase.id, 'purchased'), body, { step: 'purchased' });
    if (!done) return undefined;
    if (photo) {
      try { await uploadFile(branchPaths.emergencyAction(purchase.id, 'evidence'), {}, photo); } catch (failure) { setPhotoProblem(failure.message); }
    }
    notify('Saved. When the goods arrive, press “Goods arrived”.');
    onChanged();
    return undefined;
  }

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">You were approved for about {formatStockMoney(purchase.approvedTotal ?? purchase.estimatedTotal)}. Now say what you really paid.</p>
    <ul className="rcv-lines" aria-label="What you paid">{purchase.lines.map((l) => <li key={l.id} className="rcv-line">
      <div className="rcv-line-head"><strong>{l.itemName}</strong><small>{formatNumber(l.qty)} {unitName(l.unit, l.qty)}</small></div>
      <div className="o-field"><label className="o-label" htmlFor={`${ids}-p${l.id}`}>Price paid for one {unitName(l.unit, 1, [])}</label>
        <MoneyBox id={`${ids}-p${l.id}`} label={`${l.itemName} price paid`} value={prices[l.id]} onChange={(value) => setPrices({ ...prices, [l.id]: value })} suffix={`per ${unitName(l.unit, 1, [])}`} /></div>
    </li>)}</ul>
    <p className="o-field-hint">Total paid: <strong>{formatStockMoney(total)}</strong></p>

    <Choice legend="How did you pay?" value={method} onChange={setMethod} options={[{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa' }, { value: 'supplier_credit', label: 'On credit', hint: 'The supplier will bill us' }]} />
    {method === 'mpesa' ? <div className="o-field"><label className="o-label" htmlFor={`${ids}-code`}>M-Pesa code</label>
      <input id={`${ids}-code`} className="o-input" value={code} maxLength={14} autoCapitalize="characters" autoComplete="off" aria-invalid={codeBad ? 'true' : undefined} aria-describedby={`${ids}-code-h`}
        onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="SHK7Q2X9LM" />
      <p id={`${ids}-code-h`} className={codeBad ? 'o-field-error' : 'o-field-hint'} aria-live="polite">{codeBad ? 'That doesn’t look like an M-Pesa code. A code has 10 capital letters and numbers, like SHK7Q2X9LM. Check it against the M-Pesa message.' : 'The 10 letters and numbers in the M-Pesa message, like SHK7Q2X9LM.'}</p></div>
      : method === 'cash' ? <div className="o-field"><label className="o-label" htmlFor={`${ids}-ref`}>Number on the cash receipt {invoice !== 'none' && <span className="o-optional">Optional</span>}</label>
        <input id={`${ids}-ref`} className="o-input" value={reference} maxLength={60} onChange={(event) => setReference(event.target.value)} /></div>
        : invoice === 'none' && <div className="o-field"><label className="o-label" htmlFor={`${ids}-ref`}>Reference</label>
          <input id={`${ids}-ref`} className="o-input" value={reference} maxLength={60} onChange={(event) => setReference(event.target.value)} /></div>}

    <Choice legend="Did you get an invoice?" value={invoice} onChange={setInvoice} options={[{ value: 'etims', label: 'eTIMS invoice', hint: 'Printed with an eTIMS number' }, { value: 'other', label: 'Other receipt', hint: 'Any other paper' }, { value: 'none', label: 'No invoice', hint: 'Say why, add a photo' }]} />
    {invoice !== 'none' ? <div className="o-field"><label className="o-label" htmlFor={`${ids}-no`}>{invoice === 'etims' ? 'eTIMS invoice number' : 'Number on the receipt'}</label>
      <input id={`${ids}-no`} className="o-input" value={number} maxLength={60} onChange={(event) => setNumber(event.target.value)} /></div>
      : <div className="o-field"><label className="o-label" htmlFor={`${ids}-why`}>Why is there no invoice?</label>
        <input id={`${ids}-why`} className="o-input" value={why} maxLength={300} placeholder="For example: market trader, no receipts" onChange={(event) => setWhy(event.target.value)} /></div>}
    <PhotoField id={`${ids}-photo`} label={invoice === 'none' ? 'Photo of the goods or the shop’s slip' : 'Photo of the receipt'} file={photo} onChange={setPhoto} required={invoice === 'none'}
      hint={invoice === 'none' ? 'Needed when there is no invoice, so the owner can see what you bought.' : 'A clear photo of the whole receipt helps the owner.'} />
    {photoProblem && <FormError error={`Saved, but the photo was not: ${photoProblem}`} />}
    <FormError error={problem || error} />
    <div className="biz-form-actions"><button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : 'I’ve bought it'}</button></div>
  </form>;
}

/* ---------- step 3: goods arrived ---------- */

function Arrived({ purchase, onChanged, onClose }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [qty, setQty] = useState(() => Object.fromEntries(purchase.lines.map((l) => [l.id, String(l.qty)])));
  const needsPhoto = purchase.invoiceStatus === 'none' && !(purchase.evidence || []).some((f) => String(f.mime).startsWith('image/'));
  const [photo, setPhoto] = useState(null);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState(null);
  const [run, { busy, error }] = useInventoryWrite();

  async function submit(event) {
    event.preventDefault();
    for (const l of purchase.lines) if (qty[l.id] === '' || Number(qty[l.id]) < 0) return setProblem(`${l.itemName}: enter how much arrived (0 if none).`);
    if (needsPhoto && !photo) return setProblem('With no invoice, take a photo of the goods first.');
    setProblem('');
    if (needsPhoto && photo) {
      try { await uploadFile(branchPaths.emergencyAction(purchase.id, 'evidence'), {}, photo); } catch (failure) { return setProblem(`The photo was not saved: ${failure.message}`); }
    }
    const done = await run('POST', branchPaths.emergencyAction(purchase.id, 'receive'), { lines: purchase.lines.map((l) => ({ lineId: l.id, qty: String(Number(qty[l.id])) })) }, { step: 'receive' });
    if (!done) return undefined;
    setResult(done);
    notify('Stock added.');
    onChanged();
    return undefined;
  }

  if (result) return <div className="inv-form" aria-live="polite">
    <ul className="rcv-summary">{(result.stock || []).map((s) => <li key={s.itemId}><OIcon name="check" size={15} /><span>Added {s.added} {s.itemName} to your stock</span></li>)}
      {!result.stock?.length && <li><OIcon name="info" size={15} /><span>Nothing was added to stock.</span></li>}</ul>
    {(result.flags || []).length > 0 && <Note tone="warn">The owner will look at this one: {result.flags.join(' ')}</Note>}
    {(result.repeatAlerts || []).map((a) => <Note key={a.itemId}>{a.message}</Note>)}
    <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
  </div>;

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">Count what really arrived. If something is short, change the number: you only add what came.</p>
    <ul className="rcv-lines" aria-label="What arrived">{purchase.lines.map((l) => <li key={l.id} className="rcv-line">
      <div className="rcv-line-head"><strong>{l.itemName}</strong><small>You bought {formatNumber(l.qty)} {unitName(l.unit, l.qty)}</small></div>
      <div className="o-field"><span className="o-label">How much arrived?</span>
        <QuantityInput id={`${ids}-${l.id}`} label={`${l.itemName} arrived`} value={qty[l.id]} onChange={(value) => setQty({ ...qty, [l.id]: value })} unit={unitName(l.unit, qty[l.id], [])} placeholder="0" /></div>
    </li>)}</ul>
    {needsPhoto && <PhotoField id={`${ids}-photo`} label="Photo of the goods" file={photo} onChange={setPhoto} required hint="You said there was no invoice, so a photo of the goods is needed." />}
    <FormError error={problem || error} />
    <div className="biz-form-actions"><button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Adding…' : 'Goods arrived'}</button></div>
  </form>;
}

/* ---------- one purchase ---------- */

function Cancel({ purchase, onChanged }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  if (!open) return <button type="button" className="o-btn is-quiet is-danger" onClick={() => setOpen(true)}>Cancel this purchase</button>;
  return <div className="inv-confirm" role="group" aria-label="Cancel this purchase">
    <span>Cancel {purchase.number}? You can start a new one later.</span>
    <label className="visually-hidden" htmlFor="cancel-why">Why (optional)</label>
    <input id="cancel-why" className="o-input" placeholder="Why? (optional)" value={why} maxLength={300} onChange={(event) => setWhy(event.target.value)} />
    <FormError error={error} />
    <div className="inv-confirm-actions">
      <button type="button" className="o-btn is-danger-solid" disabled={busy} onClick={async () => { const done = await run('POST', branchPaths.emergencyAction(purchase.id, 'cancel'), { reason: why.trim() || undefined }, { step: 'cancel' }); if (done) onChanged(); }}>Yes, cancel it</button>
      <button type="button" className="o-btn is-quiet" disabled={busy} onClick={() => setOpen(false)}>Keep it</button></div>
  </div>;
}

function PurchaseSheet({ id, onClose, onChanged }) {
  const detail = useApi(id ? branchPaths.emergencyOne(id) : null, { ttl: 1000 });
  const purchase = detail.data;
  const refresh = () => { detail.refresh(); onChanged(); };
  const [send, { busy: sending, error: sendError }] = useInventoryWrite();
  const status = purchase?.status;
  const rejected = [...(purchase?.approvals || [])].reverse().find((a) => a.status === 'rejected');
  return <TaskDrawer open title={id ? (purchase ? purchase.number : 'Purchase') : 'New purchase'} onClose={onClose} wide>
    {!id ? <NewPurchase onClose={onClose} onChanged={onChanged} />
      : detail.error && !purchase ? <p className="o-field-error" role="alert">{detail.error.message || 'This purchase could not be loaded.'}</p>
        : !purchase ? <SkeletonRows rows={4} thumb={false} label="Loading the purchase" />
          : status === 'authorised' ? <>
            <Note tone="ok">Approved. Go ahead and buy it, then say what you paid.</Note>
            <Bought purchase={purchase} onChanged={refresh} />
            <Cancel purchase={purchase} onChanged={() => { refresh(); onClose(); }} /></>
            : status === 'purchased' ? <><Note>Bought. When the goods arrive, say what you got and the stock goes up.</Note><Arrived purchase={purchase} onChanged={refresh} onClose={onClose} /></>
              : <div className="inv-form">
                <p><EmergencyStatus status={status} /> <span className="o-field-hint">{EMERGENCY_STATUS[status]?.next}</span></p>
                {status === 'rejected' && rejected?.decisionNote && <p className="inv-note" role="status">The owner said: “{rejected.decisionNote}”</p>}
                <EmergencyDetail purchase={purchase} showBranch={false} />
                {status === 'draft' && <><FormError error={sendError} />
                  <div className="biz-form-actions"><button type="button" className="o-btn is-primary" disabled={sending} onClick={async () => { const done = await send('POST', branchPaths.emergencyAction(purchase.id, 'submit'), {}, { step: 'submit' }); if (done) refresh(); }}>{sending ? 'Sending…' : 'Send purchase'}</button></div></>}
                {['draft', 'pending_approval'].includes(status) && <Cancel purchase={purchase} onChanged={() => { refresh(); onClose(); }} />}
              </div>}
  </TaskDrawer>;
}

/* ---------- the page ---------- */

const NEXT_BUTTON = { draft: 'Send it', authorised: 'I’ve bought it', purchased: 'Goods arrived' };

export function BranchPurchasesPage({ section }) {
  const list = useApi(branchPaths.emergency({ limit: 100 }), { ttl: 5000 });
  const limits = useApi(branchPaths.emergencyLimits(''), { ttl: 15000 });
  const [open, setOpen] = useState(undefined); // undefined closed | null new | id
  const purchases = list.data?.purchases;
  const active = useMemo(() => (purchases || []).filter((p) => ['draft', 'pending_approval', 'authorised', 'purchased'].includes(p.status)), [purchases]);
  const past = useMemo(() => (purchases || []).filter((p) => !active.includes(p)), [purchases, active]);
  const card = (p) => <li key={p.id} className="rcv-card">
    <div className="rcv-card-main"><strong>{p.number} · {p.supplierName}</strong>
      <small>{formatStockMoney(p.actualTotal ?? p.estimatedTotal)}{p.invoiceStatus ? ` · ${INVOICE_LABEL[p.invoiceStatus]}` : ''} · {formatStamp(p.createdAt)}</small>
      <small>{p.reason}</small>
      <p className="rcv-card-next">{EMERGENCY_STATUS[p.status]?.next}</p></div>
    <div className="rcv-card-side"><EmergencyStatus status={p.status} />
      <button type="button" className={`o-btn${NEXT_BUTTON[p.status] ? ' is-primary' : ''}`} aria-label={`${NEXT_BUTTON[p.status] || 'Open'} ${p.number}`} onClick={() => setOpen(p.id)}>{NEXT_BUTTON[p.status] || 'Open'}</button></div>
  </li>;
  return <div className="biz-stack inv-page">
    <PageHeader title={section?.label || 'Purchases'} description={section?.description || 'Emergency buys, with the receipt, when you can’t wait for the warehouse.'}>
      <button type="button" className="o-btn is-primary" onClick={() => setOpen(null)}><OIcon name="plus" size={15} />New purchase</button>
    </PageHeader>
    {limits.data && <p className="rcv-limit" role="status">{limits.data.message}</p>}
    {list.error && !purchases ? <ErrorState error={list.error} onRetry={list.refresh} what="purchases" />
      : !purchases ? <Panel title="Purchases"><SkeletonRows rows={4} thumb={false} label="Loading purchases" /></Panel>
        : !purchases.length ? <EmptyState icon="orders" tone="neutral" title="No purchases yet">Ran out of something in the middle of service? Press New purchase. You say what you need, and the owner approves it, or it is approved straight away if it is within your limit.</EmptyState>
          : <>
            <Panel title="In progress" count={active.length} sub="Each one says what to do next.">
              {active.length ? <ul className="rcv-cards">{active.map(card)}</ul> : <EmptyState icon="check" title="Nothing in progress">Everything you bought is done.</EmptyState>}
            </Panel>
            {past.length > 0 && <Panel title="Done" count={past.length}><ul className="rcv-cards">{past.map(card)}</ul></Panel>}
          </>}
    {open !== undefined && <PurchaseSheet key={open || 'new'} id={open} onClose={() => setOpen(undefined)} onChanged={list.refresh} />}
  </div>;
}

export default BranchPurchasesPage;
