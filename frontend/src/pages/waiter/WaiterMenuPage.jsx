import { useMemo, useState } from 'react';
import Glyph from '../../components/media/Glyph';
import { PageHeader } from '../../components/waiter/WaiterBits';
import useStaffMenu from '../../components/waiter/useStaffMenu';
import { formatPrice } from '../../lib/format';

export function filterMenu(items, categories, { category, query }) {
  const q = query.trim().toLowerCase();
  return items.filter((item) => (!category || item.categoryId === category) && (!q || item.name.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q)));
}

/** The menu for answering guests' questions: categories, search, and what's sold out. */
export default function WaiterMenuPage({ section }) {
  const menu = useStaffMenu();
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const items = useMemo(() => (menu.status === 'ready' ? filterMenu(menu.items, menu.categories, { category, query }) : []), [menu, category, query]);
  const soldOut = menu.status === 'ready' ? menu.items.filter((item) => !item.available).length : 0;
  const deals = useMemo(() => {
    if (menu.status !== 'ready' || category) return [];
    const q = query.trim().toLowerCase();
    return (menu.deals || []).filter((deal) => !q || deal.name.toLowerCase().includes(q) || deal.items.some((part) => part.name.toLowerCase().includes(q)));
  }, [menu, category, query]);
  const groups = useMemo(() => {
    if (menu.status !== 'ready') return [];
    return menu.categories.map((c) => ({ ...c, items: items.filter((item) => item.categoryId === c.id) })).filter((g) => g.items.length);
  }, [menu, items]);

  return <>
    <PageHeader title={section.label} subtitle={menu.status === 'ready' ? `${menu.items.length} dishes${soldOut ? ` · ${soldOut} sold out` : ''}` : section.description} />
    <div className="w-search">
      <Glyph name="search" size={18} />
      <label className="visually-hidden" htmlFor="w-menu-search">Search the menu</label>
      <input id="w-menu-search" type="search" placeholder="Search dishes" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
    </div>
    {menu.status === 'ready' && <div className="w-chips" role="group" aria-label="Categories">
      <button type="button" className={`w-chip${!category ? ' is-on' : ''}`} aria-pressed={!category} onClick={() => setCategory('')}>All</button>
      {menu.categories.map((c) => <button key={c.id} type="button" className={`w-chip${category === c.id ? ' is-on' : ''}`} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}
    </div>}
    {menu.status === 'loading' && <div className="w-stack" aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i} className="w-row-skeleton" />)}</div>}
    {menu.status === 'error' && <div className="w-empty"><h2>Menu didn’t load</h2><p>{menu.error}</p><button type="button" className="w-btn w-btn-secondary" onClick={menu.reload}>Try again</button></div>}
    {deals.length > 0 && <section className="w-menu-group" aria-labelledby="wm-deals">
      <h2 id="wm-deals" className="w-subhead">Deals</h2>
      <ul className="w-menu-list">
        {deals.map((deal) => <li key={deal.id} className={`w-menu-row${deal.available ? '' : ' is-sold-out'}`}>
          <span className="w-menu-thumb" aria-hidden="true">%</span>
          <span className="w-menu-text"><strong>{deal.name}</strong>
            <span className="w-menu-desc">{deal.items.map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ')}</span></span>
          <span className="w-menu-side"><span className="w-menu-price">{formatPrice(deal.price, deal.currency)}</span>
            {deal.available ? deal.saving > 0 && <span className="w-menu-extras">Saves {formatPrice(deal.saving)}</span> : <span className="w-sold-out">{deal.unavailableReason}</span>}</span>
        </li>)}
      </ul>
    </section>}
    {menu.status === 'ready' && !items.length && !deals.length && <div className="w-empty"><h2>No dishes match</h2><p>Try another word or category.</p></div>}
    {groups.map((group) => <section key={group.id} className="w-menu-group" aria-labelledby={`wm-${group.id}`}>
      <h2 id={`wm-${group.id}`} className="w-subhead">{group.name}</h2>
      <ul className="w-menu-list">
        {group.items.map((item) => <li key={item.id} className={`w-menu-row${item.available ? '' : ' is-sold-out'}`}>
          {item.photoUrl || item.videoPosterUrl ? <img src={item.photoUrl || item.videoPosterUrl} alt="" loading="lazy" /> : <span className="w-menu-thumb" aria-hidden="true">{item.name[0]}</span>}
          <span className="w-menu-text">
            <strong>{item.name}</strong>
            {item.description && <span className="w-menu-desc">{item.description}</span>}
            {item.extras?.length > 0 && <span className="w-menu-extras">Extras: {item.extras.map((extra) => `${extra.name} +${Number(extra.price)}${extra.available ? '' : ' (sold out)'}`).join(', ')}</span>}
          </span>
          <span className="w-menu-side">
            <span className="w-menu-price">{formatPrice(item.price, item.currency)}</span>
            {!item.available && <span className="w-sold-out">Sold out</span>}
          </span>
        </li>)}
      </ul>
    </section>)}
  </>;
}
