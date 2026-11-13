import { Link } from 'react-router-dom';
import Sheet from '../Sheet';
import Glyph from '../media/Glyph';
import { formatPrice } from '../../lib/format';
import { OrderCard, ReadyCard, RequestCard } from './OpsCards';
import { useLive } from './LiveProvider';

/** One table up close: a guest ready to order, open requests, open orders with the next step, and "New order for Table N". */
export default function TableSheet({ number, onClose }) {
  const { live, fresh } = useLive();
  const table = live?.tables?.find((t) => t.number === number);
  const requests = (live?.requests || []).filter((r) => r.table?.number === number);
  const orders = (live?.orders || []).filter((o) => o.table?.number === number);
  const ready = (live?.readyToOrder || []).filter((cart) => cart.tableNumber === number);
  const unpaid = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  return <Sheet open={number != null} onClose={onClose} title={number != null ? `Table ${number}` : 'Table'} className="w-sheet w-table-sheet">
    {number != null && <div className="w-table-detail">
      {table?.section?.name && <p className="w-muted">{table.section.name}</p>}
      {ready.length > 0 && <div className="w-stack">{ready.map((cart) => <ReadyCard key={cart.id} cart={cart} showTable={false} fresh={Boolean(fresh[`c:${cart.id}`])} />)}</div>}
      {requests.length > 0 && <section aria-labelledby="ts-requests"><h3 id="ts-requests" className="w-subhead">Asking for</h3>
        <div className="w-stack">{requests.map((request) => <RequestCard key={request.id} request={request} showTable={false} fresh={Boolean(fresh[`r:${request.id}`])} />)}</div>
      </section>}
      {orders.length > 0 && <section aria-labelledby="ts-orders"><h3 id="ts-orders" className="w-subhead">Open orders <span>{formatPrice(unpaid)} unpaid</span></h3>
        <div className="w-stack">{orders.map((order) => <OrderCard key={order.id} order={order} />)}</div>
      </section>}
      {!requests.length && !orders.length && !ready.length && <p className="w-empty-line"><Glyph name="check" size={18} />Nothing open. The table is free.</p>}
      <Link className="w-btn w-btn-primary w-btn-big" to={`/waiter/order/new?table=${number}`}><Glyph name="plus" size={20} />New order for Table {number}</Link>
    </div>}
  </Sheet>;
}
