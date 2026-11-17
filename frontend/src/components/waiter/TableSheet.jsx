import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import Sheet from '../Sheet';
import Glyph from '../media/Glyph';
import { formatPrice } from '../../lib/format';
import { formatRelative, opsApi } from '../../lib/ops';
import usePolling from '../../lib/usePolling';
import { OrderCard, ReadyCard, RequestCard } from './OpsCards';
import { useLive } from './LiveProvider';

/**
 * The table's shared order (docs/v2/TABLE-SESSIONS.md): its join code to read out to guests, how many people, and
 * whether staff have been at the table yet. "Not confirmed at the table yet" means nobody from staff has seen these
 * guests: it may be someone with a photo of the table's QR. Close table / New code / Confirm guests are here.
 */
function TableSession({ number }) {
  const load = useCallback((signal) => opsApi.tableSessions(signal), []);
  const { data, refresh } = usePolling(load, { interval: 10000 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const session = data?.sessions?.find((s) => s.table?.number === number);
  if (!session) return null;
  const act = async (kind, fn) => {
    setBusy(kind); setError('');
    try { await fn(session.id); await refresh({ queue: true }); } catch (actionError) { setError(actionError.message); } finally { setBusy(''); }
  };
  const people = `${session.people} ${session.people === 1 ? 'person' : 'people'}`;
  return <section className={`w-card w-session${session.verified ? '' : ' is-unverified'}`} aria-labelledby={`ts-session-${number}`}>
    <div className="w-session-head">
      <div>
        <h3 id={`ts-session-${number}`} className="w-session-title">Ordering together</h3>
        <p className="w-muted">{session.verified ? people : `Not confirmed at the table yet · ${people}`} · last activity {formatRelative(session.lastActiveAt).toLowerCase()}</p>
      </div>
      <p className="w-session-code" aria-label={`Join code ${session.joinCode.split('').join(' ')}`}>{session.joinCode}</p>
    </div>
    {session.joinLockedUntil && <p className="w-session-note"><Glyph name="alert" size={15} />Joining is paused after wrong codes. A new code lifts it.</p>}
    {error && <p className="w-session-note is-error" role="alert"><Glyph name="alert" size={15} />{error}</p>}
    <div className="w-session-actions">
      {!session.verified && <button type="button" className="w-btn w-btn-secondary w-btn-small" disabled={Boolean(busy)} onClick={() => act('verify', opsApi.verifyTableSession)}>
        <Glyph name="check" size={16} />{busy === 'verify' ? 'Saving…' : 'Confirm guests are here'}</button>}
      <button type="button" className="w-btn w-btn-quiet w-btn-small" disabled={Boolean(busy)} onClick={() => act('code', opsApi.newTableCode)}>{busy === 'code' ? 'Changing…' : 'New code'}</button>
      <button type="button" className="w-btn w-btn-quiet w-btn-small" disabled={Boolean(busy)} onClick={() => act('close', opsApi.closeTableSession)}>{busy === 'close' ? 'Closing…' : 'Close table'}</button>
    </div>
  </section>;
}

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
      <TableSession number={number} />
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
