import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MenuView from './MenuView';
import Glyph from '../media/Glyph';
import CartSheet from '../guest/CartSheet';
import DealSheet from '../guest/DealSheet';
import DishSheet from '../guest/DishSheet';
import FindUsSheet from '../guest/FindUsSheet';
import RequestDock from '../guest/RequestDock';
import WaiterCard from '../guest/WaiterCard';
import useCartStatus from '../guest/useCartStatus';
import useGuestCart from '../guest/useGuestCart';
import useMenuEvents from '../guest/events';
import { publicApi } from '../guest/guestApi';
import { formatKsh } from '../../lib/format';
import '../guest/guest.css';

/*
 * The whole guest experience over one public menu: the menu, dish and deal sheets, the order, "Ready to order",
 * "Find us", the request dock and insight events.
 * - variant "page" (the guest's phone): the cart is kept on the phone while browsing. "Ready to order" saves it
 *   (a waiter is called) and shows the code and QR; the phone then polls the cart until a waiter confirms the
 *   order with the guest ("Order confirmed ✓", and the cart resets) or the code expires. Requests go to the
 *   server; events are batched to /api/public/events.
 * - variant "preview" (the Studio): fully interactive inside its frame, but the cart lives in memory, nothing is
 *   sent (no carts, requests or events) and "Ready to order" explains what guests would see.
 */
