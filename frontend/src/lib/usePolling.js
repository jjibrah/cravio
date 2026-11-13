import { useCallback, useEffect, useRef, useState } from 'react';

const FOCUS_GAP = 1000; // focus + visibilitychange often fire together; one refresh is enough

/**
 * Polls `load(signal)` every `interval` ms while the tab is visible. Returns { data, error, loading, refresh }.
 * - Pauses while the tab is hidden, and refreshes right away when it becomes visible or the window gains focus.
 * - Backs off on errors: interval × 2 per consecutive failure (10s → 20s → 40s), capped at `maxInterval` (60s).
 * - Keeps the last good data on errors. `load` may return `undefined` to mean "nothing changed".
 * - `initialData` (e.g. a cached snapshot) renders at once; the first poll still runs on mount.
 * - `refresh()` joins a request already in flight. `refresh({ queue: true })` runs once more after it
 *   (use it after a mutation, so the result can't predate the change).
 */
export default function usePolling(load, { interval = 10000, enabled = true, initialData, maxInterval = 60000 } = {}) {
  const [state, setState] = useState(() => ({ data: initialData, error: null, loading: initialData === undefined }));
  const loadRef = useRef(load);
  loadRef.current = load;
  const running = useRef(null);
  const failures = useRef(0);
  const timer = useRef(null);
  const lastStart = useRef(0);
  const live = useRef(false);
  const schedule = useRef(() => {});

  const refresh = useCallback(({ queue = false } = {}) => {
    const current = running.current;
    if (current) {
      if (!queue) return current.promise;
      current.again = true;
      return current.promise.then(() => current.next);
    }
    window.clearTimeout(timer.current);
    const controller = new AbortController();
    const run = { controller, again: false, next: undefined };
    running.current = run;
    lastStart.current = Date.now();
    run.promise = (async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        failures.current = 0;
        setState((previous) => ({ data: data === undefined ? previous.data : data, error: null, loading: false }));
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) return;
        failures.current += 1;
        setState((previous) => ({ ...previous, error, loading: false }));
      } finally {
        if (running.current === run) running.current = null;
        if (!controller.signal.aborted) {
          if (run.again) run.next = refresh();
          else schedule.current();
        }
      }
    })();
    return run.promise;
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    live.current = true;
    const visible = () => document.visibilityState !== 'hidden';
    schedule.current = () => {
      window.clearTimeout(timer.current);
      if (!live.current || !visible()) return;
      const delay = failures.current ? Math.min(interval * 2 ** failures.current, Math.max(maxInterval, interval)) : interval;
      timer.current = window.setTimeout(() => refresh(), delay);
    };
    const wake = () => {
      if (!visible()) { window.clearTimeout(timer.current); return; }
      if (Date.now() - lastStart.current < FOCUS_GAP) return;
      refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      live.current = false;
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      running.current?.controller.abort();
      running.current = null;
    };
  }, [enabled, interval, maxInterval, refresh]);

  return { ...state, refresh };
}
