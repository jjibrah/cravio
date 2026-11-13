import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { DEFAULT_DESIGN, designKey, normalizeDesign, resolveDesign } from '../../lib/menu-design';

/*
 * The Studio's state: what's published, the draft being edited (with undo and redo), the autosaved copy of an
 * unpublished draft on this device, and the menu the live preview renders (in the public menu's shape).
 */

const HISTORY = 100;
const COALESCE_MS = 900;
const draftKey = (restaurantId) => `cravio-studio-draft:${restaurantId}`;

function history(state, action) {
  switch (action.type) {
    case 'load': return { past: [], present: action.design, future: [], tag: null, at: 0 };
    case 'set': {
      if (designKey(action.design) === designKey(state.present)) return state;
      const now = Date.now();
      // Typing in one field (or dragging one colour) is one undo step.
      if (action.tag && action.tag === state.tag && now - state.at < COALESCE_MS) return { ...state, present: action.design, future: [], at: now };
      return { past: [...state.past, state.present].slice(-HISTORY), present: action.design, future: [], tag: action.tag || null, at: now };
    }
    case 'apply': return history(state, { type: 'set', design: action.fn(state.present), tag: action.tag });
    case 'replace': return { ...state, present: action.design };
    case 'undo': {
      if (!state.past.length) return state;
      return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future], tag: null, at: 0 };
    }
    case 'redo': {
      if (!state.future.length) return state;
      return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1), tag: null, at: 0 };
    }
    default: return state;
  }
}

/** The owner's menu (GET /api/restaurant/menu) as guests get it: available dishes, extras and pairings; live deals only. */
export function guestMenuFrom(onboarding, merch) {
  const source = merch?.items || onboarding?.items || [];
  const available = source.filter((item) => item.available !== false);
  const ids = new Set(available.map((item) => item.id));
  const items = available.map((item) => ({
    ...item,
    extras: (item.extras || []).filter((extra) => extra.available !== false).map(({ id, name, price }) => ({ id, name, price })),
    pairedItemIds: (item.pairedItemIds || []).filter((id) => ids.has(id)).slice(0, 6),
    featured: Boolean(item.featured),
  }));
  const featuredItemIds = (merch?.featuredItemIds || items.filter((item) => item.featured).map((item) => item.id)).filter((id) => ids.has(id));
  const deals = (merch?.deals || []).filter((deal) => deal.visibleToGuests ?? deal.status === 'live');
  return { categories: merch?.categories || onboarding?.categories || [], items, featuredItemIds, deals };
}

export default function useStudio() {
  const [load, setLoad] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [published, setPublished] = useState(null);
  const [state, dispatch] = useReducer(history, { past: [], present: null, future: [], tag: null, at: 0 });
  const [restored, setRestored] = useState(null); // ISO time of a restored draft
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [publishedAt, setPublishedAt] = useState(null);
  const restaurantId = load.onboarding?.restaurant?.id;

  useEffect(() => {
    let live = true;
    setLoad((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    Promise.all([
      api('/api/restaurant/onboarding'),
      api('/api/restaurant/menu').catch(() => null), // before migration 004: preview without merchandising
      api('/api/restaurant/menu-design').catch((error) => (error.status === 503 ? null : Promise.reject(error))),
    ]).then(([onboarding, merch, designResponse]) => {
      if (!live) return;
      const saved = normalizeDesign(designResponse?.design || DEFAULT_DESIGN);
      setPublished(saved);
      let present = saved;
      try {
        const stored = JSON.parse(localStorage.getItem(draftKey(onboarding.restaurant.id)) || 'null');
        if (stored?.base === designKey(saved) && stored.design && designKey(stored.design) !== designKey(saved)) {
          present = normalizeDesign(stored.design);
          setRestored(stored.at || new Date().toISOString());
        }
      } catch { /* storage blocked */ }
      dispatch({ type: 'load', design: present });
      setLoad({ status: 'ready', onboarding, merch, designAvailable: Boolean(designResponse), options: designResponse?.options || null });
    }).catch((error) => { if (live) setLoad({ status: 'error', error }); });
    return () => { live = false; };
  }, [attempt]);

  const draft = state.present;
  const dirty = Boolean(draft && published) && designKey(draft) !== designKey(published);

  // Autosave the unpublished draft on this device (and forget it once published or undone back).
  useEffect(() => {
    if (!restaurantId || !draft || !published) return undefined;
    const timer = setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(draftKey(restaurantId), JSON.stringify({ design: draft, base: designKey(published), at: new Date().toISOString() }));
        else localStorage.removeItem(draftKey(restaurantId));
      } catch { /* storage blocked: the draft lives in memory */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, published, dirty, restaurantId]);

  const set = useCallback((design, tag) => dispatch({ type: 'set', design, tag }), []);
  const update = useCallback((fn, tag) => {
    // Read the latest present through the reducer so rapid edits never lose each other.
    dispatch({ type: 'apply', fn, tag });
  }, []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback(() => set({ ...normalizeDesign(DEFAULT_DESIGN) }, 'reset'), [set]);
  const discard = useCallback(() => { if (published) { set(published, 'discard'); setRestored(null); } }, [published, set]);

  const setRestaurant = useCallback((patch) => setLoad((current) => ({ ...current, onboarding: { ...current.onboarding, restaurant: { ...current.onboarding.restaurant, ...patch } } })), []);

  const publish = useCallback(async () => {
    if (!draft || publishing) return false;
    setPublishing(true); setPublishError('');
    try {
      const response = await api('/api/restaurant/menu-design', { method: 'PUT', body: { design: draft } });
      const saved = normalizeDesign(response.design);
      setPublished(saved);
      dispatch({ type: 'replace', design: saved });
      setPublishedAt(new Date());
      setRestored(null);
      if (saved.theme) setRestaurant({ theme: saved.theme });
      try { localStorage.removeItem(draftKey(restaurantId)); } catch { /* ignore */ }
      return true;
    } catch (error) {
      setPublishError(error.message);
      return false;
    } finally { setPublishing(false); }
  }, [draft, publishing, restaurantId, setRestaurant]);

  const restaurant = load.onboarding?.restaurant;
  const menu = useMemo(() => (load.status === 'ready' ? guestMenuFrom(load.onboarding, load.merch) : null), [load]);
  const resolved = useMemo(() => (draft && menu ? resolveDesign(draft, { theme: restaurant?.theme, categories: menu.categories }) : null), [draft, menu, restaurant?.theme]);
  const preview = useMemo(() => (menu && resolved ? { restaurant, ...menu, design: resolved } : null), [menu, resolved, restaurant]);

  return {
    load, retry: () => setAttempt((n) => n + 1), restaurant, menu, draft, published, resolved, preview, dirty,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
    set, update, undo, redo, reset, discard, publish, publishing, publishError, publishedAt, restored, dismissRestored: () => setRestored(null), setRestaurant,
  };
}
