// Owner "Requests & transfers" (/owner/inventory/requests): what the branches asked the Warehouse for, what is ready to send, what is on
// the way and what has arrived (with anything that went missing waiting for a decision). Tabs: Waiting for review, To send, On the way, Done.
// The steps: Review (approve all, some or none: the stock is held) -> Prepare (a pick list) -> Send (a delivery note with a QR code) -> the
// branch receives it. Anything the server refuses comes back in plain words.
import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Segmented } from '../../components/owner/ui';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { formatDay, formatStamp, purchasing, resolutionChoices, bearerChoices, useInventoryWrite } from '../../lib/inventory';
import { AmountInput, DeliveryNote, PickList, ReceiveForm, RequestChip, TransferChip, amountFor, byId, linesText, openDiscrepancies, optionsFor, toBase, unitLabel } from './DistributionParts';
import { EmptyState, ErrorState, FormError, OIcon, OwnerFrame, Panel, SkeletonRows, TaskDrawer } from './parts';
import { ItemPicker, Note } from './PurchasingParts';
import { Choice, Facts, PhotoField } from './ReceivingParts';
import './receiving.css';
import './distribution.css';

const OPEN_DELIVERY = ['in_transit', 'partially_received', 'pending_approval'];
const SEND_STATUSES = 'approved,partially_approved,preparing,dispatched,partially_received';
const base4 = (n) => String(Math.round(n * 10000) / 10000);

/** A short "are you sure" under a card (the same look as the other inventory confirmations). */
function Confirm({ message, yes, no = 'Not now', busy, onYes, onNo, error }) {
  return <div className="inv-confirm" role="group" aria-label="Please confirm" style={{ width: '100%' }}>
    <span>{message}</span><FormError error={error} />
    <div className="inv-confirm-actions">
      <button type="button" className="o-btn is-primary" disabled={busy} onClick={onYes}>{busy ? 'Working…' : yes}</button>
      <button type="button" className="o-btn is-quiet" disabled={busy} onClick={onNo}>{no}</button>
    </div>
  </div>;
}

/* ---------- review a request ---------- */

function ReviewSheet({ ctx, request, onClose, onDone }) {
  const { notify } = useNotifications();
  const items = useMemo(() => byId(ctx.data.items), [ctx.data.items]);
  const units = ctx.data.units;
  const [lines, setLines] = useState(() => Object.fromEntries(request.lines.map((l) => {
    const available = l.warehouse ? Number(l.warehouse.available) : Number(l.requested);
    const limited = available < Number(l.requested);
    return [l.itemId, amountFor(String(Math.max(0, limited ? available : Number(l.requested))), items.get(l.itemId), units, l.unit, { floor: limited })];
  })));
  const [note, setNote] = useState('');
  const [mode, setMode] = useState('approve'); // approve | reject
  const [problem, setProblem] = useState('');
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const optionsOf = (l) => optionsFor(items.get(l.itemId), units, l.unit);
  const approvedBase = (l) => toBase(lines[l.itemId], optionsOf(l));
  const less = request.lines.some((l) => approvedBase(l) + 0.00005 < Number(l.requested));

  async function submit(decision) {
    clearError();
    if (decision === 'reject') {
      if (!note.trim()) return setProblem('Say why you are saying no, so the branch knows what to do.');
      setProblem('');
      const done = await run('POST', ctx.paths.requestAction(request.id, 'review'), { decision: 'reject', note: note.trim() }, { step: 'reject' });
      if (done) { notify(`${request.ref} was turned down. The branch can see why.`); onDone(); onClose(); }
      return undefined;
    }
    const over = request.lines.find((l) => approvedBase(l) > Number(l.requested) + 0.00005);
    if (over) return setProblem(`You can’t approve more than ${over.name} asked for (${over.requestedDisplay}). Send extra as a separate delivery.`);
    if (!request.lines.some((l) => approvedBase(l) > 0.00005)) return setProblem('Approve at least one item, or say no to the whole request.');
    if (less && !note.trim()) return setProblem('You are approving less than they asked for. Tell the branch why, so they can plan.');
    setProblem('');
    const body = { decision: 'approve', ...(note.trim() ? { note: note.trim() } : {}),
      lines: request.lines.map((l) => ({ itemId: l.itemId, approved: String(Number(lines[l.itemId].qty) || 0), unit: lines[l.itemId].unit })) };
    const done = await run('POST', ctx.paths.requestAction(request.id, 'review'), body, { step: 'approve' });
    if (done) { notify(`${request.ref} is approved. The stock is held for ${request.branchName}.`); onDone(); onClose(); }
    return undefined;
  }

  return <div className="inv-form inv-record">
    <p className="o-field-hint"><strong>{request.branchName}</strong> asked{request.requestedByName ? ` (${request.requestedByName})` : ''}{request.neededBy ? ` · needed by ${formatDay(request.neededBy)}` : ''}.
      {request.note ? ` They said: “${request.note}”` : ''} Approving holds the stock for them until it is sent.</p>
    <ul className="rcv-lines" aria-label="What was asked for">{request.lines.map((l) => {
      const options = optionsOf(l);
      const available = l.warehouse ? Number(l.warehouse.available) : null;
      const short = available !== null && available < Number(l.requested);
      return <li key={l.itemId} className="rcv-line">
        <div className="rcv-line-head"><strong>{l.name}</strong><small>Asked for {l.requestedDisplay}</small></div>
        <p className={`dist-avail${short ? ' is-short' : ''}`}>{l.warehouse ? `The Warehouse has ${l.warehouse.availableDisplay} free.` : 'How much the Warehouse has is not known.'}</p>
        {short && <p className="inv-warn" role="status">There is not enough {l.name} in the Warehouse for all of this. It is filled in with what is there ({l.warehouse.availableDisplay}); you can approve less.</p>}
        {mode === 'approve' && <div className="o-field"><span className="o-label">How much do you approve?</span>
          <AmountInput id={`rv-${l.itemId}`} label={`${l.name} approved`} amount={lines[l.itemId]} options={options} onChange={(next) => setLines((current) => ({ ...current, [l.itemId]: next }))} />
          {approvedBase(l) + 0.00005 < Number(l.requested) && <p className="o-field-hint">{approvedBase(l) < 0.00005 ? `None of ${l.name} will be sent.` : `Less than the ${l.requestedDisplay} they asked for.`}</p>}</div>}
      </li>;
    })}</ul>
    <div className="o-field"><label className="o-label" htmlFor="rv-note">{mode === 'reject' ? 'Why are you saying no?' : 'Message for the branch'} {mode === 'approve' && !less ? <span className="o-optional">Optional</span> : <span className="o-optional">Needed</span>}</label>
      <input id="rv-note" className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)}
        placeholder={mode === 'reject' ? 'For example: you asked for this on Monday' : 'For example: only half the chicken is in until Friday'} /></div>
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      {mode === 'approve' ? <>
        <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => submit('approve')}>{busy ? 'Approving…' : 'Approve and hold the stock'}</button>
        <button type="button" className="o-btn" disabled={busy} onClick={() => { setMode('reject'); setNote(''); setProblem(''); clearError(); }}>Say no to this request</button>
      </> : <>
        <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => submit('reject')}>{busy ? 'Sending…' : 'Turn the request down'}</button>
        <button type="button" className="o-btn is-quiet" disabled={busy} onClick={() => { setMode('approve'); setNote(''); setProblem(''); clearError(); }}>Back</button>
      </>}
    </div>
  </div>;
}

