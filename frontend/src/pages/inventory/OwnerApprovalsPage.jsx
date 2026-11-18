// Owner Approvals (/owner/inventory/approvals): everything that needs a yes or a no, in one place. Tabs: Waiting for you, Decided, and
// Branch purchases (the emergency buys, to look at once the goods are in). Every card says who asked, what for and how much, and
// which rule sent it here. Approve asks "are you sure"; Send back needs a reason, so the person knows what to change.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { APPROVAL_SUBJECT_LABEL, formatDay, formatStamp, formatStockMoney, useInventoryWrite } from '../../lib/inventory';
import { BranchPurchasesOwner } from './OwnerBranchPurchases';
import { EmergencyDetail } from './EmergencyParts';
import { EmptyState, ErrorState, FormError, OwnerFrame, Panel, SkeletonRows } from './parts';
import { Segmented } from '../../components/owner/ui';
import { Facts } from './ReceivingParts';
import './purchasing.css';
import './receiving.css';

/** What a purchase order, an emergency buy or any other request is, in a few plain lines. */
function Subject({ approval, ctx }) {
  const emergency = useApi(approval.subject === 'emergency_purchase' ? ctx.paths.emergencyOne(approval.subjectId) : null, { ttl: 20000 });
  const summary = approval.summary;
  if (approval.subject === 'purchase_order' && summary) {
    return <>
      <Facts items={[['Order', summary.number], ['Supplier', summary.supplierName], ['Total', summary.total !== null && summary.total !== undefined ? formatStockMoney(summary.total) : null],
        ['Items', `${summary.lineCount} ${summary.lineCount === 1 ? 'line' : 'lines'}`], ['Deliver to', summary.deliverTo], ['Needed by', summary.expectedDate ? formatDay(summary.expectedDate) : null]]} />
      <p><Link className="inv-link" to={`/owner/inventory/purchase-orders?po=${approval.subjectId}`}>Open the order</Link></p>
    </>;
  }
  if (approval.subject === 'emergency_purchase') {
    if (emergency.error && !emergency.data) return <p className="o-field-hint">The purchase details could not be loaded. {emergency.error.message}</p>;
    return emergency.data ? <EmergencyDetail purchase={emergency.data} /> : <SkeletonRows rows={2} thumb={false} label="Loading the purchase" />;
  }
  return <Facts items={[['Where', approval.locationName], ['Amount', approval.amountKes ? formatStockMoney(approval.amountKes) : null]]} />;
}

