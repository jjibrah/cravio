// Shared pieces of the branch and owner Inventory pages.
import { useCallback, useId, useRef, useState } from 'react';
import { EmptyState, ErrorState, OIcon } from '../../components/owner/ui';
import Drawer from '../../components/owner/Drawer';
import { api } from '../../lib/api';
import { useNotifications } from '../../components/notifications/NotificationProvider';

/* Units (migration 012). An item is counted in one unit; amounts can be entered in a compatible unit or its pack. */
export const UNIT_LABELS = { serving: 'Servings', piece: 'Pieces', g: 'Grams (g)', kg: 'Kilograms (kg)', ml: 'Millilitres (ml)', l: 'Litres (l)' };
const DIMENSION = { serving: 'serving', piece: 'piece', g: 'weight', kg: 'weight', ml: 'volume', l: 'volume' };
const WORDS = { serving: ['serving', 'servings'], piece: ['piece', 'pieces'] };
export const compatibleUnits = (unit) => Object.keys(DIMENSION).filter((u) => DIMENSION[u] === DIMENSION[unit || 'serving']);
const trim = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));
export const plural = (name) => (/(s|x|ch|sh)$/i.test(name) ? `${name}es` : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);
/** "3 servings", "1 piece", "0.6 kg". The unit defaults to servings (009 items). */
export const servings = (value, unit = 'serving') => {
  const number = Number(value) || 0;
  const [one, many] = WORDS[unit] || [unit, unit];
  return `${trim(number)} ${Math.abs(number) === 1 ? one : many}`;
};
/** "38.4 kg · about 3.8 crates" when the item has a pack. */
export const friendly = (value, item) => {
  const base = servings(value, item?.unit);
  if (!item?.packName || !item?.packSize) return base;
  const packs = Math.round((Number(value) / item.packSize) * 10) / 10;
  return `${base} · about ${trim(packs)} ${packs === 1 ? item.packName : plural(item.packName)}`;
};
export const signed = (value, unit) => `${value > 0 ? '+' : ''}${servings(value, unit)}`;
/** Unit of an item by id, from a snapshot's items. */
export const unitOf = (items, itemId) => items?.find((item) => item.id === itemId)?.unit || 'serving';
/** Unit choices for entering an amount of `item`: compatible units plus its pack. */
export const unitChoices = (item) => [
  ...compatibleUnits(item?.unit).map((u) => ({ value: u, label: u === 'serving' ? 'servings' : u === 'piece' ? 'pieces' : u })),
  ...(item?.packName ? [{ value: 'pack', label: `${plural(item.packName)} (${trim(item.packSize)} ${item.unit})` }] : []),
];

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
export function LineEditor({ items, lines, onChange, quantityLabel = 'Amount' }) {
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
      {line.itemId && unitOf(items, line.itemId) !== 'serving' && <span className="st-unit">{unitOf(items, line.itemId)}</span>}
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
      <td className={m.change < 0 ? 'is-minus' : 'is-plus'}>{signed(m.change, m.unit)}</td>
      <td>{servings(m.balance, m.unit)}</td>
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
  const [unit, setUnit] = useState(item.unit || 'serving');
  const [text, setText] = useState('');
  const word = item.unit === 'serving' || !item.unit ? 'Servings' : 'Amount';
  const labels = { count: 'Counted on hand now', added: `${word} added`, waste: `${word} wasted` };
  const choices = unitChoices(item);
  async function submit(event) {
    event.preventDefault();
    const result = await run(path, { kind, itemId: item.id, quantity: Number(amount), unit, note: text || undefined },
      { success: (r) => `${item.name}: ${friendly(r.onHand, item)} on hand.` });
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
      <div className="st-line">
        <input id={`${ids}-qty`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        {choices.length > 1 ? <><label className="visually-hidden" htmlFor={`${ids}-unit`}>Unit</label>
          <select id={`${ids}-unit`} className="o-select st-unit-select" value={unit} onChange={(event) => setUnit(event.target.value)}>
            {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select></> : item.unit && item.unit !== 'serving' ? <span className="st-unit">{item.unit}</span> : null}
      </div>
      {unit === 'pack' && amount !== '' && <p className="o-field-hint">= {servings(Math.round(Number(amount) * item.packSize * 1000) / 1000, item.unit)}</p>}
      <p className="o-field-hint">{kind === 'count' ? 'Sets the balance to what you counted. Use this for opening stock.' : kind === 'added' ? 'For deliveries from a supplier or your own production. Transfers from the main center are received separately.' : 'Spoiled, dropped or expired servings.'}</p>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">{kind === 'waste' ? 'Required' : 'Optional'}</span></label>
      <input id={`${ids}-note`} className="o-input" value={text} maxLength={280} onChange={(event) => setText(event.target.value)} />
    </div>
    <p className="o-field-hint">Now {friendly(item.onHand ?? item.centerOnHand ?? 0, item)} on hand.</p>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || amount === ''}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/**
 * Create an item, or edit one (`item`): name, unit, optional pack, low-stock level. `unitsOn` is false before
 * migration 012 (servings only). Edits PATCH `${path}/${item.id}`.
 */
export function NewItemForm({ path, onDone, item = null, unitsOn = true }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [name, setName] = useState(item?.name || '');
  const [low, setLow] = useState(item?.lowLevel ?? '');
  const [unit, setUnit] = useState(item?.unit || 'serving');
  const [packName, setPackName] = useState(item?.packName || '');
  const [packSize, setPackSize] = useState(item?.packSize ?? '');
  async function submit(event) {
    event.preventDefault();
    const body = { name, lowLevel: low === '' ? null : Number(low) };
    if (unitsOn) Object.assign(body, { unit, packName: packName.trim() || null, packSize: packSize === '' ? null : Number(packSize) });
    const result = item
      ? await run(`${path}/${item.id}`, body, { method: 'PATCH', success: (r) => `${r.name} saved.` })
      : await run(path, body, { success: (r) => `${r.name} added. Count it to set opening stock.` });
    if (result) onDone(result);
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Item name</label>
      <input id={`${ids}-name`} className="o-input" value={name} maxLength={80} placeholder="e.g. Pilau, Fanta 300ml" onChange={(event) => setName(event.target.value)} />
      <p className="o-field-hint">{unitsOn ? 'Items are shared by every branch of the business.' : 'Counted in servings. Items are shared by every branch of the business.'}</p>
    </div>
    {unitsOn && <>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-unit`}>Counted in</label>
        <select id={`${ids}-unit`} className="o-select" value={unit} onChange={(event) => setUnit(event.target.value)}>
          {Object.entries(UNIT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p className="o-field-hint">{item ? 'The unit can change only before the item has stock history or dishes.' : 'How you count it on the shelf. Chicken: kg. Buns: pieces. A ready plate: servings.'}</p>
      </div>
      <div className="o-field">
        <span className="o-label">Pack <span className="o-optional">Optional</span></span>
        <div className="st-line">
          <label className="visually-hidden" htmlFor={`${ids}-pack`}>Pack name</label>
          <input id={`${ids}-pack`} className="o-input" value={packName} maxLength={30} placeholder="e.g. crate, carton, bag" onChange={(event) => setPackName(event.target.value)} />
          <span className="st-unit">of</span>
          <label className="visually-hidden" htmlFor={`${ids}-pack-size`}>Pack size in {unit}</label>
          <input id={`${ids}-pack-size`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={packSize} onChange={(event) => setPackSize(event.target.value)} />
          <span className="st-unit">{unit === 'serving' ? 'servings' : unit === 'piece' ? 'pieces' : unit}</span>
        </div>
        <p className="o-field-hint">How you buy it, e.g. a crate of 10 kg. Then add or count stock as “40 crates”.</p>
      </div>
    </>}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-low`}>Low-stock level <span className="o-optional">Optional, in {unitsOn ? unit : 'servings'}</span></label>
      <input id={`${ids}-low`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={low} onChange={(event) => setLow(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : item ? 'Save' : 'Add item'}</button>
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
