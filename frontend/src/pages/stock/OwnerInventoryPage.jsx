// Owner Inventory: main center stock beside every branch, branch requests to review, dispatches with a printable
// note and QR code, and the center's history. "Needs you" puts requests to review and short deliveries first;
// every task opens in the side sheet. Operations managers see their assigned branches read-only.
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import '../business/business.css';
import { useApi } from '../../lib/api';
import {
  AdjustForm, FormError, LineEditor, Movements, NeedsYou, NewItemForm, REQUEST_STATUS, StockError, TRANSFER_STATUS,
  TaskDrawer, cleanLines, friendly, servings, unitOf, useCommand, when,
} from './parts';
import './stock.css';

const VIEWS = ['stock', 'requests', 'dispatches', 'history'];

function StockMatrix({ data, canEdit, onOpen }) {
  if (!data.items.length) return <EmptyState icon="layers" tone="neutral" title="No stock items yet">{canEdit ? 'Add what you produce or buy for your branches, then count the main center.' : 'The owner hasn’t added any items yet.'}</EmptyState>;
  return <div className="st-table-wrap"><table className="st-table st-matrix">
    <thead><tr><th scope="col">Item</th><th scope="col">Main center</th>{data.branches.map((branch) => <th scope="col" key={branch.id}>{branch.name}</th>)}</tr></thead>
    <tbody>{data.items.map((item) => <tr key={item.id}>
      <th scope="row">{canEdit ? <button type="button" className="st-row-button" onClick={() => onOpen(item)}>{item.name}</button> : item.name}
        {item.lowLevel !== null && <><br /><small>Low at {servings(item.lowLevel, item.unit)}</small></>}</th>
      <td><strong>{friendly(item.centerOnHand, item)}</strong></td>
      {data.branches.map((branch) => {
        const value = item.branches[branch.id];
        const low = value !== undefined && item.lowLevel !== null && value <= item.lowLevel;
        return <td key={branch.id} className={value < 0 || value === 0 ? 'is-minus' : low ? 'is-low' : ''}>{value === undefined ? '—' : servings(value, item.unit)}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
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
    <p className="o-field-hint">{request.branchName} asked on {when(request.createdAt)}{request.note ? `: “${request.note}”` : '.'} Lower any amount, or set it to 0, to approve part of the request. Approving doesn’t move stock; you dispatch next.</p>
    {request.lines.map((line) => <div className="o-field" key={line.itemId}>
      <label className="o-label" htmlFor={`${ids}-${line.itemId}`}>{line.name} <span className="o-optional">asked for {servings(line.requested, line.unit)}</span></label>
      <input id={`${ids}-${line.itemId}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" max={line.requested} step="any"
        value={approved[line.itemId]} onChange={(event) => setApproved({ ...approved, [line.itemId]: event.target.value })} />
    </div>)}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note to the branch <span className="o-optional">Needed to reject</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="button" className="o-btn is-primary" onClick={() => decide('approve')} disabled={busy}>Approve</button>
      <button type="button" className="o-btn is-danger" onClick={() => decide('reject')} disabled={busy || !note.trim()}>Reject</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </div>;
}

function Requests({ data, canEdit, onReview, onDispatch, busy }) {
  if (!data.requests.length) return <EmptyState icon="layers" tone="neutral" title="No requests yet">Branch managers ask for stock from their Inventory page.</EmptyState>;
  return <ul className="biz-people">{data.requests.map((request) => <li className="biz-person" key={request.id}>
    <span className="biz-person-main"><strong>#{request.number} · {request.branchName} · {REQUEST_STATUS[request.status]}</strong>
      <span>{request.lines.map((line) => `${line.name}: ${servings(line.requested, line.unit)}${line.approved !== null ? ` → ${line.approved}` : ''}`).join(' · ')}</span>
      {(request.note || request.reviewNote) && <span>{[request.note && `Branch: ${request.note}`, request.reviewNote && `You: ${request.reviewNote}`].filter(Boolean).join(' — ')}</span>}
      <span>{when(request.createdAt)}</span></span>
    {canEdit && <span className="biz-person-actions">
      {request.status === 'submitted' && <button type="button" className="o-btn is-primary is-small" onClick={() => onReview(request)}>Review</button>}
      {request.status === 'approved' && <button type="button" className="o-btn is-primary is-small" disabled={busy} onClick={() => onDispatch(request)}>Dispatch</button>}
    </span>}
  </li>)}</ul>;
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
      <label className="o-label" htmlFor={`${ids}-branch`}>To</label>
      <select id={`${ids}-branch`} className="o-select" value={branch} onChange={(event) => setBranch(event.target.value)}>
        {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
    <LineEditor items={data.items} lines={lines} onChange={setLines} />
    <p className="o-field-hint">Servings leave the main center now and reach the branch when its manager confirms receipt.</p>
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
function DispatchNote({ transfer, items, base, canEdit, onClose }) {
  const [svg, setSvg] = useState('');
  const [run, busy, error] = useCommand();
  const url = `${window.location.origin}/receive/${transfer.code}`;
  useEffect(() => { QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg, () => setSvg('')); }, [url]);
  const cancel = async () => {
    if (!window.confirm(`Cancel dispatch #${transfer.number}? The stock goes back to the main center.`)) return;
    if (await run(`${base}/dispatches/${transfer.id}/cancel`, {}, { success: `Dispatch #${transfer.number} cancelled.` })) onClose();
  };
  return <div className="st-note">
    <div>
      <p className="biz-meta">To {transfer.branchName} · sent {when(transfer.dispatchedAt)} · {TRANSFER_STATUS[transfer.status]}</p>
      <table className="st-table"><thead><tr><th scope="col">Item</th><th scope="col">Sent</th><th scope="col">Received</th></tr></thead>
        <tbody>{transfer.lines.map((line) => <tr key={line.itemId}><td>{line.name}</td><td>{servings(line.quantity, unitOf(items, line.itemId))}</td>
          <td className={line.received !== null && line.received < line.quantity ? 'is-minus' : ''}>{line.received === null ? '—' : servings(line.received, unitOf(items, line.itemId))}</td></tr>)}</tbody></table>
      {transfer.note && <p className="biz-meta">Note: {transfer.note}</p>}
      <p>Receiving code <span className="st-note-code">{transfer.code}</span></p>
      <p className="biz-meta">On arrival the branch manager scans this code and counts what came.</p>
      <FormError error={error} />
      <div className="biz-form-actions">
        <button type="button" className="o-btn is-primary" onClick={() => window.print()}><OIcon name="printer" size={15} />Print note</button>
        {canEdit && transfer.status === 'in_transit' && <button type="button" className="o-btn is-quiet is-danger" onClick={cancel} disabled={busy}>Cancel dispatch</button>}
      </div>
    </div>
    <div className="st-note-qr" role="img" aria-label={`QR code for dispatch ${transfer.code}`} dangerouslySetInnerHTML={{ __html: svg }} />
  </div>;
}

function Dispatches({ data, onOpen }) {
  if (!data.transfers.length) return <EmptyState icon="layers" tone="neutral" title="No dispatches yet">Dispatch an approved request, or send stock directly with “New dispatch”.</EmptyState>;
  return <ul className="biz-people">{data.transfers.map((transfer) => {
    const short = transfer.lines.reduce((sum, line) => sum + (line.received === null ? 0 : line.quantity - line.received), 0);
    return <li className="biz-person" key={transfer.id}>
      <span className="biz-person-main"><strong>#{transfer.number} → {transfer.branchName} · {TRANSFER_STATUS[transfer.status]}</strong>
        <span>{transfer.lines.map((line) => `${line.name}: ${servings(line.quantity, unitOf(data.items, line.itemId))}`).join(' · ')}</span>
        {short > 0 && <span className="st-short">Arrived {transfer.lines.length === 1 ? servings(short, unitOf(data.items, transfer.lines[0].itemId)) : `${Math.round(short * 1000) / 1000}`} short{transfer.note ? ` — “${transfer.note}”` : ''}</span>}
        <span>Sent {when(transfer.dispatchedAt)}{transfer.receivedAt ? ` · received ${when(transfer.receivedAt)}` : ''}</span></span>
      <span className="biz-person-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => onOpen(transfer)}>Note & QR</button></span>
    </li>;
  })}</ul>;
}

function BusinessInventory({ business, params, setParams }) {
  const base = `/api/owner/stock/${business.id}`;
  const { data, error, loading, refresh } = useApi(base, { ttl: 15000 });
  const [task, setTask] = useState(null);
  const [run, busy, dispatchError] = useCommand();
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'stock';
  const setView = (next) => setParams(next === 'stock' ? {} : { view: next }, { replace: true });
  if (error && !data) return <StockError error={error} onRetry={refresh} />;
  if (loading && !data) return <Panel title={business.name}><SkeletonRows rows={5} thumb={false} label="Loading stock" /></Panel>;
  const canEdit = data.role === 'owner';
  const transferById = (id) => data.transfers.find((t) => t.id === id);
  const dispatchRequest = async (request) => {
    const sent = await run(`${base}/dispatches`, { requestId: request.id }, { success: (r) => `Dispatch #${r.number} is on its way.` });
    if (sent) { setView('dispatches'); setTask({ kind: 'note', transferId: sent.id }); }
  };
  const waiting = data.requests.filter((r) => r.status === 'submitted');
  const approved = data.requests.filter((r) => r.status === 'approved');
  const transit = data.transfers.filter((t) => t.status === 'in_transit');
  const short = data.transfers.filter((t) => t.status === 'received' && t.lines.some((l) => l.received !== null && l.received < l.quantity)).slice(0, 2);
  const needs = canEdit ? [
    ...waiting.map((r) => ({ key: r.id, tone: 'action', primary: true, title: `${r.branchName} asked for stock`, detail: `Request #${r.number}: ${r.lines.map((l) => `${l.name} ${l.requested}`).join(', ')}`, action: 'Review', onClick: () => setTask({ kind: 'review', request: r }) })),
    ...approved.map((r) => ({ key: r.id, tone: 'action', title: `Request #${r.number} is approved`, detail: `Ready to send to ${r.branchName}`, action: 'Dispatch', onClick: () => dispatchRequest(r) })),
    ...short.map((t) => ({ key: t.id, tone: 'urgent', title: `Dispatch #${t.number} arrived short`, detail: t.note ? `${t.branchName}: “${t.note}”` : t.branchName, action: 'View', onClick: () => setTask({ kind: 'note', transferId: t.id }) })),
  ] : [];
  const noteTransfer = task?.kind === 'note' ? transferById(task.transferId) : null;
  const titles = { adjust: task?.item && `${task.item.name} · main center`, item: 'New stock item', review: task?.request && `Review request #${task.request.number}`, dispatch: 'New dispatch', note: noteTransfer && `Dispatch #${noteTransfer.number}` };

  return <>
    <NeedsYou items={needs} />
    <FormError error={dispatchError} />
    <div className="st-toolbar">
      <Segmented label={`${business.name} inventory views`} value={view} onChange={setView} options={[
        { value: 'stock', label: 'Stock' }, { value: 'requests', label: 'Requests', count: waiting.length || undefined },
        { value: 'dispatches', label: 'Dispatches', count: transit.length || undefined }, { value: 'history', label: 'History' },
      ]} />
      {canEdit && <div className="st-toolbar-actions">
        <button type="button" className="o-btn" onClick={() => setTask({ kind: 'item' })}><OIcon name="plus" size={15} />New item</button>
        <button type="button" className="o-btn is-primary" onClick={() => setTask({ kind: 'dispatch' })} disabled={!data.items.length || !data.branches.length}>New dispatch</button>
      </div>}
    </div>
    {view === 'stock' && <Panel title="Stock" count={data.items.length} sub={canEdit ? 'Select an item to count, add or record waste at the main center. Branch columns change as orders are served.' : 'Branch columns change as orders are served.'}>
      <StockMatrix data={data} canEdit={canEdit} onOpen={(item) => setTask({ kind: 'adjust', item })} /></Panel>}
    {view === 'requests' && <Panel title="Requests from branches" count={data.requests.length}>
      <Requests data={data} canEdit={canEdit} busy={busy} onReview={(request) => setTask({ kind: 'review', request })} onDispatch={dispatchRequest} /></Panel>}
    {view === 'dispatches' && <Panel title="Dispatches" count={data.transfers.length} sub="Stock leaves the main center when dispatched and enters the branch when it confirms receipt.">
      <Dispatches data={data} onOpen={(transfer) => setTask({ kind: 'note', transferId: transfer.id })} /></Panel>}
    {view === 'history' && <Panel title="Main center history" sub="The latest 60 changes"><Movements movements={data.centerMovements} /></Panel>}

    <TaskDrawer open={Boolean(task)} title={titles[task?.kind] || 'Inventory'} onClose={() => setTask(null)} wide={task?.kind === 'note'}>
      {task?.kind === 'adjust' && <AdjustForm item={task.item} path={`${base}/adjust`} onDone={() => setTask(null)} />}
      {task?.kind === 'item' && <NewItemForm path={`${base}/items`} unitsOn={Boolean(data.recipes)} onDone={() => setTask(null)} />}
      {task?.kind === 'review' && <ReviewForm request={task.request} base={base} onDone={() => setTask(null)} />}
      {task?.kind === 'dispatch' && <DispatchForm data={data} base={base} onDone={(id) => { setTask(id ? { kind: 'note', transferId: id } : null); if (id) setView('dispatches'); }} />}
      {noteTransfer && <DispatchNote transfer={noteTransfer} items={data.items} base={base} canEdit={canEdit} onClose={() => setTask(null)} />}
    </TaskDrawer>
  </>;
}

export default function OwnerInventoryPage({ section }) {
  const [params, setParams] = useSearchParams();
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  return <div className="biz-stack">
    <PageHeader title={section.label} description="Your main center’s stock, what each branch has, and what’s moving between them." />
    {error && !data ? <StockError error={error} onRetry={refresh} />
      : loading && !data ? <Panel title="Inventory"><SkeletonRows rows={4} thumb={false} label="Loading" /></Panel>
        : !businesses.length ? <EmptyState icon="store" tone="neutral" title="No business access yet" />
          : businesses.map((business) => <section key={business.id} className="biz-stack" aria-label={business.name}>
            {businesses.length > 1 && <h2>{business.name}</h2>}
            <BusinessInventory business={business} params={params} setParams={setParams} />
          </section>)}
  </div>;
}
