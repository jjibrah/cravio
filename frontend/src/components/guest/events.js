import { useCallback, useEffect, useRef } from 'react';
import { visitorId } from './guestApi';

/*
 * Guest menu insights (docs/API.md §3, POST /api/public/events): dish_view, video_play, deal_view.
 * Fire and forget: events queue in memory and go out in batches (every ~5 s, at 50 events, and when the page is
 * hidden or closed, with a keepalive request that outlives the page). Nothing here ever blocks the UI, retries or
 * shows an error. The same event for the same dish or deal is queued at most once per 10 minutes per page.
 */

const FLUSH_EVERY = 5000;
const MAX_BATCH = 50;
const REPEAT_AFTER = 10 * 60 * 1000;
const ENDPOINT = `${import.meta.env.VITE_API_URL || ''}/api/public/events`;

function send(body, { closing = false } = {}) {
  const json = JSON.stringify(body);
  try {
    fetch(ENDPOINT, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Cravio-Visitor': visitorId() },
      body: json,
    }).catch(() => {});
  } catch {
    // keepalive fetch unavailable: a beacon still delivers (without the visitor header, so it isn't deduped).
    if (closing && navigator.sendBeacon) {
      try { navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' })); } catch { /* ignore */ }
    }
  }
}

/**
 * Returns `track(type, id)`. Pass `restaurantId: null` (the Studio and owner previews) to record nothing.
 */
export default function useMenuEvents(restaurantId, tableNumber) {
  const queue = useRef([]);
  const seen = useRef(new Map());
  const target = useRef({ restaurantId, tableNumber });
  target.current = { restaurantId, tableNumber };

  const flush = useCallback((closing = false) => {
    const { restaurantId: id, tableNumber: table } = target.current;
    if (!id || !queue.current.length) return;
    while (queue.current.length) {
      const events = queue.current.splice(0, MAX_BATCH);
      send({ restaurantId: id, ...(table ? { tableNumber: table } : {}), events }, { closing });
    }
  }, []);

  useEffect(() => {
    if (!restaurantId) return undefined;
    const timer = setInterval(() => flush(), FLUSH_EVERY);
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(true); };
    const onLeave = () => flush(true);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onLeave);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onLeave);
      flush(true);
    };
  }, [restaurantId, flush]);

  return useCallback((type, id) => {
    if (!target.current.restaurantId || !id) return;
    const key = `${type}:${id}`;
    const last = seen.current.get(key);
    if (last && Date.now() - last < REPEAT_AFTER) return;
    seen.current.set(key, Date.now());
    queue.current.push({ type, ...(type === 'deal_view' ? { dealId: id } : { itemId: id }), at: new Date().toISOString() });
    if (queue.current.length >= MAX_BATCH) flush();
  }, [flush]);
}
