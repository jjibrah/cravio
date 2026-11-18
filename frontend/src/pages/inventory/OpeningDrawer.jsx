import { formatStockMoney } from '../../lib/inventory';
// Opening stock: pick a location, then say how much of each item is there now. Items that already have an opening
// are shown as done; the rest wait here. The amount can be typed in any unit the item has ("40 crates"), with the
// live total ("= 400 kg") under the box. Nothing is posted until Save; the server refuses anything unclear in plain words.
import { useEffect, useId, useMemo, useState } from 'react';
import { useApi } from '../../lib/api';
import { convert, formatNumber, ownerPaths, sayAmount, unitChoices, useInventoryWrite } from '../../lib/inventory';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { EmptyState, FormError, OIcon, QuantityInput, SkeletonRows } from './parts';

const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function Line({ row, item, units, costView, value, onChange }) {
  const id = useId();
  const choices = useMemo(() => unitChoices(item, units), [item, units]);
  const shown = item.displayUnit || item.baseUnit;
  const quantity = Number(value.quantity);
  const total = quantity > 0 ? convert(quantity, value.unit, shown, item, units) : null;
  const big = total !== null && total >= 10000 && item.baseUnit !== 'serving';
  return <li>
    <strong id={`${id}-name`}>{row.name}{row.code ? <span className="inv-unit-text"> · {row.code}</span> : null}</strong>
    <QuantityInput id={`${id}-qty`} label={`How much ${row.name} is there`} value={value.quantity} onChange={(quantity2) => onChange({ ...value, quantity: quantity2 })}
      unit={value.unit} choices={choices} onUnit={(unit) => onChange({ ...value, unit })} placeholder="0" />
    {total !== null && <p className="inv-explain" aria-live="polite">= <strong>{sayAmount(Math.round(total * 1000) / 1000, shown, units)}</strong></p>}
    {big && <p className="inv-warn">{formatNumber(total)} {shown} is a lot. Check the amount and the unit.</p>}
    {costView && <QuantityInput id={`${id}-cost`} label={`Cost of ${row.name} per ${value.unit}, in KES`} value={value.cost} onChange={(cost) => onChange({ ...value, cost })}
      unit={`KES per ${value.unit}`} placeholder="Cost (optional)" />}
  </li>;
}

