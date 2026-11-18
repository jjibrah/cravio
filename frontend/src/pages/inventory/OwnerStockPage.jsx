import { formatStockMoney } from '../../lib/inventory';
// Owner Stock (/owner/inventory when inventory is on): one table of items x places (the Warehouse first, then every
// branch this person sees), with what's low or out at the top, filters, a CSV of what is on screen, and the one main
// action: record opening stock. The Warehouse can be renamed here (it is always labelled "Warehouse").
import { useId, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { ownerPaths, useInventoryWrite } from '../../lib/inventory';
import OpeningDrawer from './OpeningDrawer';
import { FormError, NoItems, OIcon, OwnerFrame, Panel, StockBadge, TaskDrawer, downloadText, levelState, toCsv } from './parts';

const RENAME = 'rename';

function RenameWarehouse({ ctx, onClose }) {
  const id = useId();
  const { notify } = useNotifications();
  const [name, setName] = useState(ctx.data.warehouse?.name || 'Warehouse');
  const [run, { busy, error }] = useInventoryWrite();
  async function submit(event) {
    event.preventDefault();
    const result = await run('PATCH', ctx.paths.warehouse, { name });
    if (result) { notify('Warehouse renamed.'); ctx.refresh(); onClose(); }
  }
  return <form className="inv-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={id}>Warehouse name</label>
      <input id={id} className="o-input" value={name} maxLength={80} data-autofocus onChange={(event) => setName(event.target.value)} />
      <p className="o-field-hint">Your business has one Warehouse: where stock arrives before it goes to branches. Call it what your team calls it.</p>
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function Cell({ entry }) {
  if (!entry) return <span className="is-muted">–</span>;
  const state = levelState(entry);
  const zero = Number(entry.onHand) <= 0;
  return <span className="inv-amount"><StockBadge state={state} /><span className={zero && state === 'ok' ? 'is-muted' : undefined}>{entry.display.onHand}</span></span>;
}

function StockTable({ ctx, search, category, place, lowOnly, onClear }) {
  const { data, can } = ctx;
  const places = place === 'all' ? data.locations : data.locations.filter((l) => l.id === place);
  const term = search.trim().toLowerCase();
  const rows = useMemo(() => data.items.filter((item) => {
    if (category && item.categoryId !== category) return false;
    if (term && !`${item.name} ${item.sku || ''}`.toLowerCase().includes(term)) return false;
    if (lowOnly && !item.locations.some((l) => places.some((p) => p.id === l.locationId) && l.low)) return false;
    return true;
  }), [data.items, category, term, lowOnly, places]);
  const entryOf = (item, loc) => item.locations.find((l) => l.locationId === loc.id);
  const valueOf = (item) => (place === 'all' ? item.totals.value : entryOf(item, places[0])?.value);
  const money = (value) => (value === null || value === undefined ? '–' : formatStockMoney(value));

  function exportCsv() {
    const head = ['Item', 'Category', ...places.map((p) => p.name), ...(can.costView ? ['Value (KES)'] : [])];
    const body = rows.map((item) => [item.name, item.categoryName || '', ...places.map((p) => entryOf(item, p)?.display.onHand ?? ''),
      ...(can.costView ? [valueOf(item) ?? ''] : [])]);
    downloadText(`stock-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([head, ...body]));
  }

  if (!rows.length) {
    return <EmptyMatches onClear={onClear} />;
  }
  return <>
    <div className="inv-table-wrap"><table className="inv-table inv-stock inv-cards">
      <thead><tr>
        <th scope="col">Item</th>
        {places.map((p) => <th scope="col" className="is-num" key={p.id}>{p.name}{p.label === 'Warehouse' && p.name !== 'Warehouse' ? <small>Warehouse</small> : null}</th>)}
        {can.costView && <th scope="col" className="is-num">Value</th>}
      </tr></thead>
      <tbody>{rows.map((item) => <tr key={item.id}>
        <th scope="row">{can.itemEdit ? <Link className="inv-link" to={`/owner/inventory/items?item=${item.id}`}>{item.name}</Link> : item.name}
          {item.categoryName && <small>{item.categoryName}</small>}</th>
        {places.map((p) => <td className="is-num" key={p.id} data-label={p.name}><Cell entry={entryOf(item, p)} /></td>)}
        {can.costView && <td className="is-num" data-label="Value">{money(valueOf(item))}</td>}
      </tr>)}</tbody>
    </table></div>
    <div className="inv-toolbar" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
      <span className="inv-unit-text">{rows.length} {rows.length === 1 ? 'item' : 'items'} shown</span>
      <span className="inv-spacer" />
      <button type="button" className="o-btn is-small" onClick={exportCsv}><OIcon name="download" size={15} />Download as spreadsheet (CSV)</button>
    </div>
  </>;
}

function EmptyMatches({ onClear }) {
  return <div className="o-state is-empty is-neutral">
    <span className="o-state-icon"><OIcon name="search" size={22} /></span>
    <div className="o-state-text"><strong>No items match</strong><span>Try a different search or clear the filters.</span></div>
    <button type="button" className="o-btn is-secondary" onClick={onClear}>Clear filters</button>
  </div>;
}

function StockBody({ ctx, task, setTask }) {
  const { data, can } = ctx;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [place, setPlace] = useState('all');
  const [lowOnly, setLowOnly] = useState(false);
  const ids = useId();
  const clear = () => { setSearch(''); setCategory(''); setPlace('all'); setLowOnly(false); };

  const out = data.items.filter((item) => item.locations.some((l) => levelState(l) === 'out'));
  const low = data.items.filter((item) => !out.includes(item) && item.locations.some((l) => levelState(l) === 'low'));
  const rename = can.settingsEdit && <button type="button" className="o-btn is-quiet is-small" onClick={() => setTask(RENAME)}><OIcon name="edit" size={14} />Rename Warehouse</button>;

  return <>
    {(out.length > 0 || low.length > 0) && <section className="inv-attention" aria-label="Needs attention">
      {out.length > 0 && <div className="inv-attention-card is-urgent"><span><strong>{out.length} {out.length === 1 ? 'item is' : 'items are'} out</strong>Somewhere you have none left.</span>
        <button type="button" className="o-btn is-small" onClick={() => setLowOnly(true)}>Show</button></div>}
      {low.length > 0 && <div className="inv-attention-card"><span><strong>{low.length} running low</strong>Below the level you set.</span>
        <button type="button" className="o-btn is-small" onClick={() => setLowOnly(true)}>Show</button></div>}
    </section>}
    <Panel title="Stock" count={data.items.length} actions={rename || null}
      sub={`On hand in the ${data.warehouse?.name === 'Warehouse' ? 'Warehouse' : `Warehouse (${data.warehouse?.name})`} and at each branch you can see.`}>
      {!data.items.length ? <NoItems can={can} /> : <>
        <div className="inv-toolbar">
          <label className="visually-hidden" htmlFor={`${ids}-q`}>Search items</label>
          <input id={`${ids}-q`} className="o-input inv-search" type="search" placeholder="Search items" value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="visually-hidden" htmlFor={`${ids}-cat`}>Category</label>
          <select id={`${ids}-cat`} className="o-select" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {data.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="visually-hidden" htmlFor={`${ids}-place`}>Place</label>
          <select id={`${ids}-place`} className="o-select" value={place} onChange={(event) => setPlace(event.target.value)}>
            <option value="all">All places</option>
            {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <label className="inv-check"><input type="checkbox" checked={lowOnly} onChange={(event) => setLowOnly(event.target.checked)} />Low or out only</label>
        </div>
        <StockTable ctx={ctx} search={search} category={category} place={place} lowOnly={lowOnly} onClear={clear} />
      </>}
    </Panel>
    <TaskDrawer open={task === 'opening'} title="Record opening stock" onClose={() => setTask(null)}>
      <OpeningDrawer ctx={ctx} onClose={() => setTask(null)} />
    </TaskDrawer>
    <TaskDrawer open={task === RENAME} title="Rename Warehouse" onClose={() => setTask(null)}>
      <RenameWarehouse ctx={ctx} onClose={() => setTask(null)} />
    </TaskDrawer>
  </>;
}

export default function OwnerStockPage() {
  const [params] = useSearchParams();
  const [task, setTask] = useState(null);
  // Old links (/owner/inventory?view=history) keep working: history has its own page now.
  if (params.get('view') === 'history') return <Navigate to="/owner/inventory/history" replace />;
  return <OwnerFrame title="Stock" description="What you have on hand in the Warehouse and at every branch."
    actions={(ctx) => ctx.can.stockRecord && ctx.data.items.length > 0 && <button type="button" className="o-btn is-primary" onClick={() => setTask('opening')}>
      <OIcon name="plus" size={15} />Record opening stock</button>}>
    {(ctx) => <StockBody ctx={ctx} task={task} setTask={setTask} />}
  </OwnerFrame>;
}
