// Shortfalls (stock exceptions): orders that were served when the system showed too little stock. Each one can be
// marked as checked, with an optional note, once the item has been counted.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useApi } from '../../lib/api';
import { branchPaths, formatStamp, useInventoryWrite } from '../../lib/inventory';
import { EmptyState, ErrorState, FormError, SkeletonRows } from './parts';

function Shortfall({ row, onCount, onResolved }) {
  const id = useId();
  const { notify } = useNotifications();
  const [note, setNote] = useState('');
  const [run, { busy, error }] = useInventoryWrite();
  async function resolve(event) {
    event.preventDefault();
    const result = await run('POST', branchPaths.resolveException(row.id), { note: note.trim() });
    if (result) { notify(result.message); onResolved(); }
  }
  return <li>
    <div className="inv-short-line">
      <span><strong>{row.itemName}</strong> was short by <strong>{row.display.shortQty}</strong>
        {row.order && <> on order <Link className="inv-link" to={row.order.link}>#{row.order.shortId}</Link></>}</span>
      <small>{formatStamp(row.createdAt)}</small>
    </div>
    <form className="inv-short-form" onSubmit={resolve} noValidate>
      <label className="visually-hidden" htmlFor={id}>Note about {row.itemName} (optional)</label>
      <input id={id} className="o-input" placeholder="Note (optional)" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
      <button type="button" className="o-btn" onClick={() => onCount(row.itemId)} disabled={busy}>Count {row.itemName}</button>
      <button type="submit" className="o-btn is-primary" disabled={busy} aria-label={`Mark ${row.itemName} as checked`}>{busy ? 'Saving…' : 'Mark as checked'}</button>
    </form>
    <FormError error={error} />
  </li>;
}

export default function BranchShortfalls({ onCount, onChanged }) {
  const { data, error, loading, refresh } = useApi(branchPaths.exceptions(), { ttl: 5000 });
  const rows = data?.exceptions || [];
  return <div className="inv-form">
    <p className="o-field-hint">These orders were served when the system showed too little stock. Count the item to correct it, then mark it as checked.</p>
    {error && !data ? <ErrorState error={error} onRetry={refresh} what="shortfalls" compact />
      : loading && !data ? <SkeletonRows rows={3} thumb={false} label="Loading shortfalls" />
        : !rows.length ? <EmptyState icon="check" title="Nothing to check">Every shortfall has been checked.</EmptyState>
          : <ul className="inv-short">{rows.map((row) => <Shortfall key={row.id} row={row} onCount={onCount} onResolved={() => { refresh(); onChanged(); }} />)}</ul>}
  </div>;
}
