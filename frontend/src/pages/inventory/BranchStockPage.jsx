import { formatStockMoney } from '../../lib/inventory';
// Branch Stock (/branch/:id/inventory when inventory is on): what this branch has, what is held for open orders and what is
// still available, with the things that need attention at the top (out, low, count needed, shortfalls). One main action:
// Record stock (count, add or waste). Tap an item for its sheet. Everything the server says is shown in plain words.
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { branchPath } from '../../lib/branch';
import { branchPaths, formatStamp } from '../../lib/inventory';
import BranchRecordDrawer from './BranchRecordDrawer';
import BranchShortfalls from './BranchShortfalls';
import { EmptyState, ErrorState, OIcon, PageHeader, Panel, SkeletonRows, TaskDrawer } from './parts';
import './branch.css';

/** Out / Low / Count needed. An item can be both out and need a count. */
function Badges({ item }) {
  return <span className="inv-badges">
    {item.state === 'out' && <span className="inv-badge is-out">Out</span>}
    {item.state === 'low' && <span className="inv-badge is-low">Low</span>}
    {item.countNeeded && <span className="inv-badge is-count">Count needed</span>}
  </span>;
}

const used = (item) => (item.dishes ? `Used in ${item.dishes} ${item.dishes === 1 ? 'dish' : 'dishes'}` : 'Not used in a dish yet');
const money = (value) => (value === null || value === undefined ? '–' : formatStockMoney(value));

function StartGuide({ canAddItems }) {
  return <ol className="inv-guide" aria-label="How to get started">
    <li><strong>Add your items</strong> <span>Everything you buy or make: chicken, flour, oil, buns. {canAddItems
      ? <Link className="inv-link" to="/owner/inventory/items?add=1">Add items</Link> : 'The business owner adds them under Items.'}</span></li>
    <li><strong>Count what you have</strong> <span>Press Record stock, choose Count, and say how much of each item is on the shelf now.</span></li>
    <li><strong>Add recipes</strong> <span>Tell Cravio what goes into each dish, so stock goes down as you serve. <Link className="inv-link" to={branchPath('recipes')}>Open Recipes</Link></span></li>
    <li><strong>You’re done</strong> <span>This page then shows what is on hand, what is held for open orders and what is running low.</span></li>
  </ol>;
}

function ItemSheet({ item, seeCost, onRecord }) {
  const detail = useApi(branchPaths.item(item.id), { ttl: 5000 });
  const moves = (detail.data?.movements || []).slice(0, 8);
  const level = item.levelDisplay;
  return <div className="inv-form">
    <p className="o-field-hint">{used(item)}.</p>
    {item.countNeeded && <p className="inv-note" role="status"><OIcon name="alert" size={14} /> {item.countNeededReason}</p>}
    <dl className="inv-facts">
      <div className="inv-fact"><dt>On hand</dt><dd>{item.display.onHand}</dd></div>
      <div className="inv-fact"><dt>Held for open orders</dt><dd>{item.display.heldForOrders}</dd></div>
      <div className="inv-fact"><dt>Available</dt><dd>{item.display.available}</dd></div>
      {level?.reorder && <div className="inv-fact"><dt>Low at</dt><dd>{level.reorder}</dd></div>}
      {level?.par && <div className="inv-fact"><dt>Usual level</dt><dd>{level.par}</dd></div>}
      {seeCost && <div className="inv-fact"><dt>Value</dt><dd>{money(item.value)}</dd></div>}
    </dl>
    <div className="inv-actions" role="group" aria-label={`Record stock for ${item.name}`}>
      <button type="button" className="o-btn is-primary" onClick={() => onRecord('count', item.id)}>Count</button>
      <button type="button" className="o-btn" onClick={() => onRecord('add', item.id)}>Add</button>
      <button type="button" className="o-btn" onClick={() => onRecord('waste', item.id)}>Waste</button>
    </div>
    <h3 className="inv-section" style={{ margin: '0 0 4px' }}>Latest changes</h3>
    {detail.loading && !detail.data ? <SkeletonRows rows={3} thumb={false} label="Loading latest changes" />
      : !moves.length ? <p className="o-field-hint">No changes yet. Count the item to start its history.</p>
        : <ul className="inv-moves">{moves.map((m) => <li key={m.id}>
          <span>{m.reasonLabel}{m.note ? <small>{m.note}</small> : null}<small>{formatStamp(m.occurredAt)}</small></span>
          <span className={`inv-delta${m.display.delta.startsWith('-') ? ' is-minus' : ''}`}>{m.display.delta}</span>
        </li>)}</ul>}
    <p><Link className="inv-link" to={`${branchPath('inventory/history')}?item=${item.id}`}>See everything for {item.name}</Link></p>
  </div>;
}

