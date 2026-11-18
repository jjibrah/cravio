// Add or edit one item, in plain words: name, how it is measured, what to show amounts in, the packs it comes in
// ("Crate = 10 kg"), category, optional code / storage / usable share / low-stock level / notes. Editing adds low-stock
// levels per place, barcodes and Archive / Restore. Everything is sent with command ids (useInventoryWrite), so a retry
// never repeats a change. The server's messages (e.g. "Count it to zero first") are shown as they are: they are plain already.
import { useId, useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { formatNumber, factorOf, sayAmount, standardUnitsFor, useInventoryWrite } from '../../lib/inventory';
import { FormError, OIcon, QuantityInput } from './parts';

const STORAGES = [['', 'Not set'], ['ambient', 'Room temperature'], ['chilled', 'Chilled'], ['frozen', 'Frozen'], ['dry', 'Dry store']];
const EXAMPLES = { weight: 'flour, chicken, rice', volume: 'oil, milk, juice', count: 'eggs, buns, bottles', servings: 'prepared portions' };
const DEFAULT_DISPLAY = { weight: 'kg', volume: 'l', count: 'piece', servings: 'serving' };
const round = (n, dp = 4) => String(+Number(n).toFixed(dp));

/** The biggest standard unit that holds `factor` base units in a tidy amount: 10000 g -> { size: '10', unit: 'kg' }. */
function bestUnit(factor, baseUnit, units) {
  const list = [...standardUnitsFor(baseUnit, units)].sort((a, b) => Number(b.toBase) - Number(a.toBase));
  const f = Number(factor);
  for (const unit of list) {
    const q = f / Number(unit.toBase);
    if (q >= 1 && Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6) return { size: round(q, 3), unit: unit.code };
  }
  return { size: round(f), unit: baseUnit };
}

export default function ItemDrawer({ ctx, item = null, onClose }) {
  const { business, data, can, paths } = ctx;
  const ids = useId();
  const { notify } = useNotifications();
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const editing = Boolean(item);
  const units = data.units;
  const measuredOf = (value) => data.measuredBy.find((m) => m.value === value) || data.measuredBy[0];

  const [name, setName] = useState(item?.name || '');
  const [measured, setMeasured] = useState(item?.measuredBy || 'weight');
  const baseUnit = measuredOf(measured).baseUnit;
  const [display, setDisplay] = useState(item ? (item.displayUnit || item.baseUnit) : DEFAULT_DISPLAY.weight);
  const [packs, setPacks] = useState(() => (item?.units || []).map((u, i) => ({ key: i, name: u.name, ...bestUnit(u.factor, item.baseUnit, units) })));
  const [categoryId, setCategoryId] = useState(item?.categoryId || '');
  const [extraCategories, setExtraCategories] = useState([]);
  const [newCategory, setNewCategory] = useState(null);
  const [code, setCode] = useState(item?.sku || '');
  const [storage, setStorage] = useState(item?.storage || '');
  const [yieldPct, setYieldPct] = useState(item ? String(item.yieldPct) : '100');
  const [notes, setNotes] = useState(item?.notes || '');
  const [barcodes, setBarcodes] = useState(item?.barcodes || []);
  const [barcode, setBarcode] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);

  /** Base units in one `unit`: a standard unit, or a pack as it is typed in this form right now. */
  const factorNow = (unit) => {
    const pack = packs.find((p) => p.name.trim() && p.name.trim().toLowerCase() === String(unit).toLowerCase());
    if (pack) { const f = factorOf(pack.unit, null, units); return f && Number(pack.size) > 0 ? f * Number(pack.size) : null; }
    return factorOf(unit, null, units);
  };
  const toShown = (base, unit) => (base === null || base === undefined || base === '' ? '' : round(Number(base) / (factorNow(unit) || 1)));
  const [low, setLow] = useState(() => (item ? toShownInitial(item.lowLevel, item) : ''));
  const places = data.locations.filter((l) => (l.capabilities || []).includes('inv.stock.record'));
  const [levels, setLevels] = useState(() => Object.fromEntries(places.map((place) => {
    const level = item?.locations.find((l) => l.locationId === place.id)?.level;
    return [place.id, { low: toShownInitial(level?.reorder, item), par: toShownInitial(level?.par, item) }];
  })));
  function toShownInitial(base, from) {
    if (!from || base === null || base === undefined) return '';
    const unit = from.displayUnit || from.baseUnit;
    const f = factorOf(unit, from, units);
    return round(Number(base) / (f || 1));
  }

  const standard = useMemo(() => standardUnitsFor(baseUnit, units), [baseUnit, units]);
  const displayChoices = [...standard.map((u) => ({ value: u.code, label: u.plural })), ...packs.filter((p) => p.name.trim()).map((p) => ({ value: p.name.trim(), label: `${p.name.trim()} (pack)` }))];
  const shownUnit = display;
  const shownLabel = (displayChoices.find((c) => c.value === display)?.label || display).replace(' (pack)', '');

  function changeMeasured(next) {
    setMeasured(next);
    const nextBase = measuredOf(next).baseUnit;
    const fallback = DEFAULT_DISPLAY[next];
    setDisplay(fallback);
    setPacks((current) => current.map((p) => ({ ...p, unit: fallback && standardUnitsFor(nextBase, units).some((u) => u.code === fallback) ? fallback : nextBase })));
  }
  function changeDisplay(next) {
    const before = factorNow(display);
    const after = factorNow(next);
    if (before && after && before !== after) { // keep every level meaning the same amount
      const scale = (value) => (value === '' ? '' : round((Number(value) * before) / after));
      setLow((value) => scale(value));
      setLevels((current) => Object.fromEntries(Object.entries(current).map(([id, v]) => [id, { low: scale(v.low), par: scale(v.par) }])));
    }
    setDisplay(next);
  }
  const setPack = (key, patch) => setPacks((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const addPack = () => setPacks((current) => [...current, { key: Date.now(), name: '', size: '', unit: standard.some((u) => u.code === display) ? display : baseUnit }]);

  const categories = [...data.categories.filter((c) => c.active), ...extraCategories.filter((c) => !data.categories.some((d) => d.id === c.id))];
  const incomplete = packs.some((p) => (p.name.trim() || p.size !== '') && (!p.name.trim() || !(Number(p.size) > 0)));
  const packList = packs.filter((p) => p.name.trim() && Number(p.size) > 0).map((p) => ({ name: p.name.trim(), factor: { quantity: String(p.size), unit: p.unit } }));

  async function addCategory() {
    const created = await run('POST', paths.categories, { name: newCategory }, { step: 'category' });
    if (created) { setExtraCategories((c) => [...c, created]); setCategoryId(created.id); setNewCategory(null); ctx.refresh(); }
  }

  async function submit(event) {
    event.preventDefault();
    clearError();
    if (!editing) {
      const body = { name: name.trim(), baseUnit, displayUnit: display, ...(packList.length ? { units: packList } : {}),
        ...(categoryId ? { categoryId } : {}), ...(code.trim() ? { sku: code.trim() } : {}), ...(storage ? { storage } : {}),
        ...(yieldPct !== '' && Number(yieldPct) !== 100 ? { yieldPct: Number(yieldPct) } : {}), ...(low !== '' ? { lowLevel: String(low) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}) };
      const created = await run('POST', paths.items, body, { step: 'create' });
      if (created) { notify(`${created.name} added. Next: record how much you have.`); ctx.refresh(); onClose(); }
      return;
    }
    // Edit: each change is its own command, in an order that keeps every step valid.
    const same = (a, b) => Math.abs(a - b) < 1e-6;
    const originalPacks = (item.units || []).map((u) => `${u.name.toLowerCase()}:${Number(u.factor)}`).sort().join('|');
    const nowPacks = packList.map((p) => `${p.name.toLowerCase()}:${factorOf(p.factor.unit, null, units) * Number(p.factor.quantity)}`).sort().join('|');
    if (measured !== item.measuredBy && !await run('PATCH', paths.item(item.id), { baseUnit }, { step: 'base' })) return;
    if ((originalPacks !== nowPacks || display !== (item.displayUnit || item.baseUnit)) && !await run('PUT', paths.itemUnits(item.id), { units: packList, displayUnit: display }, { step: 'units' })) return;
    const patch = {};
    if (name.trim() !== item.name) patch.name = name.trim();
    if (code.trim() !== (item.sku || '')) patch.sku = code.trim() || null;
    if (categoryId !== (item.categoryId || '')) patch.categoryId = categoryId || null;
    if (storage !== (item.storage || '')) patch.storage = storage || null;
    if (Number(yieldPct || 100) !== Number(item.yieldPct)) patch.yieldPct = Number(yieldPct || 100);
    if (notes.trim() !== (item.notes || '')) patch.notes = notes.trim() || null;
    const lowBase = low === '' ? null : Number(low) * (factorNow(display) || 1);
    const wasLow = item.lowLevel === null ? null : Number(item.lowLevel);
    if ((lowBase === null) !== (wasLow === null) || (lowBase !== null && !same(lowBase, wasLow))) patch.lowLevel = low === '' ? null : String(low);
    if (Object.keys(patch).length && !await run('PATCH', paths.item(item.id), patch, { step: 'details' })) return;
    if (barcodes.join('|') !== (item.barcodes || []).join('|') && !await run('PUT', paths.itemBarcodes(item.id), { barcodes }, { step: 'barcodes' })) return;
    const levelList = places.filter((p) => levels[p.id].low !== '' || levels[p.id].par !== '').map((p) => ({ locationId: p.id,
      ...(levels[p.id].low !== '' ? { reorder: String(levels[p.id].low) } : {}), ...(levels[p.id].par !== '' ? { par: String(levels[p.id].par) } : {}) }));
    const levelKey = (list) => JSON.stringify(list);
    const original = places.map((p) => ({ id: p.id, ...toLevel(item.locations.find((l) => l.locationId === p.id)?.level) }));
    const current = places.map((p) => ({ id: p.id, low: levels[p.id].low, par: levels[p.id].par }));
    if (levelKey(original.map(({ id, low: l, par }) => [id, Number(l) || 0, Number(par) || 0])) !== levelKey(current.map(({ id, low: l, par }) => [id, Number(l) || 0, Number(par) || 0]))
      && !await run('PUT', paths.itemLevels(item.id), { levels: levelList }, { step: 'levels' })) return;
    notify(`${name.trim()} saved.`);
    ctx.refresh();
    onClose();
  }
  function toLevel(level) {
    return { low: toShownInitial(level?.reorder, item), par: toShownInitial(level?.par, item) };
  }

  async function archive(restore) {
    const done = await run('POST', restore ? paths.restore(item.id) : paths.archive(item.id), {}, { step: restore ? 'restore' : 'archive' });
    if (done) { notify(restore ? `${item.name} restored.` : `${item.name} archived. Its history is kept.`); ctx.refresh(); onClose(); }
    else setConfirmArchive(false);
  }

  function addBarcode() {
    const value = barcode.trim();
    if (value && !barcodes.includes(value)) setBarcodes([...barcodes, value]);
    setBarcode('');
  }

  const valid = name.trim() && !incomplete;
  return <form className="inv-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Name</label>
      <input id={`${ids}-name`} className="o-input" value={name} maxLength={80} placeholder="e.g. Chicken, Cooking oil, Burger buns" data-autofocus
        onChange={(event) => setName(event.target.value)} />
    </div>

    <fieldset className="o-field inv-choice-field" style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
      <legend className="o-label">How is it measured?</legend>
      <div className="inv-choice">
        {data.measuredBy.map((option) => <label key={option.value}>
          <input type="radio" name={`${ids}-measured`} value={option.value} checked={measured === option.value} onChange={() => changeMeasured(option.value)} />
          <strong>{option.label}</strong><small>{EXAMPLES[option.value] || option.example}</small>
        </label>)}
      </div>
      {editing && measured !== item.measuredBy && <p className="inv-warn">This can only change before the item has any stock history.</p>}
    </fieldset>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-display`}>Show amounts in</label>
      <select id={`${ids}-display`} className="o-select" value={display} onChange={(event) => changeDisplay(event.target.value)}>
        {displayChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
      <p className="o-field-hint">This is how amounts appear on screen. Cravio keeps the exact amount behind the scenes, so you can still type in any unit.</p>
    </div>

    <div className="o-field">
      <span className="o-label" id={`${ids}-packs`}>Packs you buy it in <span className="o-optional">Optional</span></span>
      <div className="inv-packs" role="group" aria-labelledby={`${ids}-packs`}>
        {packs.map((pack, index) => <div className="inv-pack" key={pack.key}>
          <div className="inv-row">
            <label className="visually-hidden" htmlFor={`${ids}-pn-${pack.key}`}>Pack {index + 1} name</label>
            <input id={`${ids}-pn-${pack.key}`} className="o-input" placeholder="e.g. Crate, Tray, Sack" maxLength={30} value={pack.name} onChange={(event) => setPack(pack.key, { name: event.target.value })} />
            <span className="inv-unit-text">holds</span>
            <QuantityInput id={`${ids}-ps-${pack.key}`} label={`How much one ${pack.name.trim() || 'pack'} holds`} value={pack.size} onChange={(size) => setPack(pack.key, { size })}
              unit={pack.unit} choices={standard.map((u) => ({ value: u.code, label: u.plural }))} onUnit={(unit) => setPack(pack.key, { unit })} placeholder="10" />
            <button type="button" className="o-icon-btn" aria-label={`Remove pack ${index + 1}`} onClick={() => setPacks((current) => current.filter((p) => p.key !== pack.key))}><OIcon name="close" size={16} /></button>
          </div>
          {pack.name.trim() && Number(pack.size) > 0 && <p className="inv-explain" aria-live="polite">1 {pack.name.trim().toLowerCase()} = <strong>{sayAmount(pack.size, pack.unit, units)}</strong></p>}
        </div>)}
        <div><button type="button" className="o-btn is-quiet is-small" onClick={addPack}><OIcon name="plus" size={15} />Add a pack</button></div>
      </div>
      {incomplete && <p className="inv-warn">Give each pack a name and say how much it holds, or remove it.</p>}
      <p className="o-field-hint">Example: a Crate holds 10 kg, a Tray holds 30 pieces. Then you can count “40 crates”.</p>
    </div>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-cat`}>Category <span className="o-optional">Optional</span></label>
      <select id={`${ids}-cat`} className="o-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
        <option value="">No category</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {newCategory === null
        ? <button type="button" className="o-btn is-quiet is-small" onClick={() => setNewCategory('')}><OIcon name="plus" size={15} />Add a category</button>
        : <div className="inv-row" style={{ marginTop: 6 }}>
          <label className="visually-hidden" htmlFor={`${ids}-newcat`}>New category name</label>
          <input id={`${ids}-newcat`} className="o-input" value={newCategory} maxLength={60} placeholder="New category name" onChange={(event) => setNewCategory(event.target.value)} />
          <button type="button" className="o-btn is-small" onClick={addCategory} disabled={busy || !newCategory.trim()}>Add</button>
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setNewCategory(null)}>Cancel</button>
        </div>}
    </div>

    <div className="o-field">
      <span className="o-label" aria-hidden="true">Low stock level <span className="o-optional">Optional</span></span>
      <QuantityInput id={`${ids}-low`} label="Low stock level" value={low} onChange={setLow} unit={shownUnit} choices={[{ value: shownUnit, label: shownLabel }]} placeholder="e.g. 20" />
      <p className="o-field-hint">You’ll see “Low” on the Stock page when you have less than this. You can set a different level for each place below once the item exists.</p>
    </div>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-code`}>Code <span className="o-optional">Optional</span></label>
      <input id={`${ids}-code`} className="o-input" value={code} maxLength={40} placeholder="Your own code, e.g. CHK-001" onChange={(event) => setCode(event.target.value)} />
    </div>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-storage`}>Storage <span className="o-optional">Optional</span></label>
      <select id={`${ids}-storage`} className="o-select" value={storage} onChange={(event) => setStorage(event.target.value)}>
        {STORAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-yield`}>Usable share <span className="o-optional">Optional</span></label>
      <div className="inv-row"><input id={`${ids}-yield`} className="o-input inv-qty" type="number" inputMode="decimal" min="1" max="100" step="any" value={yieldPct} onChange={(event) => setYieldPct(event.target.value)} /><span className="inv-unit-text">%</span></div>
      <p className="o-field-hint">How much is left to use after trimming or cooking. Whole chicken might be 70%. Put 100% if nothing is lost.</p>
    </div>

    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-notes`}>Notes <span className="o-optional">Optional</span></label>
      <textarea id={`${ids}-notes`} className="o-input" rows={2} maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
    </div>

    {editing && <>
      <section className="inv-section" aria-labelledby={`${ids}-levels`}>
        <h3 id={`${ids}-levels`}>Low stock level at each place</h3>
        <p className="o-field-hint">Leave blank to use the level above. “Aim to keep” is how much you like to have on the shelf.</p>
        <div className="inv-levels">
          {places.map((place) => <div className="inv-level" key={place.id}>
            <strong>{place.name}{place.label === 'Warehouse' && place.name !== 'Warehouse' ? ' (Warehouse)' : ''}</strong>
            <div><span className="o-label" aria-hidden="true">Low at</span>
              <QuantityInput id={`${ids}-l-${place.id}`} label={`Low at, ${place.name}`} value={levels[place.id].low} unit={shownUnit} choices={[{ value: shownUnit, label: shownLabel }]}
                onChange={(value) => setLevels((c) => ({ ...c, [place.id]: { ...c[place.id], low: value } }))} /></div>
            <div><span className="o-label" aria-hidden="true">Aim to keep</span>
              <QuantityInput id={`${ids}-p-${place.id}`} label={`Aim to keep, ${place.name}`} value={levels[place.id].par} unit={shownUnit} choices={[{ value: shownUnit, label: shownLabel }]}
                onChange={(value) => setLevels((c) => ({ ...c, [place.id]: { ...c[place.id], par: value } }))} /></div>
          </div>)}
        </div>
      </section>

      <section className="inv-section" aria-labelledby={`${ids}-codes`}>
        <h3 id={`${ids}-codes`}>Barcodes</h3>
        {barcodes.length > 0 && <ul className="inv-chips">{barcodes.map((value) => <li className="inv-chip" key={value}>{value}
          <button type="button" aria-label={`Remove barcode ${value}`} onClick={() => setBarcodes(barcodes.filter((b) => b !== value))}><OIcon name="close" size={13} /></button></li>)}</ul>}
        <div className="inv-row">
          <label className="visually-hidden" htmlFor={`${ids}-barcode`}>Add a barcode</label>
          <input id={`${ids}-barcode`} className="o-input" value={barcode} maxLength={64} placeholder="Type or scan a barcode"
            onChange={(event) => setBarcode(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addBarcode(); } }} />
          <button type="button" className="o-btn is-small" onClick={addBarcode} disabled={!barcode.trim()}>Add</button>
        </div>
      </section>

      <section className="inv-section" aria-labelledby={`${ids}-archive`}>
        <h3 id={`${ids}-archive`}>{item.archived ? 'This item is archived' : 'Archive'}</h3>
        {item.archived ? <>
          <p className="o-field-hint">It’s hidden from lists and can’t take new stock. Restore it to use it again.</p>
          <button type="button" className="o-btn is-small" onClick={() => archive(true)} disabled={busy}>Restore {item.name}</button>
        </> : confirmArchive ? <div className="inv-confirm" role="alertdialog" aria-label={`Archive ${item.name}?`}>
          <span>Archive <strong>{item.name}</strong>? It disappears from lists and can’t take new stock. Its history is kept, and you can restore it.</span>
          <span className="biz-form-actions" style={{ margin: 0 }}>
            <button type="button" className="o-btn is-danger-solid is-small" onClick={() => archive(false)} disabled={busy}>Yes, archive it</button>
            <button type="button" className="o-btn is-quiet is-small" onClick={() => setConfirmArchive(false)} disabled={busy}>Keep it</button>
          </span>
        </div> : <>
          <p className="o-field-hint">Stop using an item without losing its history. It must be at zero everywhere and not used in a recipe.</p>
          <button type="button" className="o-btn is-danger is-small" onClick={() => setConfirmArchive(true)} disabled={busy}>Archive {item.name}</button>
        </>}
      </section>
    </>}

    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !valid || !can.itemEdit}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add item'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
    {editing && item.totals && <p className="o-field-hint">On hand across your places: {item.totals.display.onHand}. {formatNumber(item.locations.length)} {item.locations.length === 1 ? 'place' : 'places'}.</p>}
  </form>;
}
