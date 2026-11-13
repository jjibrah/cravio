import { useEffect, useId, useState } from 'react';
import { useNotifications } from '../notifications/NotificationProvider';
import {
  NEXT_ACTION, ORDER_STAGES, PAY_METHODS, componentsText, confirmationOf, extrasText, formatClock, formatDateTime, formatKes,
  formatRelative, opsApi, payMethodLabel, shortId, tableName, useNow, useResource,
} from '../../lib/ops';
import Drawer from './Drawer';
import { ErrorState, OIcon, SkeletonRows, StatusChip } from './ui';

/**
 * Order detail in a drawer (bottom sheet on phones), following the client's sample:
 * title, placed time and how it was confirmed, items (with extras and what's in each deal) and the total,
 * "What happened" (Confirmed → Served → Paid), and the next step. There is no accept step.
 * `onChanged(order)` runs after any successful change so lists can refresh.
 */
export default function OrderDrawer({ orderId, onClose, onChanged, preview }) {
  const [title, setTitle] = useState(preview ? `${tableName(preview)} · ${shortId(preview)}` : 'Order');
  const [chip, setChip] = useState(preview ? { status: preview.status, label: preview.statusLabel } : null);
  useEffect(() => { if (preview) { setTitle(`${tableName(preview)} · ${shortId(preview)}`); setChip({ status: preview.status, label: preview.statusLabel }); } }, [preview]);
  return <Drawer open={Boolean(orderId)} onClose={onClose} title={title} className="o-order-drawer"
    header={chip && <StatusChip status={chip.status} label={chip.label} />}>
    {orderId && <OrderDetail key={orderId} orderId={orderId} onChanged={onChanged}
      onLoaded={(order) => { setTitle(`${tableName(order)} · ${shortId(order)}`); setChip({ status: order.status, label: order.statusLabel }); }} />}
  </Drawer>;
}