export default function MenuExperience({ data, restaurantId, tableNumber, variant = 'page', afterHero, focusSection }) {
  const preview = variant === 'preview';
  const items = data?.items;
  const deals = data?.deals;
  const cart = useGuestCart(restaurantId, tableNumber, items, deals, { persist: !preview });
  const track = useMenuEvents(preview ? null : restaurantId, tableNumber);
  const itemsById = useMemo(() => new Map((items || []).map((item) => [item.id, item])), [items]);

  const [dish, setDish] = useState(null);
  const [deal, setDeal] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [saved, setSaved] = useState(null); // the last "Ready to order" response
  const [cardOpen, setCardOpen] = useState(false);
  const [outcome, setOutcome] = useState(null); // { kind: 'confirmed', confirmedBy, confirmedAt, orderShortId } | { kind: 'expired' }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null); // { text, undo? } inside the order sheet
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  useEffect(() => { if (!cartOpen) { setError(''); setNotice(null); } }, [cartOpen]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const say = useCallback((text) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const openItem = useCallback((item) => { setDish(item); track('dish_view', item.id); }, [track]);
  const openDeal = useCallback((value) => { setDeal(value); track('deal_view', value.id); }, [track]);
  const onVideoPlay = useCallback((item) => track('video_play', item.id), [track]);

  const menuCart = useMemo(() => ({
    plainQuantity: cart.plainQuantity, dealQuantity: cart.dealQuantity,
    add: (item) => cart.addItem(item),
    minus: (item) => cart.changeQuantity(cart.plainKey(item.id), -1),
    addDeal: (value) => { cart.addDeal(value); say(`${value.name} added to your order`); },
  }), [cart, say]);

  function addFromDish({ item, quantity, extraIds, note, pairs }) {
    cart.addItem(item, { quantity, extraIds, note });
    pairs.forEach((pair) => cart.addItem(pair));
    setDish(null);
    say(`${item.name}${pairs.length ? ` and ${pairs.length} more` : ''} added to your order`);
  }
  function addFromDeal({ deal: value, quantity, note }) {
    cart.addDeal(value, { quantity, note });
    setDeal(null);
    say(`${value.name} added to your order`);
  }

  // After "Ready to order": follow the code until a waiter confirms it with the guest, or it expires.
  const pendingCode = preview ? null : cart.snapshot.code;
  const status = useCartStatus(restaurantId, pendingCode, { enabled: Boolean(pendingCode) && !outcome });
  useEffect(() => {
    const data = status.data;
    if (!data || !pendingCode || data.code !== pendingCode) return;
    if (data.status === 'confirmed') {
      setOutcome({ kind: 'confirmed', confirmedBy: data.confirmedBy, confirmedAt: data.confirmedAt, orderShortId: data.orderShortId });
      cart.clear();
      setSaved(null);
      setCartOpen(false);
      setCardOpen(true);
    } else if (data.status === 'expired') {
      cart.forgetCode();
      setSaved(null);
      if (cardOpen) setOutcome({ kind: 'expired' });
      else say('Your code expired. Tap Ready to order again.');
    }
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // The code is gone (purged, or saved on another phone): quietly forget it.
  useEffect(() => {
    if (pendingCode && status.error?.status === 404) { cart.forgetCode(); setSaved(null); }
  }, [status.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeCard = () => { setCardOpen(false); setOutcome(null); };

  function clearOrder() {
    const snapshot = cart.snapshot;
    cart.clear();
    setSaved(null);
    setNotice({ text: 'Order cleared.', undo: () => { cart.restore(snapshot); setNotice(null); } });
  }

  /** "Ready to order": saves the cart (which calls a waiter) and shows the code and QR. */
  async function readyToOrder() {
    if (!cart.lines.length || busy) return;
    setError(''); setNotice(null);
    if (preview) { setNotice({ text: 'Here guests get a code and a QR, and a waiter is told the table is ready to order. Nothing is sent from the preview.' }); return; }
    // Unchanged and still valid for a while: just show the card again.
    if (cart.code && !cart.changedSinceSaved && saved?.code === cart.code && Date.parse(cart.expiresAt) - Date.now() > 5 * 60 * 1000) {
      setOutcome(null); setCartOpen(false); setCardOpen(true); return;
    }
    setBusy(true);
    try {
      const body = { restaurantId, ...(tableNumber ? { tableNumber } : {}), items: cart.payload(), ...(cart.code ? { code: cart.code } : {}) };
      const response = await publicApi('/api/public/carts', { method: 'POST', body });
      cart.markSaved(response);
      setSaved(response);
      setOutcome(null);
      setCartOpen(false);
      setCardOpen(true);
    } catch (saveError) {
      const details = saveError.details || {};
      const index = Number.isInteger(details.index) ? details.index : -1;
      const line = cart.rawLines[index];
      const lineName = line?.kind === 'deal' ? deals?.find((d) => d.id === line.dealId)?.name : itemsById.get(line?.itemId)?.name;
      if (saveError.status === 409 && details.reason === 'claimed') {
        cart.clear();
        setSaved(null);
        setError('Your waiter already confirmed that order. Your list is cleared, so you can start a new one for anything extra.');
      } else if (index >= 0 && details.extraId && ['extra_sold_out', 'extra_missing'].includes(details.reason)) {
        const extra = itemsById.get(line?.itemId)?.extras?.find((e) => e.id === details.extraId);
        cart.dropExtraAt(index, details.extraId);
        setError(`${extra?.name || 'An extra'} for ${lineName || 'a dish'} isn’t available any more. We took it off. Tap “Ready to order” again.`);
      } else if (index >= 0 && ['sold_out', 'missing', 'deal_unavailable'].includes(details.reason)) {
        cart.removeLineAt(index);
        setError(`${lineName || 'One line'} ${details.reason === 'missing' ? 'is no longer on the menu' : 'isn’t available right now'}. We took it off your order. Tap “Ready to order” again.`);
      } else {
        setError(saveError.message);
      }
      if (outcome?.kind === 'expired') { setOutcome(null); setCardOpen(false); setCartOpen(true); }
    } finally { setBusy(false); }
  }

  const overlayOpen = Boolean(dish || deal || cartOpen || findOpen);
  const showBar = cart.count > 0;
  const bottom = (tableNumber || showBar) && <div className={`gx-bottom${preview ? ' is-contained' : ''}`} inert={preview && overlayOpen ? true : undefined}>
    {showBar && <button type="button" className="gx-cartbar" onClick={() => (cart.code && !cart.changedSinceSaved && saved?.code === cart.code ? setCardOpen(true) : setCartOpen(true))} aria-haspopup="dialog">
      <span className="gx-cartbar-count" aria-hidden="true">{cart.count}</span>
      <span className="gx-cartbar-text">{cart.count} item{cart.count === 1 ? '' : 's'} · {formatKsh(cart.total)}</span>
      <span className="gx-cartbar-cta">{cart.code && !cart.changedSinceSaved ? 'Waiting for waiter' : 'View order'}<Glyph name="chevron" size={16} /></span>
    </button>}
    {tableNumber && (preview
      ? <div className="gx-requests is-preview" aria-label="Ask for service (preview)">{['Call waiter', 'Bill', 'Pay'].map((label) => <span key={label} className="gx-request">{label}</span>)}</div>
      : <RequestDock restaurantId={restaurantId} tableNumber={tableNumber} />)}
  </div>;

  const overlays = <>
    {bottom}
    <p className={`gx-toast${toast ? ' is-on' : ''}`} role="status" aria-live="polite">{toast && <><Glyph name="check" size={16} />{toast}</>}</p>
    <DishSheet key={`dish-${dish?.id || 'none'}`} item={dish} itemsById={itemsById} open={Boolean(dish)} onClose={() => setDish(null)} onAdd={addFromDish} onVideoPlay={onVideoPlay} contained={preview} />
    <DealSheet key={`deal-${deal?.id || 'none'}`} deal={deal} itemsById={itemsById} open={Boolean(deal)} onClose={() => setDeal(null)} onAdd={addFromDeal} contained={preview} />
    <CartSheet open={cartOpen} onClose={() => setCartOpen(false)} cart={cart} busy={busy} error={error} notice={notice?.text} onUndoClear={notice?.undo}
      onReady={readyToOrder} onClear={clearOrder} tableNumber={tableNumber} contained={preview} />
    <FindUsSheet open={findOpen} onClose={() => setFindOpen(false)} restaurant={data?.restaurant} contained={preview} />
    {!preview && <WaiterCard saved={cardOpen ? saved : null} outcome={cardOpen ? outcome : null} restaurantName={data?.restaurant?.name} busy={busy}
      onClose={closeCard} onEdit={() => { setCardOpen(false); setCartOpen(true); }} onReadyAgain={readyToOrder} />}
  </>;

  return <div className={`mx mx-${variant}${tableNumber ? ' has-dock' : ''}${showBar ? ' has-cart' : ''}`}>
    <MenuView
      variant={variant} restaurant={data?.restaurant} categories={data?.categories} items={items} featuredItemIds={data?.featuredItemIds}
      deals={deals} design={data?.design} tableNumber={tableNumber} afterHero={afterHero} focusSection={focusSection}
      cart={menuCart} onOpenItem={openItem} onOpenDeal={openDeal} onVideoPlay={onVideoPlay}
      onOrderNow={() => setCartOpen(true)} onFindUs={() => setFindOpen(true)}
      overlays={overlays} overlayOpen={overlayOpen}
    />
  </div>;
}
