// Owner Items (/owner/inventory/items): everything the business buys or makes. Search, filter by category, show archived.
// "Add item" (primary) and "Import" open in the side sheet. /owner/inventory/items?item=<id> opens that item (the Stock page links here),
// ?add=1 opens the empty form (the first-time guide links here).
import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/api';
import { MEASURED_LABEL, ownerPaths, unitWord } from '../../lib/inventory';
import ImportDrawer from './ImportDrawer';
import ItemDrawer from './ItemDrawer';
import { EmptyState, NoItems, OIcon, OwnerFrame, Panel, SkeletonRows, StockBadge, TaskDrawer, levelState } from './parts';

function ItemsBody({ ctx, task, setTask }) {
  const { data, can, business } = ctx;
  const ids = useId();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [archived, setArchived] = useState(false);
  const archivedList = useApi(archived ? ownerPaths(business.id).overview({ archived: true }) : null, { ttl: 15000 });
  const source = archived ? archivedList.data?.items : data.items;

  const term = search.trim().toLowerCase();
  const rows = useMemo(() => (source || []).filter((item) => (!category || item.categoryId === category)
    && (!term || `${item.name} ${item.sku || ''} ${(item.barcodes || []).join(' ')}`.toLowerCase().includes(term))
    && (!archived || item.archived)), [source, category, term, archived]);

  const wanted = params.get('item');
  const open = task || (wanted ? { kind: 'item', item: (source || data.items).find((i) => i.id === wanted) } : params.get('add') ? { kind: 'item', item: null } : null);
  const close = () => { setTask(null); if (params.get('item') || params.get('add')) setParams({}, { replace: true }); };
  const editing = open?.kind === 'item' && open.item;
  const clear = () => { setSearch(''); setCategory(''); };

  return <>
    <Panel title={archived ? 'Archived items' : 'Items'} count={source ? rows.length : undefined}
      sub={archived ? 'Hidden from lists and from stock. Open one to restore it.' : 'Select an item to change how it is measured, its packs, levels and barcodes.'}>
      {!data.items.length && !archived ? <NoItems can={can} /> : <>
        <div className="inv-toolbar">
          <label className="visually-hidden" htmlFor={`${ids}-q`}>Search items</label>
          <input id={`${ids}-q`} className="o-input inv-search" type="search" placeholder="Search by name, code or barcode" value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="visually-hidden" htmlFor={`${ids}-cat`}>Category</label>
          <select id={`${ids}-cat`} className="o-select" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {data.categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="inv-check"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Show archived</label>
        </div>
        {archived && archivedList.loading ? <SkeletonRows rows={4} thumb={false} label="Loading archived items" />
          : !rows.length ? <EmptyState icon="search" tone="neutral" title={archived ? 'Nothing archived' : 'No items match'}
            action={!archived ? <button type="button" className="o-btn is-secondary" onClick={clear}>Clear filters</button> : null}>
            {archived ? 'Items you archive are kept here with their history.' : 'Try a different search or category.'}</EmptyState>
            : <div className="inv-table-wrap"><table className="inv-table inv-items">
              <thead><tr><th scope="col">Item</th><th scope="col">Category</th><th scope="col">Measured by</th><th scope="col" className="is-num">On hand</th></tr></thead>
              <tbody>{rows.map((item) => <tr key={item.id}>
                <th scope="row"><button type="button" className="inv-link" onClick={() => setTask({ kind: 'item', item })}>{item.name}</button>
                  {item.sku && <small>Code {item.sku}</small>}</th>
                <td>{item.categoryName || <span className="is-muted">–</span>}</td>
                <td>{MEASURED_LABEL[item.measuredBy] || item.measuredBy}<small>Shown in {unitWord(item.displayUnit || item.baseUnit, 2, data.units)}</small></td>
                <td className="is-num"><span className="inv-amount">{item.archived ? <span className="inv-badge is-off">Archived</span> : <StockBadge state={item.locations.some((l) => levelState(l) === 'out') ? 'out' : item.low ? 'low' : 'ok'} />}
                  <span>{item.totals.display.onHand}</span></span></td>
              </tr>)}</tbody>
            </table></div>}
      </>}
    </Panel>
    <TaskDrawer open={open?.kind === 'item'} title={editing ? open.item.name : 'Add item'} onClose={close}>
      {open?.kind === 'item' && <ItemDrawer key={open.item?.id || 'new'} ctx={ctx} item={editing ? open.item : null} onClose={close} />}
    </TaskDrawer>
    <TaskDrawer open={open?.kind === 'import'} title="Import items from a spreadsheet" onClose={close} wide>
      {open?.kind === 'import' && <ImportDrawer ctx={ctx} onClose={close} />}
    </TaskDrawer>
  </>;
}

export default function OwnerItemsPage() {
  const [task, setTask] = useState(null);
  return <OwnerFrame title="Items" description="Everything you buy or make, how it is measured, and the packs it comes in."
    actions={(ctx) => ctx.can.itemEdit && <>
      <button type="button" className="o-btn" onClick={() => setTask({ kind: 'import' })}><OIcon name="download" size={15} />Import</button>
      <button type="button" className="o-btn is-primary" onClick={() => setTask({ kind: 'item', item: null })}><OIcon name="plus" size={15} />Add item</button>
    </>}>
    {(ctx) => <ItemsBody ctx={ctx} task={task} setTask={setTask} />}
  </OwnerFrame>;
}
