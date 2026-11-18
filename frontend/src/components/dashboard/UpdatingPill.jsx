import { useEffect, useState, useSyncExternalStore } from 'react';
import { busyCount, subscribeBusy } from '../../lib/cache';

/**
 * A small "Updating…" note while a screen shows saved data and the fresh answer is on its way (lib/cache.js: only
 * refreshes behind data already on screen count). Appears after a short delay, so quick refreshes stay invisible.
 */
export default function UpdatingPill({ delay = 500 }) {
  const busy = useSyncExternalStore(subscribeBusy, () => busyCount() > 0, () => false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) { setShown(false); return undefined; }
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [busy, delay]);
  return <div className="updating-pill-slot" role="status" aria-live="polite">
    {shown && <span className="updating-pill" data-testid="updating">Updating…</span>}
  </div>;
}
