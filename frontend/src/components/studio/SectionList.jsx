import { useId, useRef, useState } from 'react';
import { LIMITS } from '../../lib/menu-design';
import { StudioIcon } from './StudioIcon';

/* Layout thumbnails: tiny drawings of each arrangement. */
export function LayoutThumb({ layout }) {
  const box = { fill: 'currentColor', opacity: 0.22 };
  return <svg viewBox="0 0 48 32" width="48" height="32" aria-hidden="true">
    {layout === 'grid' && <>{[0, 1, 2].map((c) => [0, 1].map((r) => <rect key={`${c}${r}`} x={4 + c * 14} y={3 + r * 14} width="12" height="12" rx="2" {...box} />))}</>}
    {layout === 'list' && <>{[0, 1, 2].map((r) => <g key={r}><rect x="4" y={4 + r * 9} width="26" height="3" rx="1.5" {...box} /><rect x="36" y={2 + r * 9} width="8" height="7" rx="1.5" {...box} /></g>)}</>}
    {layout === 'carousel' && <><rect x="4" y="5" width="16" height="22" rx="2.5" {...box} /><rect x="23" y="5" width="16" height="22" rx="2.5" {...box} /><rect x="42" y="5" width="6" height="22" rx="2.5" {...box} opacity=".12" /></>}
  </svg>;
}
export const LAYOUT_LABELS = { grid: 'Grid', list: 'List', carousel: 'Carousel' };
const TYPE_ICON = { featured: 'star', deals: 'tag', category: 'list' };

/**
 * The menu's sections in order. Reorder by dragging the handle (mouse or touch), by keyboard (focus the handle,
 * Space to lift, arrows to move, Space to drop, Escape to cancel), or with the up/down buttons. Each row has a
 * show/hide eye; expanding it reveals the layout picker and, for Featured and Deals, the title.
 */
