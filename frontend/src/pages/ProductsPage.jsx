import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/dashboard/PageFrame';
import { useNotifications } from '../components/notifications/NotificationProvider';
import { Modal } from '../components/owner/Drawer';
import ProductEditor from '../components/owner/ProductEditor';
import { EmptyState, ErrorState, OIcon, Segmented } from '../components/owner/ui';
import '../components/owner/products.css';
import DealEditor from '../components/products/DealEditor';
import DealsView from '../components/products/DealsView';
import FeaturedStrip from '../components/products/FeaturedStrip';
import ManageCategories from '../components/products/ManageCategories';
import { CardGrid, CardSkeletons } from '../components/products/ProductCards';
import { RowList } from '../components/products/ProductRows';
import { MEDIA_FILTERS, PIcon, byPosition, merchApi, pluralize, useMenu } from '../components/products/shared';
import { useApi } from '../lib/api';
import { CATEGORY_SUGGESTIONS } from '../lib/onboarding';

/*
 * Products: the floating squircle rail of categories (with a separate round "+"), a header with counts,
 * Dishes | Deals, filters, and per-category card groups (or a list). Reads GET /api/restaurant/menu through
 * the SWR cache; toggles are optimistic and every write marks the menu stale so it refetches.
 * URL: ?tab=deals, ?category=, ?q=, ?status=sale|soldout, ?media=photo|video|none, ?featured=1, ?view=list.
 */

const ICON_RULES = [
  [/drink|juice|beverage|soda|water|smoothie/i, 'drink'], [/beer|bar|wine|cocktail|spirit|alcohol/i, 'beer'],
  [/coffee|tea|chai|cafe|café|hot/i, 'coffee'], [/dessert|sweet|cake|ice/i, 'dessert'], [/breakfast|egg|brunch/i, 'egg'],
  [/starter|side|salad|veg|snack|appet/i, 'leaf'], [/grill|nyama|bbq|choma|meat|roast/i, 'flame'], [/soup|stew|bowl/i, 'bowl'],
  [/pizza/i, 'pizza'], [/promo|offer|deal|special/i, 'percent'],
];
const iconFor = (name = '') => ICON_RULES.find(([pattern]) => pattern.test(name))?.[1] || 'utensils';

const STATUS_OPTIONS = [{ value: '', label: 'Any status' }, { value: 'sale', label: 'On sale' }, { value: 'soldout', label: 'Sold out' }];
const MEDIA_OPTIONS = [{ value: '', label: 'Any media' }, { value: 'photo', label: 'Has photo' }, { value: 'video', label: 'Has video' }, { value: 'none', label: 'No media' }];

