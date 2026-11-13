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

/**
 * "Your order": lines with extras and deal contents, steppers, total, "Ready to order" and "Clear order".
 * Nothing is sent while the guest browses; "Ready to order" saves the list and calls a waiter to confirm it.
 */
export default function CartSheet({ open, onClose, cart, busy, error, notice, onReady, onClear, onUndoClear, tableNumber, contained }) {
  const stale = cart.code && cart.changedSinceSaved;
  const footer = cart.lines.length > 0 && <div className="gx-cart-foot">
    <div className="gx-total"><span>Total</span><strong>{formatKsh(cart.total)}</strong></div>
    <p className="gx-fineprint">Nothing is sent yet. When you’re ready, a waiter comes to your table to confirm it with you.</p>
    <button type="button" className="gx-primary gx-show" onClick={onReady} disabled={busy}>
      <Glyph name="qr" size={20} />{busy ? 'Getting your code…' : 'Ready to order'}
    </button>
    <button type="button" className="gx-text-button" onClick={onClear}>Clear order</button>
  </div>;

  return <GuestSheet open={open} onClose={onClose} title="Your order" contained={contained} className="gx-cart-sheet" footer={footer}>
    {notice && <p className="gx-info" role="status"><Glyph name="check" size={15} /><span>{notice}</span>{onUndoClear && <button type="button" className="gx-inline-button" onClick={onUndoClear}>Undo</button>}</p>}
    {cart.lines.length === 0
      ? <div className="gx-cart-empty"><Glyph name="utensils" size={26} /><p>Your order is empty.</p><p className="gx-muted">Tap + on a dish or a deal to add it.</p>
        {error && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
        <button type="button" className="gx-secondary gx-browse" onClick={onClose}>Browse the menu</button></div>
      : <>
        <ul className="gx-lines" aria-label="Dishes in your order">
          {cart.lines.map((line) => <li key={line.key} className="gx-line">
            <div className="gx-line-main">
              <strong>{line.name}{line.kind === 'deal' && <span className="gx-line-tag">Deal</span>}</strong>
              {line.extras.length > 0 && <span className="gx-line-extras">{extrasLabel(line.extras)}</span>}
              {line.kind === 'deal' && <span className="gx-line-extras">{componentsLabel(line.components)}</span>}
              <LineNote line={line} onChange={(note) => cart.setNote(line.key, note)} />
            </div>
            <div className="gx-qty is-small" role="group" aria-label={`${line.name} quantity`}>
              <button type="button" aria-label={line.quantity === 1 ? `Remove ${line.name}` : `One less ${line.name}`} onClick={() => cart.changeQuantity(line.key, -1)}>
                <Glyph name={line.quantity === 1 ? 'trash' : 'minus'} size={15} />
              </button>
              <output aria-live="polite">{line.quantity}</output>
              <button type="button" aria-label={`One more ${line.name}`} onClick={() => cart.changeQuantity(line.key, 1)} disabled={line.quantity >= 20}><Glyph name="plus" size={15} /></button>
            </div>
            <span className="gx-line-total">{formatKsh(line.lineTotal)}</span>
          </li>)}
        </ul>
        {stale && <p className="gx-info" role="status"><Glyph name="alert" size={15} />You changed your order. Tap Ready to order again so your waiter sees the latest (same code {groupCode(cart.code)}).</p>}
        {error && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
        {!tableNumber && <p className="gx-fineprint">Your waiter scans your code or types it in, then confirms the order with you.</p>}
      </>}
  </GuestSheet>;
}
