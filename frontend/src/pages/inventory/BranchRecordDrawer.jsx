// "Record stock" for a branch: three plain choices (Count, Add, Waste), the item, an amount with its unit, and a live line that says
// what the amount means ("40 crates = 400 kg"; for a count "You counted 4.8 kg; the system shows 5 kg, so 0.2 kg less").
// The server does the real arithmetic. A very large amount comes back as 409 confirm_large_amount: we show its message with the
// suggested fix and an "it is right" button. A failed save keeps its command id, so pressing again is a retry, never a double post.
import { useEffect, useId, useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { branchPaths, formatNumber, useInventoryWrite } from '../../lib/inventory';
import { FormError, QuantityInput, SkeletonRows } from './parts';

export const KINDS = [
  { value: 'count', label: 'Count', hint: 'What you counted now' },
  { value: 'add', label: 'Add', hint: 'Stock that came in' },
  { value: 'waste', label: 'Waste', hint: 'Spoiled, spilled or thrown away' },
];
const REASONS = ['Spoiled', 'Burned', 'Spilled', 'Expired', 'Other'];

const word = (unit, quantity) => (Number(quantity) === 1 ? unit.label : unit.plural);
const round = (value) => Math.round(value * 1000) / 1000;
const unitOf = (item, code) => (item?.units || []).find((u) => u.code === code);
const usualUnit = (item) => item?.units?.[0]?.code || item?.displayUnit || item?.baseUnit || '';
/** How `baseAmount` reads in the item's usual unit: { number, text } ("0.2", "0.2 kg"). */
function inUsual(item, baseAmount) {
  const unit = unitOf(item, usualUnit(item));
  if (!unit) return { number: baseAmount, text: formatNumber(baseAmount) };
  const number = round(baseAmount / Number(unit.factor));
  return { number, text: `${formatNumber(number)} ${word(unit, number)}` };
}

/** The line under the amount box. Returns null until there is something sensible to say. */
export function liveLine({ kind, item, quantity, unitCode }) {
  const entered = unitOf(item, unitCode);
  const q = Number(quantity);
  if (!item || !entered || !(q >= 0) || quantity === '') return null;
  const base = q * Number(entered.factor);
  const asTyped = `${formatNumber(q)} ${word(entered, q)}`;
  const usual = inUsual(item, base);
  const onHand = Number(item.onHand) || 0;
  if (kind === 'count') {
    const diff = base - onHand;
    if (Math.abs(diff) < 1e-6) return `You counted ${asTyped}; the system shows ${item.display.onHand}. No change.`;
    const gap = inUsual(item, Math.abs(diff));
    return `You counted ${asTyped}; the system shows ${item.display.onHand} → ${gap.text} ${diff < 0 ? 'less' : 'more'}.`;
  }
  if (q <= 0) return null;
  const same = entered.code === usualUnit(item);
  const left = inUsual(item, Math.max(onHand + (kind === 'add' ? base : -base), 0));
  if (kind === 'add') return `${same ? `Adding ${asTyped}` : `${asTyped} = ${usual.text}`}. You will have ${left.text}.`;
  if (base > onHand) return `${same ? `Writing off ${asTyped}` : `${asTyped} = ${usual.text}`}. That is more than the ${item.display.onHand} on hand.`;
  return `${same ? `Writing off ${asTyped}` : `${asTyped} = ${usual.text}`}. ${left.text} will be left.`;
}

export default function BranchRecordDrawer({ start, seeCost, items: known, onClose, onDone }) {
  const ids = useId();
  const { notify } = useNotifications();
  const all = useApi(branchPaths.snapshot({ all: true }), { ttl: 10000 });
  const items = all.data?.items || known || [];
  const canSeeCost = seeCost || all.data?.seeCost;
  const [kind, setKind] = useState(start.kind || 'count');
  const [itemId, setItemId] = useState(start.itemId || '');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [cost, setCost] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [run, { busy, error, clearError }] = useInventoryWrite();

  const item = useMemo(() => items.find((i) => i.id === itemId) || null, [items, itemId]);
  useEffect(() => { setUnit(usualUnit(item)); setCost(''); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = (item?.units || []).map((u) => ({ value: u.code, label: u.plural }));
  const entered = unitOf(item, unit);
  const line = liveLine({ kind, item, quantity, unitCode: unit });
  const large = error?.code === 'confirm_large_amount' ? error : null;
  const shownError = large ? null : error;

  const reset = () => { clearError(); setProblem(''); setConfirming(false); };
  const edit = (setter) => (value) => { setter(value); reset(); };

  async function save(confirmLarge = false, override = {}) {
    const q = override.quantity ?? quantity;
    const u = override.unit ?? unit;
    const typed = note.trim();
    const body = { kind, itemId, quantity: String(q), unit: u };
    if (kind === 'add' && canSeeCost && cost !== '') body.unitCost = String(cost);
    if (kind === 'waste') {
      // The server wants a note for every write-off: the typed words, or the chosen reason itself.
      body.note = typed || (reason && reason !== 'Other' ? reason.toLowerCase() : '');
      if (reason && reason !== 'Other' && typed) body.reasonCode = reason;
    } else if (typed) body.note = typed;
    if (confirmLarge) body.confirmLarge = true;
    // One command id per distinct write; "Yes, that is right" reuses the id of the attempt it follows.
    const result = await run('POST', branchPaths.record, body, { step: [kind, itemId, q, u, body.note || '', body.unitCost || ''].join('|') });
    if (result) {
      notify(result.message);
      (result.warnings || []).forEach((warning) => notify(warning, { type: 'info', duration: 9000 }));
      onDone(result);
    }
  }

  function submit(event) {
    event.preventDefault();
    reset();
    if (!item) return setProblem('Choose the item first.');
    if (quantity === '' || Number(quantity) < 0 || Number.isNaN(Number(quantity))) return setProblem(kind === 'count' ? 'Enter how much you counted.' : 'Enter how much.');
    if (kind !== 'count' && !(Number(quantity) > 0)) return setProblem('The amount must be more than zero.');
    if (kind === 'waste' && !reason && !note.trim()) return setProblem(`Say why ${item.name} was written off. Pick a reason or write a note.`);
    if (kind === 'waste' && reason === 'Other' && !note.trim()) return setProblem('Write a few words about what happened.');
    if (kind === 'waste' && !confirming) return setConfirming(true);
    return save(false);
  }

  const heading = { count: 'How much is there now?', add: 'How much came in?', waste: 'How much was thrown away?' }[kind];
  const submitLabel = busy ? 'Saving…' : kind === 'count' ? 'Save count' : kind === 'add' ? 'Add stock' : confirming ? 'Yes, write it off' : 'Write off';

  return <form className="inv-form inv-record" onSubmit={submit} noValidate>
    <fieldset className="inv-choice inv-kinds" disabled={busy}>
      <legend className="o-label">What are you recording?</legend>
      {KINDS.map((option) => <label key={option.value}>
        <input type="radio" name={`${ids}-kind`} value={option.value} checked={kind === option.value} onChange={() => { setKind(option.value); reset(); }} />
        <strong>{option.label}</strong><small>{option.hint}</small>
      </label>)}
    </fieldset>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-item`}>Item</label>
      {all.loading && !items.length ? <SkeletonRows rows={1} thumb={false} label="Loading items" /> : <select id={`${ids}-item`} className="o-select" value={itemId} onChange={(event) => edit(setItemId)(event.target.value)} disabled={busy}>
        <option value="">Choose an item…</option>
        {items.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>}
      {!all.loading && !items.length && <p className="o-field-hint">There are no items yet. The business owner adds them under Items.</p>}
      {item && <p className="o-field-hint">On hand now: <strong>{item.display.onHand}</strong>{Number(item.heldForOrders) > 0 ? ` · ${item.display.heldForOrders} held for open orders` : ''}</p>}
    </div>

    {item && <>
      <div className="o-field">
        <span className="o-label" id={`${ids}-q`}>{heading}</span>
        <QuantityInput id={`${ids}-qty`} label={heading} value={quantity} onChange={edit(setQuantity)} unit={unit} choices={choices} onUnit={edit(setUnit)} placeholder="0" />
        {line && <p className="inv-live" aria-live="polite">{line}</p>}
      </div>

      {kind === 'add' && canSeeCost && <div className="o-field">
        <QuantityInput id={`${ids}-cost`} label={`Cost per ${entered ? entered.label : 'unit'} in KES (optional)`} value={cost} onChange={edit(setCost)}
          unit={`KES per ${entered ? entered.label : 'unit'}`} placeholder="Cost (optional)" />
        <p className="o-field-hint">Optional. It keeps your food cost accurate.</p>
      </div>}

      {kind === 'waste' && <div className="o-field">
        <span className="o-label" id={`${ids}-why`}>Why?</span>
        <div className="inv-reasons" role="group" aria-labelledby={`${ids}-why`}>
          {REASONS.map((name) => <button key={name} type="button" className="inv-reason" aria-pressed={reason === name} onClick={() => { setReason(reason === name ? '' : name); reset(); }}>{name}</button>)}
        </div>
      </div>}

      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-note`}>{kind === 'waste' ? 'What happened? (needed if you pick Other)' : 'Note (optional)'}</label>
        <input id={`${ids}-note`} className="o-input" value={note} maxLength={200} onChange={(event) => edit(setNote)(event.target.value)} />
      </div>
    </>}

    {large && <div className="inv-confirm" role="alert">
      <span>{large.message}</span>
      <div className="inv-confirm-actions">
        {large.details?.suggestion && <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => {
          const { quantity: nextQuantity, unit: nextUnit } = large.details.suggestion;
          clearError(); setQuantity(String(nextQuantity)); if (nextUnit) setUnit(nextUnit);
        }}>Use {large.details.suggestion.quantity} {large.details.suggestion.unit} instead</button>}
        <button type="button" className="o-btn" disabled={busy} onClick={() => save(true)}>Yes, {formatNumber(quantity)} {entered ? word(entered, quantity) : unit} is right</button>
      </div>
    </div>}

    {confirming && !error && !problem && <div className="inv-confirm" role="alert">
      <span>Write off {formatNumber(quantity)} {entered ? word(entered, quantity) : unit} of {item?.name}? This can’t be undone. If it was a mistake, count the item again to correct it.</span>
    </div>}
    <FormError error={problem || shownError} />
    <div className="biz-form-actions">
      <button type="submit" className={`o-btn ${kind === 'waste' && confirming ? 'is-danger' : 'is-primary'}`} disabled={busy || !item}>{submitLabel}</button>
      <button type="button" className="o-btn is-quiet" onClick={confirming ? () => setConfirming(false) : onClose} disabled={busy}>{confirming ? 'Back' : 'Cancel'}</button>
    </div>
  </form>;
}
