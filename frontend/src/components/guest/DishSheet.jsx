import { useId, useMemo, useState } from 'react';
import GuestSheet from '../menu/GuestSheet';
import { Img, prefersReducedMotion } from '../menu/MenuCards';
import Glyph from '../media/Glyph';
import { formatKsh } from '../../lib/format';

/** − n + in the restaurant's look. */
export function QtyStepper({ value, onChange, min = 1, max = 20, label }) {
  return <div className="gx-qty" role="group" aria-label={label}>
    <button type="button" aria-label="One less" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}><Glyph name="minus" size={18} /></button>
    <output aria-live="polite">{value}</output>
    <button type="button" aria-label="One more" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}><Glyph name="plus" size={18} /></button>
  </div>;
}

/** Optional note for the kitchen: a quiet button until the guest wants it. */
export function KitchenNote({ value, onChange, open, onOpen }) {
  const id = useId();
  if (!open) return <button type="button" className="gx-note-button" onClick={onOpen}><Glyph name="note" size={14} />Add a note for the kitchen</button>;
  return <div className="gx-field">
    <label htmlFor={id}><Glyph name="note" size={15} />Note for the kitchen <span>(optional)</span></label>
    <textarea id={id} rows={2} maxLength={140} value={value} autoFocus onChange={(event) => onChange(event.target.value)} placeholder="e.g. No onions, extra spicy" />
  </div>;
}

/**
 * A dish up close: big photo or video, name, price, description, "Goes well with" (extras that change this line,
 * and paired dishes that are added as their own lines), a note, a quantity, and "Add to order · Ksh total".
 * Render it with key={item.id} so each dish starts fresh.
 */
export default function DishSheet({ item, itemsById, open, onClose, onAdd, onVideoPlay, contained }) {
  const titleId = useId();
  const [quantity, setQuantity] = useState(1);
  const [extraIds, setExtraIds] = useState(() => new Set());
  const [pairIds, setPairIds] = useState(() => new Set());
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const extras = item?.extras || [];
  const pairs = useMemo(() => (item?.pairedItemIds || []).map((id) => itemsById?.get(id)).filter(Boolean).slice(0, 6), [item, itemsById]);
  const extrasTotal = extras.filter((extra) => extraIds.has(extra.id)).reduce((sum, extra) => sum + Number(extra.price || 0), 0);
  const pairsTotal = pairs.filter((pair) => pairIds.has(pair.id)).reduce((sum, pair) => sum + Number(pair.price || 0), 0);
  const total = item ? (Number(item.price || 0) + extrasTotal) * quantity + pairsTotal : 0;
  const toggle = (setter, id) => setter((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const poster = item?.videoPosterUrl || item?.photoUrl || undefined;
  const added = pairIds.size ? ` + ${pairIds.size} more` : '';

  const footer = item && <div className="gx-add-bar">
    <QtyStepper value={quantity} onChange={setQuantity} label={`How many ${item.name}`} />
    <button type="button" className="gx-primary gx-add" onClick={() => onAdd({ item, quantity, extraIds: [...extraIds], note: note.trim(), pairs: pairs.filter((pair) => pairIds.has(pair.id)) })}>
      Add to order · {formatKsh(total, item.currency)}<span className="visually-hidden">{added}</span>
    </button>
  </div>;

  return <GuestSheet open={open && Boolean(item)} onClose={onClose} labelledBy={titleId} contained={contained} className="gx-dish-sheet" footer={footer}>
    {item && <article className="gx-dish">
      <div className={`gx-dish-media${item.videoUrl ? ' is-video' : ''}${!item.videoUrl && !item.photoUrl ? ' is-empty' : ''}`}>
        {item.videoUrl
          ? <video src={item.videoUrl} poster={poster} controls playsInline loop muted autoPlay={!contained && !prefersReducedMotion()} aria-label={`Video of ${item.name}`}
            onPlaying={() => onVideoPlay?.(item)} />
          : item.photoUrl ? <Img src={item.photoUrl} alt={`Photo of ${item.name}`} eager /> : <span className="gx-dish-monogram" aria-hidden="true">{[...item.name][0]}</span>}
        <button type="button" className="gx-media-close" onClick={onClose} aria-label="Close"><Glyph name="close" size={18} /></button>
      </div>
      <div className="gx-dish-head">
        <h2 id={titleId} className="gx-dish-name">{item.name}</h2>
        <p className="gx-dish-price">{formatKsh(item.price, item.currency)}</p>
        {item.description && <p className="gx-dish-desc">{item.description}</p>}
      </div>

      {(extras.length > 0 || pairs.length > 0) && <section className="gx-goes" aria-labelledby={`${titleId}-g`}>
        <h3 id={`${titleId}-g`} className="gx-eyebrow">Goes well with</h3>
        {extras.length > 0 && <div className="gx-chips" role="group" aria-label={`Extras for ${item.name}`}>
          {extras.map((extra) => <button key={extra.id} type="button" className="gx-chip" aria-pressed={extraIds.has(extra.id)} onClick={() => toggle(setExtraIds, extra.id)}>
            <span className="gx-chip-mark" aria-hidden="true">{extraIds.has(extra.id) ? <Glyph name="check" size={14} strokeWidth={2.6} /> : '+'}</span>
            <span className="gx-chip-name">{extra.name}</span>
            <span className="gx-chip-price">{Number(extra.price) ? formatKsh(extra.price) : 'Free'}</span>
          </button>)}
        </div>}
        {pairs.length > 0 && <div className="gx-chips" role="group" aria-label={`Dishes that go well with ${item.name}`}>
          {pairs.map((pair) => <button key={pair.id} type="button" className="gx-chip is-pair" aria-pressed={pairIds.has(pair.id)} onClick={() => toggle(setPairIds, pair.id)}>
            {pair.photoUrl || pair.videoPosterUrl ? <Img className="gx-chip-photo" src={pair.photoUrl || pair.videoPosterUrl} alt="" /> : <span className="gx-chip-mark" aria-hidden="true">{pairIds.has(pair.id) ? <Glyph name="check" size={14} strokeWidth={2.6} /> : '+'}</span>}
            <span className="gx-chip-name">{pair.name}</span>
            <span className="gx-chip-price">{formatKsh(pair.price, pair.currency)}</span>
            {(pair.photoUrl || pair.videoPosterUrl) && pairIds.has(pair.id) && <span className="gx-chip-tick" aria-hidden="true"><Glyph name="check" size={12} strokeWidth={3} /></span>}
          </button>)}
        </div>}
        {pairIds.size > 0 && <p className="gx-hint">{[...pairIds].map((id) => itemsById.get(id)?.name).filter(Boolean).join(' and ')} {pairIds.size === 1 ? 'is' : 'are'} added as {pairIds.size === 1 ? 'its own line' : 'their own lines'}.</p>}
      </section>}

      <KitchenNote value={note} onChange={setNote} open={noteOpen} onOpen={() => setNoteOpen(true)} />
    </article>}
  </GuestSheet>;
}
