import { confirmationOf, formatKes, formatRelative, lineText, shortId, tableName } from '../../lib/ops';
import { OIcon, StatusLine } from './ui';

const SHOWN = 3;

/**
 * One order: "Table 7 · #92da2e", relative time, its lines (with extras and what's in a deal), total and the
 * Confirmed · Served · Paid status line. Orders entered without the guest's phone carry a warning tag. Opens the detail.
 */
export default function OrderRow({ order, now, onOpen, showTable = true, isNew = false }) {
  const how = confirmationOf(order);
  const shown = order.items.slice(0, SHOWN);
  const more = order.items.length - shown.length;
  return <li className={`o-order-row${order.status === 'cancelled' ? ' is-cancelled' : ''}${isNew ? ' is-new' : ''}`}>
    <button type="button" className="o-order-row-button" onClick={() => onOpen(order)}
      aria-label={`${tableName(order)}, order ${shortId(order)}, ${order.statusLabel}${how?.warn ? ', not confirmed by the guest' : ''}, ${formatKes(order.total)}. Open details`}>
      <span className="o-order-row-main">
        <span className="o-order-row-title">
          {showTable && <strong>{tableName(order)}</strong>}
          {showTable && <span className="o-dot-sep" aria-hidden="true">·</span>}
          <span className="o-order-row-id">{shortId(order)}</span>
          <span className="o-order-row-time">{formatRelative(order.takenAt || order.createdAt, now)}</span>
          {how?.warn && <span className="o-tag is-warning o-order-row-tag">Not confirmed by the guest</span>}
        </span>
        <span className="o-order-row-items">
          {shown.map((line, index) => <span key={line.id || index} className="o-order-row-line">{lineText(line)}</span>)}
          {more > 0 && <span className="o-order-row-line is-more">+{more} more</span>}
        </span>
      </span>
      <span className="o-order-row-status"><StatusLine order={order} compact /></span>
      <span className="o-order-row-total">{formatKes(order.total)}</span>
      <OIcon name="arrowRight" size={16} className="o-order-row-chevron" />
    </button>
  </li>;
}
