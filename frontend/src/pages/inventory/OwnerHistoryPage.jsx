// Owner History (/owner/inventory/history). There is no owner-wide movement list in the API yet (GET /api/owner/inventory/:biz/items/:id
// returns the item's last 20 movements across the places the owner sees), so this page shows one item at a time.
// TODO(P1-15/P2): when a business-wide history endpoint exists (filters: place, item, reason, date), replace the item picker with filters.
import { useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/api';
import { ownerPaths } from '../../lib/inventory';
import { EmptyState, ErrorState, OwnerFrame, Panel, SkeletonRows } from './parts';

export const REASON_LABEL = {
  opening: 'Opening stock', purchase_receipt: 'Delivery from supplier', emergency_receipt: 'Emergency purchase', transfer_receipt: 'Received from another place',
  transfer_dispatch: 'Sent to another place', transfer_cancelled: 'Transfer cancelled', transfer_discrepancy: 'Transfer difference', pos_consumption: 'Used in an order',
  served: 'Used in an order', wastage: 'Waste', waste: 'Waste', staff_meal: 'Staff meal', complimentary: 'Given free', adjustment_gain: 'Adjustment (more)',
  adjustment_loss: 'Adjustment (less)', count_correction: 'Counted', count: 'Counted', added: 'Added', received: 'Received', dispatched: 'Sent',
  dispatch_cancelled: 'Dispatch cancelled', lost_in_transit: 'Lost on the way', order_correction: 'Order correction', reversal: 'Reversed',
  supplier_return: 'Returned to supplier', production_input: 'Used in production', production_output: 'Made in production',
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function Movements({ ctx, itemId }) {
  const { data, error, loading, refresh } = useApi(itemId ? ownerPaths(ctx.business.id).item(itemId) : null, { ttl: 10000 });
  if (!itemId) return <EmptyState icon="clock" tone="neutral" title="Choose an item">Pick an item to see its latest stock changes.</EmptyState>;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} what="this item’s history" />;
  if (loading) return <SkeletonRows rows={5} thumb={false} label="Loading history" />;
  if (!data.movements.length) return <EmptyState icon="clock" tone="neutral" title="No stock changes yet">Set opening stock on the Stock page, then every change shows here.</EmptyState>;
  return <div className="inv-table-wrap"><table className="inv-table inv-cards">
    <thead><tr><th scope="col">When</th><th scope="col">Place</th><th scope="col" className="is-num">Change</th><th scope="col" className="is-num">Left after</th><th scope="col">Why</th></tr></thead>
    <tbody>{data.movements.map((m) => <tr key={m.id}>
      <td className="inv-nowrap">{when(m.occurredAt)}</td><td data-label="Place">{m.locationName}</td>
      <td className={`is-num${m.display.delta.startsWith('-') ? ' is-minus' : ''}`} data-label="Change">{m.display.delta}</td>
      <td className="is-num" data-label="Left after">{m.display.balanceAfter}</td>
      <td>{REASON_LABEL[m.reason] || m.reason.replace(/_/g, ' ')}{m.entered ? <small>Entered as {m.entered.quantity} {m.entered.unit}</small> : null}{m.note ? <small>{m.note}</small> : null}</td>
    </tr>)}</tbody>
  </table></div>;
}

function HistoryBody({ ctx }) {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const [itemId, setItemId] = useState(params.get('item') || '');
  const choose = (value) => { setItemId(value); setParams(value ? { item: value } : {}, { replace: true }); };
  return <Panel title="Stock changes" sub="The latest 20 changes for one item, across every place you can see.">
    <div className="inv-toolbar">
      <label className="visually-hidden" htmlFor={id}>Item</label>
      <select id={id} className="o-select inv-search" value={itemId} onChange={(event) => choose(event.target.value)}>
        <option value="">Choose an item…</option>
        {ctx.data.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </div>
    <Movements ctx={ctx} itemId={itemId} />
  </Panel>;
}

export default function OwnerHistoryPage() {
  return <OwnerFrame title="History" description="Every stock change for an item, newest first.">{(ctx) => <HistoryBody ctx={ctx} />}</OwnerFrame>;
}
