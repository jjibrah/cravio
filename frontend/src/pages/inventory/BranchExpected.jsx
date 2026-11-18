// "Expected deliveries" on branch Stock: orders on their way to THIS branch. Press Receive when the goods arrive; the same receive
// sheet the owner uses opens (no prices, no invoice: just what arrived and what was rejected).
import { useState } from 'react';
import { useApi } from '../../lib/api';
import { branchPaths, formatDay, todayNairobi } from '../../lib/inventory';
import { Panel, TaskDrawer } from './parts';
import ReceiveSheet from './ReceiveSheet';
import { StatusBadge } from './PurchasingParts';
import './receiving.css';

export default function BranchExpected({ units, onReceived }) {
  const list = useApi(branchPaths.expected, { ttl: 10000 });
  const [order, setOrder] = useState(null);
  const orders = list.data?.orders || [];
  const today = todayNairobi();
  if (!orders.length) return null; // nothing on its way: no card
  const close = () => { setOrder(null); list.refresh(); };
  return <>
    <Panel title="Expected deliveries" count={orders.length} sub="Orders on their way to this branch. Press Receive when the goods arrive.">
      <ul className="rcv-cards">{orders.map((o) => {
        const late = o.expectedDate && o.expectedDate < today;
        return <li key={o.id} className="rcv-card">
          <div className="rcv-card-main"><strong>{o.number} · {o.supplier?.name}</strong>
            <small>{o.lines.length} {o.lines.length === 1 ? 'item' : 'items'}: {o.lines.slice(0, 3).map((l) => `${l.itemName} ${l.outstanding}`).join(', ')}{o.lines.length > 3 ? '…' : ''}</small>
            <small>{o.expectedDate ? <>Expected <span className={late ? 'is-late' : undefined}>{formatDay(o.expectedDate)}{late ? ' (late)' : ''}</span></> : 'No date was given'}</small></div>
          <div className="rcv-card-side"><StatusBadge status={o.status} />
            <button type="button" className="o-btn is-primary" aria-label={`Receive ${o.number}`} onClick={() => setOrder(o)}>Receive</button></div>
        </li>;
      })}</ul>
    </Panel>
    {order && <TaskDrawer open title={`Receive ${order.number}`} onClose={close} wide>
      <ReceiveSheet key={order.id} mode="branch" ctx={{ data: { units } }} order={order} onClose={close} onDone={onReceived} /></TaskDrawer>}
  </>;
}
