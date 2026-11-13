import { useCallback, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sheet from '../Sheet';
import Glyph from '../media/Glyph';
import { formatPrice } from '../../lib/format';
import CodeScanner, { cleanCode } from './CodeScanner';
import { ageText, useLive } from './LiveProvider';

export const REQUEST_LOOK = {
  call_waiter: { title: 'Call waiter', icon: 'hand', tone: 'attention' },
  bill: { title: 'Wants the bill', icon: 'receipt', tone: 'bill' },
  payment: { title: 'Wants to pay', icon: 'card', tone: 'bill' },
};
// The agreed flow: Confirmed (with the guest) → Served → Paid. Older `accepted` orders sit at Confirmed.
const STAGES = [['taken', 'Confirmed'], ['served', 'Served'], ['paid', 'Paid']];
const stageOf = (status) => (status === 'accepted' ? 'taken' : status);
export const PAY_METHODS = [['cash', 'Cash'], ['mpesa', 'M-Pesa'], ['card', 'Card'], ['other', 'Other']];

/** A button that shows its own busy state and reports errors inline (role=alert) under the card. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (actionError) { setError(actionError.message || 'That didn’t work. Try again.'); }
    finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

export function InlineError({ children }) {
  if (!children) return null;
  return <p className="w-error" role="alert"><Glyph name="alert" size={15} />{children}</p>;
}

/** Confirmed · Served · Paid, with the current stage marked in words (not just colour). */
export function StatusLine({ order }) {
  const index = Math.max(0, STAGES.findIndex(([key]) => key === stageOf(order.status)));
  return <ol className="w-status" aria-label={`Status: ${order.statusLabel || STAGES[index][1]}, step ${index + 1} of ${STAGES.length}`}>
    {STAGES.map(([key, word], i) => <li key={key} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={i === index ? 'step' : undefined}>
      <span className="w-status-dot" aria-hidden="true">{i < index ? <Glyph name="check" size={11} strokeWidth={3} /> : null}</span>{word}
    </li>)}
  </ol>;
}

/** Choose how they paid (and an optional reference), then mark paid. */
function PayForm({ order, onCancel }) {
  const { actions } = useLive();
  const { busy, error, run } = useAction();
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const refId = useId();
  return <div className="w-pay" role="group" aria-label={`How did table ${order.table?.number ?? ''} pay?`}>
    <p className="w-pay-title">How did they pay?</p>
    <div className="w-pay-methods" role="radiogroup" aria-label="Payment method">
      {PAY_METHODS.map(([key, word]) => <button key={key} type="button" role="radio" aria-checked={method === key} className={`w-pay-method${method === key ? ' is-on' : ''}`} onClick={() => setMethod(key)}>
        {word}
      </button>)}
    </div>
    {method && method !== 'cash' && <div className="w-field">
      <label htmlFor={refId}>{method === 'mpesa' ? 'M-Pesa code' : 'Reference'} <span>(optional)</span></label>
      <input id={refId} value={reference} maxLength={60} autoComplete="off" autoCapitalize="characters" placeholder={method === 'mpesa' ? 'e.g. SKL4ABC12X' : ''} onChange={(event) => setReference(event.target.value)} />
    </div>}
    <InlineError>{error}</InlineError>
    <div className="w-pay-actions">
      <button type="button" className="w-btn w-btn-quiet" onClick={onCancel}>Back</button>
      <button type="button" className="w-btn w-btn-primary" disabled={!method || busy} onClick={() => run(() => actions.pay(order, method, reference.trim()))}>
        {busy ? 'Saving…' : `Mark paid · ${formatPrice(order.total, order.currency)}`}
      </button>
    </div>
  </div>;
}

/** One open order: what was ordered, where it is, and the one next step. */
export function OrderCard({ order, showTable = false, fresh = false, headline }) {
  const { actions, offset } = useLive();
  const { busy, error, run } = useAction();
  const [paying, setPaying] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const next = order.nextAction;
  const where = order.table ? `Table ${order.table.number}` : 'Takeaway';
  return <article className={`w-card w-order${fresh ? ' is-fresh' : ''}`} aria-label={`${headline || 'Order'} ${showTable ? where : ''} #${order.shortId}`.replace(/\s+/g, ' ')}>
    <header className="w-order-head">
      {showTable && <span className="w-table-chip" aria-hidden="true">{order.table?.number ?? '—'}</span>}
      <div className="w-order-title">
        <strong>{headline || `Order #${order.shortId}`}</strong>
        <span>{showTable ? `${where} · ` : ''}{headline ? `#${order.shortId} · ` : ''}{order.confirmation === 'manual' ? 'Not confirmed by the guest · ' : ''}{ageText(order.takenAt || order.createdAt, offset)}</span>
      </div>
      <span className="w-order-total">{formatPrice(order.total, order.currency)}</span>
    </header>
    <ul className="w-order-items">
      {order.items.map((line, index) => <li key={line.id || `${line.itemId || line.dealId}-${index}`}><span className="w-qty">{line.quantity}×</span><span>
        {line.name}{line.kind === 'deal' && <span className="w-deal-tag">Deal</span>}
        {line.extras?.length > 0 && <small className="w-line-extras">{line.extras.map((extra) => `+ ${extra.name}`).join(', ')}</small>}
        {line.kind === 'deal' && line.components?.length > 0 && <small className="w-line-extras">{line.components.map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ')}</small>}
        {line.note && <em>{line.note}</em>}
      </span></li>)}
    </ul>
    {order.note && <p className="w-order-note"><Glyph name="note" size={14} />{order.note}</p>}
    <StatusLine order={order} />
    <InlineError>{error}</InlineError>
    {paying ? <PayForm order={order} onCancel={() => setPaying(false)} />
      : confirmCancel ? <div className="w-confirm" role="group" aria-label="Cancel this order?">
        <p>Cancel order #{order.shortId}? This can’t be undone.</p>
        <div className="w-pay-actions">
          <button type="button" className="w-btn w-btn-quiet" onClick={() => setConfirmCancel(false)}>Keep it</button>
          <button type="button" className="w-btn w-btn-danger" disabled={busy} onClick={() => run(() => actions.cancel(order))}>{busy ? 'Cancelling…' : 'Cancel order'}</button>
        </div>
      </div>
        : <div className="w-order-actions">
          {next === 'serve' && <button type="button" className="w-btn w-btn-primary" disabled={busy} onClick={() => run(() => actions.advance(order))}><Glyph name="utensils" size={18} />{busy ? 'Saving…' : 'Mark served'}</button>}
          {next === 'pay' && <button type="button" className="w-btn w-btn-primary" onClick={() => setPaying(true)}><Glyph name="card" size={18} />Mark paid</button>}
          {order.canCancel && <button type="button" className="w-btn w-btn-quiet w-btn-small" onClick={() => setConfirmCancel(true)}>Cancel order</button>}
        </div>}
  </article>;
}

/** A guest request: Acknowledge ("On my way"), then Done. */
export function RequestCard({ request, showTable = true, fresh = false }) {
  const { actions, offset } = useLive();
  const { busy, error, run } = useAction();
  const look = REQUEST_LOOK[request.type] || REQUEST_LOOK.call_waiter;
  const acknowledged = request.status === 'acknowledged';
  return <article className={`w-card w-request tone-${look.tone}${fresh ? ' is-fresh' : ''}${acknowledged ? ' is-acknowledged' : ''}`} aria-label={`Table ${request.table?.number}: ${look.title}`}>
    <div className="w-request-main">
      {showTable && <span className={`w-table-chip tone-${look.tone}`} aria-hidden="true">{request.table?.number}</span>}
      <div className="w-request-text">
        <strong><Glyph name={look.icon} size={17} />{look.title}</strong>
        <span>{showTable ? `Table ${request.table?.number} · ` : ''}{ageText(request.createdAt, offset)}{acknowledged ? ` · ${request.acknowledgedBy?.name ? `${request.acknowledgedBy.name} is on the way` : 'On the way'}` : ''}</span>
      </div>
    </div>
    <InlineError>{error}</InlineError>
    <div className="w-request-actions">
      {!acknowledged && <button type="button" className="w-btn w-btn-primary" disabled={busy} onClick={() => run(() => actions.acknowledge(request))}><Glyph name="walk" size={18} />{busy ? 'Saving…' : 'Acknowledge'}</button>}
      <button type="button" className={`w-btn ${acknowledged ? 'w-btn-primary' : 'w-btn-secondary'}`} disabled={busy} onClick={() => run(() => actions.resolve(request))}><Glyph name="check" size={18} />Done</button>
    </div>
  </article>;
}

/** Type the 6-character code from the guest's screen (when the camera can't read the QR). */
function TypeCodeSheet({ open, onClose, onCode, tableNumber }) {
  const inputId = useId();
  const [code, setCode] = useState('');
  const submit = (event) => { event.preventDefault(); if (code.length === 6) onCode(code); };
  return <Sheet open={open} onClose={onClose} title="Type the guest’s code" className="w-sheet">
    <form className="w-type-code" onSubmit={submit}>
      <label htmlFor={inputId} className="w-muted">{tableNumber ? `Table ${tableNumber}: the` : 'The'} 6 letters and numbers under the guest’s QR.</label>
      <input id={inputId} className="w-code-input" autoFocus value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
        onChange={(event) => setCode(cleanCode(event.target.value))} placeholder="ACD 347" autoComplete="off" autoCorrect="off"
        autoCapitalize="characters" spellCheck={false} maxLength={8} />
      <button type="submit" className="w-btn w-btn-primary w-btn-big" disabled={code.length !== 6}>Open the guest’s order</button>
    </form>
  </Sheet>;
}

/**
 * "Table 7 is ready to order · 3 items · Ksh 2,350". The waiter goes to the table and scans the guest's QR
 * (primary), or types the code from the guest's screen (fallback). Both open the review with the guest.
 * The code itself is never shown here: having it in hand is the proof the waiter was at the table.
 */
export function ReadyCard({ cart, showTable = true, fresh = false }) {
  const { offset } = useLive();
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const where = cart.tableNumber ? `Table ${cart.tableNumber}` : 'A guest';
  const open = useCallback((code, via) => navigate(`/waiter/cart/${code}?via=${via}`), [navigate]);
  const onScanned = useCallback((code) => { setScanning(false); open(code, 'scan'); }, [open]);
  return <article className={`w-card w-ready${fresh ? ' is-fresh' : ''}`} aria-label={`${where} is ready to order`}>
    <div className="w-request-main">
      {showTable && <span className="w-table-chip tone-ready" aria-hidden="true">{cart.tableNumber ?? <Glyph name="qr" size={18} />}</span>}
      <div className="w-request-text">
        <strong><Glyph name="qr" size={17} />{where} is ready to order</strong>
        <span>{cart.itemCount} item{cart.itemCount === 1 ? '' : 's'} · {formatPrice(cart.total, cart.currency)} · {ageText(cart.readyAt, offset)}</span>
      </div>
    </div>
    <p className="w-ready-help">Go to the table, scan their code and check the order with them.</p>
    <div className="w-request-actions">
      <button type="button" className="w-btn w-btn-primary" onClick={() => setScanning(true)}><Glyph name="scan" size={18} />Scan code</button>
      <button type="button" className="w-btn w-btn-secondary" onClick={() => setTyping(true)}><Glyph name="keyboard" size={18} />Type code</button>
    </div>
    <CodeScanner open={scanning} onClose={() => setScanning(false)} onCode={onScanned} onType={() => { setScanning(false); setTyping(true); }} />
    <TypeCodeSheet open={typing} onClose={() => setTyping(false)} tableNumber={cart.tableNumber} onCode={(code) => { setTyping(false); open(code, 'typed'); }} />
  </article>;
}
