import { Link } from 'react-router-dom';
import Glyph from '../../components/media/Glyph';
import { OrderCard, ReadyCard, RequestCard } from '../../components/waiter/OpsCards';
import { LiveNote, PageHeader } from '../../components/waiter/WaiterBits';
import { useLive, useTicker } from '../../components/waiter/LiveProvider';

/** The waiter's main screen: everything that needs attention, newest first. */
export default function WaiterServicesPage({ section }) {
  const { items, loading, live, fresh } = useLive();
  useTicker();
  const count = items.length;
  return <>
    <PageHeader title={section.label} subtitle={live ? (count ? `${count} need${count === 1 ? 's' : ''} attention, newest first` : 'Needs attention, newest first') : section.description}
      action={<Link className="w-btn w-btn-secondary w-btn-small" to="/waiter/order/new"><Glyph name="plus" size={16} />New order</Link>} />
    <LiveNote />
    {loading && !live && <div className="w-stack" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="w-card-skeleton" />)}</div>}
    {live && count === 0 && <div className="w-empty is-calm">
      <span className="w-empty-icon"><Glyph name="check" size={28} strokeWidth={2.2} /></span>
      <h2>All caught up</h2>
      <p>Guests ready to order, calls, bills and orders to serve appear here as they come in.</p>
    </div>}
    {count > 0 && <section aria-label="Needs attention" className="w-stack w-feed">
      {items.map((item) => item.kind === 'request'
        ? <RequestCard key={item.key} request={item.request} fresh={Boolean(fresh[item.key])} />
        : item.kind === 'ready'
          ? <ReadyCard key={item.key} cart={item.cart} fresh={Boolean(fresh[item.key])} />
          : <OrderCard key={item.key} order={item.order} showTable fresh={Boolean(fresh[item.key])}
            headline={item.kind === 'serve' ? 'Confirmed · to serve' : 'Served · waiting to pay'} />)}
    </section>}
  </>;
}
