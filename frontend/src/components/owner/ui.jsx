import { useId, useRef } from 'react';
import { ORDER_STAGES, stageOf } from '../../lib/ops';
import './owner.css';

/* Building blocks for the owner's live pages: icons, segmented controls, panels, states, the order status line. */

const PATHS = {
  check: <path d="M20 6 9 17l-5-5" />,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" /><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" /></>,
  bill: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" /><path d="M9.5 8h5M9.5 12h5M9.5 16h3" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>,
  order: <><path d="M5 7h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8Z" /><path d="M9 7a3 3 0 0 1 6 0" /></>,
  walk: <><circle cx="13" cy="4.5" r="1.8" /><path d="m9 21 2.5-6.5L14 17v4M7 12l3-4.5 4 1.5 2 3.5M11.5 14.5 10 8" /></>,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16m5 0H3v5" /></>,
  alert: <><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5v5.5m0 3.5h.01" /></>,
  info: <><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6m0-9.5h.01" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17.5 21H21v-3.5" /></>,
  printer: <><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" rx="1" /></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></>,
  external: <><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></>,
  play: <path d="M8 5.5v13l11-6.5Z" fill="currentColor" stroke="none" />,
  table: <><path d="M3 9h18M5 9v11M19 9v11M3 9l2-4h14l2 4M8 14h8" /></>,
  scan: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" /></>,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  more: <><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></>,
  heart: <path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6Z" />,
  utensils: <><path d="M3 2v7a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6a2 2 0 0 0 2 2Zm0 0v7" /></>,
  leaf: <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" /><path d="M2 21c0-3 1.9-5.4 5.1-6" /></>,
  dessert: <><path d="m7 11 4.1 10.4a1 1 0 0 0 1.8 0L17 11M17 7A5 5 0 0 0 7 7" /><path d="M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4" /></>,
  drink: <><path d="M8 22h8M7 10h10M12 15v7M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z" /></>,
  coffee: <><path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" /><path d="M6 2v2M10 2v2M14 2v2" /></>,
  beer: <><path d="M17 11h1a3 3 0 0 1 0 6h-1M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" /><path d="M5 8a3 3 0 0 1 3-4 3 3 0 0 1 5 0 3 3 0 0 1 4 4Z" /></>,
  egg: <path d="M12 22c4 0 7-3 7-7.5S16 2 12 2 5 10 5 14.5 8 22 12 22Z" />,
  flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1-2.2-.2-4.2 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8Z" />,
  bowl: <><path d="M2 12h20a10 10 0 0 1-20 0Z" /><path d="M7 21h10M12 12V8M8 8c0-2 1-4 4-4s4 2 4 4" /></>,
  layers: <><path d="m12 2 10 5-10 5L2 7Z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  pizza: <><path d="M12 2 2 20h20Z" /><circle cx="10" cy="14" r="1" /><circle cx="14" cy="16" r="1" /><circle cx="12" cy="10" r="1" /></>,
  live: <><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2" /></>,
};

export function OIcon({ name, size = 18, strokeWidth = 1.8, className, ...props }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{PATHS[name] || PATHS.dot}</svg>;
}

/**
 * Segmented control. `mode="tabs"` renders a tablist (pair it with a tabpanel labelled by `tabId(value)`);
 * `mode="radio"` renders a radiogroup. Arrow keys move between options either way.
 */
export function Segmented({ label, options, value, onChange, mode = 'radio', size = 'md', idBase, className = '' }) {
  const ref = useRef(null);
  const tabs = mode === 'tabs';
  const onKeyDown = (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in keys) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + keys[event.key] + options.length) % options.length;
    onChange(options[next].value);
    requestAnimationFrame(() => ref.current?.querySelectorAll('[data-segment]')[next]?.focus());
  };
  return <div ref={ref} className={`o-segmented size-${size} ${className}`} role={tabs ? 'tablist' : 'radiogroup'} aria-label={label} onKeyDown={onKeyDown}>
    {options.map((option) => {
      const selected = option.value === value;
      return <button key={option.value} type="button" data-segment className={`o-segment${selected ? ' is-selected' : ''}`}
        role={tabs ? 'tab' : 'radio'} id={idBase ? `${idBase}-tab-${option.value}` : undefined}
        aria-controls={tabs && idBase ? `${idBase}-panel` : undefined}
        {...(tabs ? { 'aria-selected': selected } : { 'aria-checked': selected })}
        tabIndex={selected ? 0 : -1} onClick={() => onChange(option.value)}>
        {option.icon && <OIcon name={option.icon} size={16} />}
        <span>{option.label}</span>
        {option.count !== undefined && option.count !== null && <span className="o-segment-count">{option.count}</span>}
      </button>;
    })}
  </div>;
}

