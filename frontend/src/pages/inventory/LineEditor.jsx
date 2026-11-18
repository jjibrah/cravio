// The ingredient lines of a recipe (a dish or an extra): search for an item, type an amount, pick a unit that fits that item.
// Pure form pieces; the screens around it (RecipeSheet) own saving. A "line" is { key, itemId, name, quantity, unit, choices }.
import { useId, useMemo, useState } from 'react';
import { unitChoices } from '../../lib/inventory';
import { OIcon, QuantityInput } from './parts';

let counter = 0;
export const newKey = () => `line-${(counter += 1)}`;
export const emptyLine = () => ({ key: newKey(), itemId: '', name: '', quantity: '', unit: '', choices: [] });

/** Items the picker can offer, from either side: owner overview items, or branch snapshot items. [{ id, name, baseUnit, choices }] */
export function pickItemsFromOwner(items = [], units = []) {
  return items.filter((item) => !item.archived).map((item) => ({ id: item.id, name: item.name, baseUnit: item.baseUnit, choices: unitChoices(item, units) }));
}
export function pickItemsFromBranch(items = []) {
  return items.map((item) => ({ id: item.id, name: item.name, baseUnit: item.baseUnit,
    choices: (item.units || []).map((u) => ({ value: u.code, label: u.plural || u.label })) }));
}

/** A saved line (from the recipe view) as a form line. Amounts are shown the way they were typed. */
export function lineFromView(line) {
  const entered = line.entered;
  const choices = (line.compatibleUnits || []).map((u) => ({ value: u.code, label: u.plural || u.label }));
  const unit = entered?.unit || line.baseUnit || choices[0]?.value || '';
  if (unit && !choices.some((c) => c.value === unit)) choices.push({ value: unit, label: unit });
  return { key: newKey(), itemId: line.itemId, name: line.name, quantity: String(Number(entered?.quantity ?? line.qtyBase)), unit, choices };
}

/** A line for an item the person just picked: its usual measure (g, ml, piece...) is preselected. */
export const lineForItem = (line, item) => ({ ...line, itemId: item.id, name: item.name, choices: item.choices,
  unit: item.choices.some((c) => c.value === item.baseUnit) ? item.baseUnit : item.choices[0]?.value || item.baseUnit || '' });

/** "200 g" for the saved/draft line text. */
export const lineText = (line) => {
  const label = line.choices?.find((c) => c.value === line.unit)?.label || line.unit;
  return `${Number(line.quantity)} ${label}`;
};

const started = (line) => Boolean(line.itemId) || String(line.quantity).trim() !== '';
export const isComplete = (line) => Boolean(line.itemId) && Number(line.quantity) > 0;
/** The lines worth sending: finished ones, as the API wants them. */
export const toBody = (lines) => lines.filter(isComplete).map((line) => ({ itemId: line.itemId, quantity: String(line.quantity).trim(), unit: line.unit }));
/** Something to fix before saving ("Enter an amount for Chicken"), or null. */
export function problem(lines) {
  const bad = lines.find((line) => started(line) && !isComplete(line));
  if (!bad) return null;
  return bad.itemId ? `Enter an amount for ${bad.name}.` : 'Choose an item for each ingredient, or remove the empty one.';
}

function ItemPicker({ id, label, line, items, taken, onPick, loading, onOpenChange }) {
  const [open, setOpen] = useState(!line.itemId);
  const [term, setTerm] = useState('');
  const matches = useMemo(() => {
    const text = term.trim().toLowerCase();
    return items.filter((item) => !text || item.name.toLowerCase().includes(text)).slice(0, 50);
  }, [items, term]);
  const toggle = (value) => { setOpen(value); onOpenChange?.(value); };
  if (!open && line.itemId) {
    return <button type="button" className="o-select rc-picked" aria-label={`${label}: ${line.name}. Change item`} onClick={() => toggle(true)}>{line.name}</button>;
  }
  return <div className="rc-picker">
    <label className="visually-hidden" htmlFor={id}>{`Search items for ${label.toLowerCase()}`}</label>
    <input id={id} className="o-input" type="search" autoComplete="off" placeholder="Search your items" value={term} onChange={(event) => setTerm(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape' && line.itemId) { event.stopPropagation(); toggle(false); } }} />
    <ul className="rc-results" role="listbox" aria-label={`Items for ${label.toLowerCase()}`}>
      {loading ? <li className="rc-none">Loading your items…</li>
        : !matches.length ? <li className="rc-none">{items.length ? 'No item matches. Check the spelling.' : 'No items yet. Add them under Items first.'}</li>
          : matches.map((item) => {
            const used = taken.has(item.id) && item.id !== line.itemId;
            return <li key={item.id} role="presentation">
              <button type="button" role="option" aria-selected={item.id === line.itemId} className="rc-result" disabled={used}
                onClick={() => { onPick(item); setTerm(''); toggle(false); }}>
                {item.name}{used && <small>Already in this recipe</small>}
              </button>
            </li>;
          })}
    </ul>
    {line.itemId && <button type="button" className="o-btn is-quiet is-small" onClick={() => toggle(false)}>Keep {line.name}</button>}
  </div>;
}

/** The list of lines with "Add ingredient". `items` = pickable items; `disabled` shows them as plain text. */
export default function LineEditor({ lines, onChange, items, loadingItems = false, idBase, nameOf = 'ingredient' }) {
  const fallback = useId();
  const ids = idBase || fallback;
  const taken = useMemo(() => new Set(lines.map((line) => line.itemId).filter(Boolean)), [lines]);
  const set = (key, patch) => onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  return <div className="rc-lines">
    {lines.map((line, index) => {
      const label = line.name ? `Amount of ${line.name}` : `Amount of ${nameOf} ${index + 1}`;
      const heading = `${nameOf[0].toUpperCase()}${nameOf.slice(1)} ${index + 1}`;
      return <div key={line.key} className="rc-line" role="group" aria-label={heading}>
        <div className="rc-line-item">
          <ItemPicker id={`${ids}-${line.key}`} label={heading} line={line} items={items} taken={taken} loading={loadingItems}
            onPick={(item) => set(line.key, lineForItem(line, item))} />
        </div>
        <div className="rc-line-amount">
          <QuantityInput id={`${ids}-${line.key}-qty`} label={label} value={line.quantity} onChange={(quantity) => set(line.key, { quantity })}
            unit={line.unit} choices={line.choices} onUnit={(unit) => set(line.key, { unit })} placeholder="Amount" />
          {!line.itemId && <span className="inv-unit-text">Pick an item first</span>}
        </div>
        <button type="button" className="o-icon-btn" aria-label={`Remove ${line.name || `${nameOf} ${index + 1}`}`} onClick={() => onChange(lines.filter((other) => other.key !== line.key))}>
          <OIcon name="close" size={16} />
        </button>
      </div>;
    })}
    <button type="button" className="o-btn is-quiet is-small rc-add" onClick={() => onChange([...lines, emptyLine()])}><OIcon name="plus" size={15} />Add {nameOf}</button>
  </div>;
}
