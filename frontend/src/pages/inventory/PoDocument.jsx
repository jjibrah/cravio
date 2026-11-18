// The purchase order as a document: a preview in the sheet, and (through a portal) the only thing that prints.
// `document` is the server's structured order (GET .../purchase-orders/:id/document). Print or "Save as PDF" is the browser's own.
import { createPortal } from 'react-dom';
import { formatDay, formatNumber, formatStockMoney, plural } from '../../lib/inventory';
import './purchasing.css';

function Sheet({ document: doc }) {
  const money = (value) => (value === null || value === undefined ? '–' : formatStockMoney(value));
  return <article className="po-doc" aria-label={`Purchase order ${doc.number}`}>
    <div className="po-doc-head">
      <div><h2>Purchase order</h2><div>{doc.number}</div></div>
      <div><strong>{doc.from?.name}</strong><div>{doc.dateText || formatDay(doc.date)}</div></div>
    </div>
    <div className="po-doc-cols">
      <div><h3>Order from</h3><p><strong>{doc.to?.name}</strong></p>{doc.to?.contactName && <p>{doc.to.contactName}</p>}{doc.to?.phone && <p>{doc.to.phone}</p>}{doc.to?.address && <p>{doc.to.address}</p>}{doc.to?.kraPin && <p>KRA PIN {doc.to.kraPin}</p>}</div>
      <div><h3>Deliver to</h3><p><strong>{doc.deliverTo}</strong></p>{doc.expectedDateText && <p>By {doc.expectedDateText}</p>}</div>
      <div><h3>Payment</h3><p>{Number(doc.paymentTermsDays) ? `Within ${doc.paymentTermsDays} days` : 'On delivery'}</p></div>
    </div>
    <table>
      <thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col" className="is-num">Quantity</th><th scope="col" className="is-num">Price</th><th scope="col" className="is-num">Total</th></tr></thead>
      <tbody>{(doc.lines || []).map((line) => <tr key={line.n}>
        <td>{line.n}</td><td>{line.item}</td><td className="is-num">{formatNumber(line.qty)} {Number(line.qty) === 1 ? line.unit : plural(line.unit)}</td>
        <td className="is-num">{money(line.unitPrice)}</td><td className="is-num">{money(line.lineTotal)}</td>
      </tr>)}</tbody>
    </table>
    <div className="po-doc-totals">
      <div><span>Subtotal</span><span>{money(doc.totals?.subtotal)}</span></div>
      <div><span>VAT</span><span>{money(doc.totals?.vat)}</span></div>
      <div className="is-total"><span>Total</span><span>{money(doc.totals?.total)}</span></div>
    </div>
    {doc.notes && <p className="po-doc-foot">{doc.notes}</p>}
    <p className="po-doc-foot">Please confirm you have received this order. Thank you.</p>
  </article>;
}

export default function PoDocument({ document: doc, print = false }) {
  if (!doc) return null;
  return <>
    <Sheet document={doc} />
    {print && createPortal(<div className="po-print-root" aria-hidden="true"><Sheet document={doc} /></div>, window.document.body)}
  </>;
}
