import { useEffect, useRef, useState } from 'react';
import { formatKsh } from '../../lib/format';

/* Cards for the guest menu: dishes (tile, row or text), featured photo cards and deal cards, with lazy media. */

export const prefersReducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const monogram = (name) => [...(name?.trim() || '·')][0].toUpperCase();
const plusIcon = <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
const minusIcon = <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>;

/** Videos wait for a tap when the guest asked for less motion or less data. */
function autoplayAllowed() {
  if (typeof window === 'undefined') return false;
  if (prefersReducedMotion()) return false;
  return !navigator.connection?.saveData;
}

/** An <img> that falls back (to a monogram tile) if it fails. Lazy and async unless `eager`. */
export function Img({ src, alt = '', className, fallback = null, eager = false, sizes, width, height }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return fallback;
  return <img className={className} src={src} alt={alt} sizes={sizes} width={width} height={height}
    loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined} onError={() => setFailed(true)} />;
}

export function PlayBadge() {
  return <span className="mv-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" /></svg></span>;
}

/**
 * A dish video in a card: poster first, then muted, inline and looped while mostly on screen. Loads nothing until
 * near the viewport (or the preview's scroller), pauses off screen. `onStarted` fires when it actually plays.
 */
function DishVideo({ item, onStarted, sizes }) {
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  const inView = useRef(false);
  const started = useRef(false);
  const poster = item.videoPosterUrl || item.photoUrl || undefined;
  const tryPlay = () => { const video = videoRef.current; if (video && inView.current && autoplayAllowed()) video.play().catch(() => {}); };

  useEffect(() => {
    const element = wrapRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const nearObserver = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setNear(true); }, { rootMargin: '300px' });
    const viewObserver = new IntersectionObserver(([entry]) => {
      const video = videoRef.current;
      inView.current = entry.isIntersecting && entry.intersectionRatio >= 0.6;
      if (!video) return;
      if (inView.current) tryPlay();
      else if (!video.paused) video.pause();
    }, { threshold: [0, 0.6, 1] });
    nearObserver.observe(element);
    viewObserver.observe(element);
    return () => { nearObserver.disconnect(); viewObserver.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <span ref={wrapRef} className={`mv-dish-photo is-video${playing ? ' is-playing' : ''}`}>
    {poster && <img className="mv-video-poster" src={poster} alt="" sizes={sizes} loading="lazy" decoding="async" />}
    <video
      ref={videoRef} className="mv-video" muted playsInline loop preload={near ? 'auto' : 'none'} poster={poster}
      src={near ? item.videoUrl : undefined} aria-hidden="true" tabIndex={-1} disablePictureInPicture
      onCanPlay={tryPlay}
      onPlaying={() => { setPlaying(true); if (!started.current) { started.current = true; onStarted?.(item); } }}
      onPause={() => setPlaying(false)}
    />
    {!playing && <PlayBadge />}
  </span>;
}

/** Photo, video or monogram for a dish. Previews show the poster and a play badge, never a playing video. */
export function DishMedia({ item, preview, onVideoPlay, sizes, eager }) {
  const fallback = <span className="mv-dish-photo is-empty" aria-hidden="true"><span>{monogram(item.name)}</span></span>;
  if (item.videoUrl && !preview) return <DishVideo item={item} onStarted={onVideoPlay} sizes={sizes} />;
  if (item.videoUrl) {
    const poster = item.videoPosterUrl || item.photoUrl;
    return <span className="mv-dish-photo is-video">
      {poster ? <img className="mv-video-poster" src={poster} alt="" loading="lazy" decoding="async" /> : <span className="mv-monogram" aria-hidden="true">{monogram(item.name)}</span>}
      <PlayBadge />
    </span>;
  }
  return <Img className="mv-dish-photo" src={item.photoUrl} alt="" sizes={sizes} eager={eager} fallback={fallback} />;
}

/** "+" that becomes a − n + stepper once the dish (without extras) is in the order. */
export function QuickAdd({ name, quantity, onAdd, onMinus, max = 20, size = 'md' }) {
  if (!quantity) {
    return <button type="button" className={`mv-add is-${size}`} aria-label={`Add ${name}`} onClick={onAdd}>{plusIcon}</button>;
  }
  return <div className={`mv-stepper is-${size}`} role="group" aria-label={`${name} in your order`}>
    <button type="button" aria-label={quantity === 1 ? `Remove ${name}` : `One less ${name}`} onClick={onMinus}>{minusIcon}</button>
    <output aria-live="polite" aria-label={`${quantity} ${name} in your order`}>{quantity}</output>
    <button type="button" aria-label={`One more ${name}`} onClick={onAdd} disabled={quantity >= max}>{plusIcon}</button>
  </div>;
}

/**
 * One dish. `shape`: 'tile' (photo on top), 'row' (photo beside) or 'text' (no photo).
 * With `onOpen` the whole card opens the dish sheet (one real button, stretched over the card); with `cart`
 * it gets a quick add ({ quantity, add, minus }).
 */
export function DishCard({ item, shape = 'tile', showDescription = true, headingLevel = 3, preview, onOpen, cart, onVideoPlay, sizes }) {
  const Name = `h${headingLevel}`;
  const soldOut = item.available === false;
  const hasMedia = Boolean(item.photoUrl || item.videoUrl || item.videoPosterUrl);
  const quick = cart && !soldOut ? <QuickAdd name={item.name} quantity={cart.quantity} onAdd={cart.add} onMinus={cart.minus} size={shape === 'tile' ? 'md' : 'sm'} /> : null;
  const media = shape === 'text' ? null : shape === 'row' && !hasMedia ? null
    : <div className="mv-card-media"><DishMedia item={item} preview={preview} onVideoPlay={onVideoPlay} sizes={sizes} />{shape === 'tile' && quick}</div>;
  return <li className={`mv-card is-${shape}${soldOut ? ' is-sold-out' : ''}${onOpen ? ' is-openable' : ''}${cart?.quantity ? ' is-in-cart' : ''}`} data-item={item.id}>
    {shape === 'tile' && media}
    <div className="mv-card-body">
      <Name className="mv-card-name">{onOpen
        ? <button type="button" className="mv-card-open" onClick={() => onOpen(item)} aria-haspopup="dialog">{item.name}</button>
        : item.name}</Name>
      <p className="mv-card-price">
        <span className={soldOut ? 'mv-price-struck' : undefined}>{formatKsh(item.price, item.currency)}</span>
        {soldOut && <span className="mv-sold-out">Sold out</span>}
        {item.videoUrl && shape === 'text' && <span className="mv-tag">Video</span>}
      </p>
      {showDescription && item.description && <p className="mv-card-desc">{item.description}</p>}
    </div>
    {shape !== 'tile' && (media || quick) && <div className="mv-card-side">{media}{quick}</div>}
  </li>;
}

/** A large photo card for the Featured carousel: name and price over a soft gradient. */
export function FeaturedCard({ item, headingLevel = 3, preview, onOpen, onVideoPlay, eager }) {
  const Name = `h${headingLevel}`;
  return <li className={`mv-feature${onOpen ? ' is-openable' : ''}`} data-item={item.id}>
    <div className="mv-feature-media"><DishMedia item={item} preview={preview} onVideoPlay={onVideoPlay} eager={eager} sizes="(min-width: 900px) 280px, 46vw" /></div>
    <div className="mv-feature-text">
      <Name className="mv-feature-name">{onOpen
        ? <button type="button" className="mv-card-open" onClick={() => onOpen(item)} aria-haspopup="dialog">{item.name}</button>
        : item.name}</Name>
      <p className="mv-feature-price">{formatKsh(item.price, item.currency)}</p>
    </div>
  </li>;
}

/** Up to three overlapping dish photos (or the deal's own photo, or initials) for a deal card. */
export function DealPhotos({ deal, size = 'md' }) {
  if (deal.photoUrl) return <span className={`mv-deal-photos is-${size} is-single`}><Img className="mv-deal-photo" src={deal.photoUrl} alt="" /></span>;
  const urls = (deal.photoUrls?.length ? deal.photoUrls : (deal.items || []).map((part) => part.photoUrl).filter(Boolean)).slice(0, 3);
  if (!urls.length) {
    return <span className={`mv-deal-photos is-${size} is-empty`} aria-hidden="true">
      {(deal.items || []).slice(0, 3).map((part) => <span key={part.itemId} className="mv-deal-initial">{monogram(part.name)}</span>)}
    </span>;
  }
  return <span className={`mv-deal-photos is-${size} has-${urls.length}`} aria-hidden="true">
    {urls.map((url) => <Img key={url} className="mv-deal-photo" src={url} alt="" />)}
  </span>;
}

/** A deal: photos, name, what's in it, deal price, the regular price struck through, "Save Ksh X", and a round "+". */
export function DealCard({ deal, headingLevel = 3, onOpen, onAdd, quantity = 0, as: Tag = 'li', showDescription = true }) {
  const Name = `h${headingLevel}`;
  const summary = deal.description || (deal.items || []).map((part) => (part.quantity > 1 ? `${part.quantity}× ${part.name}` : part.name)).join(', ');
  return <Tag className={`mv-deal${onOpen ? ' is-openable' : ''}`} data-deal={deal.id}>
    <DealPhotos deal={deal} />
    <div className="mv-deal-body">
      <Name className="mv-deal-name">{onOpen
        ? <button type="button" className="mv-card-open" onClick={() => onOpen(deal)} aria-haspopup="dialog">{deal.name}</button>
        : deal.name}</Name>
      {showDescription && summary && <p className="mv-deal-desc">{summary}</p>}
      <p className="mv-deal-prices">
        <strong>{formatKsh(deal.price, deal.currency)}</strong>
        {deal.saving > 0 && <s aria-label={`Regular price ${formatKsh(deal.regularPrice, deal.currency)}`}>{formatKsh(deal.regularPrice, deal.currency)}</s>}
      </p>
      {deal.saving > 0 && <p className="mv-save">Save {formatKsh(deal.saving, deal.currency)}</p>}
    </div>
    {onAdd && <button type="button" className={`mv-add is-round${quantity ? ' has-count' : ''}`} aria-label={quantity ? `Add another ${deal.name} (${quantity} in your order)` : `Add ${deal.name}`} onClick={() => onAdd(deal)}>
      {quantity ? <span className="mv-add-count" aria-hidden="true">{quantity}</span> : plusIcon}
    </button>}
  </Tag>;
}
