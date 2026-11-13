import { Link } from 'react-router-dom';
import './table-tile.css';

/*
 * One table, as a white squircle tile: the big table number and a small status pill that names the
 * state in words ("Needs help") with a coloured dot, so state never depends on colour alone.
 * Shared by the owner pages and the waiter app.
 *
 * Props: { number, state: 'free'|'ordering'|'attention'|'bill', label?, meta?, orders?, request?, href?, onClick?, size: 'md'|'lg' }
 * - `label` overrides the state word ("Wants to pay"); `meta` is a small line under the pill ("2 orders").
 * - `orders` (a count) and `request` ('call_waiter' | 'bill' | 'payment') add small badges top right.
 */

export const TILE_STATES = {
  free: { label: 'Free' },
  ordering: { label: 'Ordering' },
  attention: { label: 'Needs help' },
  bill: { label: 'Wants the bill' },
};

const ICONS = {
  free: <circle cx="12" cy="12" r="7.5" strokeDasharray="3 3" />,
  ordering: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" /><path d="M9.5 8h5M9.5 12h5" /></>,
  attention: <><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" /><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" /></>,
  bill: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>,
};
const BAG = <><path d="M5 7h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8Z" /><path d="M9 7a3 3 0 0 1 6 0" /></>;
const REQUEST = {
  call_waiter: { icon: 'attention', word: 'Called for a waiter', state: 'attention' },
  bill: { icon: 'bill', word: 'Asked for the bill', state: 'bill' },
  payment: { icon: 'bill', word: 'Ready to pay', state: 'bill' },
};

/** The state's icon (kept for callers that show state outside a tile). */
export function TileStateIcon({ state, size = 16 }) {
  return <svg className="tile-state-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICONS[state] || ICONS.free}</svg>;
}

function Svg({ children, size }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

export default function TableTile({ number, state = 'free', label, meta, orders, request, href, onClick, size = 'md', className = '' }) {
  const known = TILE_STATES[state] ? state : 'free';
  const word = label || TILE_STATES[known].label;
  const asked = REQUEST[request];
  const icon = size === 'lg' ? 16 : 13;
  const badges = (orders > 0 || asked) && <span className="table-tile-badges">
    {orders > 0 && <span className="table-tile-badge"><Svg size={icon}>{BAG}</Svg>{orders}<span className="visually-hidden">{orders === 1 ? ' open order' : ' open orders'}</span></span>}
    {asked && <span className={`table-tile-badge is-${asked.state}`}><Svg size={icon}>{ICONS[asked.icon]}</Svg><span className="visually-hidden">{asked.word}</span></span>}
  </span>;
  const body = <>
    <span className="table-tile-top">
      <span className="table-tile-heading">
        <span className="table-tile-caption" aria-hidden="true">Table</span>
        <span className="table-tile-number"><span className="visually-hidden">Table </span>{number}</span>
      </span>
      {badges}
    </span>
    <span className="table-tile-foot">
      <span className="table-tile-pill"><span className="table-tile-dot" aria-hidden="true" /><span className="table-tile-label">{word}</span></span>
      {meta && <span className="table-tile-meta">{meta}</span>}
    </span>
  </>;
  const classes = `table-tile is-${known} size-${size}${badges ? ' has-badges' : ''}${href || onClick ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`;
  if (href) return <Link className={classes} to={href} data-state={known}>{body}</Link>;
  if (onClick) return <button type="button" className={classes} onClick={onClick} data-state={known}>{body}</button>;
  return <div className={classes} data-state={known}>{body}</div>;
}
