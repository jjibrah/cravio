// Shared pieces of the branch and owner Inventory pages.
import { useCallback, useId, useRef, useState } from 'react';
import { EmptyState, ErrorState, OIcon } from '../../components/owner/ui';
import Drawer from '../../components/owner/Drawer';
import { api } from '../../lib/api';
import { useNotifications } from '../../components/notifications/NotificationProvider';

export const servings = (value) => {
  const number = Number(value) || 0;
  const text = Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/, '');
  return `${text} serving${Math.abs(number) === 1 ? '' : 's'}`;
};
export const signed = (value) => `${value > 0 ? '+' : ''}${servings(value)}`;

export const REASONS = {
  count: 'Counted', added: 'Added', waste: 'Wasted', served: 'Served', order_correction: 'Order correction',
  dispatched: 'Dispatched', received: 'Received', lost_in_transit: 'Lost in transit', dispatch_cancelled: 'Dispatch cancelled',
};
export const REQUEST_STATUS = { submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', dispatched: 'On its way', received: 'Received' };
export const TRANSFER_STATUS = { in_transit: 'On its way', received: 'Received', cancelled: 'Cancelled' };
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function StockError({ error, onRetry, what = 'inventory' }) {
  if (['stock_schema_missing', 'business_schema_missing'].includes(error?.details?.code)) {
    return <EmptyState icon="info" tone="neutral" title="Inventory isn’t switched on yet">
      It needs database update 009 (inventory), which is waiting for review. Everything else keeps working meanwhile.
    </EmptyState>;
  }
  return <ErrorState error={error} onRetry={onRetry} what={what} />;
}

export function StateChip({ state }) {
  const label = { out: 'Out', low: 'Low', ok: 'In stock' }[state];
  const tone = { out: 'cancelled', low: 'taken', ok: 'paid' }[state];
  return <span className={`o-status-chip is-${tone}`}><span className="o-status-chip-dot" aria-hidden="true" />{label}</span>;
}

/**
 * A write with a stable command id: a retry of the same submission (double tap, flaky network) is applied once by
 * the server. The id renews after a success. Returns [run, busy, error, setError].
 */
export function useCommand() {
  const { notify } = useNotifications();
  const commandId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (path, body, { method = 'POST', success } = {}) => {
    if (busy) return null;
    setBusy(true); setError('');
    try {
      const result = await api(path, { method, body: { ...body, commandId: commandId.current } });
      commandId.current = crypto.randomUUID();
      if (success) notify(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (failure) { setError(failure.message); return null; }
    finally { setBusy(false); }
  }, [busy, notify]);
  return [run, busy, error, setError];
}

export function FormError({ error }) {
  return error ? <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{error}</p> : null;
}

/** Rows of { itemId, quantity } chosen from `items`. */
export function LineEditor({ items, lines, onChange, quantityLabel = 'Servings' }) {
  const ids = useId();
  const used = new Set(lines.map((line) => line.itemId));
  const set = (index, patch) => onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  return <div className="st-lines">
    {lines.map((line, index) => <div className="st-line" key={index}>
      <label className="visually-hidden" htmlFor={`${ids}-item-${index}`}>Item {index + 1}</label>
      <select id={`${ids}-item-${index}`} className="o-select" value={line.itemId} onChange={(event) => set(index, { itemId: event.target.value })}>
        <option value="">Choose an item…</option>
        {items.map((item) => <option key={item.id} value={item.id} disabled={used.has(item.id) && item.id !== line.itemId}>{item.name}</option>)}
      </select>
      <label className="visually-hidden" htmlFor={`${ids}-qty-${index}`}>{quantityLabel} for item {index + 1}</label>
      <input id={`${ids}-qty-${index}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" placeholder={quantityLabel}
        value={line.quantity} onChange={(event) => set(index, { quantity: event.target.value })} />
      <button type="button" className="o-icon-btn" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(lines.filter((_, i) => i !== index))} disabled={lines.length === 1}>
        <OIcon name="close" size={16} />
      </button>
    </div>)}
    <button type="button" className="o-btn is-quiet is-small" onClick={() => onChange([...lines, { itemId: '', quantity: '' }])} disabled={lines.length >= items.length}>
      <OIcon name="plus" size={15} />Add another item
    </button>
  </div>;
}

export const cleanLines = (lines) => lines.filter((line) => line.itemId && line.quantity !== '').map((line) => ({ itemId: line.itemId, quantity: Number(line.quantity) }));

export function Movements({ movements }) {
  if (!movements.length) return <EmptyState icon="clock" tone="neutral" title="No stock changes yet">Counts, deliveries and served orders appear here.</EmptyState>;
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">When</th><th scope="col">Item</th><th scope="col">Change</th><th scope="col">Balance</th><th scope="col">Why</th></tr></thead>
    <tbody>{movements.map((m) => <tr key={m.id}>
      <td>{when(m.at)}</td><td>{m.name}</td>
      <td className={m.change < 0 ? 'is-minus' : 'is-plus'}>{signed(m.change)}</td>
      <td>{servings(m.balance)}</td>
      <td>{REASONS[m.reason] || m.reason}{m.by ? ` · ${m.by}` : ''}{m.note ? <><br /><small>{m.note}</small></> : null}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** Count / add / waste one item at a location. `path` is the adjust endpoint. */
export function AdjustForm({ item, path, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [kind, setKind] = useState('count');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const labels = { count: 'Counted on hand now', added: 'Servings added', waste: 'Servings wasted' };
  async function submit(event) {
    event.preventDefault();
    const result = await run(path, { kind, itemId: item.id, quantity: Number(amount), note: text || undefined },
      { success: (r) => `${item.name}: ${servings(r.onHand)} on hand.` });
    if (result) onDone();
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <fieldset className="biz-checks st-kinds">
      <legend className="o-label">What are you recording?</legend>
      {[['count', 'Count'], ['added', 'Add stock'], ['waste', 'Waste']].map(([value, label]) => <label key={value}>
        <input type="radio" name={`${ids}-kind`} value={value} checked={kind === value} onChange={() => setKind(value)} />{label}</label>)}
    </fieldset>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-qty`}>{labels[kind]}</label>
      <input id={`${ids}-qty`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required />
      <p className="o-field-hint">{kind === 'count' ? 'Sets the balance to what you counted. Use this for opening stock.' : kind === 'added' ? 'For deliveries from a supplier or your own production. Transfers from the main center are received separately.' : 'Spoiled, dropped or expired servings.'}</p>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">{kind === 'waste' ? 'Required' : 'Optional'}</span></label>
      <input id={`${ids}-note`} className="o-input" value={text} maxLength={280} onChange={(event) => setText(event.target.value)} />
    </div>
    <p className="o-field-hint">Now {servings(item.onHand ?? item.centerOnHand ?? 0)} on hand.</p>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || amount === ''}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

export function NewItemForm({ path, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [name, setName] = useState('');
  const [low, setLow] = useState('');
  async function submit(event) {
    event.preventDefault();
    const result = await run(path, { name, lowLevel: low === '' ? null : Number(low) }, { success: (r) => `${r.name} added. Count it to set opening stock.` });
    if (result) onDone(result);
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Item name</label>
      <input id={`${ids}-name`} className="o-input" value={name} maxLength={80} placeholder="e.g. Pilau, Fanta 300ml" onChange={(event) => setName(event.target.value)} />
      <p className="o-field-hint">Counted in servings. Items are shared by every branch of the business.</p>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-low`}>Low-stock level <span className="o-optional">Optional</span></label>
      <input id={`${ids}-low`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={low} onChange={(event) => setLow(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add item'}</button>
      <button type="button" className="o-btn is-quiet" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/** A short task (count, request, receive, review…) in the side sheet: one job, an obvious way out. */
export function TaskDrawer({ open, title, onClose, children, wide = false }) {
  return <Drawer open={open} onClose={onClose} title={title} className="st-drawer" wide={wide}>{open ? children : null}</Drawer>;
}

/** “Needs you” cards: the few things that are waiting on this person, each with its action. */
export function NeedsYou({ items }) {
  if (!items.length) return null;
  return <section className="st-needs" aria-label="Needs you">
    {items.map((item) => <div key={item.key} className={`st-need is-${item.tone || 'action'}`}>
      <span className="st-need-text"><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}</span>
      <button type="button" className={`o-btn is-small${item.primary ? ' is-primary' : ''}`} onClick={item.onClick}>{item.action}</button>
    </div>)}
  </section>;
}
