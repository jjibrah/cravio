// Create or edit a draft purchase order (P2-14): supplier, where it goes, when you need it, and the lines. Each line is an item, an
// amount in the pack you buy it in (crates, kg, trays...) with what that is in the item's usual unit, and a price per pack that
// starts from the supplier's price list. Totals update as you type. Saving keeps a draft; submitting is done from the order.
import { useEffect, useId, useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import {
  estimateTotals, factorOf, formatNumber, formatStockMoney, round2, sayAmount, todayNairobi, unitChoices, unitWord, useInventoryWrite,
} from '../../lib/inventory';
import { FormError, OIcon, SkeletonRows } from './parts';
import { ItemPicker, MoneyBox, Note } from './PurchasingParts';

let keySeed = 0;
const nextKey = () => `line-${++keySeed}`;

/** The supplier's price in force for an item, expressed for `unit` (their own pack price, or converted from the per-base price). null when none. */
function listPriceFor(prices, item, unit, units) {
  const rows = prices.filter((p) => p.itemId === item.id);
  if (!rows.length) return null;
  const same = rows.find((p) => String(p.unit).toLowerCase() === String(unit).toLowerCase());
  if (same) return Number(same.price);
  const factor = factorOf(unit, item, units);
  const perBase = Number(rows[0].pricePerBase);
  return perBase > 0 && factor ? round2(perBase * factor) : null;
}

/** The unit a new line starts in: the one the supplier prices it in, else a pack you buy in, else the item's usual unit. */
function firstUnit(prices, item, units) {
  const choices = unitChoices(item, units);
  const wanted = [prices.find((p) => p.itemId === item.id)?.unit, (item.units || []).find((u) => u.forPurchase)?.name, item.displayUnit, item.baseUnit]
    .filter(Boolean).map((u) => String(u).toLowerCase());
  for (const unit of wanted) { const found = choices.find((c) => c.value.toLowerCase() === unit); if (found) return found.value; }
  return choices[0]?.value || item.baseUnit;
}

const placeLabel = (l) => (l.kind === 'branch' ? l.name : l.name === 'Warehouse' ? 'Warehouse' : `${l.name} (Warehouse)`);

export default function PoEditor({ ctx, order, onSaved, onCancel }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const units = ctx.data.units;
  const vatPct = Number(ctx.data.settings?.vat_standard_pct ?? 16) || 16;
  const places = ctx.data.locations.filter((l) => l.capabilities?.includes('inv.purchase.create'));
  const deliverOptions = places.length ? places : ctx.data.locations;
  const items = ctx.data.items.filter((item) => !item.archived);

  const suppliers = useApi(ctx.paths.suppliers({ status: 'active' }), { ttl: 15000 });
  const [supplierId, setSupplierId] = useState(order?.supplier?.id || '');
  const detail = useApi(supplierId ? ctx.paths.supplier(supplierId) : null, { ttl: 15000 });
  const prices = useMemo(() => detail.data?.prices || [], [detail.data]);
  const [deliverTo, setDeliverTo] = useState(order?.deliverTo?.id || ctx.data.warehouse?.id || deliverOptions[0]?.id || '');
  const [expected, setExpected] = useState(order?.expectedDate || '');
  const [notes, setNotes] = useState(order?.notes || '');
  const [lines, setLines] = useState(() => (order?.lines || []).map((l) => ({
    key: nextKey(), item: ctx.data.items.find((i) => i.id === l.itemId) || { id: l.itemId, name: l.itemName, baseUnit: 'g', units: [] },
    qty: String(l.qty), unit: l.unit, price: l.unitPrice ?? '',
  })));

  const setLine = (key, patch) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const isEdited = (line) => { const list = listPriceFor(prices, line.item, line.unit, units); return list !== null && line.price !== '' && Number(line.price) !== list; };

  function changeSupplier(id) {
    setSupplierId(id);
    // Another supplier means another price list: the lines start again from the new list (the amounts stay).
    setLines((current) => current.map((l) => ({ ...l, price: '' })));
  }
  function addLine(item) {
    const unit = firstUnit(prices, item, units);
    const list = listPriceFor(prices, item, unit, units);
    setLines((current) => [...current, { key: nextKey(), item, qty: '', unit, price: list === null ? '' : String(list) }]);
  }
  function changeUnit(line, unit) {
    const list = listPriceFor(prices, line.item, unit, units);
    setLine(line.key, { unit, price: list === null ? '' : String(list) });
  }

  // When a supplier's prices arrive, lines still without a price start from that list (typed prices are never replaced).
  useEffect(() => {
    setLines((current) => (current.some((l) => l.price === '' && listPriceFor(prices, l.item, l.unit, units) !== null)
      ? current.map((l) => { const list = l.price === '' ? listPriceFor(prices, l.item, l.unit, units) : null; return list === null ? l : { ...l, price: String(list) }; })
      : current));
  }, [prices, units]);
  const priced = lines;
  const sums = estimateTotals(priced.map((l) => ({ qty: l.qty, price: l.price, vatClass: l.item.vatClass })), vatPct);
  const complete = priced.length > 0 && priced.every((l) => Number(l.qty) > 0 && l.price !== '' && Number(l.price) >= 0);
  const valid = supplierId && deliverTo && complete;

  async function submit(event) {
    event.preventDefault();
    if (!valid) return;
    const body = {
      supplierId, deliverToLocationId: deliverTo, expectedDate: expected || null, notes: notes.trim(),
      lines: priced.map((l) => {
        const list = listPriceFor(prices, l.item, l.unit, units);
        const typed = list === null || Number(l.price) !== list;
        return { itemId: l.item.id, qty: String(l.qty).trim(), unit: l.unit, ...(typed ? { price: String(l.price).trim() } : {}) };
      }),
    };
    const result = order ? await run('PATCH', ctx.paths.purchaseOrder(order.id), body, { step: 'edit' }) : await run('POST', ctx.paths.purchaseOrders(), body, { step: 'create' });
    if (!result) return;
    notify(order ? 'Order saved.' : 'Draft order saved. Check it, then submit it.');
    onSaved(result.order);
  }

  const today = todayNairobi();
  return <form className="inv-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-supplier`}>Supplier</label>
      <select id={`${ids}-supplier`} className="o-select" value={supplierId} onChange={(event) => changeSupplier(event.target.value)} data-autofocus>
        <option value="">Choose a supplier</option>
        {(suppliers.data?.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        {order && !(suppliers.data?.suppliers || []).some((s) => s.id === order.supplier.id) && <option value={order.supplier.id}>{order.supplier.name}</option>}
      </select>
      {suppliers.data && !suppliers.data.suppliers.length && <p className="o-field-hint">You have no active suppliers yet. Add one under Suppliers first.</p>}
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-to`}>Deliver to</label>
      <select id={`${ids}-to`} className="o-select" value={deliverTo} onChange={(event) => setDeliverTo(event.target.value)}>
        {deliverOptions.map((l) => <option key={l.id} value={l.id}>{placeLabel(l)}</option>)}
      </select>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-date`}>Needed by <span className="o-optional">Optional</span></label>
      <input id={`${ids}-date`} className="o-input" type="date" min={today} value={expected} onChange={(event) => setExpected(event.target.value)} />
    </div>

    <section className="inv-section" aria-labelledby={`${ids}-lines`}>
      <h3 id={`${ids}-lines`}>What to order</h3>
      {supplierId && detail.data && ctx.can.costView && !prices.length && <Note tone="warn">This supplier has no prices yet. You can type the prices below, or add them on the Suppliers page.</Note>}
      <ul className="po-lines">{priced.map((line, index) => {
        const item = line.item;
        const choices = unitChoices(item, units);
        const shown = item.displayUnit || item.baseUnit;
        const inShown = Number(line.qty) > 0 && String(line.unit).toLowerCase() !== String(shown).toLowerCase() && factorOf(line.unit, item, units) && factorOf(shown, item, units)
          ? (Number(line.qty) * factorOf(line.unit, item, units)) / factorOf(shown, item, units) : null;
        const list = listPriceFor(prices, item, line.unit, units);
        const amount = round2((Number(line.qty) || 0) * (Number(line.price) || 0));
        return <li className="po-line" key={line.key}>
          <div className="po-line-head"><strong>{item.name}</strong>
            <button type="button" className="o-icon-btn" aria-label={`Remove ${item.name}`} onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}><OIcon name="close" size={16} /></button></div>
          <div className="po-line-grid">
            <div><label className="o-label" htmlFor={`${ids}-q${index}`}>How much</label>
              <div className="inv-row">
                <input id={`${ids}-q${index}`} className="o-input inv-qty" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={line.qty} onChange={(event) => setLine(line.key, { qty: event.target.value })} />
                <label className="visually-hidden" htmlFor={`${ids}-u${index}`}>Unit for {item.name}</label>
                <select id={`${ids}-u${index}`} className="o-select inv-unit" value={line.unit} onChange={(event) => changeUnit(line, event.target.value)}>
                  {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </select>
              </div></div>
            <div><span className="o-label" id={`${ids}-pl${index}`}>Price for one {unitWord(line.unit, 1, units)}</span>
              <MoneyBox id={`${ids}-p${index}`} label={`Price of ${item.name} per ${unitWord(line.unit, 1, units)}`} value={line.price} onChange={(value) => setLine(line.key, { price: value })} placeholder="0" /></div>
          </div>
          {inShown !== null && <p className="inv-explain" aria-live="polite">{line.qty} {unitWord(line.unit, Number(line.qty), units)} = <strong>{sayAmount(round2(inShown * 1000) / 1000, shown, units)}</strong></p>}
          {list === null && line.price === '' ? <p className="inv-warn">No price on this supplier’s list. Type the price you were quoted.</p>
            : isEdited(line) ? <p className="inv-warn">Changed from the price list ({formatStockMoney(list)} per {unitWord(line.unit, 1, units)}).</p> : null}
          <div className="po-line-total"><span>Line total</span><strong>{formatStockMoney(amount)}</strong></div>
        </li>;
      })}</ul>
      <ItemPicker items={items} exclude={lines.map((l) => l.item.id)} label={lines.length ? 'Add another item' : 'Add an item'} placeholder="Type to find an item, e.g. Chicken"
        hint={(item) => (prices.some((p) => p.itemId === item.id) ? 'On this supplier’s price list' : '')} onPick={addLine} />
    </section>

    {priced.length > 0 && <div className="po-sums" aria-label="Order total">
      <div><span>Subtotal</span><span>{formatStockMoney(sums.subtotal)}</span></div>
      <div><span>VAT ({formatNumber(vatPct)}%)</span><span>{formatStockMoney(sums.vat)}</span></div>
      <div className="is-total"><span>Total</span><span>{formatStockMoney(sums.total)}</span></div>
    </div>}
    <p className="o-field-hint">The total is worked out again exactly when you save.</p>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-notes`}>Note for the supplier <span className="o-optional">Optional</span></label>
      <textarea id={`${ids}-notes`} className="o-input" rows={2} maxLength={500} placeholder="e.g. Deliver before 10 am" value={notes} onChange={(event) => setNotes(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !valid}>{busy ? 'Saving…' : order ? 'Save changes' : 'Save draft order'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
    {detail.loading && supplierId && <SkeletonRows rows={1} thumb={false} label="Loading prices" />}
  </form>;
}