export default function OpeningDrawer({ ctx, locationId: initialLocation, onClose }) {
  const { business, data, can } = ctx;
  const ids = useId();
  const { notify } = useNotifications();
  const places = data.locations.filter((l) => (l.capabilities || []).includes('inv.stock.record'));
  const [locationId, setLocationId] = useState(initialLocation && places.some((l) => l.id === initialLocation) ? initialLocation : places[0]?.id || '');
  const [values, setValues] = useState({});
  const [results, setResults] = useState(null);
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const status = useApi(locationId ? ownerPaths(business.id).opening(locationId) : null, { ttl: 5000 });
  useEffect(() => { setValues({}); setResults(null); clearError(); }, [locationId, clearError]);

  const byId = useMemo(() => new Map(data.items.map((item) => [item.id, item])), [data.items]);
  const rows = status.data?.items || [];
  const waiting = rows.filter((row) => row.canSetOpening && byId.has(row.itemId));
  const done = rows.filter((row) => row.hasOpening);
  const hasStock = rows.filter((row) => !row.hasOpening && !row.canSetOpening);
  const valueOf = (row) => values[row.itemId] || { quantity: '', unit: row.displayUnit || row.baseUnit, cost: '' };
  const filled = waiting.filter((row) => Number(valueOf(row).quantity) > 0);

  async function save(event) {
    event.preventDefault();
    const lines = filled.map((row) => {
      const v = valueOf(row);
      return { itemId: row.itemId, quantity: String(v.quantity), unit: v.unit, ...(can.costView && v.cost !== '' ? { unitCost: String(v.cost) } : {}) };
    });
    const result = await run('POST', ownerPaths(business.id).openingPost, { locationId, lines }, { step: `opening:${locationId}` });
    if (result) {
      setResults(result);
      setValues({});
      ctx.refresh();
      status.refresh();
      notify(`Opening stock saved for ${result.posted} ${result.posted === 1 ? 'item' : 'items'} at ${result.locationName}.`);
    }
  }

  if (!places.length) return <EmptyState icon="info" tone="neutral" title="You can’t record stock here">Opening stock is set by the business owner.</EmptyState>;
  return <form className="inv-form" onSubmit={save} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-where`}>Where is this stock?</label>
      <select id={`${ids}-where`} className="o-select" value={locationId} onChange={(event) => setLocationId(event.target.value)} disabled={busy}>
        {places.map((place) => <option key={place.id} value={place.id}>{place.label === 'Warehouse' && place.name !== 'Warehouse' ? `${place.name} (Warehouse)` : place.name}</option>)}
      </select>
      <p className="o-field-hint">Opening stock is what you have right now. Set it once for each item and place; after that, use counts to correct it.</p>
    </div>

    {results && <section aria-label="Saved" className="inv-section">
      <h3>Saved at {results.locationName}</h3>
      <ul className="inv-results">
        {results.results.map((r) => <li key={r.itemId} className={r.status === 'skipped' ? 'is-skipped' : undefined}>
          {r.status === 'skipped' ? r.message : `${r.itemName}: ${r.display}${r.status === 'replayed' ? ' (already saved)' : ''}`}</li>)}
      </ul>
    </section>}

    {status.loading ? <SkeletonRows rows={4} thumb={false} label="Loading items" />
      : status.error && !status.data ? <FormError error={status.error} />
        : !rows.length ? <EmptyState icon="layers" tone="neutral" title="No items to set up">Add items first, then come back to say how much you have.</EmptyState>
          : <>
            {waiting.length > 0 ? <>
              <h3 className="inv-section" style={{ margin: 0 }}>Waiting for opening stock <span className="inv-unit-text">{waiting.length}</span></h3>
              <ul className="inv-opening">
                {waiting.map((row) => <Line key={row.itemId} row={row} item={byId.get(row.itemId)} units={data.units} costView={can.costView}
                  value={valueOf(row)} onChange={(next) => setValues((current) => ({ ...current, [row.itemId]: next }))} />)}
              </ul>
              <p className="o-field-hint">Leave an item blank to skip it for now.</p>
            </> : <EmptyState icon="check" tone="calm" title="Every item has its opening stock here">Use a count to correct a quantity later.</EmptyState>}
            {done.length > 0 && <section className="inv-section" aria-label="Already set">
              <h3>Already set <span className="inv-unit-text">{done.length}</span></h3>
              {done.map((row) => <p className="inv-done" key={row.itemId}><span>{row.name}</span>
                <span>{row.opening ? sayAmount(row.opening.quantity, row.opening.unit, data.units) : row.display} · {when(row.openingSetAt)}</span></p>)}
            </section>}
            {hasStock.length > 0 && <p className="o-field-hint">{hasStock.length === 1 ? `${hasStock[0].name} already has stock here` : `${hasStock.length} items already have stock here`}, so they can’t take an opening amount. Use a count to correct them.</p>}
          </>}

    <FormError error={error} />
    <div className="biz-form-actions">
      {results ? <button type="button" className="o-btn is-primary" onClick={onClose}>Done</button>
        : <button type="submit" className="o-btn is-primary" disabled={busy || !filled.length}>
          {busy ? 'Saving…' : filled.length ? `Save opening stock for ${filled.length} ${filled.length === 1 ? 'item' : 'items'}` : 'Save opening stock'}</button>}
      {!results && <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>}
    </div>
    {can.costView && !results && waiting.length > 0 && <p className="o-field-hint"><OIcon name="info" size={13} /> Cost is optional, in KES for the unit you pick ({formatStockMoney(650)} per kg, for example). It gives you food cost on recipes.</p>}
  </form>;
}
