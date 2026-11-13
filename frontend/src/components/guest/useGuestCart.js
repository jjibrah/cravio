import { useCallback, useEffect, useMemo, useState } from 'react';
import { readJson, writeJson } from './guestApi';

/*
 * The guest's order, kept on the phone (localStorage per restaurant and table, or memory only for previews).
 * A line is a dish with its chosen extras ({ kind: 'item', itemId, extraIds, quantity, note }) or a deal
 * ({ kind: 'deal', dealId, quantity, note }). The same dish with different extras is a separate line.
 * After "Ready to order" it also remembers the cart code, its expiry and what was saved, so the page knows when
 * the order changed and must be saved again (keeping the same code where the API allows).
 *
 * Carts saved before extras and deals ({ lines: [{ itemId, quantity, note }] }) are read as plain dish lines.
 */

const MAX_QTY = 20;
const MAX_LINES = 30;
const VERSION = 2;
const keyFor = (restaurantId, table) => `cravio-cart:${restaurantId}:${table || 'none'}`;
const empty = { v: VERSION, lines: [], code: null, expiresAt: null, saved: null };

export const lineKey = (line) => (line.kind === 'deal' ? `d:${line.dealId}` : `i:${line.itemId}:${[...(line.extraIds || [])].sort().join(',')}`);
const signature = (lines) => JSON.stringify(lines.map((line) => [lineKey(line), line.quantity, line.note || '']));

/** Reads a stored cart of any version into the current shape. */
export function migrateCart(stored) {
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.lines)) return { ...empty };
  const lines = stored.lines.map((line) => {
    if (!line || typeof line !== 'object') return null;
    const quantity = Math.max(1, Math.min(MAX_QTY, Math.round(Number(line.quantity) || 1)));
    const note = typeof line.note === 'string' ? line.note.slice(0, 140) : '';
    if (line.kind === 'deal' && line.dealId) return { kind: 'deal', dealId: line.dealId, quantity, note };
    if (!line.itemId) return null;
    const extraIds = Array.isArray(line.extraIds) ? [...new Set(line.extraIds.filter((id) => typeof id === 'string'))].slice(0, 10) : [];
    return { kind: 'item', itemId: line.itemId, extraIds, quantity, note };
  }).filter(Boolean);
  // Merge lines that became identical (e.g. two old lines for one dish).
  const merged = [];
  for (const line of lines) {
    const same = merged.find((other) => lineKey(other) === lineKey(line));
    if (same) same.quantity = Math.min(MAX_QTY, same.quantity + line.quantity);
    else merged.push(line);
  }
  const version = stored.v === VERSION;
  return {
    v: VERSION, lines: merged.slice(0, MAX_LINES),
    code: typeof stored.code === 'string' ? stored.code : null,
    expiresAt: typeof stored.expiresAt === 'string' ? stored.expiresAt : null,
    // An old cart's saved signature can't be compared: treat it as changed, so "Ready to order" saves it again.
    saved: version ? stored.saved ?? null : null,
  };
}

const memory = new Map();
const load = (key, persist) => (persist ? migrateCart(readJson(key, null)) : memory.get(key) || { ...empty });

/**
 * @param items the menu's dishes (available ones); lines for dishes no longer there drop out.
 * @param deals the menu's deals; likewise.
 * @param persist false for previews: kept in memory, never written to the phone.
 */