/* ---------- send: what goes out now ---------- */

function SendLines({ rows, setRows, ctx, branchName }) {
  const items = useMemo(() => byId(ctx.data.items), [ctx.data.items]);
  return <ul className="rcv-lines" aria-label="What to send">{rows.map((row) => {
    const options = optionsFor(items.get(row.itemId), ctx.data.units, row.unit);
    const left = row.remaining !== undefined ? Number(row.remaining) : null;
    const sending = toBase(row.amount, options);
    return <li key={row.itemId} className="rcv-line">
      <div className="rcv-line-head"><strong>{row.name}</strong>{row.remainingDisplay && <small>Still to send {row.remainingDisplay}</small>}</div>
      <div className="o-field"><span className="o-label">How much are you sending now?</span>
        <AmountInput id={`sd-${row.itemId}`} label={`${row.name} to send`} amount={row.amount} options={options}
          onChange={(amount) => setRows((current) => current.map((r) => (r.itemId === row.itemId ? { ...r, amount } : r)))} />
        {left !== null && sending > 0 && sending + 0.00005 < left && <p className="o-field-hint">The rest stays held for {branchName} and can be sent later.</p>}
        {row.remaining === undefined && <button type="button" className="o-btn is-quiet is-small" onClick={() => setRows((current) => current.filter((r) => r.itemId !== row.itemId))}>Remove {row.name}</button>}</div>
    </li>;
  })}</ul>;
}

function DeliveryFields({ values, setValues, id }) {
  return <>
    <div className="rcv-line-grid">
      <div className="o-field"><label className="o-label" htmlFor={`${id}-driver`}>Driver <span className="o-optional">Optional</span></label>
        <input id={`${id}-driver`} className="o-input" value={values.driver} maxLength={80} onChange={(event) => setValues({ ...values, driver: event.target.value })} /></div>
      <div className="o-field"><label className="o-label" htmlFor={`${id}-vehicle`}>Vehicle <span className="o-optional">Optional</span></label>
        <input id={`${id}-vehicle`} className="o-input" value={values.vehicle} maxLength={40} placeholder="For example: KDA 123A" onChange={(event) => setValues({ ...values, vehicle: event.target.value })} /></div>
    </div>
    <div className="o-field"><label className="o-label" htmlFor={`${id}-note`}>Note for the branch <span className="o-optional">Optional</span></label>
      <input id={`${id}-note`} className="o-input" value={values.note} maxLength={280} onChange={(event) => setValues({ ...values, note: event.target.value })} /></div>
  </>;
}

