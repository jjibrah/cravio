import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';

/*
 * The full menu for staff, sold-out dishes included. Members can read their restaurant's categories and items
 * directly (row-level security: menu_*_read), which avoids the public menu endpoint (it hides sold-out dishes and
 * counts a guest scan). Video columns are asked for when present and skipped otherwise.
 * Extras and deals (migration 004) are read the same way; before 004 they're simply empty.
 */

const BASE = 'id, category_id, name, description, price, currency, photo_url, available, position';
const cache = new Map();

const toItem = (row) => ({
  id: row.id, categoryId: row.category_id, name: row.name, description: row.description, price: Number(row.price), currency: row.currency || 'KES',
  photoUrl: row.photo_url, available: row.available !== false, position: row.position, videoPosterUrl: row.video_poster_url || null,
});

/** Rows of a merchandising table, or [] when it isn't there yet (before migration 004) or can't be read. */
async function optional(query) {
  const { data, error } = await query;
  return error ? [] : data || [];
}

/** A deal as staff see it: dishes with today's prices, the regular price, and whether it can be ordered now. */
function toDeal(row, parts, itemsById, now = Date.now()) {
  const items = parts.filter((part) => part.deal_id === row.id).sort((a, b) => a.position - b.position).map((part) => {
    const item = itemsById.get(part.item_id);
    return { itemId: part.item_id, name: item?.name || 'Removed dish', quantity: part.quantity, unitPrice: Number(item?.price || 0), available: Boolean(item?.available) };
  });
  const regularPrice = items.reduce((sum, part) => sum + part.unitPrice * part.quantity, 0);
  const units = items.reduce((sum, part) => sum + part.quantity, 0);
  const started = !row.starts_at || Date.parse(row.starts_at) <= now;
  const notEnded = !row.ends_at || Date.parse(row.ends_at) > now;
  const soldOut = items.find((part) => !part.available);
  const unavailableReason = !row.active ? 'Not active' : !started ? 'Not started yet' : !notEnded ? 'Ended' : units < 2 ? 'Missing dishes' : soldOut ? `${soldOut.name} is sold out` : null;
  return {
    id: row.id, kind: 'deal', name: row.name, description: row.description, price: Number(row.price), currency: row.currency || 'KES',
    items, regularPrice, saving: Math.max(0, regularPrice - Number(row.price)), available: !unavailableReason, unavailableReason, position: row.position,
  };
}

async function fetchMenu(restaurantId) {
  const [categories, itemsWithVideo, extras, deals, dealItems] = await Promise.all([
    supabase.from('menu_categories').select('id, name, position').eq('restaurant_id', restaurantId).order('position'),
    supabase.from('menu_items').select(`${BASE}, video_poster_url`).eq('restaurant_id', restaurantId).order('position'),
    optional(supabase.from('menu_item_extras').select('id, item_id, name, price, position, available').eq('restaurant_id', restaurantId).order('position')),
    optional(supabase.from('menu_deals').select('id, name, description, price, currency, active, starts_at, ends_at, position').eq('restaurant_id', restaurantId).order('position')),
    optional(supabase.from('menu_deal_items').select('deal_id, item_id, quantity, position').eq('restaurant_id', restaurantId)),
  ]);
  if (categories.error) throw new Error('We couldn’t load the menu. Pull to refresh or try again.');
  let items = itemsWithVideo;
  if (items.error) items = await supabase.from('menu_items').select(BASE).eq('restaurant_id', restaurantId).order('position');
  if (items.error) throw new Error('We couldn’t load the menu. Try again.');
  const list = items.data.map((row) => ({
    ...toItem(row),
    extras: extras.filter((extra) => extra.item_id === row.id).map((extra) => ({ id: extra.id, name: extra.name, price: Number(extra.price), available: extra.available !== false })),
  }));
  const byId = new Map(list.map((item) => [item.id, item]));
  return { categories: categories.data, items: list, deals: deals.map((row) => toDeal(row, dealItems, byId)) };
}

export default function useStaffMenu() {
  const { account } = useAuth();
  const restaurantId = account?.place?.id;
  const [state, setState] = useState(() => (restaurantId && cache.has(restaurantId) ? { status: 'ready', ...cache.get(restaurantId) } : { status: 'loading' }));
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!restaurantId || !supabase) { setState({ status: 'error', error: 'Your restaurant isn’t set up yet.' }); return undefined; }
    let live = true;
    fetchMenu(restaurantId)
      .then((menu) => { cache.set(restaurantId, menu); if (live) setState({ status: 'ready', ...menu }); })
      .catch((error) => { if (live) setState((current) => (current.status === 'ready' ? current : { status: 'error', error: error.message })); });
    return () => { live = false; };
  }, [restaurantId, attempt]);

  return { ...state, reload, restaurantId };
}
