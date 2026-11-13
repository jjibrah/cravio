import { useEffect, useId, useState } from 'react';
import GuestSheet from './GuestSheet';
import { NO_FILTERS, activeFilterCount, priceBounds, searchMenu } from './menu-search';
import { formatKsh } from '../../lib/format';

const TOGGLES = [
  ['featured', 'Featured'],
  ['offer', 'On offer'],
  ['video', 'Has video'],
];

/** Filters for the guest menu: featured, on offer, has video, a price range and a category. Applies on "Show". */
export default function FilterSheet({ open, onClose, filters, onApply, query, menu, categories, contained }) {
  const id = useId();
  const [draft, setDraft] = useState(filters);
  useEffect(() => { if (open) setDraft(filters); }, [open, filters]);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const found = searchMenu(menu, query, draft);
  const results = found.items.length + found.deals.length;
  const bounds = priceBounds(menu.items, menu.deals);
  const usedCategories = categories.filter((category) => menu.items.some((item) => item.categoryId === category.id));
  const price = (value) => (value === '' ? '' : String(Math.max(0, Math.round(Number(value) || 0))));

  return <GuestSheet open={open} onClose={onClose} title="Filters" contained={contained} className="mv-filter-sheet"
    footer={<div className="mv-filter-actions">
      <button type="button" className="gx-secondary" onClick={() => setDraft(NO_FILTERS)} disabled={!activeFilterCount(draft)}>Clear filters</button>
      <button type="button" className="gx-primary" onClick={() => { onApply(draft); onClose(); }}>{results ? `Show ${results} result${results === 1 ? '' : 's'}` : 'No matches'}</button>
    </div>}>
    <fieldset className="mv-filter-group">
      <legend>Show only</legend>
      <div className="mv-chip-row">
        {TOGGLES.map(([key, label]) => <button key={key} type="button" className="mv-chip" aria-pressed={draft[key]} onClick={() => set({ [key]: !draft[key] })}>{label}</button>)}
      </div>
    </fieldset>
    <fieldset className="mv-filter-group">
      <legend>Price</legend>
      <div className="mv-price-range">
        <label htmlFor={`${id}-min`}><span>From (Ksh)</span>
          <input id={`${id}-min`} type="number" inputMode="numeric" min="0" step="50" value={draft.min} placeholder={String(bounds.low)} onChange={(event) => set({ min: price(event.target.value) })} />
        </label>
        <span aria-hidden="true">–</span>
        <label htmlFor={`${id}-max`}><span>To (Ksh)</span>
          <input id={`${id}-max`} type="number" inputMode="numeric" min="0" step="50" value={draft.max} placeholder={String(bounds.high)} onChange={(event) => set({ max: price(event.target.value) })} />
        </label>
      </div>
      <div className="mv-chip-row">
        {[500, 1000, 2000].map((limit) => limit < bounds.high && <button key={limit} type="button" className="mv-chip" aria-pressed={draft.min === '' && draft.max === String(limit)} onClick={() => set({ min: '', max: String(limit) })}>Under {formatKsh(limit)}</button>)}
      </div>
    </fieldset>
    {usedCategories.length > 1 && <fieldset className="mv-filter-group">
      <legend>Category</legend>
      <div className="mv-chip-row" role="radiogroup" aria-label="Category">
        <button type="button" role="radio" className="mv-chip" aria-checked={!draft.category} onClick={() => set({ category: '' })}>All</button>
        {usedCategories.map((category) => <button key={category.id} type="button" role="radio" className="mv-chip" aria-checked={draft.category === category.id} onClick={() => set({ category: category.id })}>{category.name}</button>)}
      </div>
    </fieldset>}
  </GuestSheet>;
}