/** A white panel with a header row (title, optional count badge, actions). */
export function Panel({ title, titleId, count, actions, children, className = '', as: Tag = 'section', headingLevel = 2, sub }) {
  const generated = useId();
  const id = titleId || generated;
  const Heading = `h${headingLevel}`;
  return <Tag className={`o-panel ${className}`} aria-labelledby={id}>
    <header className="o-panel-head">
      <div className="o-panel-titles">
        <Heading id={id} className="o-panel-title">{title}{count !== undefined && count !== null && <span className="o-count" aria-label={`, ${count}`}>{count}</span>}</Heading>
        {sub && <p className="o-panel-sub">{sub}</p>}
      </div>
      {actions && <div className="o-panel-actions">{actions}</div>}
    </header>
    {children}
  </Tag>;
}

export function ErrorState({ error, onRetry, compact = false, what = 'this' }) {
  return <div className={`o-state is-error${compact ? ' is-compact' : ''}`} role="alert">
    <span className="o-state-icon"><OIcon name="alert" size={20} /></span>
    <div className="o-state-text">
      <strong>We couldn’t load {what}.</strong>
      <span>{error?.message || 'Something went wrong. Please try again.'}</span>
    </div>
    {onRetry && <button type="button" className="o-btn is-secondary" onClick={() => onRetry()}><OIcon name="refresh" size={16} />Try again</button>}
  </div>;
}

export function EmptyState({ icon = 'check', title, children, action, tone = 'calm' }) {
  return <div className={`o-state is-empty is-${tone}`}>
    <span className="o-state-icon"><OIcon name={icon} size={22} /></span>
    <div className="o-state-text"><strong>{title}</strong>{children && <span>{children}</span>}</div>
    {action}
  </div>;
}

const widths = ['62%', '48%', '71%', '55%', '66%', '40%'];
export function SkeletonRows({ rows = 4, thumb = true, label = 'Loading' }) {
  return <div className="o-skeleton-rows" role="status" aria-label={label}>
    {Array.from({ length: rows }, (_, i) => <div className="o-skeleton-row" key={i} aria-hidden="true">
      {thumb && <span className="sk o-sk-thumb" />}
      <span className="sk-stack"><span className="sk sk-text" style={{ width: widths[i % 6] }} /><span className="sk sk-line" style={{ width: '34%' }} /></span>
      <span className="sk sk-line" style={{ width: 56 }} />
    </div>)}
  </div>;
}

export function TileSkeletonGrid({ count = 12 }) {
  return <div className="o-tile-grid" role="status" aria-label="Loading tables">
    {Array.from({ length: count }, (_, i) => <span key={i} className="o-tile-skeleton" aria-hidden="true"><span className="sk" style={{ width: 28, height: 24 }} /><span className="sk sk-line" style={{ width: '60%' }} /></span>)}
  </div>;
}

/** Status chip for an order: "Confirmed", "Served", … Cancelled is distinct. Older accepted orders look Confirmed. */
export function StatusChip({ status, label }) {
  return <span className={`o-status-chip is-${stageOf(status)}`}><span className="o-status-chip-dot" aria-hidden="true" />{label}</span>;
}

/**
 * Three circles joined by a line (Confirmed, Served, Paid), filled up to the current stage,
 * with the current stage in words. Cancelled replaces the line with a distinct struck state.
 */
export function StatusLine({ order, compact = false }) {
  const { status } = order;
  if (status === 'cancelled') {
    return <div className={`o-statusline is-cancelled${compact ? ' is-compact' : ''}`}>
      <span className="o-statusline-track" aria-hidden="true">
        {ORDER_STAGES.map((stage) => <span key={stage.key} className="o-statusline-node" />)}
      </span>
      <span className="o-statusline-word"><OIcon name="close" size={13} strokeWidth={2.4} />Cancelled</span>
    </div>;
  }
  const stage = stageOf(status);
  const current = ORDER_STAGES.findIndex((entry) => entry.key === stage);
  const word = { taken: 'Confirmed · to serve', served: 'Served · waiting for payment', paid: 'Paid' }[stage];
  return <div className={`o-statusline${compact ? ' is-compact' : ''}`} data-stage={stage}>
    <ol className="o-statusline-track" aria-label={`Progress: ${ORDER_STAGES.map((stage, i) => `${stage.label} ${i <= current ? 'done' : 'not yet'}`).join(', ')}`}>
      {ORDER_STAGES.map((stage, i) => <li key={stage.key} className={`o-statusline-node${i <= current ? ' is-done' : ''}${i === current ? ' is-current' : ''}${i > 0 && i <= current ? ' is-linked' : ''}`}
        title={stage.label}>
        {i <= current && <OIcon name="check" size={9} strokeWidth={3.2} />}
      </li>)}
    </ol>
    <span className="o-statusline-word">{compact ? ({ taken: 'Confirmed', served: 'Served', paid: 'Paid' }[stage]) : word}</span>
  </div>;
}

/** A small "Live · updated 8s ago" / "Reconnecting…" indicator. */
export function LiveBadge({ error, stale }) {
  if (error) return <span className="o-live is-offline" role="status"><span className="o-live-dot" aria-hidden="true" />Reconnecting…</span>;
  return <span className={`o-live${stale ? ' is-stale' : ''}`}><span className="o-live-dot" aria-hidden="true" />Live</span>;
}

export function Bar({ value, max }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return <span className="o-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>;
}
