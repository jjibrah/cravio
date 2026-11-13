import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatPrice } from '../../lib/format';
import Sheet from '../Sheet';
import { useNotifications } from '../notifications/NotificationProvider';
import Glyph from '../media/Glyph';
import CodeScanner, { canScanInApp, cleanCode } from './CodeScanner';
import { InlineError } from './OpsCards';
import { useLive } from './LiveProvider';
import useStaffMenu from './useStaffMenu';

const groupCode = (code = '') => `${code.slice(0, 3)} ${code.slice(3)}`.trim();
const MAX_QTY = 50;

const extrasKey = (extras = []) => extras.map((extra) => extra.id).sort().join(',');
export const lineKeyOf = (line) => `${line.kind}:${line.kind === 'deal' ? line.dealId : line.itemId}:${extrasKey(line.extras)}:${line.note || ''}`;
export const unitTotalOf = (line) => Number(line.unitPrice) + (line.extras || []).reduce((sum, extra) => sum + Number(extra.price || 0), 0);
/** "+ Cheese, + Bacon" */
export const extrasText = (extras = []) => extras.map((extra) => `+ ${extra.name}`).join(', ');
/** "Classic beef burger, Chips, 2× Tusker" */
export const componentsText = (parts = []) => parts.map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ');

/** Turns a looked-up guest cart into editable lines (dishes with extras, and deals) plus what had to be dropped. Prices are the server's. */
export function linesFromCart(cart) {
  const lines = [];
  const dropped = [];
  for (const line of cart.items) {
    const kind = line.kind === 'deal' ? 'deal' : 'item';
    if (line.available === false || (kind === 'item' ? !line.itemId : !line.dealId)) { dropped.push(line); continue; }
    const next = {
      kind, itemId: kind === 'item' ? line.itemId : null, dealId: kind === 'deal' ? line.dealId : null, name: line.name,
      unitPrice: Number(line.unitPrice), extras: (line.extras || []).map(({ id, name, price }) => ({ id, name, price: Number(price) })),
      components: line.components || null, quantity: line.quantity, note: line.note || '',
    };
    next.key = lineKeyOf(next);
    const existing = lines.find((l) => l.key === next.key);
    if (existing) existing.quantity += line.quantity;
    else lines.push(next);
  }
  return { lines, dropped };
}

/** Pick extras for one dish, then add it as its own line. */
function ExtrasSheet({ item, onClose, onAdd }) {
  const [chosen, setChosen] = useState(() => new Set());
  useEffect(() => { setChosen(new Set()); }, [item?.id]);
  const extras = (item?.extras || []).filter((extra) => extra.available);
  const total = item ? Number(item.price) + extras.filter((extra) => chosen.has(extra.id)).reduce((sum, extra) => sum + extra.price, 0) : 0;
  return <Sheet open={Boolean(item)} onClose={onClose} title={item ? `${item.name}: extras` : 'Extras'} className="w-sheet">
    {item && <div className="w-extras">
      <p className="w-muted">{formatPrice(item.price, item.currency)} · tap the extras the guest wants.</p>
      <div className="w-extra-list" role="group" aria-label={`Extras for ${item.name}`}>
        {extras.map((extra) => <button key={extra.id} type="button" className={`w-extra${chosen.has(extra.id) ? ' is-on' : ''}`} aria-pressed={chosen.has(extra.id)}
          onClick={() => setChosen((current) => { const next = new Set(current); if (next.has(extra.id)) next.delete(extra.id); else next.add(extra.id); return next; })}>
          <span>+ {extra.name}</span><span>{extra.price ? formatPrice(extra.price) : 'Free'}</span>
        </button>)}
        {(item.extras || []).filter((extra) => !extra.available).map((extra) => <span key={extra.id} className="w-extra is-off">+ {extra.name}<span className="w-sold-out">Sold out</span></span>)}
      </div>
      <button type="button" className="w-btn w-btn-primary w-btn-big" onClick={() => onAdd(item, extras.filter((extra) => chosen.has(extra.id)))}>Add · {formatPrice(total)}</button>
    </div>}
  </Sheet>;
}

