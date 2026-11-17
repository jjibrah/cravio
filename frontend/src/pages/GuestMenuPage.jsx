import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BrandMark } from '../components/Brand';
import Icon from '../components/Icon';
import MenuExperience from '../components/menu/MenuExperience';
import BrandedLoader from '../components/menu/BrandedLoader';
import { brandFromMenu, criticalImages, preloadImages, readBrand, writeBrand } from '../components/menu/brand-cache';
import { prefersReducedMotion } from '../components/menu/MenuCards';
import Glyph from '../components/media/Glyph';
import { publicApi } from '../components/guest/guestApi';
import './guest-menu.css';

/*
 * The guest view belongs to the restaurant: its logo, food and design lead; Cravio signs off quietly.
 * This page only imports Supabase-free modules (lib/format, lib/menu-design), so guests never download the
 * signed-in client.
 */

const tableFrom = (value) => (/^\d{1,3}$/.test(value || '') && Number(value) >= 1 ? Number(value) : undefined);

/** Loads the public menu. Plain fetch: guests are never signed in. */
function usePublicMenu(restaurantId, table) {
  const [state, setState] = useState({ status: restaurantId ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!restaurantId) { setState({ status: 'idle' }); return undefined; }
    const controller = new AbortController();
    setState({ status: 'loading' });
    const query = table ? `?t=${table}` : '';
    publicApi(`/api/public/menu/${encodeURIComponent(restaurantId)}${query}`, { signal: controller.signal })
      .then((data) => setState({ status: 'ready', data: { featuredItemIds: [], deals: [], ...data } }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setState({ status: error.status === 404 ? 'missing' : 'error' });
      });
    return () => controller.abort();
  }, [restaurantId, table, attempt]);

  return [state, retry];
}

/** Sets the tab title and the browser chrome colour while the menu is open, restoring both after. */
function useDocumentLook(title, color) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta || !color) return undefined;
    const previous = meta.getAttribute('content');
    meta.setAttribute('content', color);
    return () => meta.setAttribute('content', previous);
  }, [color]);
}

/*
 * The loading screen's life: 'on' while the menu loads and its first images arrive, 'leaving' while it fades
 * over the menu (already rendered underneath), then 'off' for good. Once the menu is here it waits for the cover,
 * logo and first dish images, but never more than HOLD_CAP ms; a short minimum keeps a fast load from flashing.
 */
const HOLD_CAP = 1200;
const FADE_MS = 400;

function useLoaderPhase(data, firstVisit) {
  const [phase, setPhase] = useState('on');
  useEffect(() => {
    if (!data || phase !== 'on') return undefined;
    let cancelled = false;
    const minimum = firstVisit ? 450 : 220;
    const leave = () => { if (!cancelled) setPhase((current) => (current === 'on' ? 'leaving' : current)); };
    const cap = setTimeout(leave, HOLD_CAP);
    Promise.all([preloadImages(criticalImages(data), HOLD_CAP), new Promise((resolve) => { setTimeout(resolve, minimum); })]).then(leave);
    return () => { cancelled = true; clearTimeout(cap); };
    // Runs once per menu load; `firstVisit` is fixed for the visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => {
    if (phase !== 'leaving') return undefined;
    const timer = setTimeout(() => setPhase('off'), prefersReducedMotion() ? 180 : FADE_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase;
}

function Notice({ icon, title, children, action, brand = false }) {
  return <main className="gm-notice">
    {brand && <p className="gm-brand"><span className="brand-word">Cravio</span><BrandMark /></p>}
    <div className="gm-notice-card">
      <span className="gm-notice-icon" aria-hidden="true">{icon}</span>
      <h1>{title}</h1>
      {children}
      {action}
    </div>
    {!brand && <footer className="gm-notice-footer">Powered by Cravio<BrandMark /></footer>}
  </main>;
}

export default function GuestMenuPage() {
  const [params] = useSearchParams();
  const restaurantId = params.get('r')?.trim() || '';
  const table = tableFrom(params.get('t')?.trim());
  const [state, retry] = usePublicMenu(restaurantId, table);
  const data = state.status === 'ready' ? state.data : null;
  // A returning guest's first paint is already the restaurant's; a first visit starts neutral.
  const [cachedBrand] = useState(() => readBrand(restaurantId));
  const liveBrand = useMemo(() => (data ? brandFromMenu(data) : null), [data]);
  useEffect(() => { if (liveBrand) writeBrand(restaurantId, liveBrand); }, [restaurantId, liveBrand]);
  const brand = liveBrand || cachedBrand;
  const loader = useLoaderPhase(data, !cachedBrand);
  useDocumentLook(data?.restaurant?.name || cachedBrand?.name || (state.status === 'idle' ? 'Guest menu · Cravio' : 'Menu'), brand?.bg || null);

  if (state.status === 'idle') {
    return <div className="gm-page gm-plain">
      <Notice brand icon={<Icon name="menu" size={26} />} title="Guest menu">
        <p>The restaurant menu will appear here.</p>
        <p className="gm-hint"><Icon name="qr" size={16} />Scan the QR code on your table to open the menu.</p>
      </Notice>
    </div>;
  }

  if (state.status === 'missing') {
    return <div className="gm-page gm-plain">
      <Notice icon={<Icon name="menu" size={26} />} title="This menu isn’t available right now.">
        <p>Please ask a member of staff.</p>
      </Notice>
    </div>;
  }

  if (state.status === 'error') {
    return <div className="gm-page gm-plain">
      <Notice icon={<Icon name="refresh" size={24} />} title="We couldn’t load the menu"
        action={<button type="button" className="gm-retry" onClick={retry}>Try again</button>}>
        <p>Check your connection and try again. If it keeps happening, a member of staff can help.</p>
      </Notice>
    </div>;
  }

  const tableNumber = data?.table?.number;
  // Same tree while loading and after, so the loader carries on (neutral to branded, then fading) without a remount.
  return <div className="gm-page" style={!data && brand ? { background: brand.bg } : undefined} aria-busy={loader === 'on' ? 'true' : undefined}>
    {data && <MenuExperience data={data} restaurantId={restaurantId} tableNumber={tableNumber}
      afterHero={!tableNumber && <p className="gx-no-table"><Glyph name="qr" size={16} />Scan the code on your table to call a waiter.</p>} />}
    {loader !== 'off' && <BrandedLoader brand={brand} leaving={loader === 'leaving'} />}
  </div>;
}