export default function ProductsPage({ section }) {
  const { notify } = useNotifications();
  const [params, setParams] = useSearchParams();
  const menu = useMenu();
  const onboarding = useApi('/api/restaurant/onboarding');
  const restaurantId = onboarding.data?.restaurant?.id;
  const data = menu.data;
  const categories = useMemo(() => [...(data?.categories || [])].sort(byPosition), [data]);
  const items = useMemo(() => data?.items || [], [data]);
  const deals = useMemo(() => [...(data?.deals || [])].sort(byPosition), [data]);

  const tab = params.get('tab') === 'deals' ? 'deals' : 'dishes';
  const view = params.get('view') === 'list' ? 'list' : 'cards';
  const status = ['sale', 'soldout'].includes(params.get('status')) ? params.get('status') : '';
  const media = MEDIA_FILTERS[params.get('media')] ? params.get('media') : '';
  const featuredOnly = params.get('featured') === '1';
  const activeId = categories.some((category) => category.id === params.get('category')) ? params.get('category') : 'all';
  const active = categories.find((category) => category.id === activeId) || null;
  const query = params.get('q')?.trim() || '';
  const [search, setSearch] = useState(params.get('q') || '');
  useEffect(() => { setSearch(params.get('q') || ''); }, [params]);

  const [editor, setEditor] = useState(null); // { id?, categoryId?, focus? }
  const [dealEditor, setDealEditor] = useState(null); // { id? }
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState({});

  const go = (patch) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(patch).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key); });
    return next;
  }, { replace: true });

  useEffect(() => {
    const value = search.trim();
    if (value === query) return undefined;
    const timer = setTimeout(() => go({ q: value }), 250);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchItem = (id, fields) => menu.setData((current) => current && { ...current, items: current.items.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry)) });
  const mark = (id, on) => setBusy((current) => { const next = { ...current }; if (on) next[id] = true; else delete next[id]; return next; });

  async function toggleSale(item) {
    const available = !item.available;
    mark(item.id, true);
    patchItem(item.id, { available });
    try {
      await merchApi.updateItem(item.id, { available });
      notify(available ? `${item.name} is on sale again.` : `${item.name} is sold out. Guests won’t see it.`);
    } catch (problem) {
      patchItem(item.id, { available: item.available });
      notify(problem.message, { type: 'error' });
    } finally { mark(item.id, false); }
  }

  async function toggleFeatured(item) {
    const featured = !item.featured;
    const before = data?.featuredItemIds || [];
    menu.setData((current) => current && {
      ...current,
      items: current.items.map((entry) => (entry.id === item.id ? { ...entry, featured } : entry)),
      featuredItemIds: featured ? [...current.featuredItemIds, item.id] : current.featuredItemIds.filter((id) => id !== item.id),
    });
    try {
      await merchApi.updateItem(item.id, { featured });
      notify(featured ? `${item.name} is featured. Guests see it first.` : `${item.name} is no longer featured.`);
    } catch (problem) {
      menu.setData((current) => current && { ...current, items: current.items.map((entry) => (entry.id === item.id ? { ...entry, featured: item.featured } : entry)), featuredItemIds: before });
      notify(problem.message, { type: 'error' });
    }
  }

  async function reorder(categoryId, ids) {
    const positions = new Map(ids.map((id, position) => [id, position]));
    const before = items;
    menu.setData((current) => current && { ...current, items: current.items.map((entry) => (positions.has(entry.id) ? { ...entry, position: positions.get(entry.id) } : entry)) });
    try { await merchApi.orderItems(categoryId, ids); } catch (problem) {
      menu.setData((current) => current && { ...current, items: before });
      notify(problem.message, { type: 'error' });
    }
  }

  // Filters
  const q = query.toLowerCase();
  const filtering = Boolean(query || status || media || featuredOnly);
  const matches = (item) => (!q || item.name.toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q))
    && (!status || (status === 'sale' ? item.available : !item.available))
    && (!media || MEDIA_FILTERS[media](item))
    && (!featuredOnly || item.featured);
  const groups = (active ? [active] : categories)
    .map((category) => ({ category, items: items.filter((item) => item.categoryId === category.id && matches(item)).sort(byPosition) }))
    .filter((group) => !filtering || group.items.length);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const onSale = items.filter((item) => item.available).length;
  const soldOut = items.length - onSale;
  const noMedia = items.filter(MEDIA_FILTERS.none).length;
  const counts = data ? [pluralize(items.length, 'dish', 'dishes'), `${onSale} on sale`, `${soldOut} sold out`, `${data.featuredItemIds.length} featured`, ...(deals.length ? [pluralize(deals.length, 'deal')] : [])].join(' · ') : null;

  const editing = editor?.id ? items.find((item) => item.id === editor.id) || null : null;
  const editingDeal = dealEditor?.id ? deals.find((deal) => deal.id === dealEditor.id) || null : null;
  const openItem = (item, focus) => setEditor({ id: item.id, focus });
  const clearFilters = () => { setSearch(''); go({ q: '', status: '', media: '', featured: '' }); };

  return <>
    <PageHeader title={section.label} description={counts || section.description}>
      {tab === 'dishes' ? <>
        <button type="button" className="o-btn is-secondary" onClick={() => setManaging(true)} disabled={!data}>Manage categories</button>
        <button type="button" className="o-btn is-primary" onClick={() => setEditor({ categoryId: active?.id })} disabled={!categories.length}>
          <OIcon name="plus" size={16} strokeWidth={2.2} />Add product
        </button>
      </> : <button type="button" className="o-btn is-primary" onClick={() => setDealEditor({})} disabled={!data || !items.length}>
        <OIcon name="plus" size={16} strokeWidth={2.2} />New deal
      </button>}
    </PageHeader>

    <div className="pp-tabs">
      <Segmented label="Show" mode="tabs" idBase="products" value={tab} onChange={(value) => go({ tab: value === 'deals' ? 'deals' : '' })}
        options={[{ value: 'dishes', label: 'Dishes', count: data ? items.length : undefined }, { value: 'deals', label: 'Deals', count: data ? deals.length : undefined }]} />
    </div>

    <div id="products-panel" role="tabpanel" aria-labelledby={`products-tab-${tab}`}>
      {menu.error && !data ? <div className="o-panel"><ErrorState error={menu.error} onRetry={menu.refresh} what="your menu" /></div>
        : tab === 'deals' ? <DealsView deals={deals} loading={!data} onChange={menu.setData}
          onOpen={(deal) => setDealEditor({ id: deal.id })} onNew={() => setDealEditor({})} />
          : <div className="products-layout">
            <CategoryRail categories={categories} items={items} activeId={activeId} loading={!data} onAdd={() => setAdding(true)} />
            <section className="product-list" aria-label="Dishes">
              <div className="pp-filters" role="search">
                <div className="o-search pp-filter-search">
                  <OIcon name="search" size={16} />
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or description" aria-label="Search your menu" autoComplete="off" />
                  {search && <button type="button" className="o-icon-btn" onClick={() => { setSearch(''); go({ q: '' }); }} aria-label="Clear search"><OIcon name="close" size={14} /></button>}
                </div>
                <FilterSelect label="Status" value={status} options={STATUS_OPTIONS} onChange={(value) => go({ status: value })} />
                <FilterSelect label="Media" value={media} options={MEDIA_OPTIONS} onChange={(value) => go({ media: value })} />
                <button type="button" className={`pp-filter-toggle${featuredOnly ? ' is-on' : ''}`} aria-pressed={featuredOnly} onClick={() => go({ featured: featuredOnly ? '' : '1' })}>
                  <PIcon name="star" size={15} filled={featuredOnly} />Featured
                </button>
                <Segmented label="Layout" size="sm" className="pp-view" value={view} onChange={(value) => go({ view: value === 'list' ? 'list' : '' })}
                  options={[{ value: 'cards', label: 'Cards' }, { value: 'list', label: 'List' }]} />
                <span className="pp-filter-count" aria-live="polite">{data ? (filtering ? `${pluralize(visibleCount, 'match', 'matches')}` : pluralize(visibleCount, 'dish', 'dishes')) : ''}</span>
              </div>

              {data && !filtering && !active && noMedia > 0 && items.length > 0 && <p className="pp-hint">
                <PIcon name="image" size={16} />{noMedia === 1 ? '1 dish has' : `${noMedia} dishes have`} no photo yet. Dishes with photos get ordered more.
                <button type="button" className="o-text-link" onClick={() => go({ media: 'none' })}>Show them</button>
              </p>}

              {data && !filtering && !active && items.length > 0 && <FeaturedStrip items={items} featuredIds={data.featuredItemIds} limit={data.limits?.featured} onOpen={openItem} />}

              {!data && <CardSkeletons />}

              {data && filtering && !visibleCount && <div className="o-panel">
                <div className="o-state is-empty is-neutral" role="status">
                  <span className="o-state-icon"><OIcon name="search" size={20} /></span>
                  <div className="o-state-text"><strong>{query ? `No products match “${query}” yet.` : `No dishes match these filters${active ? ` in ${active.name}` : ''}.`}</strong><span>Check the spelling or try fewer filters, or add it as a new product.</span></div>
                  {query ? <Link to={active ? `?category=${active.id}` : '.'} relative="path" replace className="o-btn" aria-label={`Clear search for ${query}`} onClick={() => setSearch('')}>Clear search</Link>
                    : <button type="button" className="o-btn" onClick={clearFilters}>Clear filters</button>}
                </div>
              </div>}

              {data && !categories.length && <div className="o-panel"><EmptyState icon="layers" tone="neutral" title="Start with a category"
                action={<button type="button" className="o-btn is-primary" onClick={() => setAdding(true)}><OIcon name="plus" size={16} />Add a category</button>}>
                Group your dishes, like Starters, Mains and Drinks. Then add dishes to each.</EmptyState></div>}

              {data && groups.map((group) => <section key={group.category.id} className="pp-group" aria-labelledby={`group-${group.category.id}`}>
                <header className="pp-group-head">
                  <h2 id={`group-${group.category.id}`}>{group.category.name}</h2>
                  <span>{group.items.length}</span>
                </header>
                {!group.items.length && !filtering && <p className="pp-group-empty">No dishes in {group.category.name} yet. Add one; you can add a photo or a short video right after.</p>}
                {view === 'cards'
                  ? <CardGrid category={group.category} items={group.items} canReorder={!filtering} showAdd={!filtering} busy={busy}
                    onOpen={openItem} onToggle={toggleSale} onFeature={toggleFeatured} onReorder={reorder} onAdd={(categoryId) => setEditor({ categoryId })} />
                  : <RowList category={group.category} items={group.items} canReorder={!filtering} showAdd={!filtering} busy={busy}
                    onOpen={openItem} onToggle={toggleSale} onFeature={toggleFeatured} onReorder={reorder} onAdd={(categoryId) => setEditor({ categoryId })} />}
              </section>)}
            </section>
          </div>}
    </div>

    <ProductEditor open={Boolean(editor)} item={editing} menu={data} categories={categories} defaultCategoryId={editor?.categoryId || active?.id}
      restaurantId={restaurantId} focus={editor?.focus} onClose={() => setEditor(null)}
      onCreated={(item) => { menu.setData((current) => current && (current.items.some((entry) => entry.id === item.id) ? current : { ...current, items: [...current.items, { extras: [], pairedItemIds: [], stats30d: {}, ...item }] })); setEditor({ id: item.id, focus: 'media' }); }}
      onDeleted={(item) => menu.setData((current) => current && { ...current, items: current.items.filter((entry) => entry.id !== item.id) })} />
    <DealEditor open={Boolean(dealEditor)} deal={editingDeal} items={items} restaurantId={restaurantId} onClose={() => setDealEditor(null)} />
    <ManageCategories open={managing} onClose={() => setManaging(false)} categories={categories} items={items}
      onChange={(update) => menu.setData((current) => current && update(current))} onAdd={() => setAdding(true)} />
    <AddCategory open={adding} onClose={() => setAdding(false)} existing={categories}
      onAdded={(category) => {
        menu.setData((current) => current && { ...current, categories: [...current.categories, category] });
        setAdding(false);
        if (!managing) go({ category: category.id, q: '', tab: '' });
        notify(`${category.name} added. Now add its dishes.`);
      }} />
  </>;
}

