import { useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNotifications } from '../notifications/NotificationProvider';
import { opsApi } from '../../lib/ops';
import { OIcon } from './ui';

/** "Add tables": a small popover with a stepper. Calls POST /api/ops/tables { count }. */
export function AddTablesButton({ onAdded, highest = 0 }) {
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wrap = useRef(null);
  const trigger = useRef(null);
  const inputId = useId();
  const popId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!wrap.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => wrap.current?.querySelector('input')?.focus());
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const clamp = (value) => Math.max(1, Math.min(50, Math.round(Number(value) || 1)));
  async function add(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await opsApi.addTables(count);
      const numbers = result.tables.map((table) => table.number);
      notify(numbers.length === 1 ? `Table ${numbers[0]} added.` : `Tables ${numbers[0]}–${numbers[numbers.length - 1]} added.`);
      setOpen(false);
      setCount(1);
      onAdded?.(result);
      trigger.current?.focus();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  const first = highest + 1;
  return <div className="o-popover-wrap" ref={wrap}>
    <button ref={trigger} type="button" className="o-btn is-primary" aria-expanded={open} aria-controls={popId} onClick={() => setOpen((value) => !value)}>
      <OIcon name="plus" size={16} strokeWidth={2.2} />Add tables
    </button>
    {open && <form className="o-popover" id={popId} role="dialog" aria-label="Add tables" onSubmit={add} noValidate>
      <label className="o-label" htmlFor={inputId}>How many tables?</label>
      <div className="o-stepper">
        <button type="button" className="o-icon-btn" onClick={() => setCount((value) => clamp(value - 1))} disabled={count <= 1} aria-label="One fewer"><OIcon name="minus" size={18} /></button>
        <input id={inputId} className="o-input" type="number" inputMode="numeric" min={1} max={50} value={count}
          onChange={(event) => setCount(event.target.value === '' ? '' : clamp(event.target.value))} onBlur={() => setCount((value) => clamp(value))} />
        <button type="button" className="o-icon-btn" onClick={() => setCount((value) => clamp(value + 1))} disabled={count >= 50} aria-label="One more"><OIcon name="plus" size={18} /></button>
      </div>
      <p className="o-field-hint">{count > 1 ? `Adds tables ${first} to ${first + clamp(count) - 1}.` : `Adds table ${first}.`} Each gets its own QR code.</p>
      {error && <p className="o-field-error" role="alert">{error}</p>}
      <button type="submit" className="o-btn is-primary is-block" disabled={busy}>{busy ? 'Adding…' : `Add ${clamp(count)} table${clamp(count) === 1 ? '' : 's'}`}</button>
    </form>}
  </div>;
}

/** The table's QR as inline SVG. */
export function QrSvg({ url, label, className = 'o-qr' }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let active = true;
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#111110', light: '#ffffff' } })
      .then((markup) => { if (active) setSvg(markup); }).catch(() => { if (active) setSvg(''); });
    return () => { active = false; };
  }, [url]);
  return <span className={className} role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Draws a print-quality PNG card (restaurant, QR, table number) and downloads it. */
export async function downloadQrPng({ url, number, restaurantName }) {
  const size = 1200;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = 1500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, url, { errorCorrectionLevel: 'M', margin: 0, width: 900, color: { dark: '#111110', light: '#ffffff' } });
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif';
  ctx.fillStyle = '#111110';
  ctx.textAlign = 'center';
  ctx.font = `600 54px ${font}`;
  if (restaurantName) ctx.fillText(restaurantName, size / 2, 130);
  ctx.drawImage(qr, 150, 200, 900, 900);
  ctx.font = `700 120px ${font}`;
  ctx.fillText(`Table ${number}`, size / 2, 1270);
  ctx.fillStyle = '#6f6b63';
  ctx.font = `500 46px ${font}`;
  ctx.fillText('Scan to see the menu', size / 2, 1360);
  const link = document.createElement('a');
  link.download = `table-${number}-qr.png`;
  link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Prints only the element with `.o-print-qr` (see tables.css). */
export function printQr() {
  document.body.classList.add('o-printing-qr');
  const done = () => { document.body.classList.remove('o-printing-qr'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}
