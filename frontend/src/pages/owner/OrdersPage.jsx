// Owner orders: by table or as one list, with status, date and order-number filters, kept live.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import OrderDrawer from '../../components/owner/OrderDrawer';
import OrderRow from '../../components/owner/OrderRow';
import useOrderParam from '../../components/owner/useOrderParam';
import { EmptyState, ErrorState, LiveBadge, OIcon, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/orders.css';
import { formatKes, nairobiDate, opsApi, plural, useLive, useNewArrivals, useNow } from '../../lib/ops';

const VIEWS = [{ value: 'tables', label: 'By table' }, { value: 'all', label: 'All orders' }];
const STATUSES = [
  { value: 'all', label: 'All' },
  // Confirmed covers older `accepted` orders too (there is no accept step any more).
  { value: 'confirmed', label: 'Confirmed', api: 'taken,accepted' },
  { value: 'served', label: 'Served' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
];
const RANGES = [{ value: 'today', label: 'Today', days: 0 }, { value: '7d', label: '7 days', days: 6 }, { value: '30d', label: '30 days', days: 29 }];
const PAGE = 50;
const SEARCH = /^#?[0-9a-f]{1,6}$/i;

export default function OrdersPage({ section }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'all' ? 'all' : 'tables';
  const status = STATUSES.some((option) => option.value === params.get('status')) ? params.get('status') : 'all';
  const range = RANGES.find((option) => option.value === params.get('range')) || RANGES[0];
  const tableFilter = /^\d{1,3}$/.test(params.get('table') || '') ? params.get('table') : '';
  const [query, setQuery] = useState(params.get('q') || '');
  const search = query.trim();
  const searchValid = !search || SEARCH.test(search);
  const [debounced, setDebounced] = useState(search);
  useEffect(() => { const timer = setTimeout(() => setDebounced(searchValid ? search : ''), 250); return () => clearTimeout(timer); }, [search, searchValid]);

  const now = useNow(30000);
  const live = useLive();
  const [orderId, openOrder, closeOrder, preview] = useOrderParam();
  const [state, setState] = useState({ orders: null, total: 0, hasMore: false, error: null, loading: true, more: false });
  const request = useRef(null);

  const filters = useMemo(() => ({
    status: status === 'all' ? undefined : STATUSES.find((option) => option.value === status).api || status,
    from: nairobiDate(-range.days),
    q: debounced ? debounced.replace(/^#/, '') : undefined,
    tableNumber: tableFilter || undefined,
  }), [status, range.days, debounced, tableFilter]);

  async function load({ quiet = false, append = false } = {}) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!quiet && !append) setState((current) => ({ ...current, loading: true, error: null }));
    if (append) setState((current) => ({ ...current, more: true }));
    try {
      const offset = append ? state.orders?.length || 0 : 0;
      const limit = quiet && !append ? Math.max(PAGE, state.orders?.length || 0) : PAGE;
      const result = await opsApi.orders({ ...filters, limit: Math.min(100, limit), offset }, controller.signal);
      setState((current) => ({
        orders: append ? [...(current.orders || []), ...result.orders] : result.orders,
        total: result.total, hasMore: result.hasMore, error: null, loading: false, more: false,
      }));
    } catch (error) {
      if (error.name !== 'AbortError') setState((current) => ({ ...current, error, loading: false, more: false }));
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => { loadRef.current(); }, [filters]);
  // Live: re-fetch quietly whenever the live cursor says something changed.
  const cursor = live.cursor;
  const firstCursor = useRef(true);
  useEffect(() => {
    if (!cursor) return;
    if (firstCursor.current) { firstCursor.current = false; return; }
    loadRef.current({ quiet: true });
  }, [cursor]);
  useEffect(() => () => request.current?.abort(), []);

  const setParam = (key, value, fallback) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (!value || value === fallback) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });
  useEffect(() => { setParam('q', searchValid ? search.replace(/^#/, '') : '', ''); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = useNewArrivals(state.orders);
  const groups = useMemo(() => {
    if (!state.orders) return null;
    const map = new Map();
    for (const order of state.orders) {
      const key = order.table?.number ?? 'takeaway';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(order);
    }
    return [...map.entries()].sort(([a], [b]) => (a === 'takeaway' ? 1 : b === 'takeaway' ? -1 : a - b));
  }, [state.orders]);

  const statusLabel = STATUSES.find((option) => option.value === status).label;
  const emptyTitle = debounced ? `No orders match #${debounced.replace(/^#/, '')}` : status === 'all' ? `No orders ${range.value === 'today' ? 'yet today' : `in the last ${range.label}`}` : `No ${statusLabel.toLowerCase()} orders ${range.value === 'today' ? 'today' : `in the last ${range.label}`}`;
  const refresh = () => { load({ quiet: Boolean(state.orders) }); live.reload(); };

  return <>
    <PageHeader title={section.label} description={section.description} />

    <div className="o-orders-toolbar">
      <div className="o-orders-toolbar-row">
        <Segmented label="Show orders" options={VIEWS} value={view} onChange={(value) => setParam('view', value, 'tables')} />
        <div className="o-orders-find">
        <LiveBadge error={live.error && live.data} />
        <div className="o-search o-orders-search">
          <OIcon name="search" size={16} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an order, like 92da2e"
            aria-label="Search by order number" aria-invalid={searchValid ? undefined : 'true'} aria-describedby={searchValid ? undefined : 'order-search-error'} autoComplete="off" spellCheck="false" />
          {query && <button type="button" className="o-icon-btn" onClick={() => setQuery('')} aria-label="Clear search"><OIcon name="close" size={14} /></button>}
        </div>
        </div>
      </div>
      {!searchValid && <p className="o-field-error" id="order-search-error" role="alert">Search by order number, like 92da2e. It’s the code after # on the bill.</p>}
      <div className="o-orders-toolbar-row">
        <div className="o-chips" role="radiogroup" aria-label="Status">
          {STATUSES.map((option) => <button key={option.value} type="button" role="radio" aria-checked={status === option.value} className="o-chip"
            onClick={() => setParam('status', option.value, 'all')}>{option.label}</button>)}
        </div>
 {tableFilter && <button type="button" className="o-chip o-chip-filter" aria-pressed="true" onClick={() => setParam('table', '', '')}
          aria-label={`Showing table ${tableFilter} only. Show all tables`}>Table {tableFilter}<OIcon name="close" size={13} /></button>}
        <Segmented label="Date range" options={RANGES} value={range.value} onChange={(value) => setParam('range', value, 'today')} size="sm" />
      </div>
    </div>

    <p className="o-orders-summary" role="status">
      {state.orders ? <>{plural(state.total, 'order')}{status !== 'all' && ` · ${statusLabel}`} · {range.value === 'today' ? 'Today' : `Last ${range.label}`}</> : ' '}
    </p>

    {state.loading && !state.orders && <div className="o-panel"><SkeletonRows rows={6} thumb={false} label="Loading orders" /></div>}
    {state.error && !state.orders && <div className="o-panel"><ErrorState error={state.error} onRetry={refresh} what="orders" /></div>}
    {state.error && state.orders && <p className="o-note is-warning" role="status"><OIcon name="alert" size={16} />Couldn’t refresh just now. Showing the last list. <button type="button" className="o-btn is-quiet is-small" onClick={refresh}>Try again</button></p>}

    {state.orders && !state.orders.length && <div className="o-panel"><EmptyState icon="bill" tone="neutral" title={emptyTitle}
      action={(status !== 'all' || range.value !== '30d' || debounced) && <button type="button" className="o-btn" onClick={() => { setQuery(''); setParams(view === 'all' ? { view: 'all', range: '30d' } : { range: '30d' }, { replace: true }); }}>Show all from the last 30 days</button>}>
      Orders appear here as soon as your staff enter them.
    </EmptyState></div>}

    {state.orders && state.orders.length > 0 && (view === 'all'
      ? <div className="o-panel o-orders-list-panel">
        <div className="o-orders-head" aria-hidden="true"><span>Order</span><span>Progress</span><span>Total</span><span /></div>
        <ul className="o-order-list" aria-label="Orders">
          {state.orders.map((order) => <OrderRow key={order.id} order={order} now={now} onOpen={openOrder} isNew={fresh.has(order.id)} />)}
        </ul>
      </div>
      : <div className="o-table-cards">
        {groups.map(([key, orders]) => {
          const unpaid = orders.filter((order) => ['taken', 'accepted', 'served'].includes(order.status));
          return <section className="o-panel o-table-card" key={key} aria-labelledby={`orders-table-${key}`}>
            <header className="o-table-card-head">
              <span className="o-table-card-number" aria-hidden="true">{key === 'takeaway' ? <OIcon name="order" size={18} /> : key}</span>
              <div className="o-table-card-titles">
                <h2 id={`orders-table-${key}`}>{key === 'takeaway' ? 'Takeaway' : `Table ${key}`}</h2>
                <p>{plural(orders.length, 'order')}{unpaid.length ? ` · ${formatKes(unpaid.reduce((sum, order) => sum + order.total, 0))} not paid yet` : ' · all settled'}</p>
              </div>
              {key !== 'takeaway' && <Link className="o-btn is-quiet is-small" to={`/owner/tables/${key}`} aria-label={`Table ${key} details`}>Table<OIcon name="arrowRight" size={14} /></Link>}
            </header>
            <ul className="o-order-list">
              {orders.map((order) => <OrderRow key={order.id} order={order} now={now} onOpen={openOrder} showTable={false} isNew={fresh.has(order.id)} />)}
            </ul>
          </section>;
        })}
      </div>)}

    {state.hasMore && <div className="o-orders-more">
      <button type="button" className="o-btn" onClick={() => load({ append: true })} disabled={state.more}>{state.more ? 'Loading…' : `Show more (${state.total - state.orders.length} left)`}</button>
    </div>}

    <OrderDrawer orderId={orderId} preview={preview} onClose={closeOrder} onChanged={() => { load({ quiet: true }); live.reload(); }} />
  </>;
}