function FilterSelect({ label, value, options, onChange }) {
  const id = useId();
  return <span className={`pp-select${value ? ' is-set' : ''}`}>
    <label className="visually-hidden" htmlFor={id}>{label}</label>
    <select id={id} className="o-select" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </span>;
}

/* Category rail: a floating column of squircle tiles, with "add" kept apart in its own circle. */
function CategoryRail({ categories, items, activeId, loading, onAdd }) {
  const [params] = useSearchParams();
  const href = (id) => {
    const next = new URLSearchParams(params);
    if (id === 'all') next.delete('category'); else next.set('category', id);
    const text = next.toString();
    return text ? `?${text}` : '.';
  };
  const tiles = [{ id: 'all', name: 'All products', icon: 'layers', count: items.length }, ...categories.map((category) => ({
    ...category, icon: iconFor(category.name), count: items.filter((item) => item.categoryId === category.id).length,
  }))];
  return <aside className="category-rail-wrap">
    <nav className="category-rail" aria-label="Product categories">
      <ul>
        {loading ? [0, 1, 2, 3].map((i) => <li key={i}><span className="category-tile" aria-hidden="true"><span className="category-tile-icon sk" /><span className="sk sk-line" style={{ width: 48 }} /></span></li>)
          : tiles.map((tile) => <li key={tile.id}>
            <Link to={href(tile.id)} relative="path" replace
              className={`category-tile${tile.id === activeId ? ' is-active' : ''}`} aria-current={tile.id === activeId ? 'true' : undefined}
              aria-label={`${tile.name}, ${pluralize(tile.count, 'product')}`}>
              <span className="category-tile-icon"><OIcon name={tile.icon} size={20} /></span>
              <span className="category-tile-label">{tile.name}</span>
            </Link>
          </li>)}
      </ul>
    </nav>
    <button type="button" className="category-add" aria-label="Add category" title="Add category" onClick={onAdd}>
      <OIcon name="plus" size={20} />
    </button>
  </aside>;
}

