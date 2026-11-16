// Branch Inventory: servings on hand per item, dish links (what serving deducts), counts/adds/waste, requests to
// the business owner, receiving dispatches from the main center, order corrections, and the stock history.
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import '../business/business.css';
import { useApi } from '../../lib/api';
import {
  AdjustForm, FormError, LineEditor, Movements, NewItemForm, REQUEST_STATUS, StateChip, StockError, TRANSFER_STATUS,
  cleanLines, servings, useCommand, when,
} from './parts';
import './stock.css';

function StockTable({ data, onAdjust }) {
  if (!data.items.length) return <EmptyState icon="layers" tone="neutral" title="No stock items yet">Add the items you want to track, then count them to set opening stock.</EmptyState>;
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">Item</th><th scope="col">On hand</th><th scope="col">Held by open orders</th><th scope="col">Available</th><th scope="col">State</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
    <tbody>{data.items.map((item) => <tr key={item.id}>
      <th scope="row">{item.name}<br /><small>{item.dishes ? `${item.dishes} dish${item.dishes === 1 ? '' : 'es'} linked` : 'No dishes linked'}</small></th>
      <td className={item.onHand < 0 ? 'is-minus' : ''}>{servings(item.onHand)}{item.onHand < 0 && <><br /><small>Count needed</small></>}</td>
      <td>{servings(item.reserved)}</td>
      <td><strong>{servings(item.available)}</strong></td>
      <td><StateChip state={item.state} /></td>
      <td className="st-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => onAdjust(item)}>Count / add / waste</button></td>
    </tr>)}</tbody>
  </table></div>;
}