export default function SectionList({ sections, counts, onChange, onPick, selected }) {
  const id = useId();
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null); // { key, startY, offset, order }
  const [lifted, setLifted] = useState(null); // keyboard: { key, from }
  const [announce, setAnnounce] = useState('');
  const [open, setOpen] = useState(null);
  const order = drag?.order || sections;

  const move = (list, from, to) => { const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next; };
  const commit = (list) => onChange(list, 'order');
  const patch = (key, change, tag) => onChange(sections.map((section) => (section.key === key ? { ...section, ...change } : section)), tag);

  /* Pointer drag */
  const onPointerDown = (event, key) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key, startY: event.clientY, offset: 0, order: sections });
  };
  const onPointerMove = (event) => {
    if (!drag) return;
    const rows = [...listRef.current.querySelectorAll('[data-row]')];
    const from = drag.order.findIndex((section) => section.key === drag.key);
    let to = from;
    rows.forEach((row, index) => {
      if (row.dataset.row === drag.key) return;
      const box = row.getBoundingClientRect();
      if (index < from && event.clientY < box.top + box.height / 2) to = Math.min(to, index);
      if (index > from && event.clientY > box.top + box.height / 2) to = Math.max(to, index);
    });
    const next = to === from ? drag.order : move(drag.order, from, to);
    const moved = to === from ? 0 : rows[to].getBoundingClientRect().top - rows[from].getBoundingClientRect().top;
    setDrag({ ...drag, order: next, startY: drag.startY + moved, offset: event.clientY - (drag.startY + moved) });
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.order.map((s) => s.key).join() !== sections.map((s) => s.key).join()) commit(drag.order);
    setDrag(null);
  };

  /* Keyboard */
  const onHandleKey = (event, key, index) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (lifted) { setLifted(null); setAnnounce(`${titleOf(key)} dropped at position ${index + 1} of ${sections.length}.`); }
      else { setLifted({ key, from: index, before: sections }); setAnnounce(`${titleOf(key)} lifted. Use the up and down arrows to move it, Space to drop, Escape to cancel.`); }
      return;
    }
    if (event.key === 'Escape' && lifted) {
      event.preventDefault();
      commit(lifted.before); setLifted(null); setAnnounce('Move cancelled.');
      return;
    }
    const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const to = index + step;
    if (to < 0 || to >= sections.length) return;
    if (lifted) {
      commit(move(sections, index, to));
      setAnnounce(`${titleOf(key)} moved to position ${to + 1} of ${sections.length}.`);
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-row="${CSS.escape(key)}"] .st-handle`)?.focus());
    } else {
      listRef.current?.querySelectorAll('.st-handle')[to]?.focus();
    }
  };
  const titleOf = (key) => sections.find((section) => section.key === key)?.title || 'Section';
  const nudge = (index, step) => {
    const to = index + step;
    if (to < 0 || to >= sections.length) return;
    commit(move(sections, index, to));
    setAnnounce(`${sections[index].title} moved to position ${to + 1} of ${sections.length}.`);
  };

  return <div className="st-sections">
    <p id={`${id}-help`} className="visually-hidden">Drag a section by its handle, or focus the handle and press Space to move it with the arrow keys.</p>
    <ol ref={listRef} className="st-section-list" aria-label="Menu sections, in order" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {order.map((section, index) => {
        const isDragging = drag?.key === section.key;
        const isOpen = open === section.key;
        const count = counts[section.key] ?? 0;
        const empty = count === 0;
        return <li key={section.key} data-row={section.key}
          className={`st-section${isDragging ? ' is-dragging' : ''}${lifted?.key === section.key ? ' is-lifted' : ''}${section.visible ? '' : ' is-hidden'}${selected === section.key ? ' is-selected' : ''}`}
          style={isDragging ? { transform: `translateY(${drag.offset}px)` } : undefined}>
          <div className="st-section-row">
            <button type="button" className="st-handle" aria-label={`Reorder ${section.title}`} aria-describedby={`${id}-help`} aria-pressed={lifted?.key === section.key}
              onPointerDown={(event) => onPointerDown(event, section.key)} onKeyDown={(event) => onHandleKey(event, section.key, index)}>
              <StudioIcon name="grip" size={16} />
            </button>
            <button type="button" className="st-section-main" onClick={() => { setOpen(isOpen ? null : section.key); onPick(section.key); }} aria-expanded={isOpen} aria-controls={`${id}-${index}`}>
              <span className="st-section-icon" aria-hidden="true"><StudioIcon name={TYPE_ICON[section.type]} size={15} /></span>
              <span className="st-section-text">
                <strong>{section.title}</strong>
                <span>{LAYOUT_LABELS[section.layout]} · {empty ? (section.type === 'deals' ? 'no live deals' : section.type === 'featured' ? 'nothing featured' : 'no dishes') : `${count} ${section.type === 'deals' ? `deal${count === 1 ? '' : 's'}` : `dish${count === 1 ? '' : 'es'}`}`}</span>
              </span>
              <StudioIcon name="chevron" size={15} className="st-chevron" />
            </button>
            <button type="button" className="st-eye" aria-label={`${section.visible ? 'Hide' : 'Show'} ${section.title}`}
              title={section.visible ? 'Hide from guests' : 'Show to guests'} onClick={() => patch(section.key, { visible: !section.visible }, null)}>
              <StudioIcon name={section.visible ? 'eye' : 'eye-off'} size={17} />
            </button>
          </div>
          {isOpen && <div id={`${id}-${index}`} className="st-section-detail">
            {section.type !== 'category' ? <label className="st-field">
              <span>Title</span>
              <input value={section.savedTitle ?? ''} placeholder={section.type === 'featured' ? 'Featured' : 'Pairs & deals'} maxLength={LIMITS.sectionTitle}
                onChange={(event) => patch(section.key, { savedTitle: event.target.value || null, title: event.target.value || (section.type === 'featured' ? 'Featured' : 'Pairs & deals') }, `title:${section.key}`)} />
            </label> : <p className="st-note">The title is the category’s name. Rename it in Products.</p>}
            <div className="st-layouts" role="radiogroup" aria-label={`Layout of ${section.title}`}>
              {['grid', 'list', 'carousel'].map((layout) => <button key={layout} type="button" role="radio" aria-checked={section.layout === layout}
                className={`st-layout${section.layout === layout ? ' is-on' : ''}`} onClick={() => patch(section.key, { layout }, null)}>
                <LayoutThumb layout={layout} /><span>{LAYOUT_LABELS[layout]}</span>
              </button>)}
            </div>
            {empty && <p className="st-note">{section.type === 'deals' ? 'Hidden from guests until you have a live deal (Products → Deals).' : section.type === 'featured' ? 'Feature dishes in Products to fill this section.' : 'Guests won’t see this section until it has dishes.'}</p>}
            <div className="st-move">
              <button type="button" className="o-btn is-small" onClick={() => nudge(index, -1)} disabled={index === 0} aria-label={`Move ${section.title} up`}><StudioIcon name="up" size={15} />Up</button>
              <button type="button" className="o-btn is-small" onClick={() => nudge(index, 1)} disabled={index === sections.length - 1} aria-label={`Move ${section.title} down`}><StudioIcon name="down" size={15} />Down</button>
            </div>
          </div>}
        </li>;
      })}
    </ol>
    <p className="visually-hidden" role="status" aria-live="assertive">{announce}</p>
  </div>;
}