function OrderDetail({ orderId, onChanged, onLoaded }) {
  const { notify } = useNotifications();
  const now = useNow();
  const { data, error, loading, reload, setData } = useResource((signal) => opsApi.order(orderId, signal), [orderId]);
  const order = data?.order;
  const [mode, setMode] = useState('idle'); // idle | pay | cancel
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { tone, text }
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [methodError, setMethodError] = useState('');
  const methodName = useId();
  const refId = useId();
  const reasonId = useId();

  useEffect(() => { if (order) onLoaded?.(order); }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening the pay or cancel form moves focus into it.
  useEffect(() => {
    if (mode === 'pay') document.querySelector(`input[name="${methodName}"]`)?.focus();
    if (mode === 'cancel') document.getElementById(reasonId)?.focus();
  }, [mode, methodName, reasonId]);

  async function run(action, success) {
    setBusy(true);
    setNote(null);
    try {
      const result = await action();
      setData({ order: result.order });
      setMode('idle');
      notify(success);
      onChanged?.(result.order);
    } catch (problem) {
      if (problem.status === 409 || problem.status === 404) {
        setNote({ tone: 'warning', text: problem.status === 409
          ? `Someone else just updated this order. ${problem.message} We’ve loaded the latest.`
          : problem.message });
        setMode('idle');
        await reload({ quiet: true });
        onChanged?.();
      } else {
        setNote({ tone: 'error', text: problem.message });
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading && !order) return <SkeletonRows rows={5} thumb={false} label="Loading order" />;
  if (error && !order) return <ErrorState error={error} onRetry={reload} what="this order" />;
  if (!order) return null;

  const action = NEXT_ACTION[order.nextAction];
  const how = confirmationOf(order);
  const timeline = (order.timeline || ORDER_STAGES.map((stage) => ({ stage: stage.key, at: order[`${stage.key}At`], by: order[`${stage.key}By`] })))
    .filter((step) => step.stage !== 'accepted');

  const primary = () => {
    if (order.nextAction === 'pay') { setMode('pay'); setMethodError(''); return; }
    run(() => opsApi.advance(order.id, order.status), action.done);
  };
  const confirmPay = (event) => {
    event.preventDefault();
    if (!method) { setMethodError('Choose how they paid.'); return; }
    run(() => opsApi.pay(order.id, order.status, method, reference.trim()), `Paid by ${payMethodLabel(method)}. ${formatKes(order.total)} recorded.`);
  };
  const confirmCancel = (event) => {
    event.preventDefault();
    run(() => opsApi.cancel(order.id, order.status, reason.trim()), 'Order cancelled.');
  };

  return <div className="o-order">
    <p className="o-order-placed">
      Placed {formatDateTime(order.takenAt || order.createdAt)} <span aria-hidden="true">·</span> {formatRelative(order.takenAt || order.createdAt, now)}
      {how && <span className={`o-tag ${how.warn ? 'is-warning' : 'is-confirmed'}`}>{how.warn && <OIcon name="alert" size={12} />}{how.tag}</span>}
    </p>

    {note && <div className={`o-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}><OIcon name={note.tone === 'error' ? 'alert' : 'info'} size={16} /><span>{note.text}</span></div>}

    <section className="o-order-section" aria-labelledby={`${orderId}-items`}>
      <h3 id={`${orderId}-items`} className="o-order-heading">Items</h3>
      <ul className="o-order-items">
        {order.items.map((line) => <li key={line.id}>
          <span className="o-order-qty">{line.quantity}×</span>
          <span className="o-order-item"><span>{line.name}{line.kind === 'deal' && <span className="o-deal-tag">Deal</span>}</span>
            {line.extras?.length > 0 && <span className="o-order-item-extras">{extrasText(line.extras)}</span>}
            {line.kind === 'deal' && line.components?.length > 0 && <span className="o-order-item-extras">{line.name}: {componentsText(line.components)}</span>}
            {line.note && <span className="o-order-item-note">“{line.note}”</span>}</span>
          <span className="o-order-amount">{formatKes(line.lineTotal)}</span>
        </li>)}
      </ul>
      <p className="o-order-total"><span>Total</span><span>{formatKes(order.total)}</span></p>
      {order.note && <p className="o-order-note"><strong>Note:</strong> {order.note}</p>}
    </section>

    <section className="o-order-section" aria-labelledby={`${orderId}-history`}>
      <h3 id={`${orderId}-history`} className="o-order-heading">What happened</h3>
      <ol className="o-timeline">
        {timeline.map((step, index) => {
          const confirmedStep = step.stage === 'taken';
          const label = confirmedStep && how?.warn ? 'Entered' : step.label || ORDER_STAGES.find((stage) => stage.key === step.stage)?.label || step.stage;
          const done = Boolean(step.at);
          const next = timeline[index + 1];
          const by = step.by?.name ? `by ${step.by.name} ` : '';
          // "Confirmed with the guest by Jane at 10:45 (QR)" · "Entered by Jane at 10:45" + a warning tag.
          const detail = confirmedStep && how && !how.warn ? `with the guest ${by}at ${formatClock(step.at)} (${how.how})` : `${by}at ${formatClock(step.at)}`;
          return <li key={step.stage} className={`o-timeline-step${done ? ' is-done' : ''}${next?.at ? ' is-linked' : ''}`}>
            <span className="o-timeline-node" aria-hidden="true">{done && <OIcon name="check" size={10} strokeWidth={3} />}</span>
            <span className="o-timeline-label">{label}</span>
            <span className="o-timeline-detail">{done
              ? <>{detail}{step.stage === 'paid' && order.payment?.method ? ` · ${payMethodLabel(order.payment.method)}${order.payment.reference ? ` (${order.payment.reference})` : ''}` : ''}
                {confirmedStep && how?.warn && <span className="o-tag is-warning o-timeline-tag"><OIcon name="alert" size={12} />Not confirmed by the guest</span>}</>
              : order.status === 'cancelled' ? '—' : 'Not yet'}</span>
          </li>;
        })}
        {order.status === 'cancelled' && <li className="o-timeline-step is-cancelled">
          <span className="o-timeline-node" aria-hidden="true"><OIcon name="close" size={10} strokeWidth={3} /></span>
          <span className="o-timeline-label">Cancelled</span>
          <span className="o-timeline-detail">{order.cancelledBy?.name ? `by ${order.cancelledBy.name} ` : ''}at {formatClock(order.cancelledAt)}{order.cancelReason ? ` · “${order.cancelReason}”` : ''}</span>
        </li>}
      </ol>
    </section>

    <section className="o-order-section o-order-next" aria-labelledby={`${orderId}-next`}>
      <h3 id={`${orderId}-next`} className="o-order-heading">Next step</h3>
      {!action && order.status === 'paid' && <p className="o-order-final"><OIcon name="check" size={16} />All done. This order is paid.</p>}
      {!action && order.status === 'cancelled' && <p className="o-order-final is-cancelled"><OIcon name="close" size={16} />Nothing to do. This order was cancelled.</p>}

      {action && mode === 'idle' && <div className="o-order-actions">
        <button type="button" className="o-btn is-primary is-large" onClick={primary} disabled={busy} data-autofocus>
          {busy ? 'Saving…' : order.nextAction === 'pay' ? `Mark paid · ${formatKes(order.total)}` : action.label}
        </button>
        {order.canCancel && <button type="button" className="o-btn is-quiet is-danger" onClick={() => { setMode('cancel'); setReason(''); }} disabled={busy}>Cancel order</button>}
      </div>}

      {mode === 'pay' && <form className="o-inline-form" onSubmit={confirmPay} noValidate>
        <fieldset className="o-fieldset" aria-describedby={methodError ? `${methodName}-error` : undefined}>
          <legend>How did they pay?</legend>
          <div className="o-method-grid">
            {PAY_METHODS.map((option) => <label key={option.key} className={`o-method${method === option.key ? ' is-selected' : ''}`}>
              <input type="radio" name={methodName} value={option.key} checked={method === option.key} onChange={() => { setMethod(option.key); setMethodError(''); }} />
              <span>{option.label}</span>
            </label>)}
          </div>
          {methodError && <p className="o-field-error" id={`${methodName}-error`} role="alert">{methodError}</p>}
        </fieldset>
        <label className="o-label" htmlFor={refId}>Reference <span className="o-optional">optional</span></label>
        <input id={refId} className="o-input" value={reference} maxLength={60} onChange={(event) => setReference(event.target.value)}
          placeholder={method === 'mpesa' ? 'M-Pesa code, like SKL4ABC12X' : 'Receipt or slip number'} autoComplete="off" />
        <div className="o-order-actions">
          <button type="submit" className="o-btn is-primary is-large" disabled={busy}>{busy ? 'Saving…' : `Confirm ${formatKes(order.total)} paid`}</button>
          <button type="button" className="o-btn is-quiet" onClick={() => setMode('idle')} disabled={busy}>Back</button>
        </div>
      </form>}

      {mode === 'cancel' && <form className="o-inline-form is-danger" onSubmit={confirmCancel} noValidate>
        <p className="o-inline-title">Cancel this order?</p>
        <p className="o-inline-help">It stays in the list as cancelled and won’t count towards sales.</p>
        <label className="o-label" htmlFor={reasonId}>Reason <span className="o-optional">optional</span></label>
        <input id={reasonId} className="o-input" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="For example: guest left" autoComplete="off" data-autofocus />
        <div className="o-order-actions">
          <button type="submit" className="o-btn is-danger-solid is-large" disabled={busy}>{busy ? 'Cancelling…' : 'Cancel order'}</button>
          <button type="button" className="o-btn is-quiet" onClick={() => setMode('idle')} disabled={busy}>Keep order</button>
        </div>
      </form>}
    </section>
  </div>;
}
