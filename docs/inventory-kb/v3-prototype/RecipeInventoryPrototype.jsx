// PROTOTYPE: recipe-based inventory with sample data held in the browser. No API calls, no database.
// Shown inside the real dashboard as "Recipe inventory" (owner and branch sidebars). Views: Stock, Recipes, Purchases, History.
import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented } from '../../components/owner/ui';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { FormError, StateChip, TaskDrawer, when } from '../stock/parts';
import {
  SAMPLE_DISHES, SAMPLE_ITEMS, SAMPLE_MOVEMENTS, SAMPLE_OPEN_ORDERS, SAMPLE_PURCHASES, UNITS,
  dishStatus, draftRecipe, hasPrice, kes, missingPrices, qty, rawNeed, unitCost, withAvailability,
} from './recipeData';
import '../../components/owner/overview.css';
import '../business/business.css';
import '../stock/stock.css';
import './prototype.css';

const VIEWS = ['stock', 'recipes', 'purchases', 'history'];
const newId = () => Math.random().toString(36).slice(2, 10);

/* ---------------------------------------------------------------- Views */

function StockTable({ items, onOpen }) {
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">Ingredient</th><th scope="col">Available</th><th scope="col">On hand</th><th scope="col">Held by open orders</th><th scope="col">Cost</th><th scope="col">State</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}>
      <th scope="row"><button type="button" className="st-row-button" onClick={() => onOpen(item)}>{item.name}</button>
        <small>{item.usedIn.length ? `Used in ${item.usedIn.map((d) => d.name).join(', ')}` : 'Not in any recipe yet'}</small></th>
      <td><strong>{qty(item.available, item.unit)}</strong></td>
      <td className={item.onHand < 0 ? 'is-minus' : ''}>{qty(item.onHand, item.unit)}</td>
      <td>{item.reserved ? qty(item.reserved, item.unit) : '—'}</td>
      <td>{unitCost(item)}{item.yieldPct < 100 && <small>{item.yieldPct}% usable</small>}</td>
      <td><StateChip state={item.state} /></td>
    </tr>)}</tbody>
  </table></div>;
}

function PortionsChip({ status, dish }) {
  if (!status.tracked) return <span className="rp-chip is-muted">Not tracked</span>;
  if (status.soldOut) return <span className="rp-chip is-out">Sold out</span>;
  if (status.portions === 0) return <span className="rp-chip is-low">Out · still selling</span>;
  return <span className={`rp-chip${status.portions <= 5 ? ' is-low' : ''}`}>{status.portions} more possible</span>;
}

function Recipes({ dishes, items, onEdit }) {
  return <ul className="biz-people">{dishes.map((dish) => {
    const status = dishStatus(dish, items);
    const name = (id) => items.find((i) => i.id === id);
    return <li className="biz-person" key={dish.id}>
      <span className="biz-person-main">
        <strong>{dish.name} <PortionsChip status={status} dish={dish} /></strong>
        <span>{dish.recipe.length
          ? dish.recipe.map((l) => `${qty(l.amount, name(l.itemId)?.unit)} ${name(l.itemId)?.name.toLowerCase()}`).join(' · ')
          : 'No recipe: selling it doesn’t change stock'}</span>
        {status.tracked && <span>{status.unpriced.length
          ? <span className="rp-warn">Food cost unknown: {missingPrices(status.unpriced)}</span>
          : `Food cost ${kes(status.cost)} · ${Math.round((status.cost / dish.price) * 100)}% of the ${kes(dish.price)} price`}
          {status.limit && status.portions < 20 ? ` · limited by ${status.limit.name.toLowerCase()}` : ''}{dish.keepSelling ? ' · keeps selling when out' : ''}</span>}
      </span>
      <span className="biz-person-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => onEdit(dish)}>{dish.recipe.length ? 'Edit recipe' : 'Add recipe'}</button></span>
    </li>;
  })}</ul>;
}

