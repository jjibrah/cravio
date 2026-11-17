import { useId, useState } from 'react';
import GuestSheet from '../menu/GuestSheet';
import Glyph from '../media/Glyph';

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' });

/**
 * "Table 7 already has an order going": join the table's shared order with the 4-digit code from someone at the
 * table (or a waiter), or order on your own. Nobody sees the table's order before joining.
 */
export default function TableJoinSheet({ open, tableNumber, info, onJoin, onSolo, onClose }) {
  const codeId = useId();
  const nameId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = info?.locked || error.startsWith('Too many');

  async function submit(event) {
    event.preventDefault();
    if (code.length !== 4 || busy) { setError('Enter the 4-digit code.'); return; }
    setBusy(true); setError('');
    try { await onJoin(code, name.trim()); }
    catch (joinError) { setError(joinError.message); setCode(''); }
    finally { setBusy(false); }
  }

  const footer = <div className="gx-cart-foot">
    <button type="submit" form="gx-join-form" className="gx-primary" disabled={busy || locked || code.length !== 4}>
      <Glyph name="check" size={18} />{busy ? 'Joining…' : 'Join the table’s order'}
    </button>
    <button type="button" className="gx-text-button" onClick={onSolo}>Order on my own instead</button>
  </div>;

  return <GuestSheet open={open} onClose={onClose} title={`Table ${tableNumber}`} className="gx-join-sheet" footer={footer} closeLabel="Close and browse the menu">
    <p className="gx-join-lead">Table {tableNumber} already has an order going. Enter the code from someone at your table to add to it.</p>
    <form id="gx-join-form" className="gx-join-form" onSubmit={submit} noValidate>
      <div className="gx-field">
        <label htmlFor={codeId}>Table code</label>
        <input id={codeId} className="gx-join-code" value={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={4}
          placeholder="0000" disabled={locked} aria-describedby={`${codeId}-hint`}
          onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }} />
        <p id={`${codeId}-hint`} className="gx-hint">It’s on their phone, under “Table code”. A waiter can tell you too.</p>
      </div>
      <div className="gx-field">
        <label htmlFor={nameId}>Your name <span>(optional)</span></label>
        <input id={nameId} className="gx-join-name" value={name} maxLength={24} autoComplete="given-name" placeholder="So your table knows what’s yours"
          onChange={(event) => setName(event.target.value)} />
      </div>
    </form>
    {locked && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />
      Too many wrong codes{info?.lockedUntil ? `. Try again after ${timeFmt.format(new Date(info.lockedUntil))}` : ''}, or ask a waiter for a new code.</p>}
    {error && !locked && <p className="gx-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
  </GuestSheet>;
}
