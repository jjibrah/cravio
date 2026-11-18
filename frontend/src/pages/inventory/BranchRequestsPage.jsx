// Branch "Requests & deliveries" (/branch/:id/inventory/requests): ask the Warehouse for stock, follow your requests, receive deliveries
// (scan the QR code on the delivery note or type its code), send stock back to the Warehouse and move stock to another branch.
// Every card says what happens next. Anything the server refuses comes back in plain words.
import { useEffect, useId, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { api, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { REQUEST_STATUS, branchPaths, formatDay, formatStamp, todayNairobi, useInventoryWrite, withCode } from '../../lib/inventory';
import { AmountInput, DeliveryNote, ReceiveForm, RequestChip, TransferChip, amountFor, byId, linesText, optionsFor, toBase, unitLabel } from './DistributionParts';
import { EmptyState, ErrorState, FormError, OIcon, Panel, SkeletonRows, TaskDrawer } from './parts';
import { ItemPicker, Note } from './PurchasingParts';
import './receiving.css';
import './distribution.css';

const lower = (text) => String(text || '').toLowerCase();
const say = (item, base) => { const a = amountFor(base, item, [], item?.baseUnit); return `${a.qty} ${unitLabel(optionsFor(item, [], item?.baseUnit), a.unit)}`; };

/** The line list shared by Ask, Return and Move: item, amount with its unit, and how much can leave if that matters. */
function Lines({ rows, setRows, items, showAvailable }) {
  return <ul className="rcv-lines" aria-label="Items">{rows.map((row) => {
    const item = items.get(row.itemId);
    const options = optionsFor(item, [], item?.baseUnit);
    const mine = Number(item?.available);
    return <li key={row.itemId} className="rcv-line">
      <div className="rcv-line-head"><strong>{row.name}</strong>
        <button type="button" className="o-btn is-quiet is-small" aria-label={`Remove ${row.name}`} onClick={() => setRows((current) => current.filter((r) => r.itemId !== row.itemId))}>Remove</button></div>
      {row.why && <small className="dist-sub">{row.why}</small>}
      <div className="o-field"><span className="o-label">How much?</span>
        <AmountInput id={`ln-${row.itemId}`} label={`${row.name} amount`} amount={row.amount} options={options} onChange={(amount) => setRows((current) => current.map((r) => (r.itemId === row.itemId ? { ...r, amount } : r)))} />
        {showAvailable && item && <p className="o-field-hint">You have {item.display.available} here that can leave{Number(item.heldForOrders) > 0 ? `; ${item.display.heldForOrders} is kept for open orders` : ''}.
          {toBase(row.amount, options) > mine + 0.00005 ? ' That is more than can leave.' : ''}</p>}</div>
    </li>;
  })}</ul>;
}

const toRow = (item, extra = {}) => ({ itemId: item.id, name: item.name, amount: { ...amountFor('0', item, [], item.baseUnit), qty: '' }, ...extra });
const lineBody = (rows) => rows.filter((r) => Number(r.amount.qty) > 0).map((r) => ({ itemId: r.itemId, quantity: String(Number(r.amount.qty)), unit: r.amount.unit }));

/** Stops a transfer that would take more than can leave, with the reason in plain words (stock kept for open orders cannot go). */
function heldProblem(rows, items) {
  for (const r of rows.filter((x) => Number(x.amount.qty) > 0)) {
    const item = items.get(r.itemId);
    if (!item) continue;
    if (toBase(r.amount, optionsFor(item, [], item.baseUnit)) > Number(item.available) + 0.00005) {
      return `Only ${item.display.available} of ${r.name} can leave here${Number(item.heldForOrders) > 0 ? ` (${item.display.heldForOrders} is kept for open orders)` : ''}. Send less.`;
    }
  }
  return '';
}

/* ---------- ask the Warehouse ---------- */

function AskSheet({ items, onClose, onChanged }) {
  const ids = useId();
  const { notify } = useNotifications();
  const suggestions = useApi(branchPaths.requestSuggestions, { ttl: 5000 });
  const [rows, setRows] = useState([]);
  const [seeded, setSeeded] = useState(false);
  const [note, setNote] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(null);
  const [run, { busy, error }] = useInventoryWrite();

  useEffect(() => {
    if (seeded || !suggestions.data) return;
    setSeeded(true);
    setRows((suggestions.data.suggestions || []).map((s) => {
      const item = items.get(s.itemId);
      const options = optionsFor(item, [], s.unit);
      const pack = s.pack ? options.find((o) => lower(o.value) === lower(s.pack.name)) : null;
      const amount = amountFor(s.suggested, item, [], s.unit, { unit: pack?.value });
      const usual = (base) => say(item, base);
      return { itemId: s.itemId, name: s.name, amount, why: `You keep ${usual(s.par)}; ${usual(s.available)} here${Number(s.incoming) > 0 ? `, ${usual(s.incoming)} on the way` : ''}.` };
    }));
  }, [suggestions.data, seeded, items]);

  const catalogue = [...items.values()].filter((i) => !i.archived);
  async function submit(event) {
    event.preventDefault();
    const lines = lineBody(rows);
    if (!lines.length) return setProblem('Say how much you need of at least one item.');
    setProblem('');
    const made = await run('POST', branchPaths.requests(), { lines, ...(note.trim() ? { note: note.trim() } : {}), ...(neededBy ? { neededBy } : {}), submit: true }, { step: 'ask' });
    if (!made) return undefined;
    setSent(made.request || made);
    notify('Your request was sent to the owner.');
    onChanged();
    return undefined;
  }

  if (sent) return <div className="inv-form" aria-live="polite">
    <Note tone="ok">Your request {sent.ref || ''} was sent to the owner. You will be told when they decide. Until then, nothing is held for you.</Note>
    <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
  </div>;

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">{suggestions.data?.suggestions?.length ? 'These amounts are filled in from what you usually keep and what you have now. Change anything, remove what you do not need, or add more.' : suggestions.data?.message || 'Add what you need from the Warehouse.'}</p>
    {suggestions.loading && !suggestions.data && <SkeletonRows rows={2} thumb={false} label="Working out what to ask for" />}
    {rows.length > 0 && <Lines rows={rows} setRows={setRows} items={items} />}
    <ItemPicker items={catalogue} exclude={rows.map((r) => r.itemId)} onPick={(item) => setRows((current) => [...current, toRow(item)])} label="Add something else" />
    <div className="rcv-line-grid">
      <div className="o-field"><label className="o-label" htmlFor={`${ids}-by`}>Needed by <span className="o-optional">Optional</span></label>
        <input id={`${ids}-by`} className="o-input" type="date" min={todayNairobi()} value={neededBy} onChange={(event) => setNeededBy(event.target.value)} /></div>
      <div className="o-field"><label className="o-label" htmlFor={`${ids}-note`}>Note for the owner <span className="o-optional">Optional</span></label>
        <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} placeholder="For example: big booking on Saturday" onChange={(event) => setNote(event.target.value)} /></div>
    </div>
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- return to the Warehouse / move to another branch ---------- */

function MoveSheet({ kind, items, branches, onClose, onChanged }) {
  const ids = useId();
  const { notify } = useNotifications();
  const returning = kind === 'return';
  const [rows, setRows] = useState([]);
  const [toBranch, setToBranch] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(null);
  const [run, { busy, error }] = useInventoryWrite();
  const catalogue = [...items.values()].filter((i) => !i.archived && Number(i.available) > 0);

  async function submit(event) {
    event.preventDefault();
    const lines = lineBody(rows);
    if (!returning && !toBranch) return setProblem('Choose which branch the stock goes to.');
    if (!lines.length) return setProblem('Add what you are sending, and how much.');
    if (returning && !reason.trim()) return setProblem('Say why the stock is going back (for example: too much, close to expiry).');
    const held = heldProblem(rows, items);
    if (held) return setProblem(held);
    setProblem('');
    const body = returning ? { lines, reason: reason.trim(), ...(note.trim() ? { note: note.trim() } : {}) } : { toBranchId: toBranch, lines, ...(note.trim() ? { note: note.trim() } : {}) };
    const made = await run('POST', returning ? branchPaths.returns : branchPaths.branchTransfers, body, { step: kind });
    if (!made) return undefined;
    setDone(made);
    notify(returning && !made.pendingApproval ? 'The return is on its way to the Warehouse.' : 'Sent to the owner for approval.');
    onChanged();
    return undefined;
  }

  if (done) {
    const waiting = done.pendingApproval || done.transfer?.status === 'pending_approval';
    return <div className="inv-form" aria-live="polite">
      {waiting ? <Note tone="ok">{done.transfer?.ref} is waiting for the owner to approve it. Do not send anything yet: you can send it here once it is approved.</Note>
        : <Note tone="ok">{done.transfer?.ref} is on its way to the Warehouse. Give the delivery note to whoever carries it.</Note>}
      {!waiting && done.transfer && <DeliveryNote transfer={done.transfer} />}
      <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
    </div>;
  }

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">{returning ? 'Send stock you do not need back to the Warehouse. It leaves your count now. Stock kept for open orders cannot go.'
      : 'Move stock to another branch. The owner has to approve it before anything is sent. Stock kept for open orders cannot go.'}</p>
    {!returning && <div className="o-field"><label className="o-label" htmlFor={`${ids}-to`}>Which branch gets it?</label>
      <select id={`${ids}-to`} className="o-select" value={toBranch} onChange={(event) => setToBranch(event.target.value)} data-autofocus>
        <option value="">Choose a branch…</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      {!branches.length && <p className="o-field-hint">No other branches were found for this business.</p>}</div>}
    <ItemPicker items={catalogue} exclude={rows.map((r) => r.itemId)} onPick={(item) => setRows((current) => [...current, toRow(item)])} label="What are you sending?"
      hint={(item) => `${item.display.available} can leave`} />
    {rows.length > 0 && <Lines rows={rows} setRows={setRows} items={items} showAvailable />}
    {returning && <div className="o-field"><label className="o-label" htmlFor={`${ids}-why`}>Why is it going back?</label>
      <input id={`${ids}-why`} className="o-input" value={reason} maxLength={200} placeholder="For example: ordered too much" onChange={(event) => setReason(event.target.value)} /></div>}
    <div className="o-field"><label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">Optional</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} /></div>
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Sending…' : returning ? 'Send back to the Warehouse' : 'Ask the owner to approve'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- one delivery: receive it, or show its note ---------- */

function DeliverySheet({ id, mode, items, onClose, onChanged }) {
  const detail = useApi(branchPaths.transfer(id), { ttl: 1000 });
  const transfer = detail.data?.transfer;
  return <TaskDrawer open title={transfer ? (mode === 'receive' ? `Receive ${transfer.ref}` : transfer.ref) : 'Delivery'} onClose={onClose} wide>
    {detail.error && !transfer ? <p className="o-field-error" role="alert">{detail.error.message || 'This delivery could not be loaded.'}</p>
      : !transfer ? <SkeletonRows rows={4} thumb={false} label="Loading the delivery" />
        : mode === 'receive' ? (transfer.status === 'in_transit' || transfer.status === 'partially_received'
          ? <ReceiveForm transfer={transfer} items={items} units={[]} path={branchPaths.transferAction(id, 'receive')} onClose={onClose} onDone={onChanged} />
          : <Note>{transfer.ref} is {transfer.status === 'received' ? 'already received' : transfer.status === 'pending_approval' ? 'not sent yet' : transfer.status.replace(/_/g, ' ')}, so there is nothing to count.</Note>)
          : <DeliveryNote transfer={transfer}><div className="biz-form-actions"><button type="button" className="o-btn is-quiet" onClick={onClose}>Close</button></div></DeliveryNote>}
  </TaskDrawer>;
}

/* ---------- the page ---------- */

function CodeBox({ onFound }) {
  const id = useId();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  async function find(event) {
    event.preventDefault();
    const clean = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!clean) return setProblem('Type the code from the delivery note.');
    setProblem(''); setBusy(true);
    try {
      const found = await api(branchPaths.receiveCode(clean));
      onFound(found.transfer.id);
    } catch (error) { setProblem(withCode(error).message); } finally { setBusy(false); }
    return undefined;
  }
  return <form className="inv-toolbar" onSubmit={find} noValidate style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
    <label className="o-label" htmlFor={id} style={{ flex: '1 1 100%' }}>Have a code from a delivery note? Type it here, or scan its QR code with your phone camera.</label>
    <input id={id} className="o-input inv-search" value={code} maxLength={20} autoComplete="off" placeholder="For example: K7M2QXPR4T" onChange={(event) => setCode(event.target.value)} />
    <button type="submit" className="o-btn" disabled={busy}>{busy ? 'Looking…' : 'Find the delivery'}</button>
    {problem && <p className="o-field-error" role="alert" style={{ flex: '1 1 100%', margin: 0 }}><OIcon name="alert" size={14} />{problem}</p>}
  </form>;
}

function Deliveries({ list, here, onReceive, onNote, onFound, onChanged }) {
  const { notify } = useNotifications();
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const [failed, setFailed] = useState(null);
  const rows = list.data?.transfers;
  async function act(t, action, message) {
    clearError(); setFailed(null);
    const done = await run('POST', branchPaths.transferAction(t.id, action), {}, { step: `${action}-${t.id}` });
    if (done) { notify(message); onChanged(); } else setFailed(t.id);
  }
  return <Panel title="Deliveries" count={rows ? rows.length : undefined} sub="What is on its way to you, what you are sending, and what is waiting for the owner.">
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="deliveries" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading deliveries" />
        : !rows.length ? <EmptyState icon="services" tone="neutral" title="Nothing is on the way">When the Warehouse sends you stock, it appears here with a code. Press Receive when it arrives.</EmptyState>
          : <ul className="rcv-cards">{rows.map((t) => {
            const incoming = t.toLocationId === here;
            const going = ['in_transit', 'partially_received'].includes(t.status);
            return <li key={t.id} className="rcv-card" style={failed === t.id && error ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
              <div className="rcv-card-main"><strong>{t.ref} · {incoming ? `From ${t.fromName}` : `To ${t.toName}`}</strong><small>{linesText(t.lines)}</small>
                <small>{t.dispatchedAt && !t.awaitingApproval && !t.awaitingDispatch ? `Sent ${formatStamp(t.dispatchedAt)}` : ''}{t.code ? ` · Code ${t.code}` : ''}</small>
                <p className="rcv-card-next">{t.awaitingApproval ? 'Waiting for the owner to approve. Nothing is sent until then.'
                  : t.awaitingDispatch ? (incoming ? `The owner approved it. ${t.fromName} will send it.` : 'The owner approved it. Press Send when the goods leave.')
                    : going ? (incoming ? 'On its way. Count it when it arrives.' : 'On its way to them.') : ''}</p></div>
              <div className="rcv-card-side"><TransferChip transfer={t} />
                {incoming && going && <button type="button" className="o-btn is-primary" aria-label={`Receive ${t.ref}`} onClick={() => onReceive(t)}>Receive</button>}
                {!incoming && going && <button type="button" className="o-btn" aria-label={`Delivery note ${t.ref}`} onClick={() => onNote(t)}>Delivery note</button>}
                {!incoming && t.awaitingDispatch && <button type="button" className="o-btn is-primary" disabled={busy} aria-label={`Send ${t.ref}`} onClick={() => act(t, 'dispatch', `${t.ref} is on its way.`)}>Send</button>}
                {t.status === 'pending_approval' && <button type="button" className="o-btn is-quiet" disabled={busy} aria-label={`Withdraw ${t.ref}`} onClick={() => act(t, 'cancel', `${t.ref} was withdrawn.`)}>Withdraw</button>}</div>
              {failed === t.id && <FormError error={error} />}
            </li>;
          })}</ul>}
    <CodeBox onFound={onFound} />
  </Panel>;
}

const requestLine = (l) => (l.approved !== null && l.approved !== undefined ? `${l.name}: ${l.approvedDisplay} of ${l.requestedDisplay} approved` : `${l.name}: ${l.requestedDisplay}`);

function Requests({ list, onChanged }) {
  const { notify } = useNotifications();
  const [asking, setAsking] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const rows = list.data?.requests;
  async function act(r, action, message) {
    const done = await run('POST', branchPaths.requestAction(r.id, action), action === 'cancel' ? { reason: 'Cancelled by the branch' } : {}, { step: `${action}-${r.id}` });
    if (done) { notify(message); setAsking(null); onChanged(); }
  }
  return <Panel title="My requests" count={rows ? rows.length : undefined} sub="What you asked the Warehouse for, and what happens next.">
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="requests" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading requests" />
        : !rows.length ? <EmptyState icon="order" tone="neutral" title="No requests yet">Running low? Press “Ask the Warehouse”. The amounts are filled in for you.</EmptyState>
          : <ul className="rcv-cards">{rows.map((r) => <li key={r.id} className="rcv-card" style={asking === r.id ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
            <div className="rcv-card-main"><strong>{r.ref}</strong>
              {r.lines.map((l) => <small key={l.itemId}>{requestLine(l)}</small>)}
              <small>{formatStamp(r.createdAt)}{r.neededBy ? ` · needed by ${formatDay(r.neededBy)}` : ''}</small>
              <p className="rcv-card-next">{REQUEST_STATUS[r.status]?.next}</p>
              {r.reviewNote && ['rejected', 'partially_approved', 'approved', 'cancelled'].includes(r.status) && <small>The owner said: “{r.reviewNote}”</small>}</div>
            <div className="rcv-card-side"><RequestChip status={r.status} />
              {r.status === 'draft' && <button type="button" className="o-btn is-primary" disabled={busy} aria-label={`Send ${r.ref}`} onClick={() => act(r, 'submit', `${r.ref} was sent to the owner.`)}>Send</button>}
              {['draft', 'submitted'].includes(r.status) && <button type="button" className="o-btn is-quiet" aria-label={`Cancel ${r.ref}`} onClick={() => { clearError(); setAsking(r.id); }}>Cancel</button>}</div>
            {asking === r.id && <div className="inv-confirm" role="group" aria-label="Please confirm" style={{ width: '100%' }}>
              <span>Cancel {r.ref}? The owner will not see it any more.</span><FormError error={error} />
              <div className="inv-confirm-actions"><button type="button" className="o-btn is-primary" disabled={busy} onClick={() => act(r, 'cancel', `${r.ref} was cancelled.`)}>{busy ? 'Working…' : 'Yes, cancel it'}</button>
                <button type="button" className="o-btn is-quiet" disabled={busy} onClick={() => setAsking(null)}>Not now</button></div></div>}
          </li>)}</ul>}
  </Panel>;
}

export function BranchRequestsPage({ section }) {
  const { branchId } = useParams();
  const { account } = useAuth() || {};
  const [params, setParams] = useSearchParams();
  const snapshot = useApi(branchPaths.snapshot({ all: true }), { ttl: 10000 });
  const requests = useApi(branchPaths.requests({ limit: 50 }), { ttl: 5000 });
  const transfers = useApi(branchPaths.transfers({ status: 'active' }), { ttl: 5000 });
  const siblings = useApi(branchPaths.siblings, { ttl: 60000 });
  const [sheet, setSheet] = useState(null); // { type: 'ask' | 'return' | 'move' } | { type: 'delivery', id, mode }
  const items = useMemo(() => byId(snapshot.data?.items), [snapshot.data]);
  const here = snapshot.data?.location?.id;
  const others = (siblings.data?.branches || (account?.branches || [])).filter((b) => b.id !== branchId);
  const linked = params.get('receive');
  const refresh = () => { requests.refresh(); transfers.refresh(); snapshot.refresh(); };
  const close = () => { setSheet(null); if (linked) { const next = new URLSearchParams(params); next.delete('receive'); setParams(next, { replace: true }); } };
  const shown = sheet || (linked ? { type: 'delivery', id: linked, mode: 'receive' } : null);
  const ready = Boolean(snapshot.data);

  return <div className="biz-stack inv-page">
    <PageHeader title={section?.label || 'Requests & deliveries'} description={section?.description || 'Ask the Warehouse for stock, receive deliveries and send stock back or on to another branch.'}>
      <button type="button" className="o-btn is-primary" disabled={!ready} onClick={() => setSheet({ type: 'ask' })}><OIcon name="plus" size={15} />Ask the Warehouse</button>
      <button type="button" className="o-btn is-secondary" disabled={!ready} onClick={() => setSheet({ type: 'return' })}>Return to the Warehouse</button>
      <button type="button" className="o-btn is-secondary" disabled={!ready} onClick={() => setSheet({ type: 'move' })}>Send to another branch</button>
    </PageHeader>
    {snapshot.error && !snapshot.data ? <ErrorState error={snapshot.error} onRetry={snapshot.refresh} what="stock" /> : <>
      <Deliveries list={transfers} here={here} onReceive={(t) => setSheet({ type: 'delivery', id: t.id, mode: 'receive' })} onNote={(t) => setSheet({ type: 'delivery', id: t.id, mode: 'note' })}
        onFound={(id) => setSheet({ type: 'delivery', id, mode: 'receive' })} onChanged={refresh} />
      <Requests list={requests} onChanged={refresh} />
    </>}
    {shown?.type === 'ask' && <TaskDrawer open title="Ask the Warehouse" onClose={close} wide><AskSheet items={items} onClose={close} onChanged={refresh} /></TaskDrawer>}
    {shown?.type === 'return' && <TaskDrawer open title="Return to the Warehouse" onClose={close} wide><MoveSheet kind="return" items={items} branches={[]} onClose={close} onChanged={refresh} /></TaskDrawer>}
    {shown?.type === 'move' && <TaskDrawer open title="Send to another branch" onClose={close} wide><MoveSheet kind="move" items={items} branches={others} onClose={close} onChanged={refresh} /></TaskDrawer>}
    {shown?.type === 'delivery' && <DeliverySheet id={shown.id} mode={shown.mode} items={items} onClose={close} onChanged={refresh} />}
  </div>;
}

export default BranchRequestsPage;
