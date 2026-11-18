// One supplier in the side sheet (P2-13): the details, what they supply with today's price, the price history, and the three
// things you can do: edit the details, add a price, switch them off or on. A supplier added on the spot by a branch is marked
// "Needs details" until the owner has checked it. `supplierId` null starts the "Add supplier" form.
import { useId, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import {
  PAYMENT_METHOD_LABEL, SUPPLIER_TYPE_HELP, SUPPLIER_TYPE_LABEL, formatDay, formatStockMoney, normalisePhone, normalisePin, ownerPaths, priceChange, priceSentence,
  showPhone, termsText, todayNairobi, unitChoices, unitWord, useInventoryWrite, factorOf, round2,
} from '../../lib/inventory';
import { FormError, OIcon, SkeletonRows, TaskDrawer } from './parts';
import { ItemPicker, MoneyBox, Note, PhoneField } from './PurchasingParts';

const TYPES = ['formal', 'informal', 'one_off'];
const METHODS = ['cash', 'mpesa', 'bank', 'credit'];

/** The item as the screens know it: the full record from the overview, or what the supplier page says about it. */
const itemFor = (ctx, id, fallback = {}) => ctx.data.items.find((item) => item.id === id) || { id, baseUnit: fallback.baseUnit, displayUnit: fallback.displayUnit, units: [], name: fallback.name };

/* ---------- the form ---------- */

function SupplierForm({ ctx, supplier, onSaved, onCancel }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const isOwner = ctx.data.role === 'owner';
  const editing = Boolean(supplier);
  const [name, setName] = useState(supplier?.name || '');
  const [type, setType] = useState(supplier?.type || 'informal');
  const [contactName, setContactName] = useState(supplier?.contactName || '');
  const [phone, setPhone] = useState(supplier?.phone ? showPhone(supplier.phone) : '');
  const [kraPin, setKraPin] = useState(supplier?.kraPin || '');
  const [terms, setTerms] = useState(String(supplier?.paymentTermsDays ?? 0));
  const [method, setMethod] = useState(supplier?.paymentMethod || 'cash');
  const [till, setTill] = useState(supplier?.mpesaTill || '');
  const [paybill, setPaybill] = useState(supplier?.mpesaPaybill || '');
  const [account, setAccount] = useState(supplier?.mpesaAccount || '');
  const [bank, setBank] = useState(supplier?.bankDetails || '');
  const [notes, setNotes] = useState(supplier?.notes || '');

  const phoneBad = phone.trim() && !normalisePhone(phone);
  const pinBad = kraPin.trim() && !normalisePin(kraPin);
  const termsBad = !/^\d{1,3}$/.test(terms.trim()) || Number(terms) > 180;
  const valid = name.trim() && !phoneBad && !pinBad && !termsBad;

  async function submit(event) {
    event.preventDefault();
    if (!valid) return;
    const body = {
      name: name.trim(), type, contactName: contactName.trim(), phone: phone.trim() ? normalisePhone(phone) : '', kraPin: kraPin.trim() ? normalisePin(kraPin) : '',
      paymentTermsDays: Number(terms), paymentMethod: method, notes: notes.trim(),
      ...(isOwner ? { mpesaTill: till.trim(), mpesaPaybill: paybill.trim(), mpesaAccount: account.trim(), bankDetails: bank.trim() } : {}),
    };
    const result = editing ? await run('PATCH', ctx.paths.supplier(supplier.id), body, { step: 'edit' }) : await run('POST', ctx.paths.suppliers(), body, { step: 'create' });
    if (!result) return;
    notify(editing ? `${body.name} saved.` : `${body.name} added. Now add what they sell and the price.`);
    (result.warnings || []).forEach((warning) => notify(warning.message));
    onSaved(result.supplier);
  }

  return <form className="inv-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Supplier name</label>
      <input id={`${ids}-name`} className="o-input" value={name} maxLength={80} placeholder="e.g. Karibu Poultry" data-autofocus onChange={(event) => setName(event.target.value)} />
    </div>
    <fieldset className="o-field" style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
      <legend className="o-label">What kind of supplier?</legend>
      <div className="inv-choice">
        {TYPES.map((value) => <label key={value}>
          <input type="radio" name={`${ids}-type`} value={value} checked={type === value} onChange={() => setType(value)} />
          <strong>{SUPPLIER_TYPE_LABEL[value]}</strong><small>{SUPPLIER_TYPE_HELP[value]}</small>
        </label>)}
      </div>
    </fieldset>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-contact`}>Contact person <span className="o-optional">Optional</span></label>
      <input id={`${ids}-contact`} className="o-input" value={contactName} maxLength={80} placeholder="Who do you talk to?" onChange={(event) => setContactName(event.target.value)} />
    </div>
    <PhoneField id={`${ids}-phone`} value={phone} onChange={setPhone} label="Phone number" />
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-pin`}>KRA PIN <span className="o-optional">Optional</span></label>
      <input id={`${ids}-pin`} className="o-input" value={kraPin} maxLength={14} placeholder="A123456789B" autoCapitalize="characters" aria-invalid={pinBad ? 'true' : undefined}
        onChange={(event) => setKraPin(event.target.value)} />
      <p className={pinBad ? 'o-field-error' : 'o-field-hint'}>{pinBad ? 'A KRA PIN looks like A123456789B: a letter, nine digits, a letter.' : 'A letter, nine digits and a letter, like A123456789B. Leave it empty if you don’t have it.'}</p>
    </div>
    <div className="o-field">
      <span className="o-label" id={`${ids}-terms-label`}>When do you pay?</span>
      <div className="inv-row">
        <span className="inv-unit-text">Within</span>
        <label className="visually-hidden" htmlFor={`${ids}-terms`}>Payment terms in days</label>
        <input id={`${ids}-terms`} className="o-input inv-qty" type="number" inputMode="numeric" min="0" max="180" step="1" value={terms} onChange={(event) => setTerms(event.target.value)} />
        <span className="inv-unit-text">days</span>
      </div>
      <p className={termsBad ? 'o-field-error' : 'o-field-hint'}>{termsBad ? 'Use a whole number of days from 0 to 180.' : '0 means you pay when the goods arrive.'}</p>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-method`}>How do you pay them?</label>
      <select id={`${ids}-method`} className="o-select" value={method} onChange={(event) => setMethod(event.target.value)}>
        {METHODS.map((value) => <option key={value} value={value}>{PAYMENT_METHOD_LABEL[value]}</option>)}
      </select>
    </div>
    {isOwner && <section className="inv-section" aria-labelledby={`${ids}-pay`}>
      <h3 id={`${ids}-pay`}>Payment details</h3>
      <p className="o-field-hint">Only you, the owner, can see these.</p>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-till`}>M-Pesa till number <span className="o-optional">Optional</span></label>
        <input id={`${ids}-till`} className="o-input" inputMode="numeric" value={till} maxLength={7} onChange={(event) => setTill(event.target.value)} />
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-paybill`}>M-Pesa paybill number <span className="o-optional">Optional</span></label>
        <input id={`${ids}-paybill`} className="o-input" inputMode="numeric" value={paybill} maxLength={7} onChange={(event) => setPaybill(event.target.value)} />
      </div>
      {paybill.trim() && <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-account`}>Paybill account <span className="o-optional">Optional</span></label>
        <input id={`${ids}-account`} className="o-input" value={account} maxLength={40} onChange={(event) => setAccount(event.target.value)} />
      </div>}
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-bank`}>Bank details <span className="o-optional">Optional</span></label>
        <textarea id={`${ids}-bank`} className="o-input" rows={2} maxLength={300} placeholder="Bank, account name and number" value={bank} onChange={(event) => setBank(event.target.value)} />
      </div>
    </section>}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-notes`}>Notes <span className="o-optional">Optional</span></label>
      <textarea id={`${ids}-notes`} className="o-input" rows={2} maxLength={500} placeholder="Delivery days, minimum order…" value={notes} onChange={(event) => setNotes(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !valid}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add supplier'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- add a price ---------- */

/** The unit a new price is for: what the supplier already uses for this item, else a pack you buy in, else the item's usual unit. */
function startUnit(item, hint, units) {
  const choices = unitChoices(item, units);
  const wanted = [hint, (item.units || []).find((u) => u.forPurchase)?.name, item.displayUnit, item.baseUnit].filter(Boolean).map((u) => String(u).toLowerCase());
  for (const unit of wanted) { const found = choices.find((c) => c.value.toLowerCase() === unit); if (found) return found.value; }
  return choices[0]?.value || item.baseUnit;
}

function PriceForm({ ctx, supplier, preset, existing, onSaved, onCancel }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const units = ctx.data.units;
  const [item, setItem] = useState(preset || null);
  const [unit, setUnit] = useState(preset ? startUnit(preset, existing?.unit, units) : '');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(todayNairobi());
  const [note, setNote] = useState('');
  const choices = item ? unitChoices(item, units) : [];
  const amount = Number(price);
  const shown = item ? (item.displayUnit || item.baseUnit) : null;
  const factor = item ? factorOf(unit, item, units) : null;
  const shownFactor = item && shown ? factorOf(shown, item, units) : null;
  const perShown = amount > 0 && factor && shownFactor && String(unit).toLowerCase() !== String(shown).toLowerCase() ? round2((amount / factor) * shownFactor) : null;
  const packSize = factor && shownFactor && String(unit).toLowerCase() !== String(shown).toLowerCase() ? round2((factor / shownFactor) * 1000) / 1000 : null;
  const valid = item && unit && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit(event) {
    event.preventDefault();
    if (!valid) return;
    const result = await run('POST', ctx.paths.supplierPrices(supplier.id), { itemId: item.id, unit, price: String(price).trim(), effectiveFrom: date, ...(note.trim() ? { note: note.trim() } : {}) });
    if (!result) return;
    const change = result.changePct === null || result.changePct === undefined ? null : Number(result.changePct);
    notify(`Price saved.${change ? ` ${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)}% since last time.` : ''}`);
    (result.warnings || []).forEach((warning) => notify(warning.message));
    onSaved(result);
  }

  return <form className="inv-form" onSubmit={submit} noValidate>
    {preset ? <p><strong>{preset.name}</strong> from {supplier.name}</p>
      : <ItemPicker items={ctx.data.items.filter((i) => !i.archived)} label="Which item?" placeholder="Type an item, e.g. Chicken"
        onPick={(picked) => { setItem(picked); setUnit(startUnit(picked, null, units)); }} />}
    {!preset && item && <p><strong>{item.name}</strong> <button type="button" className="inv-link" onClick={() => { setItem(null); setUnit(''); }}>Change</button></p>}
    {item && <>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-unit`}>The price is for one…</label>
        <select id={`${ids}-unit`} className="o-select" value={unit} onChange={(event) => setUnit(event.target.value)}>
          {choices.map((choice) => <option key={choice.value} value={choice.value}>{unitWord(choice.value, 1, units)}</option>)}
        </select>
        <p className="o-field-hint">Pick the way they sell it: a crate, a kg, a tray.</p>
      </div>
      <div className="o-field">
        <span className="o-label" id={`${ids}-price-label`}>Price</span>
        <MoneyBox id={`${ids}-price`} label={`Price per ${unitWord(unit, 1, units)}`} value={price} onChange={setPrice} placeholder="6500" suffix={`per ${unitWord(unit, 1, units)}`} data-autofocus />
        {amount > 0 && <p className="inv-explain" aria-live="polite">{formatStockMoney(amount)} per {unitWord(unit, 1, units)}
          {packSize ? <> · 1 {unitWord(unit, 1, units)} = <strong>{packSize} {unitWord(shown, packSize, units)}</strong></> : null}
          {perShown ? <> · <strong>{formatStockMoney(perShown)}/{unitWord(shown, 1, units)}</strong></> : null}</p>}
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-date`}>Starts on</label>
        <input id={`${ids}-date`} className="o-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        <p className="o-field-hint">Today, or the day the new price starts. Old prices are kept in the history.</p>
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">Optional</span></label>
        <input id={`${ids}-note`} className="o-input" value={note} maxLength={200} placeholder="e.g. Festive season price" onChange={(event) => setNote(event.target.value)} />
      </div>
    </>}
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save price'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/* ---------- the supplier's page ---------- */

