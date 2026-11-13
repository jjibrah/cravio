import { OIcon } from '../owner/ui';
import { PIcon, SaleSwitch, StarToggle, formatCount, formatKsh, pluralize } from './shared';

/* List view: compact rows with the same switch and star, plus up/down to reorder within the category. */
export function RowList({ category, items, canReorder, busy, onOpen, onToggle, onFeature, onReorder, onAdd, showAdd }) {
  const move = (item, direction) => {
    const ids = items.map((entry) => entry.id);
    const from = ids.indexOf(item.id);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    onReorder(category.id, ids, item.id);
    requestAnimationFrame(() => document.querySelector(`[data-move="${item.id}:${direction}"]`)?.focus());
  };
  return <div className="o-panel pr-panel">
    <ul className="o-product-rows" aria-label={`${category.name} dishes`}>
      {items.map((item, index) => {
        const thumb = item.photoUrl || item.videoPosterUrl;
        const extras = item.extras?.length || 0;
        const pairings = item.pairedItemIds?.length || 0;
        return <li key={item.id} className={`o-product-row pr-row${item.available ? '' : ' is-sold-out'}`}>
          <span className="o-thumb">
            {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="o-thumb-empty" aria-hidden="true"><PIcon name="image" size={18} /></span>}
            {item.videoUrl && <span className="o-thumb-play" aria-label="Has a video"><OIcon name="play" size={10} /></span>}
          </span>
          <span className="o-product-main">
            <button type="button" className="pr-open" onClick={() => onOpen(item)} aria-label={`Edit ${item.name}`}>
              <span className="o-product-name">{item.name}</span>
            </button>
            <span className="pr-meta">
              {extras > 0 && <span>{pluralize(extras, 'extra')}</span>}
              {pairings > 0 && <span>{pluralize(pairings, 'pairing')}</span>}
              <span>{formatCount(item.stats30d?.views)} views · {formatCount(item.stats30d?.orderedQuantity)} ordered in 30 days</span>
            </span>
          </span>
          <span className="o-product-price">{formatKsh(item.price)}</span>
          <SaleSwitch on={item.available} onToggle={() => onToggle(item)} label={`${item.name} on sale`} busy={busy[item.id]} />
          <span className="o-product-tools">
            <StarToggle on={item.featured} onToggle={() => onFeature(item)} name={item.name} />
            {canReorder && <>
              <button type="button" className="o-icon-btn" onClick={() => move(item, -1)} disabled={index === 0} data-move={`${item.id}:-1`} aria-label={`Move ${item.name} up`}><OIcon name="arrowUp" size={16} /></button>
              <button type="button" className="o-icon-btn" onClick={() => move(item, 1)} disabled={index === items.length - 1} data-move={`${item.id}:1`} aria-label={`Move ${item.name} down`}><OIcon name="arrowDown" size={16} /></button>
            </>}
          </span>
        </li>;
      })}
      {showAdd && <li className="pr-add-row">
        <button type="button" className="o-btn is-quiet is-small" onClick={() => onAdd(category.id)}><OIcon name="plus" size={15} />Add dish to {category.name}</button>
      </li>}
    </ul>
  </div>;
}
