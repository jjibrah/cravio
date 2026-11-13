import { useId, useState } from 'react';
import { OIcon } from '../owner/ui';
import { formatKsh, formatWhole } from './chartKit';

const COLUMNS = [
  { key: 'name', label: 'Dish', sort: 'name' },
  { key: 'views', label: 'Views', sort: 'views', numeric: true },
  { key: 'videoPlays', label: 'Video plays', sort: 'plays', numeric: true },
  { key: 'orderedQuantity', label: 'Ordered', sort: 'quantity', numeric: true },
  { key: 'sales', label: 'Sales', sort: 'sales', numeric: true },
];
const TOP = 10;

/**
 * Dish performance: every dish and deal for the period, sorted on the server (`sort`, `dir`), with a search,
 * the top 10 and "Show all", a sticky header, and a stacked card list on phones.
 */
export default function DishTable({ rows, sort, dir, onSort, loading }) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const titleId = useId();
  const q = query.trim().toLowerCase();
  const matched = (rows || []).filter((row) => !q || row.name.toLowerCase().includes(q) || (row.categoryName || '').toLowerCase().includes(q));
  const shown = all || q ? matched : matched.slice(0, TOP);
  const nextDir = (column) => (column.sort === sort ? (dir === 'desc' ? 'asc' : 'desc') : column.sort === 'name' ? 'asc' : 'desc');

  return <section className="in-panel in-dishes" aria-labelledby={titleId}>
    <header className="in-panel-head">
      <div>
        <h2 id={titleId}>Dish performance</h2>
        <p>Views, video plays, units ordered (alone and inside deals) and sales. Deal sales also count in their dishes, so don’t add the rows up.</p>
      </div>
      <div className="o-search in-dish-search">
        <OIcon name="search" size={16} />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a dish or deal" aria-label="Find a dish or deal" autoComplete="off" />
      </div>
    </header>

    {rows && !rows.length && <p className="in-muted-note">No dishes yet. Add dishes on the Products page to see how each one sells.</p>}
    {rows && rows.length > 0 && !matched.length && <p className="in-muted-note">Nothing matches “{query}”.</p>}

    {(loading && !rows) ? <div className="in-table-skeleton" role="status" aria-label="Loading dish performance">
      {Array.from({ length: 6 }, (_, i) => <span key={i} className="sk" style={{ height: 40 }} />)}
    </div> : matched.length > 0 && <>
      <div className={`in-table-scroll${loading ? ' is-stale' : ''}`}>
        <table className="in-dish-table">
          <thead><tr>
            {COLUMNS.map((column) => <th key={column.key} scope="col" className={column.numeric ? 'is-num' : undefined}
              aria-sort={column.sort === sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              <button type="button" className={`in-sort${column.sort === sort ? ' is-active' : ''}`} onClick={() => onSort(column.sort, nextDir(column))}>
                {column.label}
                <span className="in-sort-icon" aria-hidden="true">{column.sort === sort ? (dir === 'asc' ? '↑' : '↓') : '↕'}</span>
              </button>
            </th>)}
          </tr></thead>
          <tbody>
            {shown.map((row) => <tr key={`${row.kind}-${row.id}`} className={row.kind === 'deal' ? 'is-deal' : row.available === false ? 'is-off' : undefined}>
              <th scope="row"><DishCell row={row} /></th>
              <td className="is-num">{formatWhole(row.views)}</td>
              <td className="is-num">{row.kind === 'deal' ? '—' : formatWhole(row.videoPlays)}</td>
              <td className="is-num">{formatWhole(row.orderedQuantity)}{row.dealQuantity > 0 && <small>{formatWhole(row.dealQuantity)} in deals</small>}</td>
              <td className="is-num">{formatKsh(row.sales)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      <ul className="in-dish-cards" aria-label="Dish performance">
        {shown.map((row) => <li key={`${row.kind}-${row.id}`} className={row.kind === 'deal' ? 'is-deal' : undefined}>
          <DishCell row={row} />
          <dl>
            <div><dt>Views</dt><dd>{formatWhole(row.views)}</dd></div>
            <div><dt>Plays</dt><dd>{row.kind === 'deal' ? '—' : formatWhole(row.videoPlays)}</dd></div>
            <div><dt>Ordered</dt><dd>{formatWhole(row.orderedQuantity)}</dd></div>
            <div><dt>Sales</dt><dd>{formatKsh(row.sales)}</dd></div>
          </dl>
        </li>)}
      </ul>

      {!q && matched.length > TOP && <div className="in-show-all">
        <button type="button" className="o-btn is-secondary is-small" onClick={() => setAll((value) => !value)}>
          {all ? `Show top ${TOP}` : `Show all ${matched.length}`}
        </button>
      </div>}
    </>}
  </section>;
}

function DishCell({ row }) {
  return <span className="in-dish">
    <span className="in-dish-thumb" aria-hidden="true">{row.photoUrl ? <img src={row.photoUrl} alt="" loading="lazy" /> : row.kind === 'deal' ? '%' : row.name[0]}</span>
    <span className="in-dish-name">
      <span>{row.name}</span>
      <small>{row.kind === 'deal' ? <span className="in-deal-tag">Deal</span> : row.categoryName}{row.kind !== 'deal' && row.available === false ? ' · Sold out' : ''}</small>
    </span>
  </span>;
}
