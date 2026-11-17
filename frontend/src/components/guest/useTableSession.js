import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { publicApi, readJson, writeJson } from './guestApi';

/*
 * The table's shared order (docs/v2/TABLE-SESSIONS.md). With a table number, scanning opens the table's session (the
 * first phone hosts it) or asks for the 4-digit join code from someone already at the table. Members poll the session
 * (~3 s, "unchanged since version N" is cheap) and change the cart line by line on the server, so two phones adding at
 * once both land. "Order on my own" (remembered for this table for 6 hours) keeps today's per-phone cart.
 * phase: 'off' (no table, preview, or sessions unavailable) | 'checking' | 'join' | 'member' | 'solo'.
 * `cart` has the same shape as useGuestCart's, so the menu and the order sheet work with either.
 */

const SOLO_MS = 6 * 3600 * 1000;
const POLL_MS = 3000;
const soloKey = (restaurantId, table) => `cravio-table-solo:${restaurantId}:${table}`;
const seenKey = (sessionId) => `cravio-table-seen:${sessionId}`;

export default function useTableSession(restaurantId, tableNumber, items, deals, { enabled = true, preferSolo = false } = {}) {
  const active = Boolean(enabled && restaurantId && tableNumber);
  const [phase, setPhase] = useState(active ? 'checking' : 'off');
  const [session, setSession] = useState(null);
  const [joinInfo, setJoinInfo] = useState(null); // { verified, locked, lockedUntil }
  const [confirmed, setConfirmed] = useState(null); // the newest round a waiter confirmed, once per phone
  const [closedNotice, setClosedNotice] = useState('');
  const versionRef = useRef(null);

  const adopt = useCallback((next) => {
    if (!next) return;
    versionRef.current = next.version;
    setSession(next);
    // A new round in "Ordered so far" that this phone hasn't shown yet: the waiter just confirmed it.
    const seen = readJson(seenKey(next.id), null);
    const count = next.ordered.length;
    if (seen === null) writeJson(seenKey(next.id), count);
    else if (count > seen) { writeJson(seenKey(next.id), count); setConfirmed({ ...next.ordered[count - 1], at: Date.now() }); }
  }, []);

  const openSession = useCallback(async (name) => {
    try {
      const data = await publicApi('/api/public/table-sessions', { method: 'POST', body: { restaurantId, tableNumber, ...(name ? { name } : {}) } });
      if (!data.available) { setPhase('off'); return; }
      if (data.state === 'member') { adopt(data.session); setPhase('member'); }
      else { setJoinInfo({ verified: data.verified, locked: data.locked, lockedUntil: data.lockedUntil }); setPhase('join'); }
    } catch { setPhase('off'); } // offline or refused: the guest still has their own cart
  }, [restaurantId, tableNumber, adopt]);

  useEffect(() => {
    setSession(null); setJoinInfo(null); versionRef.current = null;
    if (!active) { setPhase('off'); return; }
    const solo = readJson(soloKey(restaurantId, tableNumber), null);
    if (preferSolo || (solo && Date.now() - solo < SOLO_MS)) { setPhase('solo'); return; }
    setPhase('checking');
    openSession();
  }, [active, restaurantId, tableNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Members poll. A closed session (staff, idle, paid) sends the phone back to scanning state.
  useEffect(() => {
    if (phase !== 'member' || !session?.id) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const data = await publicApi(`/api/public/table-sessions/${session.id}?since=${versionRef.current ?? ''}`);
          if (stopped) return;
          if (!data.available) { setPhase('off'); return; }
          if (data.changed) adopt(data.session);
        } catch (error) {
          if (stopped) return;
          if (error.status === 404) {
            setSession(null);
            setClosedNotice('Your table’s order was closed. Start a new one any time.');
            openSession();
            return;
          }
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [phase, session?.id, adopt, openSession]);

  const call = useCallback(async (path, body) => {
    const data = await publicApi(`/api/public/table-sessions/${session.id}${path}`, { method: 'POST', body: body || {} });
    if (data.session) adopt(data.session);
    return data;
  }, [session?.id, adopt]);

  /** One cart change. Errors (a line someone else just removed) refresh the cart; the caller decides what to say. */
  const op = useCallback(async (body) => {
    try { return await call('/ops', body); }
    catch (error) {
      if (error.status === 409 || error.status === 404) {
        publicApi(`/api/public/table-sessions/${session.id}`).then((data) => data.session && adopt(data.session)).catch(() => {});
      }
      throw error;
    }
  }, [call, session?.id, adopt]);

  const joinTable = useCallback(async (code, name) => {
    const data = await publicApi('/api/public/table-sessions/join', { method: 'POST', body: { restaurantId, tableNumber, code, ...(name ? { name } : {}) } });
    if (!data.available) { setPhase('off'); return; }
    adopt(data.session);
    setPhase('member');
  }, [restaurantId, tableNumber, adopt]);

  const orderOnMyOwn = useCallback(async () => {
    writeJson(soloKey(restaurantId, tableNumber), Date.now());
    if (phase === 'member' && session?.id) call('/leave').catch(() => {});
    setSession(null);
    setPhase('solo');
  }, [restaurantId, tableNumber, phase, session?.id, call]);

  const ready = useCallback(() => call('/ready'), [call]);

  /* ---------- The shared cart, shaped like useGuestCart ---------- */

  const itemsById = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);
  const dealsById = useMemo(() => new Map((deals || []).map((deal) => [deal.id, deal])), [deals]);
  const raw = useMemo(() => session?.cart || [], [session]);

  const lines = useMemo(() => raw.map((line) => {
    const base = { ...line, key: line.id };
    if (line.kind === 'deal') {
      const deal = dealsById.get(line.dealId);
      if (!deal) return null;
      const unitTotal = Number(deal.price || 0);
      return { ...base, name: deal.name, deal, extras: [], unitTotal, lineTotal: unitTotal * line.quantity, components: deal.items || [] };
    }
    const item = itemsById.get(line.itemId);
    if (!item) return null;
    const extras = line.extraIds.map((id) => (item.extras || []).find((extra) => extra.id === id)).filter(Boolean);
    const unitTotal = Number(item.price || 0) + extras.reduce((sum, extra) => sum + Number(extra.price || 0), 0);
    return { ...base, name: item.name, item, extras, unitTotal, lineTotal: unitTotal * line.quantity };
  }).filter(Boolean), [raw, itemsById, dealsById]);

  const cart = useMemo(() => {
    const plain = (itemId) => raw.filter((line) => line.kind === 'item' && line.itemId === itemId && !line.extraIds.length);
    const quiet = (promise) => promise.catch(() => {});
    return {
      shared: true,
      lines, rawLines: raw,
      snapshot: { code: session?.ready?.code || null },
      count: lines.reduce((sum, line) => sum + line.quantity, 0),
      total: lines.reduce((sum, line) => sum + line.lineTotal, 0),
      code: session?.ready?.code || null,
      expiresAt: session?.ready?.expiresAt || null,
      changedSinceSaved: session?.ready ? session.ready.changedSinceReady : true,
      addItem: (item, { quantity = 1, extraIds = [], note } = {}) => quiet(op({ type: 'add', line: { itemId: item.id, quantity, extraIds, ...(note ? { note } : {}) } })),
      addDeal: (deal, { quantity = 1, note } = {}) => quiet(op({ type: 'add', line: { dealId: deal.id, quantity, ...(note ? { note } : {}) } })),
      changeQuantity: (key, delta) => key && quiet(op({ type: 'change', lineId: key, delta })),
      setNote: (key, note) => quiet(op({ type: 'note', lineId: key, note })),
      removeLineAt: (index) => raw[index] && quiet(op({ type: 'remove', lineId: raw[index].id })),
      dropExtraAt: (index) => raw[index] && quiet(op({ type: 'remove', lineId: raw[index].id })),
      clear: () => quiet(op({ type: 'clear' })),
      restore: () => {}, markSaved: () => {}, forgetCode: () => {},
      payload: () => [],
      // The menu's +/- on a dish: the whole table's plain lines; minus takes from this phone's line first.
      plainKey: (itemId) => {
        const mine = plain(itemId).filter((line) => line.addedBy?.you);
        return (mine[mine.length - 1] || plain(itemId).slice(-1)[0])?.id || null;
      },
      plainQuantity: (itemId) => plain(itemId).reduce((sum, line) => sum + line.quantity, 0),
      itemQuantity: (itemId) => raw.reduce((sum, line) => sum + (line.kind === 'item' && line.itemId === itemId ? line.quantity : 0), 0),
      dealQuantity: (dealId) => raw.reduce((sum, line) => sum + (line.kind === 'deal' && line.dealId === dealId ? line.quantity : 0), 0),
    };
  }, [lines, raw, session, op]);

  return {
    phase, session, joinInfo, cart, confirmed, closedNotice,
    clearConfirmed: () => setConfirmed(null), clearClosedNotice: () => setClosedNotice(''),
    join: joinTable, orderOnMyOwn, ready,
  };
}
