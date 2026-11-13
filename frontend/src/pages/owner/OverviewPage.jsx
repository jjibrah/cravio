// Owner overview: the control room. "Finish setting up" (only while a step is left), then Live and Analytics.
// Reads go through the API cache (lib/cache.js), so coming back to the Overview renders at once from the
// last answers while they revalidate; prefetchRoute('/owner') warms the same keys on hover.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import SetupChecklist from '../../components/onboarding/SetupChecklist';
import Tour from '../../components/onboarding/Tour';
import NeedsAttention from '../../components/owner/NeedsAttention';
import AnalyticsView, { RANGES } from '../../components/owner/AnalyticsView';
import { MenuToday, SystemHealth, TablesPlan, TodayStrip } from '../../components/owner/LivePanels';
import OrderDrawer from '../../components/owner/OrderDrawer';
import useOrderParam from '../../components/owner/useOrderParam';
import { Segmented } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import { api, useApi } from '../../lib/api';
import { peek, setCached } from '../../lib/cache';
import { opsApi, useNow } from '../../lib/ops';
import usePolling from '../../lib/usePolling';
import { OVERVIEW_GETS } from '../../lib/prefetch';

const [LIVE, TODAY, HEALTH, SETUP] = OVERVIEW_GETS;

const TOUR = [
  { title: 'Everything lives here', body: 'Orders, tables, your menu and insights are one tap away in the menu.', selectors: ['aside.sidebar', '.mobile-nav-toggle'] },
  { title: 'Jump anywhere with search', body: 'Press ⌘K (or Ctrl+K) to find any page, setting or record without leaving your keyboard.', selectors: ['.search-trigger'] },
  { title: 'Finish setting up', body: 'Your next step waits here, one button away. The steps beside it show what’s left.', selectors: ['#finish-setup', '.page-header'] },
];
const VIEWS = [{ value: 'live', label: 'Live' }, { value: 'analytics', label: 'Analytics' }];

/**
 * /api/ops/live, polled every 10s with the cursor (like useLive in lib/ops), but seeded from the cache so
 * the feed and the tables plan render at once on a return visit. Full answers are written back to it.
 */
function useCachedLive() {
  const cursor = useRef(null);
  const [offset, setOffset] = useState(0);
  const poll = usePolling(async (signal) => {
    // A full fetch joins a prefetch already in flight for the same key.
    const result = cursor.current ? await opsApi.live(cursor.current, signal) : await api(LIVE, { cache: 'swr', force: true, signal });
    setOffset(Date.now() - Date.parse(result.serverTime));
    cursor.current = result.cursor;
    if (result.changed === false) return undefined;
    setCached(LIVE, result);
    return result;
  }, { interval: 10000, initialData: peek(LIVE)?.data });
  const { refresh } = poll;
  // After a change of our own: fetch everything again, after any poll already in flight.
  const reload = useCallback(() => { cursor.current = null; return refresh({ queue: true }); }, [refresh]);
  return { ...poll, reload, offset };
}

/** Re-runs `reload({ quiet: true })` every `ms` while the tab is visible. */
function useQuietRefresh(reload, ms) {
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload({ quiet: true }); }, ms);
    return () => clearInterval(timer);
  }, [reload, ms]);
}

export default function OverviewPage({ section }) {
  const [params, setParams] = useSearchParams();
  const touring = params.get('tour') === '1';
  const view = params.get('view') === 'analytics' ? 'analytics' : 'live';
  const range = RANGES.some((option) => option.value === params.get('range')) ? params.get('range') : 'today';
  const now = useNow(15000);

  const live = useCachedLive();
  const today = useApi(TODAY, { ttl: 60000 });
  const health = useApi(HEALTH, { ttl: 60000 });
  const setup = useApi(SETUP, { ttl: 60000 });
  const state = setup.data || null;
  const ready = !setup.loading;
  useQuietRefresh(today.reload, 60000);
  useQuietRefresh(health.reload, 60000);
  const [orderId, openOrder, closeOrder, preview] = useOrderParam();

  useEffect(() => {
    if (setup.error) console.warn('Setup checklist unavailable:', setup.error.message);
  }, [setup.error]);
  const setState = setup.setData;

  const saveProgressData = useCallback(async (data) => {
    const { progress } = await api('/api/restaurant/onboarding/progress', { method: 'PUT', body: { data } });
    setState((current) => current && { ...current, progress });
  }, [setState]);

  const endTour = useCallback(async (completed) => {
    setParams((current) => { const next = new URLSearchParams(current); next.delete('tour'); return next; }, { replace: true });
    if (!completed) return;
    try { await saveProgressData({ tourCompleted: true }); } catch { /* the card will offer the tour again */ }
  }, [setParams, saveProgressData]);

  const setParam = (key, value, fallback) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value === fallback) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });

  return <>
    <PageHeader title={section.label} description={section.description} />
    {state && <SetupChecklist state={state} onStartTour={() => setParams({ tour: '1' })} />}

    <div className="o-overview-tabs">
      <Segmented mode="tabs" label="Overview views" idBase="overview" options={VIEWS} value={view} onChange={(value) => setParam('view', value, 'live')} size="lg" />
    </div>

    <section className="o-overview" id="overview-panel" role="tabpanel" aria-labelledby={`overview-tab-${view}`}>
      {view === 'live' ? <div className="o-ov-grid">
        <div className="o-ov-main">
          <NeedsAttention live={live} now={now} onOpenOrder={openOrder} />
          <TablesPlan live={live} />
          <MenuToday analytics={today} rangeLabel="today" />
        </div>
        <div className="o-ov-side">
          <section className="o-panel o-today-panel" aria-labelledby="today-title">
            <header className="o-panel-head"><h2 className="o-panel-title" id="today-title">Today so far</h2></header>
            <TodayStrip analytics={today} />
          </section>
          <SystemHealth health={health} now={now} />
        </div>
      </div> : <AnalyticsView range={range} onRange={(value) => setParam('range', value, 'today')} />}
    </section>

    <OrderDrawer orderId={orderId} preview={preview} onClose={closeOrder} onChanged={() => { live.reload(); today.reload({ quiet: true }); }} />
    {touring && ready && <Tour stops={TOUR} onFinish={() => endTour(true)} onSkip={() => endTour(false)} />}
  </>;
}