function DispatchSheet({ ctx, request, onClose, onDone }) {
  const id = useId();
  const { notify } = useNotifications();
  const items = useMemo(() => byId(ctx.data.items), [ctx.data.items]);
  const [rows, setRows] = useState(() => request.lines.filter((l) => Number(l.remaining) > 0).map((l) => {
    const options = optionsFor(items.get(l.itemId), ctx.data.units, l.unit);
    const amount = amountFor(l.remaining, items.get(l.itemId), ctx.data.units, l.unit);
    return { itemId: l.itemId, name: l.name, unit: l.unit, remaining: l.remaining, remainingDisplay: `${amount.qty} ${unitLabel(options, amount.unit)}`, amount };
  }));
  const [values, setValues] = useState({ driver: '', vehicle: '', note: '' });
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();

  async function submit(event) {
    event.preventDefault();
    clearError();
    const picked = rows.filter((r) => Number(r.amount.qty) > 0);
    if (!picked.length) return setProblem('Enter how much you are sending. Put at least one item.');
    const over = picked.find((r) => toBase(r.amount, optionsFor(items.get(r.itemId), ctx.data.units, r.unit)) > Number(r.remaining) + 0.00005);
    if (over) return setProblem(`Only ${over.remainingDisplay} of ${over.name} is left to send on this request.`);
    setProblem('');
    const body = { lines: picked.map((r) => ({ itemId: r.itemId, quantity: String(Number(r.amount.qty)), unit: r.amount.unit })),
      ...(values.note.trim() ? { note: values.note.trim() } : {}), ...(values.driver.trim() ? { driver: values.driver.trim() } : {}), ...(values.vehicle.trim() ? { vehicle: values.vehicle.trim() } : {}) };
    const made = await run('POST', ctx.paths.requestAction(request.id, 'dispatch'), body, { step: 'dispatch' });
    if (!made) return undefined;
    setSent(made.transfer);
    notify(`${made.transfer.ref} is on its way to ${request.branchName}.`);
    onDone();
    return undefined;
  }

  if (sent) return <div className="inv-form">
    <Note tone="ok">{sent.ref} is on its way to {request.branchName}. Print the delivery note and give it to the driver: the branch scans the code to receive it.</Note>
    <DeliveryNote transfer={sent}><div className="biz-form-actions"><button type="button" className="o-btn is-quiet" onClick={onClose}>Done</button></div></DeliveryNote>
  </div>;

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">Sending to <strong>{request.branchName}</strong>. Everything still to send is filled in. Send less if that is all you have ready.</p>
    <SendLines rows={rows} setRows={setRows} ctx={ctx} branchName={request.branchName} />
    <DeliveryFields values={values} setValues={setValues} id={id} />
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending…' : 'Send the delivery'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function DirectSheet({ ctx, onClose, onDone }) {
  const id = useId();
  const { notify } = useNotifications();
  const branches = ctx.data.locations.filter((l) => l.kind === 'branch' && l.restaurantId);
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0].restaurantId : '');
  const [rows, setRows] = useState([]);
  const [values, setValues] = useState({ driver: '', vehicle: '', note: '' });
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(null);
  const [run, { busy, error }] = useInventoryWrite();
  const catalogue = ctx.data.items.filter((i) => !i.archived);
  const add = (item) => setRows((current) => [...current, { itemId: item.id, name: item.name, unit: item.baseUnit, amount: { ...amountFor('0', item, ctx.data.units, item.baseUnit), qty: '' } }]);

  async function submit(event) {
    event.preventDefault();
    const picked = rows.filter((r) => Number(r.amount.qty) > 0);
    if (!branchId) return setProblem('Choose which branch you are sending to.');
    if (!picked.length) return setProblem('Add what you are sending, and how much.');
    setProblem('');
    const made = await run('POST', ctx.paths.directDispatch, { branchId, lines: picked.map((r) => ({ itemId: r.itemId, quantity: String(Number(r.amount.qty)), unit: r.amount.unit })),
      ...(values.note.trim() ? { note: values.note.trim() } : {}), ...(values.driver.trim() ? { driver: values.driver.trim() } : {}), ...(values.vehicle.trim() ? { vehicle: values.vehicle.trim() } : {}) }, { step: 'direct' });
    if (!made) return undefined;
    setSent(made.transfer);
    notify(`${made.transfer.ref} is on its way.`);
    onDone();
    return undefined;
  }

  if (sent) return <div className="inv-form">
    <Note tone="ok">{sent.ref} is on its way to {sent.toName}. Print the delivery note for the driver.</Note>
    <DeliveryNote transfer={sent}><div className="biz-form-actions"><button type="button" className="o-btn is-quiet" onClick={onClose}>Done</button></div></DeliveryNote>
  </div>;

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">Send stock to a branch that did not ask for it. It comes out of the Warehouse stock that is not held for approved requests.</p>
    <div className="o-field"><label className="o-label" htmlFor={`${id}-branch`}>Which branch?</label>
      <select id={`${id}-branch`} className="o-select" value={branchId} onChange={(event) => setBranchId(event.target.value)} data-autofocus>
        <option value="">Choose a branch…</option>{branches.map((b) => <option key={b.id} value={b.restaurantId}>{b.name}</option>)}</select></div>
    <ItemPicker items={catalogue} exclude={rows.map((r) => r.itemId)} onPick={add} label="What are you sending?" />
    {rows.length > 0 && <SendLines rows={rows} setRows={setRows} ctx={ctx} branchName="the branch" />}
    <DeliveryFields values={values} setValues={setValues} id={id} />
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending…' : 'Send the delivery'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- decide what happened to goods that went missing ---------- */