const FILTER_NAMES = { out: 'Showing items that are out', low: 'Showing items running low', count: 'Showing items that need a count' };

function StockBody({ data, refresh, canAddItems, sheet, setSheet }) {
  const ids = useId();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | attention | out | low | count
  const { items, summary, seeCost } = data;
  const term = search.trim().toLowerCase();
  const rows = useMemo(() => items.filter((item) => {
    if (term && !`${item.name} ${item.sku || ''}`.toLowerCase().includes(term)) return false;
    if (filter === 'attention') return item.state !== 'ok';
    if (filter === 'out') return item.state === 'out';
    if (filter === 'low') return item.state === 'low';
    if (filter === 'count') return item.countNeeded;
    return true;
  }), [items, term, filter]);
  const sheetItem = sheet?.type === 'item' ? items.find((item) => item.id === sheet.id) : null;
  const close = () => setSheet(null);
  const cards = [
    { key: 'out', n: summary.out, title: `${summary.out} ${summary.out === 1 ? 'item is' : 'items are'} out`, text: 'None available right now.', urgent: true },
    { key: 'low', n: summary.low, title: `${summary.low} running low`, text: 'Below the level you set.' },
    { key: 'count', n: summary.countNeeded, title: `${summary.countNeeded} ${summary.countNeeded === 1 ? 'needs' : 'need'} a count`, text: 'The numbers can’t be trusted until counted.' },
  ].filter((card) => card.n > 0);

  return <>
    {(cards.length > 0 || data.openExceptions > 0) && <section className="inv-attention" aria-label="Needs attention">
      {data.openExceptions > 0 && <div className="inv-attention-card is-urgent">
        <span><strong>{data.openExceptions} {data.openExceptions === 1 ? 'order was' : 'orders were'} served short</strong>The system showed too little stock. Check them.</span>
        <button type="button" className="o-btn is-small" onClick={() => setSheet({ type: 'short' })}>Review</button></div>}
      {cards.map((card) => <div key={card.key} className={`inv-attention-card${card.urgent ? ' is-urgent' : ''}`}>
        <span><strong>{card.title}</strong>{card.text}</span>
        <button type="button" className="o-btn is-small" onClick={() => setFilter(card.key)}>Show</button></div>)}
    </section>}

    <Panel title="Stock" count={items.length} sub="On hand is what is on the shelf. Available is what is left after what open orders will use.">
      {!items.length ? <>
        <EmptyState icon="layers" tone="neutral" title="No stock recorded here yet">
          Press Record stock (top of the page) and count what you have on the shelf. It will show up here.
        </EmptyState>
        <StartGuide canAddItems={canAddItems} />
      </> : <>
        <div className="inv-toolbar">
          <label className="visually-hidden" htmlFor={`${ids}-q`}>Search items</label>
          <input id={`${ids}-q`} className="o-input inv-search" type="search" placeholder="Search items" value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="inv-check"><input type="checkbox" checked={filter === 'attention'} onChange={(event) => setFilter(event.target.checked ? 'attention' : 'all')} />Low or out only</label>
          {FILTER_NAMES[filter] && <button type="button" className="o-btn is-small is-secondary inv-filter-chip" onClick={() => setFilter('all')}>{FILTER_NAMES[filter]}<OIcon name="close" size={13} /></button>}
        </div>
        {!rows.length ? <div className="o-state is-empty is-neutral">
          <span className="o-state-icon"><OIcon name="search" size={22} /></span>
          <div className="o-state-text"><strong>No items match</strong><span>Try a different search or clear the filters.</span></div>
          <button type="button" className="o-btn is-secondary" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</button>
        </div> : <div className="inv-table-wrap"><table className="inv-table inv-stock-table">
          <thead><tr>
            <th scope="col">Item</th><th scope="col" className="is-num">On hand</th><th scope="col" className="is-num">Held for open orders</th>
            <th scope="col" className="is-num">Available</th><th scope="col">Status</th>{seeCost && <th scope="col" className="is-num">Value</th>}
          </tr></thead>
          <tbody>{rows.map((item) => <tr key={item.id} onClick={() => setSheet({ type: 'item', id: item.id })}>
            <th scope="row"><button type="button" className="inv-link" onClick={(event) => { event.stopPropagation(); setSheet({ type: 'item', id: item.id }); }}>{item.name}</button>
              <span className="inv-used">{used(item)}</span></th>
            <td className="is-num" data-label="On hand">{item.display.onHand}</td>
            <td className={`is-num${Number(item.heldForOrders) > 0 ? '' : ' is-zero'}`} data-label="Held for open orders">{Number(item.heldForOrders) > 0 ? item.display.heldForOrders : <span className="is-muted">–</span>}</td>
            <td className={`is-num${item.state === 'out' ? ' is-minus' : ''}`} data-label="Available"><strong>{item.display.available}</strong></td>
            <td className={`inv-status${item.state === 'ok' && !item.countNeeded ? ' is-zero' : ''}`}><Badges item={item} /></td>
            {seeCost && <td className="is-num" data-label="Value">{money(item.value)}</td>}
          </tr>)}</tbody>
        </table></div>}
        <div className="inv-toolbar" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
          <span className="inv-unit-text">{rows.length} {rows.length === 1 ? 'item' : 'items'} shown</span>
          <span className="inv-spacer" />
          {seeCost && summary.value !== undefined && <span className="inv-unit-text">Stock value {formatStockMoney(summary.value)}{summary.valueComplete === false ? ' (some costs unknown)' : ''}</span>}
        </div>
      </>}
    </Panel>

    <TaskDrawer open={Boolean(sheetItem)} title={sheetItem?.name || 'Item'} onClose={close}>
      {sheetItem && <ItemSheet item={sheetItem} seeCost={seeCost} onRecord={(kind, itemId) => setSheet({ type: 'record', kind, itemId })} />}
    </TaskDrawer>
    <TaskDrawer open={sheet?.type === 'record'} title="Record stock" onClose={close}>
      {sheet?.type === 'record' && <BranchRecordDrawer start={sheet} seeCost={seeCost} items={items} onClose={close} onDone={() => { refresh(); close(); }} />}
    </TaskDrawer>
    <TaskDrawer open={sheet?.type === 'short'} title="Orders served short" onClose={close}>
      <BranchShortfalls onChanged={refresh} onCount={(itemId) => setSheet({ type: 'record', kind: 'count', itemId })} />
    </TaskDrawer>
  </>;
}

export default function BranchStockPage({ section }) {
  const { account } = useAuth() || {};
  const { data, error, loading, refresh } = useApi(branchPaths.snapshot(), { ttl: 10000 });
  const canAddItems = (account?.businesses || []).length > 0;
  const [sheet, setSheet] = useState(null); // { type: 'item', id } | { type: 'record', kind, itemId } | { type: 'short' }
  return <div className="biz-stack inv-page">
    <PageHeader title={section?.label || 'Stock'} description={section?.description || 'What you have on hand at this branch.'}>
      <button type="button" className="o-btn is-primary" disabled={!data} onClick={() => setSheet({ type: 'record', kind: 'count' })}><OIcon name="plus" size={15} />Record stock</button>
    </PageHeader>
    {error && !data ? <ErrorState error={error} onRetry={refresh} what="stock" />
      : loading && !data ? <Panel title="Stock"><SkeletonRows rows={6} thumb={false} label="Loading stock" /></Panel>
        : data ? <StockBody data={data} refresh={refresh} canAddItems={canAddItems} sheet={sheet} setSheet={setSheet} /> : null}
  </div>;
}