function DishLinks({ data }) {
  const [run, busy, error] = useCommand();
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState({ itemId: '', servings: '1', allowWhenOut: false });
  const open = (dish) => { setEditing(dish.id); setValues({ itemId: dish.link?.itemId || '', servings: String(dish.link?.servings ?? 1), allowWhenOut: Boolean(dish.link?.allowWhenOut) }); };
  const name = (id) => data.items.find((item) => item.id === id)?.name || 'Item';
  async function save(dish) {
    const body = values.itemId ? { itemId: values.itemId, servings: Number(values.servings), allowWhenOut: values.allowWhenOut } : { itemId: null };
    if (await run(`/api/stock/links/${dish.id}`, body, { method: 'PUT', success: values.itemId ? `${dish.name} now uses ${name(values.itemId)}.` : `${dish.name} is no longer tracked.` })) setEditing(null);
  }
  if (!data.dishes.length) return <EmptyState icon="utensils" tone="neutral" title="No dishes yet">Add dishes in Products first.</EmptyState>;
  return <ul className="biz-people">{data.dishes.map((dish) => <li key={dish.id}>
    <div className="biz-person">
      <span className="biz-person-main"><strong>{dish.name}</strong>
        <span>{dish.link ? `${servings(dish.link.servings)} of ${name(dish.link.itemId)} per dish${dish.link.allowWhenOut ? ' · keeps selling when out' : ''}` : 'Not tracked'}{dish.manuallySoldOut ? ' · marked sold out in Products' : ''}</span></span>
      <span className="biz-person-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => open(dish)}>{dish.link ? 'Change' : 'Track'}</button></span>
    </div>
    {editing === dish.id && <div className="st-form">
      <div className="o-field">
        <label className="o-label" htmlFor={`link-${dish.id}`}>Stock item</label>
        <select id={`link-${dish.id}`} className="o-select" value={values.itemId} onChange={(event) => setValues({ ...values, itemId: event.target.value })}>
          <option value="">Don’t track this dish</option>
          {data.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      {values.itemId && <>
        <div className="o-field">
          <label className="o-label" htmlFor={`servings-${dish.id}`}>Servings used per dish</label>
          <input id={`servings-${dish.id}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={values.servings} onChange={(event) => setValues({ ...values, servings: event.target.value })} />
        </div>
        <label className="biz-checks-inline"><input type="checkbox" checked={values.allowWhenOut} onChange={(event) => setValues({ ...values, allowWhenOut: event.target.checked })} />
          Keep selling when the count says it’s out (manager override)</label>
      </>}
      <FormError error={error} />
      <div className="biz-form-actions">
        <button type="button" className="o-btn is-primary" onClick={() => save(dish)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="o-btn is-quiet" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
      </div>
    </div>}
  </li>)}</ul>;
}

function RequestForm({ items, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [lines, setLines] = useState([{ itemId: '', quantity: '' }]);
  const [note, setNote] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (await run('/api/stock/requests', { lines: cleanLines(lines), note: note || undefined }, { success: (r) => `Request #${r.number} sent to the business owner.` })) onDone();
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <LineEditor items={items} lines={lines} onChange={setLines} />
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">Optional</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} placeholder="e.g. For the weekend" onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !cleanLines(lines).length}>{busy ? 'Sending…' : 'Send request'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function Requests({ data }) {
  const [adding, setAdding] = useState(false);
  const [run, busy, error] = useCommand();
  return <Panel title="Requests to the main center" count={data.requests.length} sub="The business owner approves (fully or partly) or rejects. Nothing changes your stock until you receive it."
    actions={!adding && data.items.length > 0 && <button type="button" className="o-btn is-small" onClick={() => setAdding(true)}><OIcon name="plus" size={15} />New request</button>}>
    {adding && <RequestForm items={data.items} onDone={() => setAdding(false)} />}
    <FormError error={error} />
    {data.requests.length ? <ul className="biz-people">{data.requests.map((request) => <li className="biz-person" key={request.id}>
      <span className="biz-person-main"><strong>Request #{request.number} · {REQUEST_STATUS[request.status]}</strong>
        <span>{request.lines.map((line) => `${line.name}: ${servings(line.requested)}${line.approved !== null && line.approved !== line.requested ? ` (approved ${line.approved})` : ''}`).join(' · ')}</span>
        {(request.note || request.reviewNote) && <span>{[request.note, request.reviewNote && `Owner: ${request.reviewNote}`].filter(Boolean).join(' — ')}</span>}
        <span>{when(request.createdAt)}</span></span>
      {request.status === 'submitted' && <span className="biz-person-actions">
        <button type="button" className="o-btn is-quiet is-small" disabled={busy} onClick={() => run(`/api/stock/requests/${request.id}/cancel`, {}, { success: `Request #${request.number} cancelled.` })}>Cancel</button></span>}
    </li>)}</ul> : !adding && <EmptyState icon="layers" tone="neutral" title="No requests yet" />}
  </Panel>;
}

function ReceiveForm({ transfer, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [counts, setCounts] = useState(() => Object.fromEntries(transfer.lines.map((line) => [line.itemId, String(line.quantity)])));
  const [note, setNote] = useState('');
  const short = transfer.lines.some((line) => Number(counts[line.itemId]) < line.quantity);
  async function submit(event) {
    event.preventDefault();
    const lines = transfer.lines.map((line) => ({ itemId: line.itemId, received: Number(counts[line.itemId]) }));
    if (await run(`/api/stock/transfers/${transfer.id}/receive`, { lines, note: note || undefined }, { success: `Dispatch #${transfer.number} received.` })) onDone();
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <p className="o-field-hint">Count what actually arrived. Anything missing or damaged is recorded on the dispatch for the owner.</p>
    {transfer.lines.map((line) => <div className="o-field" key={line.itemId}>
      <label className="o-label" htmlFor={`${ids}-${line.itemId}`}>{line.name} <span className="o-optional">sent {servings(line.quantity)}</span></label>
      <input id={`${ids}-${line.itemId}`} className="o-input st-qty" type="number" inputMode="decimal" min="0" max={line.quantity} step="any"
        value={counts[line.itemId]} onChange={(event) => setCounts({ ...counts, [line.itemId]: event.target.value })} />
    </div>)}
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>Note <span className="o-optional">{short ? 'Required: what was short?' : 'Optional'}</span></label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : 'Confirm receipt'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function Incoming({ data, receiveId, onReceive }) {
  const pending = data.incoming.filter((t) => t.status === 'in_transit');
  return <Panel title="Deliveries from the main center" count={pending.length} sub="Scan the QR code on the dispatch note, or open the delivery here, then count what arrived.">
    {data.incoming.length ? <ul className="biz-people">{data.incoming.map((transfer) => <li key={transfer.id}>
      <div className="biz-person">
        <span className="biz-person-main"><strong>Dispatch #{transfer.number} · {TRANSFER_STATUS[transfer.status]}</strong>
          <span>{transfer.lines.map((line) => `${line.name}: ${servings(line.quantity)}${line.received !== null && line.received !== line.quantity ? ` (received ${line.received})` : ''}`).join(' · ')}</span>
          <span>Sent {when(transfer.dispatchedAt)}{transfer.receivedAt ? ` · received ${when(transfer.receivedAt)}` : ''}</span></span>
        {transfer.status === 'in_transit' && receiveId !== transfer.id && <span className="biz-person-actions">
          <button type="button" className="o-btn is-small" onClick={() => onReceive(transfer.id)}>Receive</button></span>}
      </div>
      {receiveId === transfer.id && <ReceiveForm transfer={transfer} onDone={() => onReceive(null)} />}
    </li>)}</ul> : <EmptyState icon="layers" tone="neutral" title="Nothing on its way" />}
  </Panel>;
}

function CorrectionForm({ data, orderId, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [returned, setReturned] = useState([{ itemId: '', quantity: '' }]);
  const [used, setUsed] = useState([{ itemId: '', quantity: '' }]);
  const [order, setOrder] = useState(orderId || '');
  const [note, setNote] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (await run(`/api/stock/orders/${order}/correction`, { returned: cleanLines(returned), used: cleanLines(used), note }, { success: 'Stock corrected for that order.' })) onDone();
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <p className="o-field-hint">For changes after serving, e.g. a Fanta swapped for a Coke. The order’s bill doesn’t change.</p>
    {!orderId && <div className="o-field"><label className="o-label" htmlFor={`${ids}-order`}>Order id</label>
      <input id={`${ids}-order`} className="o-input" value={order} onChange={(event) => setOrder(event.target.value.trim())} placeholder="Open the order and use “Correct stock”" /></div>}
    <p className="o-label">Came back unused (added back)</p>
    <LineEditor items={data.items} lines={returned} onChange={setReturned} />
    <p className="o-label">Used instead (taken out)</p>
    <LineEditor items={data.items} lines={used} onChange={setUsed} />
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-note`}>What changed</label>
      <input id={`${ids}-note`} className="o-input" value={note} maxLength={280} placeholder="Swapped Fanta for Coke" onChange={(event) => setNote(event.target.value)} />
    </div>
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy || !order || !note.trim()}>{busy ? 'Saving…' : 'Save correction'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

export default function BranchInventoryPage({ section }) {
  const [params, setParams] = useSearchParams();
  const { data, error, loading, refresh } = useApi('/api/stock', { ttl: 15000 });
  const [view, setView] = useState(params.get('receive') ? 'deliveries' : params.get('correct') ? 'stock' : 'stock');
  const [adjusting, setAdjusting] = useState(null);
  const [adding, setAdding] = useState(false);
  const [receiveId, setReceiveId] = useState(params.get('receive'));
  const [correcting, setCorrecting] = useState(params.get('correct'));
  useEffect(() => { if (params.get('receive') || params.get('correct')) setParams({}, { replace: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="biz-stack"><PageHeader title={section.label} description={section.description} /><StockError error={error} onRetry={refresh} /></div>;
  if (loading && !data) return <div className="biz-stack"><PageHeader title={section.label} description={section.description} /><Panel title="Stock"><SkeletonRows rows={5} thumb={false} label="Loading stock" /></Panel></div>;

  const attention = data.items.filter((item) => item.state !== 'ok');
  const pending = data.incoming.filter((t) => t.status === 'in_transit').length;
  return <div className="biz-stack">
    <PageHeader title={section.label} description="Servings on hand. Stock leaves when an order is served; dishes with no servings left show as sold out." />
    {attention.length > 0 && <p className="biz-notice st-attention" role="status">{attention.map((item) => `${item.name} ${item.state === 'out' ? 'is out' : 'is low'}`).join(' · ')}</p>}
    <Segmented label="Inventory views" value={view} onChange={setView} options={[
      { value: 'stock', label: 'Stock', count: data.items.length },
      { value: 'dishes', label: 'Dish links' },
      { value: 'requests', label: 'Requests', count: data.requests.filter((r) => ['submitted', 'approved', 'dispatched'].includes(r.status)).length || undefined },
      { value: 'deliveries', label: 'Deliveries', count: pending || undefined },
      { value: 'history', label: 'History' },
    ]} />
    {view === 'stock' && <>
      {correcting && <Panel title="Correct stock for a served order"><CorrectionForm data={data} orderId={correcting === 'new' ? '' : correcting} onDone={() => setCorrecting(null)} /></Panel>}
      <Panel title="Stock" count={data.items.length} sub={`Updated ${when(data.generatedAt)}`}
        actions={<>
          {!correcting && <button type="button" className="o-btn is-quiet is-small" onClick={() => setCorrecting('new')}>Correct an order</button>}
          {!adding && <button type="button" className="o-btn is-small" onClick={() => setAdding(true)}><OIcon name="plus" size={15} />New item</button>}
        </>}>
        {adding && <NewItemForm path="/api/stock/items" onDone={() => setAdding(false)} />}
        {adjusting && <AdjustForm key={adjusting.id} item={adjusting} path="/api/stock/adjust" onDone={() => setAdjusting(null)} />}
        <StockTable data={data} onAdjust={setAdjusting} />
      </Panel>
    </>}
    {view === 'dishes' && <Panel title="Dish links" sub="A tracked dish takes its servings when served. Untracked dishes, and extras, don’t affect stock."><DishLinks data={data} /></Panel>}
    {view === 'requests' && <Requests data={data} />}
    {view === 'deliveries' && <Incoming data={data} receiveId={receiveId} onReceive={setReceiveId} />}
    {view === 'history' && <Panel title="Stock history" sub="Latest 60 changes at this branch"><Movements movements={data.movements} /></Panel>}
  </div>;
}
