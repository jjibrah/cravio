// Pieces shared by the owner "Requests & transfers" and the branch "Requests & deliveries" screens (P2-26, P2-27): amounts with their
// unit, status chips, the delivery note (with its QR code), the pick list, and the receive form. Same look as Receive goods and Purchases.
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { useEffect, useId, useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { REQUEST_STATUS, TRANSFER_STATUS, factorOf, formatNumber, formatStamp, inUnit, unitOptions, useInventoryWrite, usualUnitOf } from '../../lib/inventory';
import { FormError, OIcon, QuantityInput } from './parts';
import { Note } from './PurchasingParts';
import './receiving.css';
import './purchasing.css';
import './distribution.css';

/* ---------- chips and small words ---------- */

export function RequestChip({ status }) {
  const info = REQUEST_STATUS[status] || { label: status, tone: 'off' };
  return <span className={`inv-badge is-${info.tone}`}>{info.label}</span>;
}

export function TransferChip({ transfer }) {
  if (transfer.status === 'pending_approval') {
    const info = transfer.awaitingDispatch ? { label: 'Approved: waiting to be sent', tone: 'ok' } : { label: 'Waiting for the owner', tone: 'low' };
    return <span className={`inv-badge is-${info.tone}`}>{info.label}</span>;
  }
  const info = TRANSFER_STATUS[transfer.status] || { label: transfer.status, tone: 'off' };
  return <span className={`inv-badge is-${info.tone}`}>{info.label}</span>;
}

/** "Chicken 15 kg, Rice 20 kg" from a transfer's lines. */
export const linesText = (lines, key = 'display', max = 3) => {
  const text = lines.slice(0, max).map((l) => `${l.name} ${l[key] ?? ''}`.trim()).join(', ');
  return lines.length > max ? `${text} and ${lines.length - max} more` : text;
};

export const openDiscrepancies = (transfer) => (transfer.discrepancies || []).filter((d) => d.status === 'open');

/* ---------- amounts in the unit people use ---------- */

/** Every unit an amount of this item can be typed in (the item's own, or just its base unit when the item is unknown). */
export function optionsFor(item, units, fallbackUnit) {
  const found = item ? unitOptions(item, units) : [];
  return found.length ? found : [{ value: fallbackUnit || 'unit', label: fallbackUnit || 'unit', factor: 1 }];
}

/** The unit people usually count this item in, if it is one of the options. */
export function usualUnit(item, options) {
  const wanted = String(usualUnitOf(item)).toLowerCase();
  return options.find((o) => String(o.value).toLowerCase() === wanted)?.value || options[0]?.value || '';
}

/** { qty, unit } for an amount in base units, shown in the item's usual unit (or `unit`). `floor` never rounds up (what is available). */
export function amountFor(base, item, units, fallbackUnit, { unit, floor = false } = {}) {
  const options = optionsFor(item, units, fallbackUnit);
  const chosen = unit && options.some((o) => o.value === unit) ? unit : usualUnit(item, options);
  const factor = options.find((o) => o.value === chosen)?.factor || 1;
  const value = Number(base) / factor;
  return { qty: floor ? String(Math.floor(value * 1000) / 1000) : inUnit(base, chosen, options), unit: chosen };
}

/** A typed { qty, unit } in base units (a number). */
export const toBase = (amount, options) => (Number(amount.qty) || 0) * (options.find((o) => o.value === amount.unit)?.factor || 1);

/** Changing the unit keeps the real amount the same (2 kg becomes 2000 g), so nothing moves under the person's finger. */
export function switchUnit(amount, options, unit) {
  const from = options.find((o) => o.value === amount.unit)?.factor || 1;
  const to = options.find((o) => o.value === unit)?.factor || 1;
  const qty = amount.qty === '' ? '' : String(Math.round(((Number(amount.qty) * from) / to) * 10000) / 10000);
  return { qty, unit };
}

export const unitLabel = (options, unit, qty) => {
  const o = options.find((x) => x.value === unit);
  return o ? o.label : unit;
};

/** A quantity box with its unit beside it (a dropdown when there is more than one unit). */
export function AmountInput({ id, label, amount, options, onChange }) {
  return <QuantityInput id={id} label={label} value={amount.qty} onChange={(qty) => onChange({ ...amount, qty })} unit={amount.unit}
    choices={options.map((o) => ({ value: o.value, label: o.label }))} onUnit={(unit) => onChange(switchUnit(amount, options, unit))} placeholder="0" />;
}

/* ---------- printing ---------- */

/** What prints: anything inside goes to a root that only shows on paper (the page and sheet are hidden by purchasing.css). */
export function PrintRoot({ children }) {
  return createPortal(<div className="po-print-root" aria-hidden="true">{children}</div>, window.document.body);
}

/* ---------- the delivery note ---------- */

const absolute = (path) => `${window.location.origin}${path}`;

function useQr(text) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    if (!text) { setSvg(''); return undefined; }
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((value) => live && setSvg(value), () => live && setSvg(''));
    return () => { live = false; };
  }, [text]);
  return svg;
}

