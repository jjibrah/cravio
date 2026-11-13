import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatKsh, hoursSummary, kindLabel, openStatus } from '../../lib/format';
import { designVars, loadDesignFonts, resolveDesign } from '../../lib/menu-design';
import { BrandMark } from '../Brand';
import Glyph from '../media/Glyph';
import FilterSheet from './FilterSheet';
import { DealCard, DishCard, FeaturedCard, Img, prefersReducedMotion } from './MenuCards';
import { NO_FILTERS, activeFilterCount, isSearching, searchMenu } from './menu-search';
import './menu-view.css';

export { openStatus } from '../../lib/format';

/*
 * The guest menu, shared by the public page (variant "page") and every owner preview (variant "preview").
 * Give it the public menu (restaurant, categories, items, featuredItemIds, deals, design) and it renders the
 * restaurant's design: header with logo and search, a cover, sticky category tabs that follow the scroll, the
 * sections in design order with their layouts, and the footer band.
 *
 * "page" scrolls the window. "preview" is its own scroll container inside a frame (`.mv-shell`), so nothing
 * escapes a device mock-up and no document-level listeners are added; overlays (sheets, the order bar) passed
 * as `overlays` render inside that frame.
 *
 * Interaction is opt-in, so a static preview shows no cart UI:
 * - `cart` { plainQuantity(id), dealQuantity(id), add(item), minus(item), addDeal(deal) } adds "+" buttons;
 * - `onOpenItem(item)` / `onOpenDeal(deal)` open the dish and deal sheets;
 * - `onOrderNow()` / `onFindUs()` power the footer band.
 */

const initials = (name = '') => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0]).join('').toUpperCase();
const isResolved = (design) => Array.isArray(design?.sections) && design.sections.every((section) => section.key);

function SectionHeading({ id, level, title, variant, count, preview }) {
  const H = `h${level}`;
  if (variant === 'center') {
    return <header className="mv-head is-center">
      <H id={id} className="mv-head-title" tabIndex={-1}><span>{title}</span></H>
      <p className="mv-head-count">{count} item{count === 1 ? '' : 's'}</p>
    </header>;
  }
  return <header className="mv-head is-rule"><H id={id} className="mv-head-title" tabIndex={-1}><span>{title}</span></H></header>;
}