function Purchases({ purchases, items }) {
  if (!purchases.length) return <EmptyState icon="layers" tone="neutral" title="No purchases yet">Record each supplier invoice so stock and costs stay right.</EmptyState>;
  const name = (id) => items.find((i) => i.id === id);
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">Date</th><th scope="col">Supplier</th><th scope="col">Ingredients</th><th scope="col">Paid by</th><th scope="col">Total</th></tr></thead>
    <tbody>{purchases.map((p) => <tr key={p.id}>
      <td>{day(p.at)}</td>
      <th scope="row">{p.supplier}</th>
      <td>{p.lines.map((l) => <span className="rp-inv-cell" key={l.itemId}>{name(l.itemId)?.name} · {qty(l.amount, name(l.itemId)?.unit)} · {kes(l.total)}</span>)}</td>
      <td><span className={`rp-chip${p.payment === 'credit' ? ' is-low' : ' is-muted'}`}>{PAYMENTS[p.payment]}</span></td>
      <td><strong>{kes(p.lines.reduce((sum, l) => sum + l.total, 0))}</strong></td>
    </tr>)}</tbody>
  </table></div>;
}

function History({ movements, items }) {
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">When</th><th scope="col">Ingredient</th><th scope="col">Change</th><th scope="col">Why</th></tr></thead>
    <tbody>{movements.map((m) => {
      const item = items.find((i) => i.id === m.itemId);
      return <tr key={m.id}><td>{when(m.at)}</td><td>{item?.name}</td>
        <td className={m.change < 0 ? 'is-minus' : 'is-plus'}>{m.change > 0 ? '+' : ''}{qty(m.change, item?.unit)}</td>
        <td>{m.reason}{m.note && <small>{m.note}</small>}</td></tr>;
    })}</tbody>
  </table></div>;
}

/* ---------------------------------------------------------------- Side-sheet forms */