/**
 * Scanning (or typing) the guest's 6-character code after they tapped "Ready to order".
 * Calls onCart(cart, via) once found: via is 'scan' (their QR) or 'typed' (the code from their screen).
 */
export function ImportBox({ onCart }) {
  const inputId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const lookup = useCallback(async (value, via = 'typed') => {
    const clean = cleanCode(value);
    if (clean.length !== 6) { setError('Cart codes are 6 letters and numbers, like ACD347.'); return; }
    setBusy(true); setError('');
    try {
      const { cart } = await api(`/api/ops/carts/${clean}`);
      setCode('');
      onCart(cart, via);
    } catch (lookupError) {
      setError(lookupError.message);
    } finally { setBusy(false); }
  }, [onCart]);
  const onScanned = useCallback((scanned) => { setScanning(false); setCode(scanned); lookup(scanned, 'scan'); }, [lookup]);

  return <section className="w-card w-import" aria-labelledby={`${inputId}-t`}>
    <h2 id={`${inputId}-t`} className="w-import-title"><Glyph name="qr" size={20} />Scan the guest’s code</h2>
    <p className="w-muted">Ask the guest to tap “Ready to order”, then scan their QR. If the camera can’t read it, type the code under the QR.</p>
    <button type="button" className="w-btn w-btn-primary w-btn-big" onClick={() => setScanning(true)}><Glyph name="scan" size={20} />Scan code</button>
    <form className="w-import-row" onSubmit={(event) => { event.preventDefault(); lookup(code, 'typed'); }}>
      <label className="visually-hidden" htmlFor={inputId}>Guest’s code</label>
      <input id={inputId} className="w-code-input" value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code} onChange={(event) => { setCode(cleanCode(event.target.value)); setError(''); }}
        placeholder="ACD 347" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} inputMode="text" maxLength={8}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-e` : undefined} />
      <button type="submit" className="w-btn w-btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Finding…' : 'Find'}</button>
    </form>
    {error && <p className="w-error" id={`${inputId}-e`} role="alert"><Glyph name="alert" size={15} />{error}</p>}
    {!canScanInApp() && <p className="w-fineprint">Tip: your phone’s camera app can scan it too. The link opens the order here.</p>}
    <CodeScanner open={scanning} onClose={() => setScanning(false)} onCode={onScanned}
      onType={() => { setScanning(false); document.getElementById(inputId)?.focus(); }} />
  </section>;
}

function NoteButton({ line, onChange }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(line.note || '');
  if (!editing) return <button type="button" className="w-note-button" onClick={() => { setValue(line.note || ''); setEditing(true); }}>
    <Glyph name="note" size={14} />{line.note ? <span>{line.note}</span> : 'Add note'}<span className="visually-hidden"> for {line.name}</span>
  </button>;
  const save = () => { onChange(value.trim().slice(0, 140)); setEditing(false); };
  return <div className="w-note-edit">
    <label className="visually-hidden" htmlFor={id}>Note for {line.name}</label>
    <input id={id} autoFocus value={value} maxLength={140} placeholder="e.g. No onions" onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
    <button type="button" className="w-btn w-btn-primary w-btn-small" onClick={save}>Save</button>
  </div>;
}

function Stepper({ label, quantity, onMinus, onPlus, max = MAX_QTY }) {
  return <div className="w-stepper" role="group" aria-label={`${label} quantity`}>
    <button type="button" aria-label={quantity === 1 ? `Remove ${label}` : `One less ${label}`} onClick={onMinus}><Glyph name={quantity === 1 ? 'trash' : 'minus'} size={17} /></button>
    <output aria-live="polite">{quantity}</output>
    <button type="button" aria-label={`One more ${label}`} onClick={onPlus} disabled={quantity >= max}><Glyph name="plus" size={17} /></button>
  </div>;
}

/**
 * Confirms an order at the table (docs/ORDER-FLOW.md):
 * - with the guest's code (scanned or typed): "Check with the guest" lists their order, the waiter edits it with
 *   them, asks "Is that all?" and taps Confirm order (POST /api/ops/orders with cartCode and via). The order is
 *   created Confirmed; the guest's phone shows "Order confirmed".
 * - without a phone ("No phone? Enter the order yourself"): a fast item picker (chips, search, big + buttons) and a
 *   review; the order is marked as not confirmed by the guest.
 */
export default function OrderComposer({ table, onChangeTable, initialCart = null, initialVia = 'typed', allowImport = true }) {
  const menu = useStaffMenu();
  const { actions } = useLive();
  const { notify } = useNotifications();
  const initial = useMemo(() => (initialCart ? linesFromCart(initialCart) : { lines: [], dropped: [] }), [initialCart]);
  const [lines, setLines] = useState(initial.lines);
  const [cart, setCart] = useState(initialCart);
  const [dropped, setDropped] = useState(initial.dropped);
  const [cartTable, setCartTable] = useState(initialCart?.table?.number ?? null);
  const [via, setVia] = useState(initialVia === 'scan' ? 'scan' : 'typed');
  const [stage, setStage] = useState(initialCart ? 'review' : 'build');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const topRef = useRef(null);

  const [extrasFor, setExtrasFor] = useState(null);
  const tableNumber = table === 'takeaway' ? null : (table ?? cartTable);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = lines.reduce((sum, line) => sum + line.quantity * unitTotalOf(line), 0);
  const qtyOf = (kind, id) => lines.filter((line) => line.kind === kind && (kind === 'deal' ? line.dealId : line.itemId) === id).reduce((sum, line) => sum + line.quantity, 0);

  /** Adds one dish (with chosen extras) or one deal, merging into an identical line without a note. */
  const addLine = (fresh) => setLines((current) => {
    const key = lineKeyOf({ ...fresh, note: '' });
    const existing = current.find((line) => line.key === key);
    if (existing) return current.map((line) => line === existing ? { ...line, quantity: Math.min(MAX_QTY, line.quantity + 1) } : line);
    return [...current, { ...fresh, note: '', quantity: 1, key }];
  });
  const add = (item, extras = []) => addLine({ kind: 'item', itemId: item.id, dealId: null, name: item.name, unitPrice: Number(item.price), extras: extras.map(({ id, name, price }) => ({ id, name, price })), components: null });
  const addDeal = (deal) => addLine({ kind: 'deal', itemId: null, dealId: deal.id, name: deal.name, unitPrice: Number(deal.price), extras: [], components: deal.items.map(({ itemId, name, quantity, unitPrice }) => ({ itemId, name, quantity, unitPrice })) });
  const changeLine = (key, fn) => setLines((current) => current.map((line) => {
    if (line.key !== key) return line;
    const next = fn(line);
    return { ...next, key: lineKeyOf(next) };
  }).filter((line) => line.quantity > 0));
  const minus = (kind, id) => setLines((current) => {
    const last = [...current].reverse().find((line) => line.kind === kind && (kind === 'deal' ? line.dealId : line.itemId) === id);
    if (!last) return current;
    return current.map((line) => line === last ? { ...line, quantity: line.quantity - 1 } : line).filter((line) => line.quantity > 0);
  });

  const importCart = useCallback((found, how = 'typed') => {
    const { lines: imported, dropped: lost } = linesFromCart(found);
    setLines(imported);
    setDropped(lost);
    setCart(found);
    setVia(how === 'scan' ? 'scan' : 'typed');
    setCartTable(found.table?.number ?? null);
    setError('');
    setStage('review');
    topRef.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const clearImport = () => { setCart(null); setDropped([]); setCartTable(null); setLines([]); };

  const showDeals = category === '' || category === 'deals';
  const visible = useMemo(() => {
    if (menu.status !== 'ready' || category === 'deals') return [];
    const q = query.trim().toLowerCase();
    return menu.items.filter((item) => (!category || item.categoryId === category) && (!q || item.name.toLowerCase().includes(q)));
  }, [menu, category, query]);
  const visibleDeals = useMemo(() => {
    if (menu.status !== 'ready' || !showDeals) return [];
    const q = query.trim().toLowerCase();
    return (menu.deals || []).filter((deal) => !q || deal.name.toLowerCase().includes(q) || deal.items.some((part) => part.name.toLowerCase().includes(q)));
  }, [menu, showDeals, query]);

  async function send() {
    if (!lines.length || busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        tableNumber: tableNumber ?? null,
        items: lines.map((line) => (line.kind === 'deal'
          ? { dealId: line.dealId, quantity: line.quantity, ...(line.note ? { note: line.note } : {}) }
          : { itemId: line.itemId, quantity: line.quantity, ...(line.extras.length ? { extraIds: line.extras.map((extra) => extra.id) } : {}), ...(line.note ? { note: line.note } : {}) })),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(cart ? { cartCode: cart.code, via } : {}),
      };
      const { order } = await api('/api/ops/orders', { method: 'POST', body });
      actions.created(order, cart?.code);
      notify(`Order #${order.shortId} ${cart ? 'confirmed' : 'entered'}${order.table ? ` for Table ${order.table.number}` : ''}`);
      setSent(order);
      setStage('sent');
      topRef.current?.scrollIntoView?.({ block: 'start' });
    } catch (sendError) {
      const details = sendError.details || {};
      const at = Number.isInteger(details.index) ? lines[details.index] : null;
      if (details.extraId && ['extra_sold_out', 'extra_missing'].includes(details.reason)) {
        setLines((current) => current.map((line) => {
          if (!(line.extras || []).some((extra) => extra.id === details.extraId)) return line;
          const next = { ...line, extras: line.extras.filter((extra) => extra.id !== details.extraId) };
          return { ...next, key: lineKeyOf(next) };
        }));
        setError(`${sendError.message} We took that extra off. Check the list and send again.`);
        menu.reload();
      } else if (details.dealId || at?.kind === 'deal') {
        const dealId = details.dealId || at.dealId;
        setLines((current) => current.filter((line) => line.dealId !== dealId));
        setError(`${sendError.message} We took the deal off the order. Check the list and send again.`);
        menu.reload();
      } else if (['sold_out', 'missing'].includes(details.reason) && details.itemId) {
        setLines((current) => current.filter((line) => line.itemId !== details.itemId));
        setError(`${sendError.message} We took it off the order. Check the list and send again.`);
        menu.reload();
      } else if (sendError.status === 410) {
        setError('The guest’s code expired. Ask them to tap “Ready to order” again, then scan the new code. Your changes are still here.');
      } else {
        setError(sendError.message);
      }
    } finally { setBusy(false); }
  }

  if (stage === 'sent' && sent) {
    const manual = sent.confirmation === 'manual' || (!sent.confirmation && sent.source !== 'guest_cart');
    return <div ref={topRef} className="w-sent" role="status">
      <span className="w-sent-icon"><Glyph name="check" size={34} strokeWidth={2.4} /></span>
      <h2>{manual ? 'Order entered' : 'Order confirmed'}</h2>
      <p>#{sent.shortId} · {sent.table ? `Table ${sent.table.number}` : 'Takeaway'} · {formatPrice(sent.total, sent.currency)}</p>
      <p className="w-muted">{manual
        ? 'It’s marked as not confirmed by the guest. Mark it served from Services when it reaches the table.'
        : 'The guest’s phone now shows it’s confirmed. Mark it served from Services when it reaches the table.'}</p>
      <div className="w-stack">
        <Link className="w-btn w-btn-primary w-btn-big" to="/waiter/services">Go to Services</Link>
        <Link className="w-btn w-btn-secondary w-btn-big" to="/waiter">Back to tables</Link>
      </div>
    </div>;
  }

  const tableBar = <div className="w-table-bar">
    <span className="w-table-chip" aria-hidden="true">{tableNumber ?? <Glyph name="bag" size={18} />}</span>
    <span className="w-table-bar-text"><strong>{tableNumber ? `Table ${tableNumber}` : table === 'takeaway' ? 'Takeaway' : 'No table yet'}</strong>
      {cart && <span>Guest’s list {groupCode(cart.code)}</span>}</span>
    {onChangeTable && <button type="button" className="w-btn w-btn-quiet w-btn-small" onClick={onChangeTable}>Change table</button>}
  </div>;

  if (stage === 'review') {
    const withGuest = Boolean(cart);
    return <div ref={topRef} className="w-compose">
      {tableBar}
      {withGuest
        ? <><h2 className="w-check-title">Check with the guest</h2>
          <p className="w-check-sub">Read their order back to them and change anything they ask for.</p></>
        : <h2 className="w-section-title">Review order</h2>}
      {dropped.length > 0 && <p className="w-warning" role="status"><Glyph name="alert" size={15} />Not available any more: {dropped.map((line) => line.name).join(', ')}. Tell the guest and pick something else.</p>}
      <ul className="w-review-lines" aria-label="Order lines">
        {lines.map((line) => <li key={line.key}>
          <div className="w-review-main">
            <strong>{line.name}{line.kind === 'deal' && <span className="w-deal-tag">Deal</span>}</strong>
            {line.extras.length > 0 && <span className="w-line-extras">{extrasText(line.extras)}</span>}
            {line.kind === 'deal' && line.components?.length > 0 && <span className="w-line-extras">{componentsText(line.components)}</span>}
            <span className="w-muted">{formatPrice(unitTotalOf(line))} each · {formatPrice(unitTotalOf(line) * line.quantity)}</span>
            <NoteButton line={line} onChange={(value) => changeLine(line.key, (l) => ({ ...l, note: value }))} />
          </div>
          <Stepper label={line.name} quantity={line.quantity} onMinus={() => changeLine(line.key, (l) => ({ ...l, quantity: l.quantity - 1 }))} onPlus={() => changeLine(line.key, (l) => ({ ...l, quantity: Math.min(MAX_QTY, l.quantity + 1) }))} />
        </li>)}
      </ul>
      {!lines.length && <p className="w-empty-line">No dishes left. Go back and add some.</p>}
      <div className="w-field">
        <label htmlFor="w-order-note">Note for the whole order <span>(optional)</span></label>
        <input id="w-order-note" value={note} maxLength={280} placeholder="e.g. Birthday, bring candles" onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="w-total"><span>Total</span><strong>{formatPrice(total)}</strong></div>
      {withGuest
        ? <p className="w-check-ask"><Glyph name="hand" size={20} />Is that all?</p>
        : <p className="w-manual-note"><Glyph name="alert" size={15} />Entered without the guest’s code, so it will be marked as not confirmed by the guest.</p>}
      {!tableNumber && table !== 'takeaway' && <p className="w-error" role="alert"><Glyph name="alert" size={15} />Choose a table first.</p>}
      <InlineError>{error}</InlineError>
      <div className="w-sticky-actions">
        <button type="button" className="w-btn w-btn-secondary" onClick={() => setStage('build')}><Glyph name={withGuest ? 'plus' : 'back'} size={18} />Add more</button>
        <button type="button" className="w-btn w-btn-primary w-btn-grow" disabled={!lines.length || busy || (!tableNumber && table !== 'takeaway')} onClick={send}>
          {busy ? 'Saving…' : `${withGuest ? 'Confirm order' : 'Enter order'} · ${formatPrice(total)}`}
        </button>
      </div>
    </div>;
  }

  return <div ref={topRef} className="w-compose">
    {tableBar}
    {cart ? <div className="w-imported" role="status">
      <Glyph name="check" size={18} />
      <span><strong>The guest’s order</strong>{lines.length} line{lines.length === 1 ? '' : 's'} · code {groupCode(cart.code)}. Add what they ask for, then check it with them.</span>
      {allowImport && <button type="button" className="w-btn w-btn-quiet w-btn-small" onClick={clearImport}>Undo</button>}
    </div> : allowImport && <ImportBox onCart={importCart} />}
    {dropped.length > 0 && <p className="w-warning" role="status"><Glyph name="alert" size={15} />Not available any more: {dropped.map((line) => line.name).join(', ')}. Tell the guest and pick something else.</p>}

    {cart || !allowImport ? <h2 className="w-section-title">{cart ? 'Add more dishes' : 'Dishes'}</h2>
      : <div className="w-manual-head">
        <h2 className="w-section-title">No phone? Enter the order yourself</h2>
        <p className="w-manual-note"><Glyph name="alert" size={15} />It’ll be marked as not confirmed by the guest.</p>
      </div>}
    <div className="w-search">
      <Glyph name="search" size={18} />
      <label className="visually-hidden" htmlFor="w-order-search">Search dishes</label>
      <input id="w-order-search" type="search" placeholder="Search dishes" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
    </div>
    {menu.status === 'ready' && <div className="w-chips" role="group" aria-label="Categories">
      <button type="button" className={`w-chip${!category ? ' is-on' : ''}`} aria-pressed={!category} onClick={() => setCategory('')}>All</button>
      {menu.deals?.length > 0 && <button type="button" className={`w-chip${category === 'deals' ? ' is-on' : ''}`} aria-pressed={category === 'deals'} onClick={() => setCategory('deals')}>Deals</button>}
      {menu.categories.map((c) => <button key={c.id} type="button" className={`w-chip${category === c.id ? ' is-on' : ''}`} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}
    </div>}
    {menu.status === 'ready' && visibleDeals.length > 0 && <ul className="w-pick-list w-deal-list" aria-label="Deals">
      {visibleDeals.map((deal) => {
        const qty = qtyOf('deal', deal.id);
        return <li key={deal.id} className={`w-pick${deal.available ? '' : ' is-sold-out'}${qty ? ' is-picked' : ''}`}>
          <span className="w-pick-text"><strong>{deal.name}<span className="w-deal-tag">Deal</span></strong>
            <span>{formatPrice(deal.price, deal.currency)}{deal.saving > 0 && <s>{formatPrice(deal.regularPrice)}</s>}{!deal.available && <span className="w-sold-out">{deal.unavailableReason}</span>}</span>
            <span className="w-line-extras">{componentsText(deal.items)}</span></span>
          {deal.available && (qty
            ? <Stepper label={deal.name} quantity={qty} onMinus={() => minus('deal', deal.id)} onPlus={() => addDeal(deal)} />
            : <button type="button" className="w-pick-add" aria-label={`Add ${deal.name}`} onClick={() => addDeal(deal)}><Glyph name="plus" size={20} strokeWidth={2.2} /></button>)}
        </li>;
      })}
    </ul>}
    {menu.status === 'loading' && <div className="w-stack" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="w-row-skeleton" />)}</div>}
    {menu.status === 'error' && <p className="w-error" role="alert"><Glyph name="alert" size={15} />{menu.error} <button type="button" className="w-btn w-btn-quiet w-btn-small" onClick={menu.reload}>Retry</button></p>}
    {menu.status === 'ready' && category !== 'deals' && <ul className="w-pick-list" aria-label="Dishes">
      {visible.map((item) => {
        const qty = qtyOf('item', item.id);
        const hasExtras = item.extras?.some((extra) => extra.available);
        return <li key={item.id} className={`w-pick${item.available ? '' : ' is-sold-out'}${qty ? ' is-picked' : ''}`}>
          <span className="w-pick-text"><strong>{item.name}</strong><span>{formatPrice(item.price, item.currency)}{!item.available && <span className="w-sold-out">Sold out</span>}</span></span>
          {item.available && hasExtras && <button type="button" className="w-btn w-btn-secondary w-btn-small w-extras-button" aria-label={`Add ${item.name} with extras`} onClick={() => setExtrasFor(item)}>Extras</button>}
          {item.available && (qty
            ? <Stepper label={item.name} quantity={qty} onMinus={() => minus('item', item.id)} onPlus={() => add(item)} />
            : <button type="button" className="w-pick-add" aria-label={`Add ${item.name}`} onClick={() => add(item)}><Glyph name="plus" size={20} strokeWidth={2.2} /></button>)}
        </li>;
      })}
      {!visible.length && !visibleDeals.length && <li className="w-empty-line">No dishes match.</li>}
    </ul>}

    <ExtrasSheet item={extrasFor} onClose={() => setExtrasFor(null)} onAdd={(item, extras) => { add(item, extras); setExtrasFor(null); }} />
    <div className="w-sticky-actions">
      <button type="button" className="w-btn w-btn-primary w-btn-grow w-btn-big" disabled={!count} onClick={() => { setStage('review'); setError(''); topRef.current?.scrollIntoView?.({ block: 'start' }); }}>
        {count ? `${cart ? 'Check with the guest' : 'Review order'} · ${count} item${count === 1 ? '' : 's'} · ${formatPrice(total)}` : 'Add dishes to continue'}
      </button>
    </div>
  </div>;
}
