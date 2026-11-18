// How an emergency purchase reads, for the owner's Approvals inbox and for the branch's own screen: its items in plain words,
// who it is from, what it costs, the invoice and the photos.
import { EMERGENCY_STATUS, INVOICE_LABEL, PAYMENT_LABEL, formatStamp, formatStockMoney, unitName } from '../../lib/inventory';
import { Evidence, Facts } from './ReceivingParts';
import './purchasing.css';

export function EmergencyStatus({ status }) {
  const info = EMERGENCY_STATUS[status] || { label: status, tone: 'off' };
  return <span className={`inv-badge is-${info.tone}`}>{info.label}</span>;
}

/** The items: "Cooking oil: 2 jerrycans at Ksh 3,200 each". Once bought it shows what was really paid; once received, what arrived. */
export function EmergencyLines({ purchase }) {
  return <ul className="rcv-items" aria-label="Items">{(purchase.lines || []).map((l) => <li key={l.id}>
    <strong>{l.itemName}</strong> — {l.qty} {unitName(l.unit, l.qty)} · {l.actualUnitPrice ? `paid ${formatStockMoney(l.actualUnitPrice)}` : `about ${formatStockMoney(l.estimatedUnitPrice)}`} each
    {l.received ? ` · ${l.received.qty} ${unitName(l.received.unit, l.received.qty)} arrived` : ''} · {formatStockMoney(l.actualTotal ?? l.estimatedTotal)}
  </li>)}</ul>;
}

/** Everything the owner needs to judge a purchase on one screen. */
export function EmergencyDetail({ purchase, showBranch = true }) {
  const bought = purchase.actualTotal !== null && purchase.actualTotal !== undefined;
  return <>
    <Facts items={[showBranch ? ['Branch', purchase.locationName] : null, ['Bought from', purchase.supplierName ? `${purchase.supplierName}${purchase.supplierIncomplete ? ' (new, details missing)' : ''}` : null],
      ['Estimate', formatStockMoney(purchase.estimatedTotal)], bought ? ['Paid', formatStockMoney(purchase.actualTotal)] : null,
      purchase.paymentMethod ? ['Paid by', `${PAYMENT_LABEL[purchase.paymentMethod] || purchase.paymentMethod}${purchase.paymentReference ? ` (${purchase.paymentReference})` : ''}`] : null,
      purchase.invoiceStatus ? ['Invoice', `${INVOICE_LABEL[purchase.invoiceStatus]}${purchase.invoiceNo ? ` ${purchase.invoiceNo}` : ''}`] : null,
      purchase.invoiceStatus === 'none' ? ['Why no invoice', purchase.noInvoiceReason] : null, ['Asked by', purchase.requestedByName],
      purchase.submittedAt ? ['Sent', formatStamp(purchase.submittedAt)] : null].filter(Boolean)} />
    <p className="o-field-hint"><strong>Why it couldn’t wait:</strong> {purchase.reason}</p>
    <EmergencyLines purchase={purchase} />
    <Evidence files={purchase.evidence || []} />
    {purchase.reviewNote && <p className="inv-note" role="status">{purchase.reviewNote}</p>}
  </>;
}