function Facts({ supplier, isOwner }) {
  const rows = [
    ['Phone', supplier.phone ? <a className="inv-link" href={`tel:+${supplier.phone}`}>{showPhone(supplier.phone)}</a> : <span className="is-muted">Not added yet</span>],
    supplier.contactName && ['Contact person', supplier.contactName],
    ['Pays', <>{termsText(supplier.paymentTermsDays)}<small>{PAYMENT_METHOD_LABEL[supplier.paymentMethod] || supplier.paymentMethod}</small></>],
    supplier.kraPin && ['KRA PIN', supplier.kraPin],
    isOwner && supplier.mpesaTill && ['M-Pesa till', supplier.mpesaTill],
    isOwner && supplier.mpesaPaybill && ['M-Pesa paybill', <>{supplier.mpesaPaybill}{supplier.mpesaAccount ? <small>Account {supplier.mpesaAccount}</small> : null}</>],
    isOwner && supplier.bankDetails && ['Bank', supplier.bankDetails],
  ].filter(Boolean);
  return <dl className="pur-facts">{rows.map(([label, value]) => <div className="pur-fact" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function PriceHistory({ ctx, data }) {
  const rows = data.priceHistory || [];
  const groups = [];
  for (const row of rows) {
    let group = groups.find((g) => g.itemId === row.itemId);
    if (!group) { group = { itemId: row.itemId, name: row.itemName, rows: [] }; groups.push(group); }
    group.rows.push(row);
  }
  if (!groups.length) return null;
  return <section className="inv-section" aria-label="Price history">
    <h3>Price history</h3>
    {groups.map((group) => {
      const item = itemFor(ctx, group.itemId, { name: group.name, ...(data.items.find((i) => i.itemId === group.itemId) || {}) });
      return <div className="pur-hist" key={group.itemId}>
        <h4>{group.name}</h4>
        <ul className="pur-list">{group.rows.map((row, index) => {
          const older = group.rows.slice(index + 1).find((r) => r.effectiveFrom <= row.effectiveFrom && r.id !== row.id);
          const change = older ? priceChange(row, older) : null;
          return <li key={row.id}>
            <span className="pur-main">{priceSentence(row, item, ctx.data.units)}
              <small>From {formatDay(row.effectiveFrom)}{row.current ? ' · in use now' : ''}{row.scheduled ? ' · starts later' : ''}{row.note ? ` · ${row.note}` : ''}</small></span>
            {change !== null && change !== 0 && <span className={change > 0 ? 'pur-up' : 'pur-down'}>{change > 0 ? '+' : '−'}{Math.abs(change)}% since last time</span>}
          </li>;
        })}</ul>
      </div>;
    })}
  </section>;
}

function Detail({ ctx, detail, onEdit, onPrice, onChanged }) {
  const { notify } = useNotifications();
  const [run, { busy, error }] = useInventoryWrite();
  const [confirmOff, setConfirmOff] = useState(false);
  const { supplier, items = [], prices = [], openOrders = 0 } = detail;
  const isOwner = ctx.data.role === 'owner';
  const canEdit = ctx.can.purchaseCreate;
  const active = supplier.status === 'active';
  const showPrices = ctx.can.costView && detail.prices !== undefined;

  async function act(action, message, step) {
    const result = await run('POST', ctx.paths.supplierAction(supplier.id, action), {}, { step });
    if (result) { notify(message); onChanged(); setConfirmOff(false); } else setConfirmOff(false);
  }

  return <div className="inv-form">
    <p>
      <span className="inv-badge is-off">{SUPPLIER_TYPE_LABEL[supplier.type] || supplier.type}</span>{' '}
      {!active && <span className="inv-badge is-off">Deactivated</span>}{' '}
      {supplier.incomplete && <span className="inv-badge is-low">Needs details</span>}
    </p>
    {supplier.incomplete && <Note tone="warn">A branch added this supplier on the spot. Check the details, then mark them complete.
      {canEdit && <> <button type="button" className="inv-link" onClick={() => act('complete', `${supplier.name} is complete.`, 'complete')} disabled={busy}>Mark complete</button></>}</Note>}
    <Facts supplier={supplier} isOwner={isOwner} />
    {supplier.notes && <p className="o-field-hint">{supplier.notes}</p>}

    <section className="inv-section" aria-label="What they supply">
      <h3>What they supply</h3>
      {!items.length ? <p className="o-field-hint">Nothing yet. Add a price for an item and it appears here.</p>
        : <ul className="pur-list">{items.map((entry) => {
          const item = itemFor(ctx, entry.itemId, entry);
          const current = prices.filter((p) => p.itemId === entry.itemId);
          return <li key={entry.itemId}>
            <span className="pur-main"><strong>{entry.name}</strong>{entry.preferred ? <> <span className="inv-badge is-ok">Preferred</span></> : null}
              {showPrices && (current.length ? current.map((p) => <small key={p.id}>{priceSentence(p, item, ctx.data.units)} · since {formatDay(p.effectiveFrom)}</small>) : <small>No price yet</small>)}</span>
            {canEdit && active && showPrices && <button type="button" className="o-btn is-small" onClick={() => onPrice(item)} aria-label={`Update price of ${entry.name}`}>Update price</button>}
          </li>;
        })}</ul>}
    </section>

    {showPrices && <PriceHistory ctx={ctx} data={detail} />}

    <FormError error={error} />
    {canEdit && <div className="biz-form-actions">
      {active && <button type="button" className="o-btn is-primary" onClick={() => onPrice(null)}><OIcon name="plus" size={15} />Add a price</button>}
      <button type="button" className="o-btn" onClick={onEdit}><OIcon name="edit" size={15} />Edit details</button>
    </div>}
    {canEdit && <section className="inv-section" aria-label="Deactivate">
      {active ? (confirmOff ? <div className="inv-confirm" role="alertdialog" aria-label={`Deactivate ${supplier.name}?`}>
        <span>Deactivate <strong>{supplier.name}</strong>? You won’t be able to order from them until you activate them again.{openOrders ? ` They have ${openOrders} open ${openOrders === 1 ? 'order' : 'orders'}, which must be finished first.` : ''}</span>
        <span className="biz-form-actions" style={{ margin: 0 }}>
          <button type="button" className="o-btn is-danger-solid is-small" onClick={() => act('deactivate', `${supplier.name} deactivated.`, 'off')} disabled={busy}>Yes, deactivate</button>
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setConfirmOff(false)} disabled={busy}>Keep active</button>
        </span>
      </div> : <>
        <p className="o-field-hint">Stop ordering from this supplier. Their prices and history are kept.</p>
        <button type="button" className="o-btn is-danger is-small" onClick={() => setConfirmOff(true)}>Deactivate supplier</button>
      </>) : <>
        <p className="o-field-hint">This supplier is switched off, so it can’t be chosen for new orders.</p>
        <button type="button" className="o-btn is-small" onClick={() => act('activate', `${supplier.name} is active again.`, 'on')} disabled={busy}>Activate supplier</button>
      </>}
    </section>}
  </div>;
}

/** The side sheet. `onChanged()` tells the list to reload; `onOpen(id)` switches to a supplier (after adding one). */
export default function SupplierSheet({ ctx, supplierId, listed, onClose, onChanged, onOpen }) {
  const detail = useApi(supplierId ? ctx.paths.supplier(supplierId) : null, { ttl: 5000 });
  const [view, setView] = useState(supplierId ? 'detail' : 'edit');
  const [pricing, setPricing] = useState(null); // an item to update, or {} for "pick one"
  const data = detail.data;
  const supplier = data?.supplier;
  const title = view === 'price' ? 'Add a price' : !supplierId ? 'Add supplier' : view === 'edit' ? `Edit ${supplier?.name || listed?.name || 'supplier'}` : supplier?.name || listed?.name || 'Supplier';
  const back = () => { setView('detail'); setPricing(null); };

  return <TaskDrawer open title={title} onClose={onClose}>
    {view === 'edit' && (!supplierId || supplier) && <SupplierForm ctx={ctx} supplier={supplierId ? supplier : null}
      onSaved={(saved) => { onChanged(); if (!supplierId) onOpen(saved.id); else { detail.refresh(); back(); } }} onCancel={supplierId ? back : onClose} />}
    {view === 'price' && supplier && <PriceForm ctx={ctx} supplier={supplier} preset={pricing?.id ? pricing : null}
      existing={data.items.find((i) => i.itemId === pricing?.id)?.purchaseUnit ? { unit: data.items.find((i) => i.itemId === pricing.id).purchaseUnit } : null}
      onSaved={() => { onChanged(); detail.refresh(); back(); }} onCancel={back} />}
    {view === 'detail' && (detail.error && !data ? <p className="o-field-error" role="alert">{detail.error.message || 'This supplier could not be loaded.'}</p>
      : !data ? <SkeletonRows rows={4} thumb={false} label="Loading supplier" />
        : <Detail ctx={ctx} detail={data} onEdit={() => setView('edit')} onPrice={(item) => { setPricing(item); setView('price'); }} onChanged={() => { onChanged(); detail.refresh(); }} />)}
  </TaskDrawer>;
}