function RecipeForm({ dish, items, onSave, onCancel }) {
  const ids = useId();
  const [lines, setLines] = useState(dish.recipe.length ? dish.recipe.map((l) => ({ ...l, amount: String(l.amount) })) : [{ itemId: '', amount: '' }]);
  const [keepSelling, setKeepSelling] = useState(dish.keepSelling);
  const [describe, setDescribe] = useState('');
  const [drafted, setDrafted] = useState(null);
  const clean = lines.filter((l) => l.itemId && Number(l.amount) > 0).map((l) => ({ itemId: l.itemId, amount: Number(l.amount) }));
  const status = dishStatus({ ...dish, recipe: clean, keepSelling }, items);
  const set = (index, patch) => setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const used = new Set(lines.map((l) => l.itemId));

  function draft() {
    const found = draftRecipe(describe);
    setDrafted(found.length);
    if (found.length) setLines(found.map((l) => ({ ...l, amount: String(l.amount) })));
  }

  return <form className="st-form" onSubmit={(e) => { e.preventDefault(); onSave({ ...dish, recipe: clean, keepSelling }); }} noValidate>
    <div className="rp-describe">
      <label className="o-label" htmlFor={`${ids}-describe`}><OIcon name="sparkle" size={14} /> Describe it instead <span className="o-optional">Optional</span></label>
      <textarea id={`${ids}-describe`} className="o-input" rows={2} value={describe} onChange={(e) => setDescribe(e.target.value)}
        placeholder="e.g. 120g chicken, 80g cheese and one dough ball" />
      <div className="rp-describe-actions">
        <button type="button" className="o-btn is-small" onClick={draft} disabled={!describe.trim()}>Draft recipe</button>
        <span className="o-field-hint">{drafted === null ? 'Prototype: drafted in your browser. The real version would use AI and could read a photo of a written recipe.'
          : drafted ? `Drafted ${drafted} ingredient${drafted === 1 ? '' : 's'}. Check the amounts below.` : 'Couldn’t find any ingredients. Add them below.'}</span>
      </div>
    </div>

    <p className="o-label">Ingredients per portion</p>
    <div className="st-lines">
      {lines.map((line, index) => {
        const item = items.find((i) => i.id === line.itemId);
        const amount = Number(line.amount);
        return <div key={index} className="rp-line-wrap">
          <div className="st-line">
            <label className="visually-hidden" htmlFor={`${ids}-item-${index}`}>Ingredient {index + 1}</label>
            <select id={`${ids}-item-${index}`} className="o-select" value={line.itemId} onChange={(e) => set(index, { itemId: e.target.value })}>
              <option value="">Choose an ingredient…</option>
              {items.map((i) => <option key={i.id} value={i.id} disabled={used.has(i.id) && i.id !== line.itemId}>{i.name}</option>)}
            </select>
            <span className="rp-input-unit">
              <label className="visually-hidden" htmlFor={`${ids}-amt-${index}`}>Amount for ingredient {index + 1}</label>
              <input id={`${ids}-amt-${index}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" placeholder="Amount"
                value={line.amount} onChange={(e) => set(index, { amount: e.target.value })} />
              <span>{item ? UNITS[item.unit].short : ''}</span>
            </span>
            <button type="button" className="o-icon-btn" aria-label={`Remove ingredient ${index + 1}`} onClick={() => setLines(lines.filter((_, i) => i !== index))} disabled={lines.length === 1}>
              <OIcon name="close" size={16} />
            </button>
          </div>
          {item && amount > 0 && <p className="rp-line-note">
            {item.yieldPct < 100 && `Takes ${qty(rawNeed({ amount }, item), item.unit)} raw off stock (${item.yieldPct}% usable) · `}
            {hasPrice(item) ? `${kes(rawNeed({ amount }, item) * item.cost)} per portion` : <span className="rp-warn">No price yet</span>}</p>}
        </div>;
      })}
      <button type="button" className="o-btn is-quiet is-small" onClick={() => setLines([...lines, { itemId: '', amount: '' }])}><OIcon name="plus" size={15} />Add ingredient</button>
    </div>
    <p className="o-field-hint">Only the ingredients worth tracking. Salt, spices and garnish can stay out.</p>

    {clean.length > 0 && <div className="rp-summary">
      {status.unpriced.length
        ? <div><span>Food cost</span><strong>Unknown</strong><small>{missingPrices(status.unpriced)}</small></div>
        : <div><span>Food cost</span><strong>{kes(status.cost)}</strong><small>{Math.round((status.cost / dish.price) * 100)}% of {kes(dish.price)}</small></div>}
      <div><span>Possible now</span><strong>{status.portions}</strong><small>{status.limit ? `${status.limit.name} runs out first` : ''}</small></div>
    </div>}

    <label className="biz-checks-inline"><input type="checkbox" checked={keepSelling} onChange={(e) => setKeepSelling(e.target.checked)} />
      Keep selling when an ingredient runs out</label>
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary">Save recipe</button>
      <button type="button" className="o-btn is-quiet" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

const PAYMENTS = { cash: 'Cash', credit: 'Credit', bank: 'Bank' };
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const day = (iso) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
const emptyLine = (itemId = '') => ({ key: newId(), itemId, amount: '', unitIndex: 0, total: '' });

/** One supplier invoice: supplier, date, how it was paid, then a line per ingredient and the invoice total. */
function PurchaseForm({ items, preset, onSave, onCancel }) {
  const ids = useId();
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(today);
  const [payment, setPayment] = useState('cash');
  // Opens with 4 empty rows (the first pre-filled when opened from a specific ingredient); empty rows are ignored.
  const [lines, setLines] = useState(() => [emptyLine(preset?.id || ''), emptyLine(), emptyLine(), emptyLine()]);
  const set = (key, patch) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const used = new Set(lines.map((l) => l.itemId));

  const rows = lines.map((l) => {
    const item = items.find((i) => i.id === l.itemId);
    const options = item ? UNITS[item.unit].buy : [];
    const base = Number(l.amount) * (options[l.unitIndex]?.[1] || 1);
    const total = Number(l.total);
    return { ...l, item, options, base, totalNum: total,
      complete: Boolean(item) && base > 0 && total > 0, started: Boolean(l.itemId) || l.amount !== '' || l.total !== '' };
  });
  const complete = rows.filter((r) => r.complete);
  const invoiceTotal = complete.reduce((sum, r) => sum + r.totalNum, 0);
  const unfinished = rows.some((r) => r.started && !r.complete);
  const valid = supplier.trim() && date && complete.length > 0 && !unfinished;
  // Errors appear only after a save attempt: missing fields turn red and one message sits above the buttons.
  const [tried, setTried] = useState(false);
  const show = tried && !valid;
  const rowErrors = (row, index) => {
    const check = show && (row.started || (complete.length === 0 && index === 0));
    return { item: check && !row.item, qty: check && !(row.base > 0), total: check && !(row.totalNum > 0) };
  };

  function submit(e) {
    e.preventDefault();
    setTried(true);
    if (!valid) return;
    onSave({ supplier: supplier.trim(), date, payment, lines: complete.map((r) => ({ itemId: r.itemId, amount: r.base, total: r.totalNum })) });
  }

  return <form className="st-form rp-invoice" onSubmit={submit} noValidate>
    <div className="rp-inv-meta">
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-supplier`}>Supplier</label>
        <input id={`${ids}-supplier`} className="o-input" aria-invalid={show && !supplier.trim()} value={supplier} maxLength={80} placeholder="e.g. Mama Njeri Poultry" onChange={(e) => setSupplier(e.target.value)} />
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-date`}>Date</label>
        <input id={`${ids}-date`} className="o-input" type="date" aria-invalid={show && !date} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
      </div>
    </div>
    <div className="o-field">
      <span className="o-label" id={`${ids}-pay`}>Paid by</span>
      <Segmented label="Paid by" value={payment} onChange={setPayment}
        options={Object.entries(PAYMENTS).map(([value, label]) => ({ value, label }))} />
      <p className="o-field-hint">{payment === 'credit' ? 'Credit: you owe the supplier and will pay later.' : payment === 'bank' ? 'Bank transfer or M-Pesa from the business account.' : 'Paid in cash.'}</p>
    </div>

    <div className="rp-inv-table" role="table" aria-label="Invoice lines">
      <div className="rp-inv-grid rp-inv-head" role="row">
        <span role="columnheader">Ingredient</span><span role="columnheader">Quantity</span><span role="columnheader">Unit</span>
        <span role="columnheader">Amount (KES)</span><span role="columnheader"><span className="visually-hidden">Remove</span></span>
      </div>
      {rows.map((row, index) => { const err = rowErrors(row, index); return <div className="rp-inv-line" role="row" key={row.key}>
        <div className="rp-inv-grid">
          <span className="rp-inv-item" role="cell">
            <label className="visually-hidden" htmlFor={`${ids}-item-${row.key}`}>Ingredient {index + 1}</label>
            <select id={`${ids}-item-${row.key}`} className="o-select" aria-invalid={err.item} value={row.itemId} onChange={(e) => set(row.key, { itemId: e.target.value, unitIndex: 0 })}>
              <option value="">Choose…</option>
              {items.map((i) => <option key={i.id} value={i.id} disabled={used.has(i.id) && i.id !== row.itemId}>{i.name}</option>)}
            </select>
          </span>
          <span role="cell">
            <label className="visually-hidden" htmlFor={`${ids}-qty-${row.key}`}>Quantity for ingredient {index + 1}</label>
            <input id={`${ids}-qty-${row.key}`} className="o-input" type="number" inputMode="decimal" min="0" step="any" placeholder="Qty" aria-invalid={err.qty} value={row.amount} onChange={(e) => set(row.key, { amount: e.target.value })} />
          </span>
          <span role="cell">
            {/* Always shown; the choices come from the ingredient (kg/g, L/ml, pcs or servings), so it waits for one. */}
            <select className="o-select" aria-label={`Unit for ingredient ${index + 1}`} value={row.item ? row.unitIndex : ''} disabled={!row.item}
              onChange={(e) => set(row.key, { unitIndex: Number(e.target.value) })}>
              {row.item ? row.options.map(([label], i) => <option key={label} value={i}>{label}</option>) : <option value="">Unit</option>}
            </select>
          </span>
          <span role="cell">
            <label className="visually-hidden" htmlFor={`${ids}-total-${row.key}`}>Amount in KES for ingredient {index + 1}</label>
            <input id={`${ids}-total-${row.key}`} className="o-input" type="number" inputMode="decimal" min="0" step="any" placeholder="KES" aria-invalid={err.total} value={row.total} onChange={(e) => set(row.key, { total: e.target.value })} />
          </span>
          <span role="cell">
            <button type="button" className="o-icon-btn" aria-label={`Remove ingredient ${index + 1}`} disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((l) => l.key !== row.key))}><OIcon name="close" size={16} /></button>
          </span>
        </div>
      </div>; })}
      <button type="button" className="o-btn is-quiet is-small" onClick={() => setLines([...lines, emptyLine()])} disabled={lines.length >= items.length}>
        <OIcon name="plus" size={15} />Add ingredient</button>
    </div>

    <div className="rp-inv-total">
      <div><span>Items</span><strong>{complete.length}</strong></div>
      <div><span>{payment === 'credit' ? 'Total owed' : 'Invoice total'}</span><strong>{kes(invoiceTotal)}</strong>
        <small>{PAYMENTS[payment]}{supplier.trim() ? ` · ${supplier.trim()}` : ''}{date ? ` · ${day(date)}` : ''}</small></div>
    </div>

    <p className="o-field-hint rp-scan"><OIcon name="scan" size={14} />Later: photograph the supplier’s invoice and these lines fill themselves in.</p>
    <FormError error={show ? (complete.length === 0 && !unfinished
      ? 'Add at least one ingredient with a quantity and an amount.'
      : 'Fill in the fields marked in red.') : ''} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary">Record purchase</button>
      <button type="button" className="o-btn is-quiet" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function IngredientForm({ item, onSave, onBuy, onCancel }) {
  const ids = useId();
  const isNew = !item;
  const [values, setValues] = useState(() => ({
    name: item?.name || '', unit: item?.unit || 'g',
    low: item?.low === null || item?.low === undefined ? '' : String(item.unit === 'g' || item.unit === 'ml' ? item.low / 1000 : item.low),
  }));
  const big = values.unit === 'g' || values.unit === 'ml';
  // No price here: an ingredient gets its price from Record purchase.
  const set = (patch) => setValues({ ...values, ...patch });
  function submit(e) {
    e.preventDefault();
    onSave({
      ...(item || { id: newId(), onHand: 0, cost: 0 }),
      name: values.name.trim(), unit: values.unit,
      low: values.low === '' ? null : Number(values.low) * (big ? 1000 : 1),
    });
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    {!isNew && <div className="rp-summary">
      <div><span>On hand</span><strong>{qty(item.onHand, item.unit)}</strong><small>{qty(item.available, item.unit)} available</small></div>
      <div><span>Cost</span><strong>{unitCost(item)}</strong><small>latest purchase</small></div>
    </div>}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Name</label>
      <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={80} placeholder="e.g. Chicken (raw, bone-in)" onChange={(e) => set({ name: e.target.value })} />
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-unit`}>Measured by</label>
      <select id={`${ids}-unit`} className="o-select" value={values.unit} disabled={!isNew} onChange={(e) => set({ unit: e.target.value })}>
        {Object.entries(UNITS).map(([key, u]) => <option key={key} value={key}>{u.name}</option>)}
      </select>
      {!isNew && <p className="o-field-hint">Can’t change once stock is recorded.</p>}
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-low`}>Running low below <span className="o-optional">{big ? (values.unit === 'g' ? 'kg' : 'L') : UNITS[values.unit].short}</span></label>
      <input id={`${ids}-low`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={values.low} onChange={(e) => set({ low: e.target.value })} />
    </div>
    {!isNew && item.usedIn.length > 0 && <p className="o-field-hint">Used in {item.usedIn.map((d) => d.name).join(', ')}.</p>}
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={!values.name.trim()}>{isNew ? 'Add ingredient' : 'Save'}</button>
      {!isNew && <button type="button" className="o-btn" onClick={() => onBuy(item)}>Record purchase</button>}
      <button type="button" className="o-btn is-quiet" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

/* ---------------------------------------------------------------- Page */

export default function RecipeInventoryPrototype() {
  const { notify } = useNotifications();
  const [params, setParams] = useSearchParams();
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'stock';
  const setView = (next) => setParams(next === 'stock' ? {} : { view: next }, { replace: true });

  const [rawItems, setRawItems] = useState(SAMPLE_ITEMS);
  const [dishes, setDishes] = useState(SAMPLE_DISHES);
  const [purchases, setPurchases] = useState(SAMPLE_PURCHASES);
  const [movements, setMovements] = useState(SAMPLE_MOVEMENTS);
  const [task, setTask] = useState(null); // { kind: 'recipe' | 'purchase' | 'ingredient', dish?, item? }
  const close = () => setTask(null);

  const items = useMemo(() => withAvailability(rawItems, dishes, SAMPLE_OPEN_ORDERS), [rawItems, dishes]);
  const log = (entries) => setMovements((list) => [...entries.map((e) => ({ id: newId(), at: new Date().toISOString(), ...e })), ...list]);

  function saveRecipe(dish) {
    setDishes((list) => list.map((d) => (d.id === dish.id ? dish : d)));
    notify(`${dish.name}: recipe saved.`); close();
  }
  // A whole invoice: every line adds stock and sets that ingredient's latest price.
  function savePurchase({ supplier, date, payment, lines }) {
    setRawItems((list) => list.map((i) => {
      const line = lines.find((l) => l.itemId === i.id);
      return line ? { ...i, onHand: i.onHand + line.amount, cost: line.total / line.amount } : i;
    }));
    setPurchases((list) => [{ id: newId(), at: date, supplier, payment, lines }, ...list]);
    log(lines.map((l) => ({ itemId: l.itemId, change: l.amount, reason: 'Purchased', note: `${supplier} · ${PAYMENTS[payment]} · ${kes(l.total)}` })));
    const total = lines.reduce((sum, l) => sum + l.total, 0);
    notify(`Purchase from ${supplier} recorded: ${lines.length} item${lines.length === 1 ? '' : 's'}, ${kes(total)}.`); close();
  }
  function saveIngredient(next) {
    setRawItems((list) => (list.some((i) => i.id === next.id) ? list.map((i) => (i.id === next.id ? { ...i, ...next } : i)) : [...list, next]));
    notify(`${next.name} saved.`); close();
  }

  const titles = { recipe: task?.dish?.name, purchase: 'Record purchase', ingredient: task?.item ? task.item.name : 'New ingredient' };
  const tracked = dishes.filter((d) => d.recipe.length).length;

  return <div className="biz-stack">
      <div className="rp-banner" role="note"><OIcon name="info" size={16} /><span><strong>Prototype with sample data.</strong> Changes stay in this browser tab and disappear on reload. Nothing is saved to Cravio.</span></div>
      <PageHeader title="Inventory" description="Ingredients at this branch. When a dish is served, its recipe comes off stock; when an ingredient runs out, the dishes that need it show as sold out." />
      <div className="st-toolbar">
        <Segmented label="Inventory views" value={view} onChange={setView} options={[
          { value: 'stock', label: 'Stock' }, { value: 'recipes', label: 'Recipes' }, { value: 'purchases', label: 'Purchases' },
          { value: 'history', label: 'History' },
        ]} />
        <div className="st-toolbar-actions">
          <button type="button" className="o-btn" onClick={() => setTask({ kind: 'ingredient' })}><OIcon name="plus" size={15} />New ingredient</button>
          <button type="button" className="o-btn is-primary" onClick={() => setTask({ kind: 'purchase' })}>Record purchase</button>
        </div>
      </div>

      {view === 'stock' && <Panel title="Ingredients" count={items.length} sub="Select an ingredient to change its details or record a purchase">
        <StockTable items={items} onOpen={(item) => setTask({ kind: 'ingredient', item })} /></Panel>}
      {view === 'recipes' && <Panel title="Recipes" sub={`${tracked} of ${dishes.length} dishes have a recipe. Dishes without one don’t change stock.`}>
        <Recipes dishes={dishes} items={items} onEdit={(dish) => setTask({ kind: 'recipe', dish })} /></Panel>}
      {view === 'purchases' && <Panel title="Purchases" count={purchases.length} sub="One row per supplier invoice. Each one adds stock and updates ingredient prices.">
        <Purchases purchases={purchases} items={items} /></Panel>}
      {view === 'history' && <Panel title="History" sub="Every change, newest first"><History movements={movements} items={items} /></Panel>}

      <TaskDrawer open={Boolean(task)} title={titles[task?.kind] || 'Inventory'} onClose={close} wide={task?.kind === 'purchase'}>
        {task?.kind === 'recipe' && <RecipeForm dish={task.dish} items={items} onSave={saveRecipe} onCancel={close} />}
        {task?.kind === 'purchase' && <PurchaseForm items={items} preset={task.item} onSave={savePurchase} onCancel={close} />}
        {task?.kind === 'ingredient' && <IngredientForm item={task.item ? items.find((i) => i.id === task.item.id) : null} onSave={saveIngredient}
          onBuy={(item) => setTask({ kind: 'purchase', item })} onCancel={close} />}
      </TaskDrawer>
  </div>;
}
