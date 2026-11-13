import { useState } from 'react';
import { OIcon } from '../owner/ui';
import { PIcon, SaleSwitch, StarToggle, formatCount, formatKsh, pluralize } from './shared';

/*
 * Card view of one category: square media, name and price, the On sale switch and featured star, small
 * extras/pairings indicators and 30-day numbers. Cards reorder by dragging the grip (or arrow keys on it).
 * The whole card opens the editor (a stretched button), while the switch, star and "Add photo" sit above it.
 */
export function CardGrid({ category, items, canReorder, showAdd, busy, onOpen, onToggle, onFeature, onReorder, onAdd }) {
  const [drag, setDrag] = useState(null); // { id, over }

  const drop = (targetId) => {
    if (!drag || drag.id === targetId) { setDrag(null); return; }
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(drag.id);
    const to = ids.indexOf(targetId);
    setDrag(null);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, drag.id);
    onReorder(category.id, next, drag.id);
  };
  const nudge = (item, direction) => {
    const ids = items.map((entry) => entry.id);
    const from = ids.indexOf(item.id);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[from], next[to]] = [next[to], next[from]];
    onReorder(category.id, next, item.id);
    requestAnimationFrame(() => document.querySelector(`[data-grip="${item.id}"]`)?.focus());
  };

  return <ul className="pc-grid" aria-label={`${category.name} dishes`}>
    {items.map((item) => <ProductCard key={item.id} item={item} category={category} busy={busy[item.id]} canReorder={canReorder}
      dragging={drag?.id === item.id} over={drag && drag.over === item.id && drag.id !== item.id}
      onOpen={onOpen} onToggle={onToggle} onFeature={onFeature} onNudge={nudge}
      onDragStart={() => setDrag({ id: item.id, over: item.id })} onDragOver={() => setDrag((current) => current && current.over !== item.id ? { ...current, over: item.id } : current)}
      onDrop={() => drop(item.id)} onDragEnd={() => setDrag(null)} />)}
    {showAdd && <li className="pc-add-wrap">
      <button type="button" className="pc-add" onClick={() => onAdd(category.id)}>
        <span className="pc-add-icon"><OIcon name="plus" size={20} /></span>
        <span>Add dish to {category.name}</span>
      </button>
    </li>}
  </ul>;
}

function ProductCard({ item, category, busy, canReorder, dragging, over, onOpen, onToggle, onFeature, onNudge, onDragStart, onDragOver, onDrop, onDragEnd }) {
  const [handle, setHandle] = useState(false);
  const image = item.photoUrl || item.videoPosterUrl;
  const stats = item.stats30d || {};
  const extras = item.extras?.length || 0;
  const pairings = item.pairedItemIds?.length || 0;
  return <li className={`pc-card${item.available ? '' : ' is-sold-out'}${dragging ? ' is-dragging' : ''}${over ? ' is-over' : ''}`}
    draggable={canReorder && handle}
    onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); onDragStart(); }}
    onDragOver={(event) => { if (!canReorder) return; event.preventDefault(); onDragOver(); }}
    onDrop={(event) => { event.preventDefault(); onDrop(); }}
    onDragEnd={() => { setHandle(false); onDragEnd(); }}>
    <div className="pc-media">
      {image ? <img src={image} alt="" loading="lazy" draggable={false} />
        : <button type="button" className="pc-media-empty" onClick={() => onOpen(item, 'media')} aria-label={`Add a photo of ${item.name}`}>
          <PIcon name="image" size={22} /><span>Add photo</span>
        </button>}
      {item.videoUrl && <span className="pc-play" title={`Has a ${Math.round(item.videoDurationSeconds || 0)}s video`}><OIcon name="play" size={11} /><span className="visually-hidden">Has a video</span></span>}
      {!item.available && <span className="pc-badge">Sold out</span>}
      {canReorder && <button type="button" className="pc-grip" data-grip={item.id} aria-label={`Reorder ${item.name}. Drag, or use the arrow keys`}
        onPointerDown={() => setHandle(true)} onPointerUp={() => setHandle(false)}
        onKeyDown={(event) => {
          const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
          if (direction) { event.preventDefault(); onNudge(item, direction); }
        }}>
        <PIcon name="grip" size={16} />
      </button>}
    </div>
    <div className="pc-body">
      <div className="pc-title-row">
        <button type="button" className="pc-open" onClick={() => onOpen(item)}>
          <span className="pc-name">{item.name}</span>
        </button>
        <span className="pc-price">{formatKsh(item.price)}</span>
      </div>
      <p className="pc-category">{category.name}</p>
      {(extras > 0 || pairings > 0) && <p className="pc-tags">
        {extras > 0 && <span className="pc-tag" title={item.extras.map((extra) => extra.name).join(', ')}><OIcon name="plus" size={12} strokeWidth={2.2} />{pluralize(extras, 'extra')}</span>}
        {pairings > 0 && <span className="pc-tag" title="Suggested with other dishes"><PIcon name="link" size={12} strokeWidth={2} />{pluralize(pairings, 'pairing')}</span>}
      </p>}
      <p className="pc-stats" title="Last 30 days">{formatCount(stats.views)} views · {formatCount(stats.orderedQuantity)} ordered <span className="pc-stats-range">· 30d</span></p>
    </div>
    <div className="pc-foot">
      <SaleSwitch on={item.available} onToggle={() => onToggle(item)} label={`${item.name} on sale`} busy={busy} />
      <StarToggle on={item.featured} onToggle={() => onFeature(item)} name={item.name} />
    </div>
  </li>;
}

export function CardSkeletons({ count = 8 }) {
  return <ul className="pc-grid" role="status" aria-label="Loading products">
    {Array.from({ length: count }, (_, i) => <li key={i} className="pc-card is-skeleton" aria-hidden="true">
      <div className="pc-media"><span className="sk" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} /></div>
      <div className="pc-body"><span className="sk sk-text" style={{ width: '70%' }} /><span className="sk sk-line" style={{ width: '40%', marginTop: 8 }} /></div>
      <div className="pc-foot"><span className="sk sk-pill" style={{ width: 96, height: 24 }} /></div>
    </li>)}
  </ul>;
}
