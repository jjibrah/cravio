import { useEffect, useRef, useState } from 'react';
import Glyph from '../media/Glyph';
import { formatKsh } from '../../lib/format';
import { componentsLabel, extrasLabel } from './CartSheet';

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' });

/** Keeps the screen awake while the waiter card is open, where the browser supports it. */
function useWakeLock(active) {
  useEffect(() => {
    if (!active || !navigator.wakeLock?.request) return undefined;
    let lock = null;
    let cancelled = false;
    const acquire = () => navigator.wakeLock.request('screen').then((l) => { if (cancelled) l.release(); else lock = l; }).catch(() => {});
    acquire();
    const onVisible = () => { if (document.visibilityState === 'visible' && (!lock || lock.released)) acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); lock?.release().catch(() => {}); };
  }, [active]);
}

/**
 * Full-screen card after "Ready to order" (docs/ORDER-FLOW.md). Always bright white, whatever the restaurant's
 * theme, so it scans in a dim room. Three states:
 * - ready: "A waiter is on the way. Show them this code." A huge code, a QR that opens the waiter app on this
 *   cart, and the list. The waiter scans it at the table and confirms the order with the guest.
 * - confirmed (`outcome.kind === 'confirmed'`): "Order confirmed ✓ · Jane confirmed your order at 10:45 · #92da2e".
 * - expired (`outcome.kind === 'expired'`): "This code expired. Tap Ready to order again."
 */
export default function WaiterCard({ saved, outcome, restaurantName, onClose, onEdit, onReadyAgain, busy = false }) {
  const ref = useRef(null);
  const closeRef = useRef(null);
  const [qr, setQr] = useState('');
  const open = Boolean(saved || outcome);
  useWakeLock(Boolean(saved) && !outcome);

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) { dialog.showModal(); closeRef.current?.focus(); }
    if (!open && dialog.open) dialog.close();
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (!saved?.qrValue) { setQr(''); return; }
    let live = true;
    // qrcode (~25 KB) loads only when a card opens, never with the menu.
    import('qrcode').then(({ default: QRCode }) => QRCode.toString(saved.qrValue, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#111110', light: '#ffffff' } }))
      .then((svg) => { if (live) setQr(svg); }).catch(() => setQr(''));
    return () => { live = false; };
  }, [saved?.qrValue]);

  const code = saved?.code || '';
  const head = (title) => <header className="gx-card-head">
    <div>
      <p className="gx-card-eyebrow">{restaurantName}{saved?.table ? ` · Table ${saved.table.number}` : ''}</p>
      <h2 id="gx-card-title">{title}</h2>
    </div>
    <button ref={closeRef} type="button" className="gx-card-close" onClick={onClose} aria-label="Close"><Glyph name="close" size={22} /></button>
  </header>;

  // One <dialog> for every state, so switching from "on the way" to "confirmed" keeps it open.
  let content = null;
  if (outcome?.kind === 'confirmed') {
    const at = outcome.confirmedAt ? timeFmt.format(new Date(outcome.confirmedAt)) : null;
    const who = outcome.confirmedBy || 'Your waiter';
    content = <div className="gx-card-inner gx-card-done" role="status">
      {head('Order confirmed ✓')}
      <span className="gx-done-icon" aria-hidden="true"><Glyph name="check" size={44} /></span>
      <p id="gx-card-help" className="gx-done-text">{who} confirmed your order{at ? ` at ${at}` : ''}{outcome.orderShortId ? ` · #${outcome.orderShortId}` : ''}</p>
      <p className="gx-done-sub">It’s on its way to the kitchen. Use Call waiter or Bill below if you need anything else.</p>
      <div className="gx-card-actions is-single">
        <button type="button" className="gx-primary" onClick={onClose}>Done</button>
      </div>
    </div>;
  } else if (outcome?.kind === 'expired') {
    content = <div className="gx-card-inner gx-card-done is-expired">
      {head('Your code expired')}
      <span className="gx-done-icon" aria-hidden="true"><Glyph name="clock" size={40} /></span>
      <p id="gx-card-help" className="gx-done-text">This code expired. Tap Ready to order again.</p>
      <p className="gx-done-sub">Your order is still on your phone. Nothing was sent to the kitchen.</p>
      <div className="gx-card-actions">
        <button type="button" className="gx-secondary" onClick={onClose}>Not now</button>
        <button type="button" className="gx-primary" onClick={onReadyAgain} disabled={busy}>{busy ? 'Getting your code…' : 'Ready to order'}</button>
      </div>
    </div>;
  }

  return <dialog ref={ref} className="gx-card" aria-labelledby="gx-card-title" aria-describedby="gx-card-help" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {content}
    {!content && saved && <div className="gx-card-inner">
      {head('Ready to order')}

      <p className="gx-code" aria-label={`Code ${code.split('').join(' ')}`}>
        <span aria-hidden="true">{code.slice(0, 3)}</span><span className="gx-code-gap" aria-hidden="true" /><span aria-hidden="true">{code.slice(3)}</span>
      </p>
      <p id="gx-card-help" className="gx-card-help">A waiter is on the way. Show them this code.</p>

      <div className="gx-qr" role="img" aria-label="QR code for your waiter" dangerouslySetInnerHTML={{ __html: qr }} />

      <section className="gx-card-list" aria-label="Your order">
        <ul>
          {saved.items.map((line, index) => <li key={`${line.kind || 'item'}-${line.itemId || line.dealId}-${index}`}>
            <span className="gx-card-qty">{line.quantity}×</span>
            <span className="gx-card-name">{line.name}
              {line.extras?.length > 0 && <small>{extrasLabel(line.extras)}</small>}
              {line.kind === 'deal' && line.components?.length > 0 && <small>Deal: {componentsLabel(line.components)}</small>}
              {line.note && <em>“{line.note}”</em>}
            </span>
            <span className="gx-card-price">{formatKsh(line.lineTotal, saved.currency)}</span>
          </li>)}
        </ul>
        <p className="gx-card-total"><span>Total</span><strong>{formatKsh(saved.total, saved.currency)}</strong></p>
      </section>

      <p className="gx-card-waiting" role="status"><span className="gx-pulse" aria-hidden="true" />Waiting for your waiter to confirm it with you</p>
      <p className="gx-card-valid"><Glyph name="clock" size={15} />Valid for 2 hours{saved.expiresAt ? ` · until ${timeFmt.format(new Date(saved.expiresAt))}` : ''}</p>

      <div className="gx-card-actions">
        <button type="button" className="gx-secondary" onClick={onEdit}>Change order</button>
        <button type="button" className="gx-primary" onClick={onClose}>Done</button>
      </div>
    </div>}
  </dialog>;
}