/** A horizontally scrolling row with scroll-snap, optional pagination bars and (on wide screens) arrows. */
function Carousel({ label, className = '', dots = false, children, count }) {
  const ref = useRef(null);
  const [index, setIndex] = useState(0);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = useCallback(() => {
    const row = ref.current;
    if (!row) return;
    const first = row.firstElementChild;
    const stride = first ? first.getBoundingClientRect().width + parseFloat(getComputedStyle(row).columnGap || 0) : row.clientWidth;
    setIndex(Math.min(count - 1, Math.round(row.scrollLeft / Math.max(1, stride))));
    setEdges({ start: row.scrollLeft < 4, end: row.scrollLeft + row.clientWidth >= row.scrollWidth - 4 });
  }, [count]);
  useEffect(() => { update(); }, [update]);
  const page = (direction) => {
    const row = ref.current;
    row?.scrollBy({ left: direction * row.clientWidth * 0.85, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };
  const go = (to) => {
    const row = ref.current;
    const item = row?.children[to];
    if (item) row.scrollTo({ left: item.offsetLeft - row.firstElementChild.offsetLeft, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };
  return <div className={`mv-carousel ${className}`}>
    <ul ref={ref} className="mv-scroller" aria-label={label} onScroll={update}>{children}</ul>
    {count > 1 && <div className="mv-carousel-nav">
      {dots && <div className="mv-dots" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => <button key={i} type="button" tabIndex={-1} className={i === index ? 'is-on' : undefined} onClick={() => go(i)} />)}
      </div>}
      <div className="mv-arrows">
        <button type="button" className="mv-arrow" aria-label={`Previous in ${label}`} onClick={() => page(-1)} disabled={edges.start}><Glyph name="back" size={18} /></button>
        <button type="button" className="mv-arrow" aria-label={`Next in ${label}`} onClick={() => page(1)} disabled={edges.end}><Glyph name="chevron" size={18} /></button>
      </div>
    </div>}
  </div>;
}

export default function MenuView({
  restaurant = {}, categories = [], items = [], featuredItemIds, deals = [], design, tableNumber,
  variant = 'page', cart, onOpenItem, onOpenDeal, onOrderNow, onFindUs, onVideoPlay, afterHero, overlays, overlayOpen = false,
  focusSection, className = '',
}) {
  const preview = variant === 'preview';
  const uid = useId().replace(/:/g, '');
  const resolved = useMemo(() => (isResolved(design) ? design : resolveDesign(design, { theme: restaurant?.theme, categories })), [design, restaurant?.theme, categories]);
  const vars = useMemo(() => designVars(resolved), [resolved]);
  useEffect(() => { loadDesignFonts(resolved); }, [resolved]);

  const name = restaurant?.name?.trim() || '';
  const meta = [kindLabel(restaurant?.kind), restaurant?.area?.trim()].filter(Boolean).join(' · ');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  const status = useMemo(() => openStatus(restaurant?.openingHours, now), [restaurant?.openingHours, now]);
  const hours = hoursSummary(restaurant?.openingHours);
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [restaurant?.coverUrl]);
  const showLogo = resolved.header.showLogo && Boolean(restaurant?.logoUrl);
  const hasCover = resolved.header.showCover && Boolean(restaurant?.coverUrl) && !coverFailed;
  const cards = resolved.cards;

  /* ---------- Sections with their dishes ---------- */
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const blocks = useMemo(() => {
    const byCategory = new Map();
    for (const item of items) {
      if (!byCategory.has(item.categoryId)) byCategory.set(item.categoryId, []);
      byCategory.get(item.categoryId).push(item);
    }
    const featured = (featuredItemIds?.length ? featuredItemIds.map((id) => byId.get(id)) : items.filter((item) => item.featured)).filter(Boolean);
    const list = resolved.sections.filter((section) => section.visible).map((section) => ({
      ...section,
      list: section.type === 'featured' ? featured : section.type === 'deals' ? deals : byCategory.get(section.categoryId) || [],
    })).filter((block) => block.list.length);
    const known = new Set(categories.map((category) => category.id));
    const orphans = items.filter((item) => !known.has(item.categoryId));
    if (orphans.length) list.push({ key: 'more', type: 'category', title: 'More', layout: 'list', visible: true, list: orphans });
    return list;
  }, [items, byId, featuredItemIds, deals, categories, resolved.sections]);

  // Tabs: Featured and the categories. Other sections (deals) belong to the tab before them.
  const { tabs, tabOf } = useMemo(() => {
    const list = blocks.filter((block) => block.type !== 'deals').map((block) => ({ key: block.key, title: block.title }));
    const map = new Map();
    let current = list[0]?.key;
    for (const block of blocks) {
      if (block.type !== 'deals') current = block.key;
      map.set(block.key, current);
    }
    return { tabs: list, tabOf: map };
  }, [blocks]);
  const blockKey = blocks.map((block) => block.key).join('|');

  /* ---------- Search and filters ---------- */
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const searching = isSearching(query, filters);
  const menu = useMemo(() => ({ items, deals, featuredIds: featuredItemIds || items.filter((item) => item.featured).map((item) => item.id) }), [items, deals, featuredItemIds]);
  const found = useMemo(() => (searching ? searchMenu(menu, query, filters) : null), [searching, menu, query, filters]);
  const filterCount = activeFilterCount(filters);
  const clearSearch = () => { setQuery(''); setFilters(NO_FILTERS); };

  /* ---------- Scroll: sticky offsets, active tab, jumps ---------- */
  const shellRef = useRef(null);
  const rootRef = useRef(null);
  const topRef = useRef(null);
  const tabsRef = useRef(null);
  const tabRowRef = useRef(null);
  const sectionEls = useRef(new Map());
  const lock = useRef(0);
  const [active, setActive] = useState(null);
  const activeTab = tabs.some((tab) => tab.key === active) ? active : tabs[0]?.key;
  const [indicator, setIndicator] = useState(null);
  const [stuck, setStuck] = useState(false);

  // The tab row sticks under the header: keep the header's height in a variable.
  useLayoutEffect(() => {
    const top = topRef.current;
    const root = rootRef.current;
    if (!top || !root) return undefined;
    const apply = () => root.style.setProperty('--mv-top-h', `${top.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(apply);
    observer.observe(top);
    return () => observer.disconnect();
  }, []);

  const stickyHeight = () => (topRef.current?.offsetHeight || 0) + (tabsRef.current?.offsetHeight || 0);

  useEffect(() => {
    if (searching || !blocks.length) return undefined;
    const scroller = preview ? rootRef.current : window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = rootRef.current;
      if (!root) return;
      const top = preview ? root.scrollTop : window.scrollY;
      const height = preview ? root.clientHeight : window.innerHeight;
      const full = preview ? root.scrollHeight : document.documentElement.scrollHeight;
      const tabsBox = tabsRef.current?.getBoundingClientRect();
      const base = preview ? root.getBoundingClientRect().top : 0;
      setStuck(Boolean(tabsBox) && top > 0 && tabsBox.top - base <= ((topRef.current?.offsetHeight || 0) + 0.5) * (preview ? (root.getBoundingClientRect().height / root.clientHeight) || 1 : 1));
      if (Date.now() < lock.current) return;
      let current = blocks[0].key;
      // A preview may be scaled (the Studio's device): compare in the menu's own pixels.
      const k = preview ? (root.getBoundingClientRect().height / root.clientHeight) || 1 : 1;
      for (const block of blocks) {
        const element = sectionEls.current.get(block.key);
        if (element && (element.getBoundingClientRect().top - base) / k <= stickyHeight() + 24) current = block.key;
      }
      if (top > 8 && top + height >= full - 4) current = blocks[blocks.length - 1].key;
      setActive(tabOf.get(current));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
    // blockKey captures the identity of the sections that matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockKey, preview, searching, tabOf]);

  // The underline follows the active tab; the row keeps it in view (never scrolls the page).
  useLayoutEffect(() => {
    const row = tabRowRef.current;
    const tab = row?.querySelector(`[data-tab="${CSS.escape(String(activeTab))}"]`);
    if (!row || !tab) { setIndicator(null); return; }
    const style = getComputedStyle(tab);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    setIndicator({ left: tab.offsetLeft + padLeft, width: tab.offsetWidth - padLeft - (parseFloat(style.paddingRight) || 0) });
    const left = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [activeTab, blockKey, vars]);

  const scrollToKey = useCallback((key, { focus = true } = {}) => {
    const element = sectionEls.current.get(key);
    if (!element) return;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    lock.current = Date.now() + 900;
    const offset = stickyHeight() - 1;
    if (preview) {
      const root = rootRef.current;
      const k = (root.getBoundingClientRect().height / root.clientHeight) || 1;
      root.scrollTo({ top: root.scrollTop + (element.getBoundingClientRect().top - root.getBoundingClientRect().top) / k - offset, behavior });
    } else {
      window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - offset, behavior });
    }
    // Move focus to the heading for keyboard and screen-reader users, without a second jump.
    if (focus) element.querySelector('.mv-head-title')?.focus({ preventScroll: true });
  }, [preview]);

  const jump = (event, key) => {
    event.preventDefault();
    setActive(key);
    scrollToKey(key);
  };
  const onTabKey = (event) => {
    const links = [...(tabRowRef.current?.querySelectorAll('a') || [])];
    const index = links.indexOf(document.activeElement);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: links.length - 1 }[event.key];
    if (next === undefined || index < 0) return;
    event.preventDefault();
    links[(next + links.length) % links.length]?.focus();
  };

  // The Studio points at a section: scroll the preview to it and flash it.
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!focusSection?.key) return undefined;
    if (searching) clearSearch();
    const timer = setTimeout(() => {
      const target = sectionEls.current.has(focusSection.key) ? focusSection.key : null;
      if (!target) return;
      scrollToKey(target, { focus: false });
      setFlash(target);
    }, 30);
    const off = setTimeout(() => setFlash(null), 1400);
    return () => { clearTimeout(timer); clearTimeout(off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection]);

  /* ---------- Rendering ---------- */
  const H1 = preview ? 'h2' : 'h1';
  const sectionLevel = preview ? 3 : 2;
  const cardLevel = sectionLevel + 1;
  const open = preview && !onOpenItem ? undefined : onOpenItem;
  const openDeal = preview && !onOpenDeal ? undefined : onOpenDeal;
  const quickFor = (item) => (cart ? { quantity: cart.plainQuantity(item.id), add: () => cart.add(item), minus: () => cart.minus(item) } : null);
  const sectionId = (key) => `mv-${uid}-${String(key).replace(/[^\w-]/g, '')}`;
  const shapeFor = (layout) => (cards.style === 'text-only' ? 'text' : layout === 'list' || cards.style === 'photo-side' ? 'row' : 'tile');

  const dishList = (list, layout, label) => {
    const shape = shapeFor(layout);
    const props = (item) => ({ item, shape, showDescription: cards.showDescription, headingLevel: cardLevel, preview, onOpen: open, cart: quickFor(item), onVideoPlay, sizes: layout === 'grid' ? '(min-width: 1000px) 25vw, (min-width: 600px) 33vw, 50vw' : '160px' });
    if (layout === 'carousel') return <Carousel label={label} count={list.length} className={`is-dishes is-${shape}`}>{list.map((item) => <DishCard key={item.id} {...props(item)} />)}</Carousel>;
    return <ul className={`mv-${layout === 'grid' ? 'grid' : 'list'} is-${shape}`} aria-label={label}>{list.map((item) => <DishCard key={item.id} {...props(item)} />)}</ul>;
  };
  const dealList = (list, layout, label) => {
    const card = (deal) => <DealCard key={deal.id} deal={deal} headingLevel={cardLevel} onOpen={openDeal} onAdd={cart ? cart.addDeal : undefined} quantity={cart?.dealQuantity(deal.id) || 0} showDescription={cards.showDescription} />;
    if (layout === 'carousel') return <Carousel label={label} count={list.length} className="is-deals">{list.map(card)}</Carousel>;
    return <ul className={`mv-${layout === 'grid' ? 'grid' : 'list'} is-deals`} aria-label={label}>{list.map(card)}</ul>;
  };

  const renderBlock = (block) => {
    const headingId = `${sectionId(block.key)}-t`;
    let body;
    if (block.type === 'featured' && block.layout === 'carousel') {
      body = <Carousel label={block.title} count={block.list.length} dots className="is-featured">
        {block.list.map((item, index) => <FeaturedCard key={item.id} item={item} headingLevel={cardLevel} preview={preview} onOpen={open} onVideoPlay={onVideoPlay} eager={!preview && index < 2} />)}
      </Carousel>;
    } else if (block.type === 'deals') body = dealList(block.list, block.layout, block.title);
    else body = dishList(block.list, block.layout, block.title);
    return <section key={block.key} id={sectionId(block.key)} data-section={block.key} aria-labelledby={headingId}
      className={`mv-section is-${block.type} is-${block.layout}${flash === block.key ? ' is-flash' : ''}`}
      ref={(element) => { if (element) sectionEls.current.set(block.key, element); else sectionEls.current.delete(block.key); }}>
      <SectionHeading id={headingId} level={sectionLevel} title={block.title} variant={block.type === 'category' ? 'center' : 'rule'} count={block.list.length} preview={preview} />
      {body}
    </section>;
  };

  const brand = showLogo
    ? <span className="mv-logo"><Img src={restaurant.logoUrl} alt={hasCover ? '' : name ? `${name}` : 'Restaurant logo'} eager={!preview} fallback={<span className="mv-wordmark">{name || 'Menu'}</span>} /></span>
    : <span className="mv-wordmark">{name || 'Menu'}</span>;
  const badges = (status || hours || tableNumber) ? <ul className="mv-badges" aria-label="Details">
    {status ? <li className={`mv-badge${status.open ? ' is-open' : ''}`}><span className="mv-dot" aria-hidden="true" />{status.label}</li>
      : hours ? <li className="mv-badge">{hours}</li> : null}
    {tableNumber ? <li className="mv-badge is-table">Table {tableNumber}</li> : null}
  </ul> : null;
  const resultCount = found ? found.items.length + found.deals.length : 0;
  const tagline = resolved.footer.tagline || 'Ready when you are. Build your order, then tap Ready to order.';

  return <div ref={shellRef} className={`mv-shell mv-shell-${preview ? 'preview' : 'page'}`} style={vars} data-theme={resolved.theme}>
    <div ref={rootRef} className={`mv mv-${preview ? 'preview' : 'page'} cards-${cards.style}${className ? ` ${className}` : ''}`} inert={preview && overlayOpen ? true : undefined}>
      <div ref={topRef} className={`mv-top${stuck ? ' is-stuck' : ''}`}>
        <div className="mv-top-inner">
          {hasCover ? <div className="mv-brand">{brand}</div> : <H1 className="mv-brand">{brand}</H1>}
          {resolved.header.showSearch && <div className="mv-search" role="search">
            <Glyph name="search" size={18} />
            <label className="visually-hidden" htmlFor={`${uid}-q`}>Search the menu</label>
            <input id={`${uid}-q`} type="search" placeholder="Search…" value={query} autoComplete="off" enterKeyHint="search"
              onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }} />
            {query && <button type="button" className="mv-search-clear" aria-label="Clear search" onClick={() => setQuery('')}><Glyph name="close" size={16} /></button>}
            <button type="button" className={`mv-filter-button${filterCount ? ' is-on' : ''}`} aria-label={filterCount ? `Filters, ${filterCount} on` : 'Filters'} aria-haspopup="dialog" onClick={() => setFilterOpen(true)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
              {filterCount > 0 && <span className="mv-filter-count" aria-hidden="true">{filterCount}</span>}
            </button>
          </div>}
        </div>
      </div>

      {hasCover ? <header className="mv-cover">
        <img className="mv-cover-img" src={restaurant.coverUrl} alt="" fetchPriority={preview ? undefined : 'high'} decoding="async" onError={() => setCoverFailed(true)} />
        <div className="mv-cover-text">
          <H1 className="mv-name">{name || 'Menu'}</H1>
          {meta && <p className="mv-meta">{meta}</p>}
          {badges}
        </div>
      </header> : (meta || badges) && <div className="mv-intro">{meta && <p className="mv-meta">{meta}</p>}{badges}</div>}

      {afterHero}

      {!searching && tabs.length > 0 && <nav ref={tabsRef} className={`mv-tabs${stuck ? ' is-stuck' : ''}`} aria-label="Menu categories">
        <ul ref={tabRowRef} className="mv-tab-row" onKeyDown={onTabKey}>
          {tabs.map((tab) => <li key={tab.key}>
            <a href={`#${sectionId(tab.key)}`} data-tab={tab.key} className={`mv-tab${tab.key === activeTab ? ' is-active' : ''}`}
              aria-current={tab.key === activeTab ? 'true' : undefined} onClick={(event) => jump(event, tab.key)}>{tab.title}</a>
          </li>)}
          {indicator && <li className="mv-tab-line" aria-hidden="true" style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }} />}
        </ul>
      </nav>}

      <main className="mv-main" aria-label={preview ? undefined : 'Menu'}>
        {searching ? <section className="mv-results" aria-labelledby={`${uid}-results`}>
          <div className="mv-results-head">
            <h2 id={`${uid}-results`} className="mv-results-title" aria-live="polite">{resultCount ? `${resultCount} result${resultCount === 1 ? '' : 's'}` : 'No matches'}{query.trim() ? <> for “{query.trim()}”</> : ''}</h2>
            <button type="button" className="mv-link-button" onClick={clearSearch}>Clear{filterCount ? ' filters' : ''}</button>
          </div>
          {found.deals.length > 0 && dealList(found.deals, 'grid', 'Matching deals')}
          {found.items.length > 0 && dishList(found.items, 'grid', 'Matching dishes')}
          {!resultCount && <p className="mv-empty-text">Try another word, or clear the filters to see the whole menu.</p>}
        </section> : blocks.length ? blocks.map(renderBlock) : <div className="mv-empty">
          <span className="mv-empty-art" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="24" cy="25" r="11" /><circle cx="24" cy="25" r="6.5" opacity=".5" /><path d="M7 12v7a3 3 0 0 0 3 3v14M10 12v6M13 12v7a3 3 0 0 1-3 3M39 12c-2.5 1.5-3.5 5-3.5 9h3.5v15" /></svg>
          </span>
          <p className="mv-empty-title">The menu is on its way</p>
          <p className="mv-empty-text">Dishes will appear here soon. In the meantime, a member of staff will be happy to help.</p>
        </div>}
      </main>

      <footer className="mv-foot">
        {resolved.footer.showCta && blocks.length > 0 ? <div className="mv-band">
          <div className="mv-band-brand">
            {restaurant?.logoUrl && resolved.header.showLogo ? <span className="mv-band-logo"><Img src={restaurant.logoUrl} alt="" /></span> : <span className="mv-band-mark" aria-hidden="true">{initials(name) || 'M'}</span>}
            <p className="mv-band-tagline"><strong>{name}</strong><span>{tagline}</span></p>
          </div>
          <div className="mv-band-actions">
            <button type="button" className="mv-band-primary" onClick={onOrderNow} disabled={!onOrderNow} aria-haspopup="dialog">Order now</button>
            <button type="button" className="mv-band-secondary" onClick={onFindUs} disabled={!onFindUs} aria-haspopup="dialog">Find us</button>
          </div>
        </div> : (restaurant?.address || restaurant?.phone || hours) && blocks.length > 0 && <aside className="mv-info" aria-label="Restaurant information">
          {hours && <p><span>Hours</span>{hours}</p>}
          {restaurant?.address && <p><span>Address</span>{restaurant.address}</p>}
          {restaurant?.phone && <p><span>Phone</span>{preview ? restaurant.phone : <a href={`tel:${restaurant.phone.replace(/[^\d+]/g, '')}`}>{restaurant.phone}</a>}</p>}
        </aside>}
        <p className="mv-powered">Powered by Cravio<BrandMark /></p>
      </footer>
    </div>

    <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} filters={filters} onApply={setFilters} query={query} menu={menu} categories={categories} contained={preview} />
    {overlays}
  </div>;
}

