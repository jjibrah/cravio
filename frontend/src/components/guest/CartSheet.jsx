import { useId, useState } from 'react';
import GuestSheet from '../menu/GuestSheet';
import Glyph from '../media/Glyph';
import { formatKsh } from '../../lib/format';
import { groupCode } from './guestApi';

export const extrasLabel = (extras = []) => extras.map((extra) => `+ ${extra.name}`).join(', ');
export const componentsLabel = (parts = []) => parts.map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ');

function LineNote({ line, onChange }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(line.note || '');
  if (!editing) {
    return <button type="button" className="gx-note-button is-small" onClick={() => { setValue(line.note || ''); setEditing(true); }}>
      <Glyph name="note" size={13} />{line.note ? <span className="gx-note-text">“{line.note}”</span> : 'Add a note'}
      <span className="visually-hidden"> for {line.name}</span>
    </button>;
  }
  const save = () => { onChange(value.trim()); setEditing(false); };
  return <div className="gx-note-edit">
    <label className="visually-hidden" htmlFor={id}>Note for {line.name}</label>
    <input id={id} value={value} maxLength={140} autoFocus placeholder="e.g. No onions" onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
    <button type="button" className="gx-mini" onClick={save}>Save</button>
  </div>;
}

/** One order line with its stepper. */
function Line({ line, cart }) {
  return <li className="gx-line">
    <div className="gx-line-main">
      <strong>{line.name}{line.kind === 'deal' && <span className="gx-line-tag">Deal</span>}</strong>
      {line.extras.length > 0 && <span className="gx-line-extras">{extrasLabel(line.extras)}</span>}
      {line.kind === 'deal' && <span className="gx-line-extras">{componentsLabel(line.components)}</span>}
      <LineNote key={line.note || ''} line={line} onChange={(note) => cart.setNote(line.key, note)} />
    </div>
    <div className="gx-qty is-small" role="group" aria-label={`${line.name} quantity`}>
      <button type="button" aria-label={line.quantity === 1 ? `Remove ${line.name}` : `One less ${line.name}`} onClick={() => cart.changeQuantity(line.key, -1)}>
        <Glyph name={line.quantity === 1 ? 'trash' : 'minus'} size={15} />
      </button>
      <output aria-live="polite">{line.quantity}</output>
      <button type="button" aria-label={`One more ${line.name}`} onClick={() => cart.changeQuantity(line.key, 1)} disabled={line.quantity >= 20}><Glyph name="plus" size={15} /></button>
    </div>
    <span className="gx-line-total">{formatKsh(line.lineTotal)}</span>
  </li>;
}

/** The table's lines, grouped by who added them ("You" first). */
function groupByPerson(lines) {
  const groups = new Map();
  for (const line of lines) {
    const who = line.addedBy?.you ? 'You' : line.addedBy?.label || 'Someone';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(line);
  }
  return [...groups].sort(([a], [b]) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
}

/**
 * "Your order": lines with extras and deal contents, steppers, total, "Ready to order" and "Clear order".
 * Nothing is sent while the guest browses; "Ready to order" saves the list and calls a waiter to confirm it.
 * With `table` (a table session) it's the table's shared order: lines grouped by who added them, the table code,
 * "Ordered so far", and "Order on my own instead".
 */
export default function CartSheet({ open, onClose, cart, busy, error, notice, onReady, onClear, onUndoClear, tableNumber, contained, table, onLeaveTable }) {
  const stale = cart.code && cart.changedSinceSaved;
  const footer = cart.lines.length > 0 && <div className="gx-cart-foot">
    <div className="gx-total"><span>Total</span><strong>{formatKsh(cart.total)}</strong></div>
    <p className="gx-fineprint">{table ? 'Anyone at the table can tap Ready to order. A waiter comes to confirm it with you all.' : 'Nothing is sent yet. When you’re ready, a waiter comes to your table to confirm it with you.'}</p>
    <button type="button" className="gx-primary gx-show" onClick={onReady} disabled={busy}>
      <Glyph name="qr" size={20} />{busy ? 'Getting your code…' : 'Ready to order'}
    </button>
    <button type="button" className="gx-text-button" onClick={onClear}>{table ? 'Clear the table’s order' : 'Clear order'}</button>
  </div>;
  const tableInfo = table && <div className="gx-table-info">
    <p className="gx-info"><Glyph name="hand" size={15} /><span>Table code <strong>{table.joinCode}</strong>. Share it with friends at your table so they can add to this order.</span></p>
    {table.members.length > 1 && <p className="gx-hint">Ordering together: {table.members.map((m) => (m.you ? 'You' : m.label)).join(', ')}</p>}
  </div>;
  const orderedSoFar = table?.ordered?.length > 0 && <section className="gx-ordered" aria-labelledby="gx-ordered-title">
    <h3 id="gx-ordered-title" className="gx-group-title">Ordered so far</h3>
    <ul>{table.ordered.map((round) => <li key={round.orderShortId}>
      <span className="gx-muted">#{round.orderShortId}{round.confirmedBy ? ` · ${round.confirmedBy}` : ''}</span>
      <span>{round.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}</span>
    </li>)}</ul>
  </section>;
  const leave = onLeaveTable && <button type="button" className="gx-text-button" onClick={onLeaveTable}>Order on my own instead</button>;

  return <GuestSheet open={open} onClose={onClose} title="Your order" contained={contained} className="gx-cart-sheet" footer={footer}>
    {notice && <p className="gx-info" role="status"><Glyph name="check" size={15} /><span>{notice}</span>{onUndoClear && <button type="button" className="gx-inline-button" onClick={onUndoClear}>Undo</button>}</p>}
    {cart.lines.length === 0
      ? <div className="gx-cart-empty"><Glyph name="utensils" size={26} /><p>{table ? 'Your table’s order is empty.' : 'Your order is empty.'}</p><p className="gx-muted">Tap + on a dish or a deal to add it.</p>
        {error && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
        <button type="button" className="gx-secondary gx-browse" onClick={onClose}>Browse the menu</button>
        {tableInfo}{orderedSoFar}{leave}</div>
      : <>
        {tableInfo}
        {table
          ? groupByPerson(cart.lines).map(([who, lines]) => <section key={who} className="gx-group" aria-label={`Added by ${who}`}>
            <h3 className="gx-group-title">{who === 'You' ? 'Added by you' : who}</h3>
            <ul className="gx-lines">{lines.map((line) => <Line key={line.key} line={line} cart={cart} />)}</ul>
          </section>)
          : <ul className="gx-lines" aria-label="Dishes in your order">{cart.lines.map((line) => <Line key={line.key} line={line} cart={cart} />)}</ul>}
        {stale && <p className="gx-info" role="status"><Glyph name="alert" size={15} />{table ? 'The order changed.' : 'You changed your order.'} Tap Ready to order again so your waiter sees the latest (same code {groupCode(cart.code)}).</p>}
        {error && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
        {!tableNumber && <p className="gx-fineprint">Your waiter scans your code or types it in, then confirms the order with you.</p>}
        {orderedSoFar}{leave}
      </>}
  </GuestSheet>;
}