function Decision({ ctx, transfer, d, onDone }) {
  const id = useId();
  const { notify } = useNotifications();
  const items = useMemo(() => byId(ctx.data.items), [ctx.data.items]);
  const choices = resolutionChoices(d.kind, transfer.fromName, transfer.toName);
  const [resolution, setResolution] = useState(choices[0]?.value || '');
  const [bearer, setBearer] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);
  const options = optionsFor(items.get(d.itemId), ctx.data.units, d.unit || 'unit');
  const [part, setPart] = useState({ qty: '', unit: amountFor('0', items.get(d.itemId), ctx.data.units, d.unit).unit });
  const [problem, setProblem] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  const needsBearer = resolution === 'write_off' && d.kind !== 'over';
  const canPart = d.kind === 'short' && ['arrived_later', 'returned_to_source'].includes(resolution);
  const label = { short: 'Short', damaged: 'Damaged', over: 'Extra' }[d.kind];

  async function submit(event) {
    event.preventDefault();
    if (needsBearer && !bearer) return setProblem('Choose who pays for what was lost.');
    if (!note.trim()) return setProblem('Write a note saying what happened.');
    const partBase = canPart && Number(part.qty) > 0 ? toBase(part, options) : 0;
    if (partBase > Number(d.quantity) + 0.00005) return setProblem(`That is more than is missing (${d.display}).`);
    setProblem('');
    const body = { bearer: needsBearer ? bearer : 'source', resolution, note: note.trim(), ...(partBase > 0 && partBase + 0.00005 < Number(d.quantity) ? { quantity: base4(partBase) } : {}) };
    const done = await run('POST', ctx.paths.discrepancyResolve(d.id), body, { step: `resolve-${d.id}` });
    if (!done) return undefined;
    let photoNote = '';
    if (photo) { try { await purchasing.upload(ctx.business.id, { entityType: 'discrepancy', entityId: d.id, file: photo }); } catch (failure) { photoNote = ` The photo was not saved: ${failure.message}`; } }
    notify(`Settled.${photoNote}`);
    onDone();
    return undefined;
  }

  return <form className="dist-resolve" onSubmit={submit} noValidate aria-label={`Decide: ${label} ${d.name}`}>
    <strong>{label}: {d.display} of {d.name}</strong>
    {d.note && <small className="dist-sub">The branch wrote: “{d.note}”</small>}
    <Choice legend="What do you want to do?" options={choices} value={resolution} onChange={(value) => { setResolution(value); setProblem(''); }} />
    {needsBearer && <Choice legend="Who pays for it?" options={bearerChoices(transfer.fromName, transfer.toName)} value={bearer} onChange={setBearer} />}
    {canPart && <div className="o-field"><span className="o-label">How much turned up? <span className="o-optional">Leave empty if all of it</span></span>
      <AmountInput id={`${id}-part`} label={`${d.name} that turned up`} amount={part} options={options} onChange={setPart} /></div>}
    <div className="o-field"><label className="o-label" htmlFor={`${id}-note`}>What happened?</label>
      <input id={`${id}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} placeholder="For example: the driver confirmed two boxes fell off" /></div>
    <PhotoField id={`${id}-photo`} label="Photo as proof" file={photo} onChange={setPhoto} />
    <FormError error={problem || error} />
    <div className="biz-form-actions"><button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : 'Save this decision'}</button></div>
  </form>;
}

function DiscrepancyList({ ctx, transfer, onChanged }) {
  const open = openDiscrepancies(transfer);
  const settled = (transfer.discrepancies || []).filter((d) => d.status !== 'open');
  if (!open.length && !settled.length) return null;
  return <>
    {open.length > 0 && <>
      <h3 className="inv-section">Needs your decision</h3>
      {open.map((d) => <Decision key={d.id} ctx={ctx} transfer={transfer} d={d} onDone={onChanged} />)}</>}
    {settled.length > 0 && <>
      <h3 className="inv-section">Settled</h3>
      <ul className="pur-list">{settled.map((d) => <li key={d.id}><span className="pur-main"><strong>{d.name}: {d.display} {d.kind === 'over' ? 'extra' : d.kind}</strong>
        <small>{d.resolution ? d.resolution.replace(/_/g, ' ') : 'settled'}{d.bearer ? ` · ${{ carrier: 'carrier pays', source: `${transfer.fromName} absorbs it`, destination: `${transfer.toName} absorbs it` }[d.bearer] || d.bearer}` : ''}</small></span></li>)}</ul></>}
  </>;
}

/* ---------- one delivery ---------- */

function TransferSheet({ ctx, id, mode, onClose, onChanged }) {
  const detail = useApi(ctx.paths.dispatch(id), { ttl: 1000 });
  const { notify } = useNotifications();
  const [view, setView] = useState(mode);
  const [asking, setAsking] = useState(false);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const transfer = detail.data?.transfer;
  const items = useMemo(() => byId(ctx.data.items), [ctx.data.items]);
  const changed = () => { detail.refresh(); onChanged(); };
  const warehouse = ctx.data.warehouse?.id;
  const title = transfer ? (view === 'receive' ? `Receive ${transfer.ref}` : transfer.ref) : 'Delivery';

  async function cancel() {
    const done = await run('POST', ctx.paths.dispatchAction(id, 'cancel'), {}, { step: 'cancel' });
    if (done) { notify('The delivery was cancelled. The stock went back.'); onChanged(); onClose(); }
  }

  return <TaskDrawer open title={title} onClose={onClose} wide>
    {detail.error && !transfer ? <p className="o-field-error" role="alert">{detail.error.message || 'This delivery could not be loaded.'}</p>
      : !transfer ? <SkeletonRows rows={4} thumb={false} label="Loading the delivery" />
        : view === 'receive' ? <ReceiveForm transfer={transfer} items={items} units={ctx.data.units} path={ctx.paths.dispatchAction(id, 'receive')} place="the Warehouse" onClose={onClose} onDone={onChanged} />
          : <div className="inv-form">
            <p><TransferChip transfer={transfer} /></p>
            <Facts items={[['From', transfer.fromName], ['To', transfer.toName], ['Sent', transfer.dispatchedAt ? formatStamp(transfer.dispatchedAt) : null], ['Received', transfer.receivedAt ? formatStamp(transfer.receivedAt) : null],
              ['For request', transfer.requestRef], ['Note', transfer.note]]} />
            <ul className="rcv-lines" aria-label="What was sent">{transfer.lines.map((l) => <li key={l.itemId} className="rcv-line">
              <div className="rcv-line-head"><strong>{l.name}</strong><small>Sent {l.display}{transfer.status !== 'in_transit' && transfer.status !== 'pending_approval' ? ` · counted ${l.receivedDisplay}` : ''}</small></div></li>)}</ul>
            <DiscrepancyList ctx={ctx} transfer={transfer} onChanged={changed} />
            {transfer.deliveryNote && ['in_transit', 'partially_received'].includes(transfer.status) && <DeliveryNote transfer={transfer} />}
            <FormError error={error} />
            {asking && <Confirm message={`Take ${transfer.ref} back? The stock goes back to ${transfer.fromName}${transfer.requestRef ? ' and is held for the request again' : ''}.`} yes="Yes, cancel the delivery" busy={busy} error={null}
              onYes={cancel} onNo={() => { setAsking(false); clearError(); }} />}
            <div className="biz-form-actions">
              {transfer.status === 'in_transit' && transfer.toLocationId === warehouse && <button type="button" className="o-btn is-primary" onClick={() => setView('receive')}>Receive it</button>}
              {transfer.status === 'in_transit' && !asking && <button type="button" className="o-btn is-danger" onClick={() => setAsking(true)}>Cancel this delivery</button>}
              <button type="button" className="o-btn is-quiet" onClick={onClose}>Close</button>
            </div>
          </div>}
  </TaskDrawer>;
}

/* ---------- the four lists ---------- */

const summary = (r) => r.lines.map((l) => `${l.name} ${l.approvedDisplay && l.approved !== null ? `${l.approvedDisplay} of ${l.requestedDisplay}` : l.requestedDisplay}`).join(', ');

function Waiting({ list, onReview }) {
  const rows = list.data?.requests;
  return <Panel title="Waiting for review" count={rows ? rows.length : undefined} sub="Branches asking the Warehouse for stock. The urgent ones come first.">
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="requests" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading requests" />
        : !rows.length ? <EmptyState icon="success" title="No requests are waiting">When a branch asks the Warehouse for stock, it shows up here.</EmptyState>
          : <ul className="rcv-cards">{rows.map((r) => <li key={r.id} className="rcv-card">
            <div className="rcv-card-main"><strong>{r.ref} · {r.branchName}</strong>
              <small>{r.requestedByName ? `Asked by ${r.requestedByName} · ` : ''}{formatStamp(r.createdAt)}{r.neededBy ? ` · needed by ${formatDay(r.neededBy)}` : ''}</small>
              <small>{r.lines.map((l) => `${l.name} ${l.requestedDisplay}`).join(', ')}</small>
              {r.note && <small>“{r.note}”</small>}
              {r.lines.some((l) => l.short) && <small className="dist-attention">Not enough in the Warehouse for all of it.</small>}</div>
            <div className="rcv-card-side">{r.priority === 'urgent' && <span className="inv-badge is-out">Urgent</span>}
              <button type="button" className="o-btn is-primary" aria-label={`Review ${r.ref}`} onClick={() => onReview(r)}>Review</button></div>
          </li>)}</ul>}
  </Panel>;
}

function ToSend({ ctx, list, onPrepare, onSend, onChanged }) {
  const [asking, setAsking] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const rows = list.data?.requests.filter((r) => r.hasRemainder && !(r.transfers || []).some((t) => OPEN_DELIVERY.includes(t.status)));
  const { notify } = useNotifications();
  async function cancel(r) {
    const done = await run('POST', ctx.paths.requestAction(r.id, 'cancel'), { reason: 'Cancelled by the owner' }, { step: `cancel-${r.id}` });
    if (done) { notify(`${r.ref} was cancelled. The held stock is free again.`); setAsking(null); onChanged(); }
  }
  return <Panel title="To send" count={rows ? rows.length : undefined} sub="Approved requests. Prepare the pick list, then send. Sending less than approved is fine: the rest stays held.">
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="requests" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading requests" />
        : !rows.length ? <EmptyState icon="check" title="Nothing waiting to be sent">Approve a request and it appears here.</EmptyState>
          : <ul className="rcv-cards">{rows.map((r) => <li key={r.id} className="rcv-card" style={asking === r.id ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
            <div className="rcv-card-main"><strong>{r.ref} · {r.branchName}</strong><small>{summary(r)}</small>
              {r.needsAttention && <small className="dist-attention">Needs attention: the Warehouse no longer has all of the held stock.</small>}
              {r.reviewNote && <small>You wrote: “{r.reviewNote}”</small>}</div>
            <div className="rcv-card-side"><RequestChip status={r.status} />
              <button type="button" className="o-btn" aria-label={`${r.status === 'preparing' ? 'Pick list for' : 'Prepare'} ${r.ref}`} onClick={() => onPrepare(r)}>{r.status === 'preparing' ? 'Pick list' : 'Prepare'}</button>
              <button type="button" className="o-btn is-primary" aria-label={`Send ${r.ref}`} onClick={() => onSend(r)}>Send</button>
              <button type="button" className="o-btn is-quiet" aria-label={`Cancel ${r.ref}`} onClick={() => { clearError(); setAsking(r.id); }}>Cancel</button></div>
            {asking === r.id && <Confirm message={`Cancel ${r.ref}? ${r.branchName} is told, and the stock held for it is free again.`} yes="Yes, cancel it" busy={busy} error={error} onYes={() => cancel(r)} onNo={() => setAsking(null)} />}
          </li>)}</ul>}
  </Panel>;
}

function OnTheWay({ ctx, list, onOpen, onReceive, onChanged }) {
  const [asking, setAsking] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const { notify } = useNotifications();
  const rows = list.data?.transfers;
  const warehouse = ctx.data.warehouse?.id;
  async function cancel(t) {
    const done = await run('POST', ctx.paths.dispatchAction(t.id, 'cancel'), {}, { step: `cancel-${t.id}` });
    if (done) { notify(`${t.ref} was cancelled. The stock went back.`); setAsking(null); onChanged(); }
  }
  async function sendFor(t) {
    const done = await run('POST', ctx.paths.dispatchAction(t.id, 'send'), {}, { step: `send-${t.id}` });
    if (done) { notify(`${t.ref} is on its way.`); onChanged(); }
  }
  return <Panel title="On the way" count={rows ? rows.length : undefined} sub="Deliveries that have left and are not counted yet, and transfers waiting to be sent.">
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="deliveries" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading deliveries" />
        : !rows.length ? <EmptyState icon="services" tone="neutral" title="Nothing is on the way">Deliveries you send show up here until the branch counts them.</EmptyState>
          : <ul className="rcv-cards">{rows.map((t) => {
            const going = ['in_transit', 'partially_received'].includes(t.status);
            return <li key={t.id} className="rcv-card" style={asking === t.id ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
              <div className="rcv-card-main"><strong>{t.ref} · {t.fromName} to {t.toName}</strong><small>{linesText(t.lines)}</small>
                <small>{t.dispatchedAt ? `Sent ${formatStamp(t.dispatchedAt)}` : 'Not sent yet'}{t.code ? ` · Code ${t.code}` : ''}</small>
                {t.status === 'pending_approval' && !t.approvedAt && <small>Waiting for your decision in <Link className="inv-link" to="/owner/inventory/approvals">Approvals</Link>.</small>}
                {t.awaitingDispatch && <small>Approved. {t.fromName} sends it.</small>}</div>
              <div className="rcv-card-side"><TransferChip transfer={t} />
                {going && <button type="button" className="o-btn" aria-label={`Delivery note ${t.ref}`} onClick={() => onOpen(t)}>Delivery note</button>}
                {going && t.toLocationId === warehouse && t.status === 'in_transit' && <button type="button" className="o-btn is-primary" aria-label={`Receive ${t.ref}`} onClick={() => onReceive(t)}>Receive</button>}
                {t.status === 'in_transit' && <button type="button" className="o-btn is-quiet" aria-label={`Cancel ${t.ref}`} onClick={() => { clearError(); setAsking(t.id); }}>Cancel</button>}
                {t.awaitingDispatch && <button type="button" className="o-btn" disabled={busy} onClick={() => sendFor(t)}>Send it for them</button>}</div>
              {asking === t.id && <Confirm message={`Take ${t.ref} back? The stock goes back to ${t.fromName}.`} yes="Yes, cancel the delivery" busy={busy} error={error} onYes={() => cancel(t)} onNo={() => setAsking(null)} />}
            </li>;
          })}</ul>}
  </Panel>;
}

function Done({ received, turnedDown, onOpen }) {
  const rows = received.data?.transfers;
  const refused = turnedDown.data?.requests || [];
  return <Panel title="Done" count={rows ? rows.length : undefined} sub="Deliveries that arrived. If something went missing or came damaged, decide what happens to it.">
    {received.error && !rows ? <ErrorState error={received.error} onRetry={received.refresh} what="deliveries" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading deliveries" />
        : !rows.length && !refused.length ? <EmptyState icon="order" tone="neutral" title="Nothing has arrived yet">Finished deliveries are listed here.</EmptyState>
          : <ul className="rcv-cards">{rows.map((t) => {
            const open = openDiscrepancies(t).length;
            return <li key={t.id} className="rcv-card">
              <div className="rcv-card-main"><strong>{t.ref} · {t.fromName} to {t.toName}</strong><small>{t.lines.map((l) => `${l.name} ${l.receivedDisplay}`).join(', ')}</small>
                <small>{t.receivedAt ? `Received ${formatStamp(t.receivedAt)}` : ''}{t.receivedByName ? ` by ${t.receivedByName}` : ''}</small></div>
              <div className="rcv-card-side">{open > 0 ? <span className="inv-badge is-low">{open} to decide</span> : (t.discrepancies || []).length ? <span className="inv-badge is-off">Settled</span> : <span className="inv-badge is-ok">All arrived</span>}
                <button type="button" className={`o-btn${open ? ' is-primary' : ''}`} aria-label={`${open ? 'Decide' : 'Open'} ${t.ref}`} onClick={() => onOpen(t)}>{open ? 'Decide' : 'Open'}</button></div>
            </li>;
          })}
            {refused.map((r) => <li key={r.id} className="rcv-card"><div className="rcv-card-main"><strong>{r.ref} · {r.branchName}</strong><small>{r.lines.map((l) => `${l.name} ${l.requestedDisplay}`).join(', ')}</small>{r.reviewNote && <small>“{r.reviewNote}”</small>}</div>
              <div className="rcv-card-side"><RequestChip status={r.status} /></div></li>)}</ul>}
  </Panel>;
}

/* ---------- the page ---------- */

function Body({ ctx }) {
  const [params, setParams] = useSearchParams();
  // Notification links: ?tab=problems (or done) opens Done, where the deliveries that need a decision are; ?receive=<id> opens a delivery to count.
  const [tab, setTab] = useState(() => ({ problems: 'done', done: 'done', send: 'send', way: 'way' }[params.get('tab')] || 'waiting'));
  const [task, setTask] = useState(null);
  const inbox = useApi(ctx.paths.requestsInbox, { ttl: 5000 });
  const toSend = useApi(ctx.paths.requests({ status: SEND_STATUSES, limit: 100 }), { ttl: 5000 });
  const active = useApi(ctx.paths.dispatches({ status: 'active' }), { ttl: 5000 });
  const received = useApi(ctx.paths.dispatches({ status: 'received' }), { ttl: 5000 });
  const turnedDown = useApi(ctx.paths.requests({ status: 'rejected', limit: 20 }), { ttl: 10000 });
  const [prepare, { busy: preparing, error: prepareError }] = useInventoryWrite();
  const refreshAll = () => { inbox.refresh(); toSend.refresh(); active.refresh(); received.refresh(); turnedDown.refresh(); };
  const waiting = inbox.data?.requests;
  const sendRows = toSend.data?.requests.filter((r) => r.hasRemainder && !(r.transfers || []).some((t) => OPEN_DELIVERY.includes(t.status)));
  const decisions = received.data ? received.data.transfers.reduce((n, t) => n + openDiscrepancies(t).length, 0) : null;
  const receiveId = params.get('receive');
  const close = () => { setTask(null); if (receiveId) { const next = new URLSearchParams(params); next.delete('receive'); setParams(next, { replace: true }); } };
  const shown = task || (receiveId ? { type: 'transfer', id: receiveId, mode: 'receive' } : null);

  async function startPrepare(request) {
    const list = await prepare('POST', ctx.paths.requestAction(request.id, 'prepare'), {}, { step: `prepare-${request.id}` });
    if (list) { toSend.refresh(); setTask({ type: 'pick', request, list }); }
  }

  return <>
    {waiting?.length > 0 && <p className="dist-banner" role="status">{waiting.length} {waiting.length === 1 ? 'request is' : 'requests are'} waiting for your decision.</p>}
    <FormError error={prepareError} />
    <Segmented mode="tabs" idBase="dist" label="Requests and transfers" value={tab} onChange={setTab}
      options={[{ value: 'waiting', label: 'Waiting for review', count: waiting ? waiting.length : null }, { value: 'send', label: 'To send', count: sendRows ? sendRows.length : null },
        { value: 'way', label: 'On the way', count: active.data ? active.data.transfers.length : null }, { value: 'done', label: 'Done', count: decisions || null }]} />
    <div role="tabpanel" id="dist-panel" aria-labelledby={`dist-tab-${tab}`} className="dist-tabpanel">
      {tab === 'waiting' && <Waiting list={inbox} onReview={(request) => setTask({ type: 'review', request })} />}
      {tab === 'send' && <ToSend ctx={ctx} list={toSend} onPrepare={startPrepare} onSend={(request) => setTask({ type: 'send', request })} onChanged={refreshAll} />}
      {tab === 'way' && <OnTheWay ctx={ctx} list={active} onOpen={(t) => setTask({ type: 'transfer', id: t.id, mode: 'note' })} onReceive={(t) => setTask({ type: 'transfer', id: t.id, mode: 'receive' })} onChanged={refreshAll} />}
      {tab === 'done' && <Done received={received} turnedDown={turnedDown} onOpen={(t) => setTask({ type: 'transfer', id: t.id, mode: 'done' })} />}
    </div>
    {preparing && <p className="o-field-hint" role="status">Getting the pick list ready…</p>}
    {shown?.type === 'review' && <TaskDrawer open title={`Review ${shown.request.ref}`} onClose={close} wide>
      <ReviewSheet ctx={ctx} request={shown.request} onClose={close} onDone={() => { refreshAll(); setTab('send'); }} /></TaskDrawer>}
    {shown?.type === 'pick' && <TaskDrawer open title={`Pick list for ${shown.request.ref}`} onClose={close} wide>
      <PickList list={shown.list} onBack={close} onSend={() => setTask({ type: 'send', request: shown.request })} /></TaskDrawer>}
    {shown?.type === 'send' && <TaskDrawer open title={`Send ${shown.request.ref}`} onClose={close} wide>
      <DispatchSheet ctx={ctx} request={shown.request} onClose={close} onDone={() => { refreshAll(); setTab('way'); }} /></TaskDrawer>}
    {shown?.type === 'transfer' && <TransferSheet ctx={ctx} id={shown.id} mode={shown.mode} onClose={close} onChanged={refreshAll} />}
    <p className="o-field-hint">Stock moving between two branches needs your approval first: look for it in <Link className="inv-link" to="/owner/inventory/approvals">Approvals</Link>.</p>
  </>;
}

function Actions({ onDirect }) {
  return <button type="button" className="o-btn is-secondary" onClick={onDirect}><OIcon name="plus" size={15} />Send stock without a request</button>;
}

export function OwnerRequestsPage({ section }) {
  const [direct, setDirect] = useState(0);
  return <OwnerFrame title={section?.label || 'Requests & transfers'} description={section?.description || 'What the branches asked the Warehouse for, what is on the way, and what arrived.'}
    actions={() => <Actions onDirect={() => setDirect((n) => n + 1)} />}>
    {(ctx) => <DirectHost ctx={ctx} signal={direct} />}
  </OwnerFrame>;
}

/** The "send without a request" sheet lives beside the page body so the header button can open it. */
function DirectHost({ ctx, signal }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(0);
  const [key, setKey] = useState(0);
  if (signal !== last) { setLast(signal); setOpen(true); }
  return <>
    <Body key={key} ctx={ctx} />
    {open && <TaskDrawer open title="Send stock without a request" onClose={() => setOpen(false)} wide>
      <DirectSheet ctx={ctx} onClose={() => setOpen(false)} onDone={() => setKey((n) => n + 1)} /></TaskDrawer>}
  </>;
}

export default OwnerRequestsPage;
