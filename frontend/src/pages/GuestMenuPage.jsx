import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BrandMark } from '../components/Brand';
import Icon from '../components/Icon';
import MenuExperience from '../components/menu/MenuExperience';
import { MenuSkeleton } from '../components/menu/MenuView';
import Glyph from '../components/media/Glyph';
import { publicApi } from '../components/guest/guestApi';
import { designColors } from '../lib/menu-design';
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
  useDocumentLook(data?.restaurant?.name || (state.status === 'idle' ? 'Guest menu · Cravio' : 'Menu'), data ? designColors(data.design || { theme: data.restaurant?.theme }).bg : null);

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

  if (!data) return <div className="gm-page"><MenuSkeleton /></div>;

  const tableNumber = data.table?.number;
  return <div className="gm-page">
    <MenuExperience data={data} restaurantId={restaurantId} tableNumber={tableNumber}
      afterHero={!tableNumber && <p className="gx-no-table"><Glyph name="qr" size={16} />Scan the code on your table to call a waiter.</p>} />
  </div>;
}