/** Loading state in the same layout as MenuView (page variant). Static, decorative. */
export function MenuSkeleton() {
  return <div className="mv-shell mv-shell-page" style={designVars(resolveDesign(null))}>
    <div className="mv mv-page mv-skeleton" aria-busy="true" aria-label="Loading menu">
      <div className="mv-top"><div className="mv-top-inner"><span className="mv-sk" style={{ width: 96, height: 40 }} /><span className="mv-sk" style={{ flex: 1, height: 44 }} /></div></div>
      <div className="mv-tabs"><div className="mv-tab-row">{[72, 64, 56, 68].map((w, i) => <span key={i} className="mv-sk" style={{ width: w, height: 14, margin: '16px 10px' }} />)}</div></div>
      <div className="mv-main">
        <span className="mv-sk" style={{ width: 160, height: 28, margin: '28px 0 16px' }} />
        <div className="mv-sk-row">{[0, 1, 2].map((i) => <span key={i} className="mv-sk mv-sk-card" />)}</div>
        <span className="mv-sk" style={{ width: 200, height: 28, margin: '36px 0 16px' }} />
        <div className="mv-sk-row">{[0, 1].map((i) => <span key={i} className="mv-sk mv-sk-deal" />)}</div>
      </div>
    </div>
  </div>;
}

export { formatKsh };