function NoteDocument({ note, svg, link }) {
  return <article className="po-doc dist-note" aria-label={`Delivery note ${note.ref}`}>
    <div className="po-doc-head">
      <div><h2>Delivery note</h2><div>{note.ref}</div></div>
      <div><strong>{note.from} to {note.to}</strong><div>{note.dispatchedAt ? formatStamp(note.dispatchedAt) : ''}</div></div>
    </div>
    <div className="po-doc-cols">
      <div><h3>Sent by</h3><p>{note.dispatchedBy || note.from}</p></div>
      <div><h3>Driver</h3><p>{note.driver || 'Not written down'}</p></div>
      <div><h3>Vehicle</h3><p>{note.vehicle || 'Not written down'}</p></div>
      {note.requestRef && <div><h3>For request</h3><p>{note.requestRef}</p></div>}
    </div>
    <table>
      <thead><tr><th scope="col">Item</th><th scope="col" className="is-num">Sent</th><th scope="col" className="is-num">Counted on arrival</th></tr></thead>
      <tbody>{note.lines.map((l) => <tr key={l.itemId}><td>{l.name}</td><td className="is-num">{l.display}</td><td className="is-num">&nbsp;</td></tr>)}</tbody>
    </table>
    {note.note && <p className="po-doc-foot">Note: {note.note}</p>}
    <div className="dist-qr-row">
      <div className="dist-qr" role="img" aria-label={`QR code for delivery ${note.code}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div><p className="dist-code-label">Receiving code</p><p className="dist-code">{note.code}</p>
        <p className="po-doc-foot" style={{ marginTop: 4 }}>On arrival, scan the code (or type it) and count what came.</p>
        <p className="po-doc-foot dist-link" style={{ marginTop: 4 }}>{link}</p></div>
    </div>
  </article>;
}

/** The delivery note with its big QR, the code, Print or save as PDF, and Share. `transfer` is the server's transfer (with deliveryNote). */
export function DeliveryNote({ transfer, children }) {
  const { notify } = useNotifications();
  const note = transfer.deliveryNote;
  const link = note?.qr ? absolute(note.qr.path) : '';
  const svg = useQr(link);
  if (!note) return <Note tone="warn">The delivery note is not ready yet. It appears here once the goods have been sent.</Note>;
  const text = `Delivery ${note.ref} from ${note.from} to ${note.to}. Receiving code ${note.code}. Open: ${link}`;
  async function share() {
    try {
      if (navigator.share) { await navigator.share({ title: `Delivery ${note.ref}`, text, url: link }); return; }
      await navigator.clipboard.writeText(text);
      notify('The delivery details were copied. Paste them into WhatsApp or a message.');
    } catch (error) {
      if (error?.name !== 'AbortError') notify('Sharing did not work here. Print the note instead.');
    }
  }
  return <div className="inv-form">
    <NoteDocument note={note} svg={svg} link={link} />
    <PrintRoot><NoteDocument note={note} svg={svg} link={link} /></PrintRoot>
    <div className="po-send-actions">
      <button type="button" className="o-btn is-primary" onClick={() => window.print()}><OIcon name="printer" size={15} />Print or save as PDF</button>
      <button type="button" className="o-btn" onClick={share}><OIcon name="external" size={15} />Share</button>
    </div>
    {children}
  </div>;
}

/* ---------- the pick list ---------- */

function PickDocument({ list }) {
  return <article className="po-doc" aria-label={`Pick list ${list.request.ref}`}>
    <div className="po-doc-head"><div><h2>Pick list</h2><div>{list.request.ref}</div></div><div><strong>For {list.request.branchName}</strong></div></div>
    <table>
      <thead><tr><th scope="col">Item</th><th scope="col">Where it is kept</th><th scope="col" className="is-num">Take</th><th scope="col">Packed</th></tr></thead>
      <tbody>{list.lines.map((l) => <tr key={l.itemId}><td>{l.name}</td><td>{l.location}</td>
        <td className="is-num">{l.display}{l.pack ? ` (${formatNumber(l.pack.count)} ${l.pack.name})` : ''}</td><td>&#9633;</td></tr>)}</tbody>
    </table>
  </article>;
}

export function PickList({ list, onSend, onBack }) {
  return <div className="inv-form">
    <p className="o-field-hint">Take these from the shelves for {list.request.branchName}. Tick each one as you pack it.</p>
    {list.lines.length === 0 ? <Note tone="ok">Everything approved has been sent already.</Note>
      : <ul className="rcv-lines" aria-label="What to pack">{list.lines.map((l) => <li key={l.itemId} className="rcv-line">
        <label className="inv-check dist-pick"><input type="checkbox" aria-label={`Packed ${l.name}`} />
          <span><strong>{l.name}: {l.display}</strong>
            <small className="dist-sub">{l.pack ? `About ${formatNumber(l.pack.count)} ${l.pack.name}. ` : ''}Kept in: {l.location}</small></span></label>
      </li>)}</ul>}
    <PrintRoot><PickDocument list={list} /></PrintRoot>
    <div className="biz-form-actions">
      <button type="button" className="o-btn is-primary" onClick={onSend} disabled={!list.lines.length}>Send it now</button>
      <button type="button" className="o-btn" onClick={() => window.print()}><OIcon name="printer" size={15} />Print the pick list</button>
      <button type="button" className="o-btn is-quiet" onClick={onBack}>Close</button>
    </div>
  </div>;
}

/* ---------- receiving a delivery (the branch, or the Warehouse for a return) ---------- */

const DIFF = 0.00005;

function ReceiveLine({ line, state, options, onChange, id }) {
  const unit = state.unit;
  const label = unitLabel(options, unit);
  const factor = options.find((o) => o.value === unit)?.factor || 1;
  const outstanding = Number(line.outstanding) / factor;
  const set = (patch) => onChange({ ...state, ...patch });
  const num = (key, text, hint) => <div className="o-field"><label className="o-label" htmlFor={`${id}-${key}`}>{text}</label>
    <div className="inv-row"><input id={`${id}-${key}`} className="o-input inv-qty" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={state[key]} aria-label={`${line.name} ${hint}`}
      onChange={(event) => set({ [key]: event.target.value })} /><span className="inv-unit-text">{label}</span></div></div>;
  return <li className="rcv-line">
    <div className="rcv-line-head"><strong>{line.name}</strong><small>Sent {line.display}{Number(line.received) > 0 ? ` · already counted ${line.receivedDisplay}` : ''}</small></div>
    {options.length > 1 && <div className="o-field"><label className="o-label" htmlFor={`${id}-unit`}>Count {line.name} in</label>
      <select id={`${id}-unit`} className="o-select" value={unit} onChange={(event) => onChange({ ...state, ...Object.fromEntries(['good', 'damaged', 'over'].map((k) => [k, state[k] === '' ? '' : String(Math.round((Number(state[k]) * factor / (options.find((o) => o.value === event.target.value)?.factor || 1)) * 10000) / 10000)])), unit: event.target.value })}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>}
    <div className="rcv-line-grid">
      {num('good', 'Arrived in good order', 'arrived in good order')}
      {num('damaged', 'Damaged', 'damaged')}
    </div>
    <details className="rcv-more"><summary>Got more than was sent?</summary>
      <div className="rcv-line-grid">{num('over', 'Extra', 'extra')}</div></details>
    <p className="o-field-hint">Still expected: {formatNumber(outstanding)} {label}.</p>
  </li>;
}

/**
 * Count a delivery: per line what arrived well, what was damaged and what came extra; anything missing is "short". A note is needed
 * when something is not as sent. "More is coming" keeps the delivery open for the rest. `path` is the receive endpoint.
 */
export function ReceiveForm({ transfer, items, units, path, onClose, onDone, place = 'this branch' }) {
  const ids = useId();
  const { notify } = useNotifications();
  const open = transfer.lines.filter((l) => Number(l.outstanding) > 0);
  const lines = open.length ? open : transfer.lines;
  const [state, setState] = useState(() => Object.fromEntries(lines.map((l) => {
    const a = amountFor(l.outstanding, items.get(l.itemId), units, l.unit);
    return [l.itemId, { unit: a.unit, good: a.qty, damaged: '', over: '' }];
  })));
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const optionsOf = (l) => optionsFor(items.get(l.itemId), units, l.unit);
  const factorOfLine = (l) => optionsOf(l).find((o) => o.value === state[l.itemId].unit)?.factor || 1;

  const differences = lines.map((l) => {
    const s = state[l.itemId];
    const f = factorOfLine(l);
    const good = (Number(s.good) || 0) * f; const damaged = (Number(s.damaged) || 0) * f; const over = (Number(s.over) || 0) * f;
    const short = more ? 0 : Math.max(0, Number(l.outstanding) - good - damaged);
    return { l, good, damaged, over, short, differs: damaged > DIFF || over > DIFF || short > DIFF };
  });
  const anyDifference = differences.some((d) => d.differs);

  async function submit(event) {
    event.preventDefault();
    clearError();
    if (!differences.some((d) => d.good > DIFF || d.damaged > DIFF || d.over > DIFF) && !(!more && differences.some((d) => d.short > DIFF))) return setProblem('Enter what arrived before you confirm. Put 0 if nothing came.');
    if (anyDifference && !note.trim()) return setProblem('Something did not arrive as sent (short, damaged or extra). Write a note saying what happened.');
    setProblem('');
    const body = {
      lines: lines.map((l) => ({ itemId: l.itemId, received: String(Number(state[l.itemId].good) || 0), damaged: String(Number(state[l.itemId].damaged) || 0), over: String(Number(state[l.itemId].over) || 0), unit: state[l.itemId].unit })),
      ...(note.trim() ? { note: note.trim() } : {}), final: !more,
    };
    const made = await run('POST', path, body, { step: 'receive' });
    if (!made) return undefined;
    setResult(made);
    notify(made.closed ? 'Delivery received. The stock is now in your count.' : 'Part of the delivery was received. The rest is still coming.');
    onDone?.(made);
    return undefined;
  }

  if (result) {
    const t = result.transfer;
    return <div className="inv-form" aria-live="polite">
      <p className="o-field-hint"><strong>{t.ref}</strong> {result.closed ? 'is received.' : 'is partly received. You can receive the rest when it arrives.'}</p>
      <ul className="rcv-summary">
        {t.lines.filter((l) => Number(l.received) > 0).map((l) => <li key={l.itemId}><OIcon name="check" size={15} /><span>Added {l.receivedDisplay} {l.name} to {place}</span></li>)}
        {(result.discrepanciesOpened || []).map((d) => <li key={d.id}><OIcon name="info" size={15} /><span>{d.kind === 'short' ? 'Short' : d.kind === 'damaged' ? 'Damaged' : 'Extra'}: {d.display} of {d.name}. The owner was told.</span></li>)}
      </ul>
      <div className="biz-form-actions"><button type="button" className="o-btn is-primary" onClick={onClose}>Done</button></div>
    </div>;
  }

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <p className="o-field-hint">{transfer.ref} from {transfer.fromName}. What is still expected is filled in. Change only what is different.</p>
    <ul className="rcv-lines" aria-label="What arrived">{lines.map((l) => <ReceiveLine key={l.itemId} id={`${ids}-${l.itemId}`} line={l} state={state[l.itemId]} options={optionsOf(l)}
      onChange={(next) => setState((current) => ({ ...current, [l.itemId]: next }))} />)}</ul>
    {differences.filter((d) => d.differs).map((d) => <p key={d.l.itemId} className="inv-warn" role="status">
      {d.l.name}: {[d.short > DIFF && `${formatNumber(Math.round(d.short / factorOfLine(d.l) * 1000) / 1000)} ${unitLabel(optionsOf(d.l), state[d.l.itemId].unit)} short`,
        d.damaged > DIFF && `${formatNumber(Number(state[d.l.itemId].damaged))} ${unitLabel(optionsOf(d.l), state[d.l.itemId].unit)} damaged`,
        d.over > DIFF && `${formatNumber(Number(state[d.l.itemId].over))} ${unitLabel(optionsOf(d.l), state[d.l.itemId].unit)} extra`].filter(Boolean).join(', ')}.</p>)}
    <label className="inv-check dist-toggle"><input type="checkbox" checked={more} onChange={(event) => setMore(event.target.checked)} />More is coming: this is only part of the delivery</label>
    <div className="o-field"><label className="o-label" htmlFor={`${ids}-note`}>Note {anyDifference ? <span className="o-optional">Needed</span> : <span className="o-optional">Optional</span>}</label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} placeholder="For example: two boxes were wet" /></div>
    <FormError error={problem || error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : more ? 'Save what arrived' : 'Confirm what arrived'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/** Fills in a map of items by id from a list. */
export const byId = (list = []) => new Map(list.map((i) => [i.id, i]));
export const useItemMap = (list) => useMemo(() => byId(list), [list]);
export { factorOf };
