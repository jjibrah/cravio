// Owner Inventory: the main center's stock, every branch's balances, branch requests to review (approve fully or
// partly, or reject), dispatches to branches with a printable note and QR code, and the center's history.
// Operations managers see their assigned branches read-only.
import { useEffect, useId, useState } from 'react';
import QRCode from 'qrcode';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import '../business/business.css';
import { useApi } from '../../lib/api';
import {
  AdjustForm, FormError, LineEditor, Movements, NewItemForm, REQUEST_STATUS, StockError, TRANSFER_STATUS,
  cleanLines, servings, useCommand, when,
} from './parts';
import './stock.css';

function CenterStock({ data, base, canEdit }) {
  const [adjusting, setAdjusting] = useState(null);
  const [adding, setAdding] = useState(false);
  return <Panel title="Stock" count={data.items.length} sub="Main center and each branch, in servings. Branch balances change when orders are served."
    actions={canEdit && !adding && <button type="button" className="o-btn is-small" onClick={() => setAdding(true)}><OIcon name="plus" size={15} />New item</button>}>
    {adding && <NewItemForm path={`${base}/items`} onDone={() => setAdding(false)} />}
    {adjusting && <AdjustForm key={adjusting.id} item={adjusting} path={`${base}/adjust`} onDone={() => setAdjusting(null)} />}
    {data.items.length ? <div className="st-table-wrap"><table className="st-table st-matrix">
      <thead><tr><th scope="col">Item</th><th scope="col">Main center</th>
        {data.branches.map((branch) => <th scope="col" key={branch.id}>{branch.name}</th>)}{canEdit && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
      <tbody>{data.items.map((item) => <tr key={item.id}>
        <th scope="row">{item.name}{item.lowLevel !== null && <><br /><small>Low at {item.lowLevel}</small></>}</th>
        <td><strong>{servings(item.centerOnHand)}</strong></td>
        {data.branches.map((branch) => { const value = item.branches[branch.id]; return <td key={branch.id} className={value < 0 ? 'is-minus' : ''}>{value === undefined ? '—' : servings(value)}</td>; })}
        {canEdit && <td className="st-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => setAdjusting(item)}>Count / add / waste</button></td>}
      </tr>)}</tbody>
    </table></div> : <EmptyState icon="layers" tone="neutral" title="No stock items yet">{canEdit ? 'Add what you produce or buy for your branches, then count the main center.' : 'The owner hasn’t added any items.'}</EmptyState>}
  </Panel>;
}

function ReviewForm({ request, base, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [approved, setApproved] = useState(() => Object.fromEntries(request.lines.map((line) => [line.itemId, String(line.requested)])));
  const [note, setNote] = useState('');
  const decide = async (decision) => {
    const body = decision === 'reject' ? { decision, note } : { decision, note: note || undefined, lines: request.lines.map((line) => ({ itemId: line.itemId, approved: Number(approved[line.itemId]) })) };
    if (await run(`${base}/requests/${request.id}/review`, body, { success: `Request #${request.number} ${decision === 'reject' ? 'rejected' : 'approved'}.` })) onDone();
  };
  return <div className="st-form">
    <p className="o-field-hint">Approve less than asked (or 0) for any line. Approving doesn’t move stock: dispatch it next.</p>
    {request.lines.map((line) => <div className="o-field" key={line.itemId}>
      <label className="o-label" htmlFor={`${ids}-${line.itemId}`}>{line.name} <span className="o-optional">asked for {servings(line.requested)}</span></label>
      <input id={`${ids}-${line.itemId}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" max={line.requested} step="any"
        value={approved[line.itemId]} onChange={(event) => setApproved({ ...approved, [line.itemId]: event.target.value })} />
    </div>)}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note to the branch <span className="o-optional">Required to reject</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="button" className="o-btn is-primary" onClick={() => decide('approve')} disabled={busy}>Approve</button>
      <button type="button" className="o-btn" onClick={() => decide('reject')} disabled={busy || !note.trim()}>Reject</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </div>;
}

function Requests({ data, base, canEdit, onDispatched }) {
  const [reviewing, setReviewing] = useState(null);
  const [run, busy, error] = useCommand();
  const open = data.requests.filter((r) => r.status === 'submitted').length;
  return <Panel title="Branch requests" count={data.requests.length} sub={`${open} waiting for review`}>
    <FormError error={error} />
    {data.requests.length ? <ul className="biz-people">{data.requests.map((request) => <li key={request.id}>
      <div className="biz-person">
        <span className="biz-person-main"><strong>#{request.number} · {request.branchName} · {REQUEST_STATUS[request.status]}</strong>
          <span>{request.lines.map((line) => `${line.name}: ${servings(line.requested)}${line.approved !== null ? ` → ${line.approved}` : ''}`).join(' · ')}</span>
          {(request.note || request.reviewNote) && <span>{[request.note && `Branch: ${request.note}`, request.reviewNote && `You: ${request.reviewNote}`].filter(Boolean).join(' — ')}</span>}
          <span>{when(request.createdAt)}</span></span>
        {canEdit && <span className="biz-person-actions">
          {request.status === 'submitted' && reviewing !== request.id && <button type="button" className="o-btn is-small" onClick={() => setReviewing(request.id)}>Review</button>}
          {request.status === 'approved' && <button type="button" className="o-btn is-small" disabled={busy}
            onClick={async () => { const sent = await run(`${base}/dispatches`, { requestId: request.id }, { success: (r) => `Dispatch #${r.number} is on its way.` }); if (sent) onDispatched(sent.id); }}>Dispatch approved</button>}
        </span>}
      </div>
      {reviewing === request.id && <ReviewForm request={request} base={base} onDone={() => setReviewing(null)} />}
    </li>)}</ul> : <EmptyState icon="layers" tone="neutral" title="No requests from branches yet" />}
  </Panel>;
}

function DispatchForm({ data, base, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [branch, setBranch] = useState(data.branches[0]?.id || '');
  const [lines, setLines] = useState([{ itemId: '', quantity: '' }]);
  const [note, setNote] = useState('');
  async function submit(event) {
    event.preventDefault();
    const sent = await run(`${base}/dispatches`, { restaurantId: branch, lines: cleanLines(lines), note: note || undefined }, { success: (r) => `Dispatch #${r.number} is on its way.` });
    if (sent) onDone(sent.id);
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-branch`}>To branch</label>
      <select id={`${ids}-branch`} className="o-select" value={branch} onChange={(event) => setBranch(event.target.value)}>
        {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
    <LineEditor items={data.items} lines={lines} onChange={setLines} />
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">Optional</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !branch || !cleanLines(lines).length}>{busy ? 'Sending…' : 'Dispatch'}</button>
      <button type="button" className="o-btn is-quiet" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

/** Printable dispatch note. The QR opens /receive/<code> on the branch manager's phone. */
function DispatchNote({ transfer, onClose }) {
  const [svg, setSvg] = useState('');
  const url = `${window.location.origin}/receive/${transfer.code}`;
  useEffect(() => { QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg, () => setSvg('')); }, [url]);
  return <div className="st-note" aria-label={`Dispatch note #${transfer.number}`}>
    <div>
      <h3>Dispatch #{transfer.number} → {transfer.branchName}</h3>
      <p className="biz-meta">Sent {when(transfer.dispatchedAt)} · {TRANSFER_STATUS[transfer.status]}</p>
      <table className="st-table"><thead><tr><th scope="col">Item</th><th scope="col">Sent</th><th scope="col">Received</th></tr></thead>
        <tbody>{transfer.lines.map((line) => <tr key={line.itemId}><td>{line.name}</td><td>{servings(line.quantity)}</td><td>{line.received === null ? '' : servings(line.received)}</td></tr>)}</tbody></table>
      <p>Receiving code: <span className="st-note-code">{transfer.code}</span></p>
      <p className="biz-meta">The branch manager scans the QR code (or opens Inventory → Deliveries) and counts what arrived. The code identifies this dispatch.</p>
      <div className="biz-form-actions">
        <button type="button" className="o-btn" onClick={() => window.print()}><OIcon name="printer" size={15} />Print</button>
        <button type="button" className="o-btn is-quiet" onClick={onClose}>Close</button>
      </div>
    </div>
    <div className="st-note-qr" role="img" aria-label={`QR code for dispatch ${transfer.code}`} dangerouslySetInnerHTML={{ __html: svg }} />
  </div>;
}

function Dispatches({ data, base, canEdit, showing, onShow }) {
  const [adding, setAdding] = useState(false);
  const [run, busy, error] = useCommand();
  return <Panel title="Dispatches" count={data.transfers.length} sub="Stock leaves the main center when dispatched and enters the branch when it confirms receipt."
    actions={canEdit && !adding && data.branches.length > 0 && <button type="button" className="o-btn is-small" onClick={() => setAdding(true)}><OIcon name="plus" size={15} />New dispatch</button>}>
    {adding && <DispatchForm data={data} base={base} onDone={(id) => { setAdding(false); if (id) onShow(id); }} />}
    <FormError error={error} />
    {data.transfers.length ? <ul className="biz-people">{data.transfers.map((transfer) => {
      const short = transfer.lines.reduce((sum, line) => sum + (line.received === null ? 0 : line.quantity - line.received), 0);
      return <li key={transfer.id}>
        <div className="biz-person">
          <span className="biz-person-main"><strong>#{transfer.number} → {transfer.branchName} · {TRANSFER_STATUS[transfer.status]}</strong>
            <span>{transfer.lines.map((line) => `${line.name}: ${servings(line.quantity)}`).join(' · ')}</span>
            {short > 0 && <span className="st-short">Short on arrival: {servings(short)}{transfer.note ? ` — “${transfer.note}”` : ''}</span>}
            <span>Sent {when(transfer.dispatchedAt)}{transfer.receivedAt ? ` · received ${when(transfer.receivedAt)}` : ''}</span></span>
          <span className="biz-person-actions">
            <button type="button" className="o-btn is-quiet is-small" onClick={() => onShow(showing === transfer.id ? null : transfer.id)}>Note & QR</button>
            {canEdit && transfer.status === 'in_transit' && <button type="button" className="o-btn is-quiet is-small" disabled={busy}
              onClick={() => window.confirm(`Cancel dispatch #${transfer.number}? The servings go back to the main center.`) && run(`${base}/dispatches/${transfer.id}/cancel`, {}, { success: `Dispatch #${transfer.number} cancelled.` })}>Cancel</button>}
          </span>
        </div>
        {showing === transfer.id && <DispatchNote transfer={transfer} onClose={() => onShow(null)} />}
      </li>;
    })}</ul> : !adding && <EmptyState icon="layers" tone="neutral" title="No dispatches yet" />}
  </Panel>;
}

function BusinessInventory({ business, section }) {
  const base = `/api/owner/stock/${business.id}`;
  const { data, error, loading, refresh } = useApi(base, { ttl: 15000 });
  const [view, setView] = useState('stock');
  const [showing, setShowing] = useState(null);
  if (error && !data) return <StockError error={error} onRetry={refresh} />;
  if (loading && !data) return <Panel title={business.name}><SkeletonRows rows={5} thumb={false} label="Loading stock" /></Panel>;
  const canEdit = data.role === 'owner';
  const waiting = data.requests.filter((r) => r.status === 'submitted').length;
  const transit = data.transfers.filter((t) => t.status === 'in_transit').length;
  return <>
    <Segmented label={`${business.name} inventory views`} value={view} onChange={setView} options={[
      { value: 'stock', label: 'Stock', count: data.items.length },
      { value: 'requests', label: 'Requests', count: waiting || undefined },
      { value: 'dispatches', label: 'Dispatches', count: transit || undefined },
      { value: 'history', label: 'Main center history' },
    ]} />
    {view === 'stock' && <CenterStock data={data} base={base} canEdit={canEdit} />}
    {view === 'requests' && <Requests data={data} base={base} canEdit={canEdit} onDispatched={(id) => { setShowing(id); setView('dispatches'); }} />}
    {view === 'dispatches' && <Dispatches data={data} base={base} canEdit={canEdit} showing={showing} onShow={setShowing} />}
    {view === 'history' && <Panel title="Main center history" sub={section.label}><Movements movements={data.centerMovements} /></Panel>}
  </>;
}

export default function OwnerInventoryPage({ section }) {
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  return <div className="biz-stack">
    <PageHeader title={section.label} description={section.description} />
    {error && !data ? <StockError error={error} onRetry={refresh} />
      : loading && !data ? <Panel title="Inventory"><SkeletonRows rows={4} thumb={false} label="Loading" /></Panel>
        : !businesses.length ? <EmptyState icon="store" tone="neutral" title="No business access yet" />
          : businesses.map((business) => <section key={business.id} className="biz-stack" aria-label={business.name}>
            {businesses.length > 1 && <h2>{business.name}</h2>}
            <BusinessInventory business={business} section={section} />
          </section>)}
  </div>;
}
