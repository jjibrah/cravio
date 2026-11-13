import { useCallback, useEffect, useRef, useState } from 'react';
import usePolling from '../../lib/usePolling';
import Glyph from '../media/Glyph';
import { publicApi } from './guestApi';

export const REQUESTS = [
  { type: 'call_waiter', label: 'Call waiter', short: 'Call waiter', icon: 'hand', sent: 'Waiter called' },
  { type: 'bill', label: 'Ask for the bill', short: 'Bill', icon: 'receipt', sent: 'Bill requested' },
  { type: 'payment', label: 'Pay', short: 'Pay', icon: 'card', sent: 'Ready to pay' },
];
const WATCH_FOR = 30 * 60 * 1000;
const DONE_FOR = 8000;

/**
 * Call waiter / Ask for the bill / Pay, with the live state of each: Sent → On the way → Done.
 * Duplicate taps are blocked while a request is active (the server dedupes too). Polls every 8 seconds while
 * something is unresolved (capped at 30 minutes after the last tap), and stops when nothing is.
 */
export default function RequestDock({ restaurantId, tableNumber }) {
  const [requests, setRequests] = useState([]);
  const [done, setDone] = useState({});
  const [sending, setSending] = useState(null);
  const [error, setError] = useState('');
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [watch, setWatch] = useState(true);
  const lastSent = useRef(0);
  const known = useRef(new Map());

  const apply = useCallback((list) => {
    const next = new Map(list.map((request) => [request.type, request]));
    const finished = [...known.current.keys()].filter((type) => !next.has(type));
    if (finished.length) setDone((current) => ({ ...current, ...Object.fromEntries(finished.map((type) => [type, Date.now()])) }));
    known.current = next;
    setRequests(list);
    // Keep polling while something is unresolved (for up to 30 minutes after the last tap); stop when the list is empty.
    setWatch(list.length > 0 && (lastSent.current === 0 || Date.now() - lastSent.current < WATCH_FOR));
  }, []);

  const load = useCallback(async (signal) => {
    const data = await publicApi(`/api/public/requests?restaurantId=${encodeURIComponent(restaurantId)}&tableNumber=${tableNumber}`, { signal });
    apply(data.requests || []);
    return data;
  }, [restaurantId, tableNumber, apply]);
  const { refresh } = usePolling(load, { interval: 8000, enabled: watch });

  // "Done" shows for a few seconds, then the button is ready again.
  useEffect(() => {
    const times = Object.values(done);
    if (!times.length) return undefined;
    const wait = Math.max(0, Math.min(...times) + DONE_FOR - Date.now());
    const timer = setTimeout(() => setDone((current) => Object.fromEntries(Object.entries(current).filter(([, at]) => Date.now() - at < DONE_FOR))), wait + 50);
    return () => clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    if (!blockedUntil) return undefined;
    const timer = setTimeout(() => setBlockedUntil(0), Math.max(0, blockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [blockedUntil]);

  async function send(type) {
    if (sending) return;
    setError('');
    setSending(type);
    try {
      const { request } = await publicApi('/api/public/requests', { method: 'POST', body: { restaurantId, tableNumber, type } });
      lastSent.current = Date.now();
      setDone((current) => { const next = { ...current }; delete next[type]; return next; });
      const list = [...requests.filter((item) => item.type !== type), request];
      known.current = new Map(list.map((item) => [item.type, item]));
      setRequests(list);
      setWatch(true);
      refresh();
    } catch (sendError) {
      setError(sendError.message);
      if (sendError.status === 429) setBlockedUntil(Date.now() + (sendError.details?.retryAfterSeconds || 60) * 1000);
    } finally { setSending(null); }
  }

  const stateOf = (type) => {
    const request = requests.find((item) => item.type === type);
    if (sending === type) return 'sending';
    if (request?.status === 'acknowledged') return 'coming';
    if (request) return 'sent';
    if (done[type]) return 'done';
    return 'idle';
  };
  const words = { sending: 'Sending…', sent: 'Sent', coming: 'On the way', done: 'Done' };

  const coming = REQUESTS.find((r) => stateOf(r.type) === 'coming');
  const sent = REQUESTS.find((r) => stateOf(r.type) === 'sent');
  const finished = REQUESTS.find((r) => stateOf(r.type) === 'done');
  const line = coming ? `${coming.sent} · your waiter is on the way`
    : sent ? `${sent.sent} · sent, a waiter will come`
      : finished ? `${finished.sent} · done` : '';
  const blocked = blockedUntil > Date.now();

  return <div className="gx-dock">
    <p className={`gx-dock-status${coming ? ' is-coming' : ''}`} role="status" aria-live="polite">
      {line && <><span className="gx-pulse" aria-hidden="true" />{line}</>}
    </p>
    {error && <p className="gx-dock-error" role="alert">{error}</p>}
    <div className="gx-requests" role="group" aria-label="Ask for service">
      {REQUESTS.map((request) => {
        const state = stateOf(request.type);
        const active = state !== 'idle';
        return <button key={request.type} type="button" className={`gx-request is-${state}`} onClick={() => send(request.type)}
          disabled={active || blocked || Boolean(sending)} aria-label={active ? `${request.label}: ${words[state]}` : request.label}>
          <Glyph name={state === 'coming' ? 'walk' : state === 'done' ? 'check' : request.icon} size={18} />
          <span>{active ? words[state] : request.short}</span>
        </button>;
      })}
    </div>
  </div>;
}
