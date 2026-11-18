// The owner's view of the branches' emergency purchases (a tab on Approvals): what each branch bought on the spot, with its invoice
// and photos, and a way to review it and close it. Approving the buy beforehand happens under "Waiting for you".
import { useMemo, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { INVOICE_LABEL, formatStamp, formatStockMoney, useInventoryWrite } from '../../lib/inventory';
import { EmergencyDetail, EmergencyStatus } from './EmergencyParts';
import { EmptyState, ErrorState, FormError, Panel, SkeletonRows, TaskDrawer } from './parts';

const GROUPS = [
  { value: 'review', label: 'Needs a look', statuses: ['under_review'] },
  { value: 'open', label: 'In progress', statuses: ['draft', 'pending_approval', 'authorised', 'purchased'] },
  { value: 'done', label: 'Received and closed', statuses: ['received', 'closed'] },
  { value: 'other', label: 'Sent back or cancelled', statuses: ['rejected', 'cancelled'] },
];

function ReviewSheet({ ctx, id, onClose, onChanged }) {
  const detail = useApi(ctx.paths.emergencyOne(id), { ttl: 2000 });
  const { notify } = useNotifications();
  const [note, setNote] = useState('');
  const [clawback, setClawback] = useState('');
  const [flagging, setFlagging] = useState(false);
  const [problem, setProblem] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  const purchase = detail.data;
  const canReview = purchase && ['received', 'under_review'].includes(purchase.status);

  async function review(outcome) {
    if (outcome === 'flag' && !note.trim()) return setProblem('Say what looks wrong, so there is something to follow up.');
    setProblem('');
    const body = { outcome, ...(note.trim() ? { note: note.trim() } : {}), ...(outcome === 'close' && clawback.trim() ? { clawbackNote: clawback.trim() } : {}) };
    const result = await run('POST', ctx.paths.emergencyReview(id), body, { step: `review-${outcome}` });
    if (!result) return undefined;
    notify(outcome === 'close' ? `${purchase.number} is reviewed and closed.` : `${purchase.number} is marked for follow-up.`);
    onChanged();
    onClose();
    return undefined;
  }

  return <TaskDrawer open title={purchase ? purchase.number : 'Branch purchase'} onClose={onClose} wide>
    {detail.error && !purchase ? <p className="o-field-error" role="alert">{detail.error.message || 'This purchase could not be loaded.'}</p>
      : !purchase ? <SkeletonRows rows={4} thumb={false} label="Loading the purchase" />
        : <div className="inv-form">
          <p><EmergencyStatus status={purchase.status} /></p>
          <EmergencyDetail purchase={purchase} />
          {purchase.clawbackNote && <p className="inv-note">Money to recover: {purchase.clawbackNote}</p>}
          {canReview && <>
            <div className="o-field"><label className="o-label" htmlFor="rv-note">{flagging ? 'What looks wrong?' : 'Note'} {!flagging && <span className="o-optional">Optional</span>}</label>
              <input id="rv-note" className="o-input" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></div>
            {!flagging && <div className="o-field"><label className="o-label" htmlFor="rv-claw">Money to get back from someone <span className="o-optional">Optional</span></label>
              <input id="rv-claw" className="o-input" value={clawback} maxLength={500} placeholder="For example: Ksh 400 over the price, to be repaid" onChange={(event) => setClawback(event.target.value)} /></div>}
            <FormError error={problem || error} />
            <div className="biz-form-actions">
              {flagging ? <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => review('flag')}>Mark for follow-up</button>
                : <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => review('close')}>{busy ? 'Saving…' : 'Looks fine, close it'}</button>}
              {purchase.status === 'received' && <button type="button" className="o-btn" disabled={busy} onClick={() => { setFlagging(!flagging); setProblem(''); }}>{flagging ? 'Back' : 'Something looks wrong'}</button>}
            </div></>}
        </div>}
  </TaskDrawer>;
}

export function BranchPurchasesOwner({ ctx }) {
  const list = useApi(ctx.paths.emergency({ limit: 200 }), { ttl: 8000 });
  const [group, setGroup] = useState('');
  const [open, setOpen] = useState(null);
  const purchases = list.data?.purchases;
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [g.value, (purchases || []).filter((p) => g.statuses.includes(p.status)).length])), [purchases]);
  const active = group || (counts.review ? 'review' : 'open');
  const rows = (purchases || []).filter((p) => GROUPS.find((g) => g.value === active).statuses.includes(p.status));
  return <>
    <Panel title="Branch purchases" count={purchases ? purchases.length : undefined} sub="What your branches bought on the spot. Look at each one once the goods are in, then close it.">
      {list.error && !purchases ? <ErrorState error={list.error} onRetry={list.refresh} what="branch purchases" />
        : !purchases ? <SkeletonRows rows={3} thumb={false} label="Loading branch purchases" />
          : !purchases.length ? <EmptyState icon="orders" tone="neutral" title="No branch purchases yet">When a branch buys something in an emergency, it is listed here.</EmptyState>
            : <>
              <div className="pur-chips" role="group" aria-label="Show">
                {GROUPS.map((g) => <button key={g.value} type="button" className="pur-chip" aria-pressed={active === g.value} onClick={() => setGroup(g.value)}>{g.label}<small>{counts[g.value]}</small></button>)}
              </div>
              {!rows.length ? <EmptyState icon="check" title="Nothing here">Nothing is in this group.</EmptyState>
                : <ul className="rcv-cards">{rows.map((p) => <li key={p.id} className="rcv-card">
                  <div className="rcv-card-main"><strong>{p.number} · {p.locationName}</strong>
                    <small>{p.supplierName} · {formatStockMoney(p.actualTotal ?? p.estimatedTotal)}{p.invoiceStatus ? ` · ${INVOICE_LABEL[p.invoiceStatus]}` : ''}</small>
                    <small>{p.reason}</small><small>{formatStamp(p.createdAt)}</small></div>
                  <div className="rcv-card-side"><EmergencyStatus status={p.status} />
                    <button type="button" className={`o-btn${['received', 'under_review'].includes(p.status) ? ' is-primary' : ''}`} aria-label={`${['received', 'under_review'].includes(p.status) ? 'Review' : 'Open'} ${p.number}`} onClick={() => setOpen(p.id)}>
                      {['received', 'under_review'].includes(p.status) ? 'Review' : 'Open'}</button></div>
                </li>)}</ul>}
            </>}
    </Panel>
    {open && <ReviewSheet key={open} ctx={ctx} id={open} onClose={() => setOpen(null)} onChanged={list.refresh} />}
  </>;
}