function Card({ approval, ctx, onDecided }) {
  const { notify } = useNotifications();
  const [mode, setMode] = useState(null); // null | approve | reject
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  const pending = approval.status === 'pending';
  const label = APPROVAL_SUBJECT_LABEL[approval.subject] || 'Request';
  const amount = approval.amountKes ? formatStockMoney(approval.amountKes) : null;
  const what = approval.summary?.number || label.toLowerCase();

  async function decide(decision) {
    if (decision === 'reject' && !note.trim()) return setProblem('Say what needs to change, so the person who asked knows.');
    setProblem('');
    const result = await run('POST', ctx.paths.approvalDecide(approval.id), { decision, ...(note.trim() ? { note: note.trim() } : {}) }, { step: `${approval.id}-${decision}` });
    if (!result) return undefined;
    notify(decision === 'approve' ? `Approved${amount ? ` ${amount}` : ''}.` : 'Sent back. They can see why.');
    onDecided();
    return undefined;
  }

  return <li className="rcv-card rcv-approval">
    <div className="rcv-card-side" style={{ justifyContent: 'space-between' }}>
      <div className="rcv-card-main"><strong>{label}{amount ? ` · ${amount}` : ''}</strong>
        <small>Asked by {approval.requestedByName || 'someone'}{approval.locationName ? ` · ${approval.locationName}` : ''} · {formatStamp(approval.requestedAt)}</small></div>
      <div className="rcv-card-side">
        {approval.status === 'approved' && <span className="inv-badge is-ok">Approved</span>}
        {approval.status === 'rejected' && <span className="inv-badge is-out">Sent back</span>}
        {approval.status === 'cancelled' && <span className="inv-badge is-off">Withdrawn</span>}
        {approval.selfApproved && <span className="inv-badge is-off">Self-approved</span>}
      </div>
    </div>
    <Subject approval={approval} ctx={ctx} />
    {(approval.reasons?.length > 0 || approval.safeDefault) && <p className="o-field-hint"><strong>Why it came to you:</strong> {approval.reasons?.length ? approval.reasons.join(' ') : 'No limit is set for this, so it needs your approval.'}</p>}
    {!pending && approval.decidedByName && <p className="o-field-hint">{approval.status === 'rejected' ? 'Sent back' : approval.status === 'cancelled' ? 'Withdrawn' : 'Approved'}{approval.decidedByName ? ` by ${approval.decidedByName}` : ''}{approval.decidedAt ? ` · ${formatStamp(approval.decidedAt)}` : ''}{approval.decisionNote ? `: “${approval.decisionNote}”` : ''}</p>}
    {approval.selfApproved && <p className="o-field-hint">You were the only person who could approve this, so it is marked self-approved.</p>}
    {pending && approval.canDecide === false && <p className="inv-note" role="status">{approval.blocked || 'Another approver has to decide this.'}</p>}
    {pending && approval.canDecide !== false && <div className="rcv-decide" style={{ padding: 0 }}>
      {!mode && <div className="biz-form-actions" style={{ margin: 0 }}>
        <button type="button" className="o-btn is-primary" aria-label={`Approve ${what}`} onClick={() => setMode('approve')}>Approve</button>
        <button type="button" className="o-btn" aria-label={`Send back ${what}`} onClick={() => setMode('reject')}>Send back</button></div>}
      {mode === 'approve' && <div className="inv-confirm" role="group" aria-label="Confirm approval">
        <span>Approve {amount ? `${amount} for ` : ''}this {label.toLowerCase()}? {approval.subject === 'emergency_purchase' ? 'The branch can then go and buy it.' : ''}</span>
        <label className="visually-hidden" htmlFor={`note-${approval.id}`}>Note (optional)</label>
        <input id={`note-${approval.id}`} className="o-input" placeholder="Add a note (optional)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        <div className="inv-confirm-actions">
          <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving…' : 'Yes, approve'}</button>
          <button type="button" className="o-btn is-quiet" disabled={busy} onClick={() => { setMode(null); setNote(''); }}>Not yet</button></div></div>}
      {mode === 'reject' && <div className="inv-confirm" role="group" aria-label="Send back with a reason">
        <label className="o-label" htmlFor={`why-${approval.id}`}>Why are you sending it back?</label>
        <input id={`why-${approval.id}`} className="o-input" placeholder="For example: too expensive, ask another supplier" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} data-autofocus />
        <div className="inv-confirm-actions">
          <button type="button" className="o-btn is-primary" disabled={busy} onClick={() => decide('reject')}>{busy ? 'Sending…' : 'Send back'}</button>
          <button type="button" className="o-btn is-quiet" disabled={busy} onClick={() => { setMode(null); setNote(''); setProblem(''); }}>Cancel</button></div></div>}
      <FormError error={problem || error} />
    </div>}
  </li>;
}

function Inbox({ ctx, status, emptyTitle, emptyText }) {
  const list = useApi(ctx.paths.approvals({ status, limit: 50 }), { ttl: 5000 });
  const rows = list.data?.approvals;
  return <Panel title={status === 'pending' ? 'Waiting for you' : 'Decided'} count={rows ? rows.length : undefined}
    sub={status === 'pending' ? 'Each one says who asked, what for and how much. Approve it, or send it back with a reason.' : 'What has been decided, newest first, and who decided it.'}>
    {list.error && !rows ? <ErrorState error={list.error} onRetry={list.refresh} what="approvals" />
      : !rows ? <SkeletonRows rows={3} thumb={false} label="Loading approvals" />
        : !rows.length ? <EmptyState icon="success" title={emptyTitle}>{emptyText}</EmptyState>
          : <ul className="rcv-cards">{rows.map((a) => <Card key={a.id} approval={a} ctx={ctx} onDecided={list.refresh} />)}</ul>}
  </Panel>;
}

function Body({ ctx }) {
  const [tab, setTab] = useState('pending');
  const waiting = useApi(ctx.paths.approvals({ status: 'pending', limit: 50 }), { ttl: 5000 });
  const count = waiting.data ? Number(waiting.data.pending ?? waiting.data.approvals?.length ?? 0) : null;
  return <>
    <Segmented mode="tabs" idBase="appr" label="Approvals" value={tab} onChange={setTab}
      options={[{ value: 'pending', label: 'Waiting for you', count }, { value: 'decided', label: 'Decided' }, { value: 'branch', label: 'Branch purchases' }]} />
    <div role="tabpanel" id="appr-panel" aria-labelledby={`appr-tab-${tab}`}>
      {tab === 'pending' && <Inbox ctx={ctx} status="pending" emptyTitle="Nothing needs your approval" emptyText="When a purchase order or a branch buy needs a decision, it appears here." />}
      {tab === 'decided' && <Inbox ctx={ctx} status="decided" emptyTitle="Nothing decided yet" emptyText="Approved and sent-back requests will be listed here." />}
      {tab === 'branch' && <BranchPurchasesOwner ctx={ctx} />}
    </div>
  </>;
}

export function OwnerApprovalsPage() {
  return <OwnerFrame title="Approvals" description="Orders and requests waiting for your decision.">{(ctx) => <Body ctx={ctx} />}</OwnerFrame>;
}
export default OwnerApprovalsPage;