export default function useGuestCart(restaurantId, table, items, deals, { persist = true } = {}) {
  const key = keyFor(restaurantId, table);
  const [state, setState] = useState(() => ({ key, cart: load(key, persist) }));
  // A different restaurant or table: load its cart (during render, so the old cart is never written under the new key).
  if (state.key !== key) setState({ key, cart: load(key, persist) });
  const cart = state.key === key ? state.cart : load(key, persist);
  const setCart = useCallback((fn) => setState((current) => ({ ...current, cart: typeof fn === 'function' ? fn(current.cart) : fn })), []);
  useEffect(() => {
    if (!restaurantId) return;
    const value = state.cart.lines.length || state.cart.code ? state.cart : null;
    if (persist) writeJson(state.key, value);
    else if (value) memory.set(state.key, value); else memory.delete(state.key);
  }, [state, restaurantId, persist]);

  const itemsById = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);
  const dealsById = useMemo(() => new Map((deals || []).map((deal) => [deal.id, deal])), [deals]);

  // Dishes, deals and extras that left the menu drop out once the menu is known.
  useEffect(() => {
    if (!items) return;
    setCart((current) => {
      let changed = false;
      const lines = [];
      for (const line of current.lines) {
        if (line.kind === 'deal') {
          if (dealsById.has(line.dealId)) lines.push(line); else changed = true;
          continue;
        }
        const item = itemsById.get(line.itemId);
        if (!item) { changed = true; continue; }
        const available = new Set((item.extras || []).map((extra) => extra.id));
        const extraIds = line.extraIds.filter((id) => available.has(id));
        if (extraIds.length !== line.extraIds.length) { changed = true; lines.push({ ...line, extraIds }); } else lines.push(line);
      }
      return changed ? { ...current, lines } : current;
    });
  }, [items, itemsById, dealsById, setCart]);

  const update = useCallback((fn) => setCart((current) => {
    const lines = fn(current.lines).filter((line) => line.quantity > 0).slice(0, MAX_LINES);
    return { ...current, lines };
  }), [setCart]);

  /** Adds a dish (optionally with extras and a note) or merges into the identical line. */
  const addItem = useCallback((item, { quantity = 1, extraIds = [], note } = {}) => update((lines) => {
    const line = { kind: 'item', itemId: item.id, extraIds: [...new Set(extraIds)], quantity: 0, note: '' };
    const existing = lines.find((other) => lineKey(other) === lineKey(line));
    if (existing) return lines.map((other) => other === existing ? { ...other, quantity: Math.min(MAX_QTY, other.quantity + quantity), note: note ? note.slice(0, 140) : other.note } : other);
    return [...lines, { ...line, quantity: Math.min(MAX_QTY, quantity), note: (note || '').slice(0, 140) }];
  }), [update]);
  const addDeal = useCallback((deal, { quantity = 1, note } = {}) => update((lines) => {
    const existing = lines.find((other) => other.kind === 'deal' && other.dealId === deal.id);
    if (existing) return lines.map((other) => other === existing ? { ...other, quantity: Math.min(MAX_QTY, other.quantity + quantity), note: note ? note.slice(0, 140) : other.note } : other);
    return [...lines, { kind: 'deal', dealId: deal.id, quantity: Math.min(MAX_QTY, quantity), note: (note || '').slice(0, 140) }];
  }), [update]);
  const changeQuantity = useCallback((key, delta) => update((lines) => lines.map((line) => lineKey(line) === key ? { ...line, quantity: Math.min(MAX_QTY, line.quantity + delta) } : line)), [update]);
  const setNote = useCallback((key, note) => update((lines) => lines.map((line) => lineKey(line) === key ? { ...line, note: (note || '').slice(0, 140) } : line)), [update]);
  const removeLineAt = useCallback((index) => update((lines) => lines.filter((_, i) => i !== index)), [update]);
  const dropExtraAt = useCallback((index, extraId) => update((lines) => lines.map((line, i) => i === index && line.kind === 'item' ? { ...line, extraIds: line.extraIds.filter((id) => id !== extraId) } : line)), [update]);
  const clear = useCallback(() => setCart({ ...empty }), [setCart]);
  const restore = useCallback((snapshot) => setCart(snapshot), [setCart]);
  const markSaved = useCallback((response) => setCart((current) => ({ ...current, code: response.code, expiresAt: response.expiresAt, saved: signature(current.lines) })), [setCart]);
  const forgetCode = useCallback(() => setCart((current) => ({ ...current, code: null, expiresAt: null, saved: null })), [setCart]);

  const plainKey = (itemId) => `i:${itemId}:`;
  const plainQuantity = useCallback((itemId) => cart.lines.find((line) => lineKey(line) === plainKey(itemId))?.quantity || 0, [cart.lines]);
  const itemQuantity = useCallback((itemId) => cart.lines.reduce((sum, line) => sum + (line.kind === 'item' && line.itemId === itemId ? line.quantity : 0), 0), [cart.lines]);
  const dealQuantity = useCallback((dealId) => cart.lines.find((line) => line.kind === 'deal' && line.dealId === dealId)?.quantity || 0, [cart.lines]);

  // Lines with their dish or deal, extras and prices, for display. Lines whose dish or deal isn't known yet are hidden.
  const lines = useMemo(() => cart.lines.map((line) => {
    if (line.kind === 'deal') {
      const deal = dealsById.get(line.dealId);
      if (!deal) return null;
      const unitTotal = Number(deal.price || 0);
      return { ...line, key: lineKey(line), name: deal.name, deal, extras: [], unitTotal, lineTotal: unitTotal * line.quantity, components: deal.items || [] };
    }
    const item = itemsById.get(line.itemId);
    if (!item) return null;
    const extras = line.extraIds.map((id) => (item.extras || []).find((extra) => extra.id === id)).filter(Boolean);
    const unitTotal = Number(item.price || 0) + extras.reduce((sum, extra) => sum + Number(extra.price || 0), 0);
    return { ...line, key: lineKey(line), name: item.name, item, extras, unitTotal, lineTotal: unitTotal * line.quantity };
  }).filter(Boolean), [cart.lines, itemsById, dealsById]);

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const codeValid = Boolean(cart.code && cart.expiresAt && Date.parse(cart.expiresAt) > Date.now());
  const changedSinceSaved = cart.saved !== signature(cart.lines);

  /** The lines as POST /api/public/carts wants them, in stored order (server error indexes refer to this order). */
  const payload = useCallback(() => cart.lines.map((line) => (line.kind === 'deal'
    ? { dealId: line.dealId, quantity: line.quantity, ...(line.note ? { note: line.note } : {}) }
    : { itemId: line.itemId, quantity: line.quantity, ...(line.extraIds.length ? { extraIds: line.extraIds } : {}), ...(line.note ? { note: line.note } : {}) })), [cart.lines]);

  return {
    lines, rawLines: cart.lines, snapshot: cart, count, total, code: codeValid ? cart.code : null, expiresAt: codeValid ? cart.expiresAt : null, changedSinceSaved,
    addItem, addDeal, changeQuantity, setNote, removeLineAt, dropExtraAt, clear, restore, markSaved, forgetCode, payload,
    plainQuantity, itemQuantity, dealQuantity, plainKey,
  };
}