function AddCategory({ open, onClose, existing, onAdded }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const taken = new Set(existing.map((category) => category.name.toLowerCase()));
  const suggestions = CATEGORY_SUGGESTIONS.filter((suggestion) => !taken.has(suggestion.toLowerCase())).slice(0, 6);
  const input = useRef(null);
  useEffect(() => { if (open) { setName(''); setError(''); } }, [open]);

  async function add(event) {
    event?.preventDefault();
    const value = name.trim();
    if (!value) { setError('Give the category a name, like Drinks.'); input.current?.focus(); return; }
    if (taken.has(value.toLowerCase())) { setError(`You already have ${value}.`); return; }
    setBusy(true);
    try {
      const { category } = await merchApi.addCategory(value);
      onAdded(category);
    } catch (problem) { setError(problem.message); } finally { setBusy(false); }
  }

  return <Modal open={open} onClose={onClose} title="New category">
    <form className="o-cat-form" onSubmit={add} noValidate>
      <label className="o-label" htmlFor={inputId}>Name</label>
      <input ref={input} id={inputId} className="o-input" value={name} maxLength={40} onChange={(event) => { setName(event.target.value); setError(''); }}
        placeholder="For example: Drinks" data-autofocus autoComplete="off" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${inputId}-e` : undefined} />
      {error && <p className="o-field-error" id={`${inputId}-e`} role="alert">{error}</p>}
      {suggestions.length > 0 && <div className="o-cat-suggestions"><span>Ideas:</span>
        {suggestions.map((suggestion) => <button key={suggestion} type="button" className="o-chip" onClick={() => { setName(suggestion); setError(''); }}>{suggestion}</button>)}
      </div>}
      <button type="submit" className="o-btn is-primary is-large is-block" disabled={busy}>{busy ? 'Adding…' : 'Add category'}</button>
    </form>
  </Modal>;
}
