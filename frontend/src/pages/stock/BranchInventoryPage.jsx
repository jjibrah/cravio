// Branch Inventory. One page, five views (Stock, Dish links, Requests, Deliveries, History) chosen in the toolbar;
// the things waiting on the manager (deliveries to receive, items out or low) sit on top as "Needs you";
// every task (count, link a dish, request, receive, correct an order) opens in the side sheet.
import { useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import '../business/business.css';
import { useApi } from '../../lib/api';
import {
  AdjustForm, FormError, LineEditor, Movements, NeedsYou, NewItemForm, REQUEST_STATUS, StateChip, StockError, TRANSFER_STATUS,
  TaskDrawer, cleanLines, servings, useCommand, when,
} from './parts';
import './stock.css';

const VIEWS = ['stock', 'dishes', 'requests', 'deliveries', 'history'];

function StockTable({ items, onOpen }) {
  if (!items.length) return <EmptyState icon="layers" tone="neutral" title="No stock items yet">Add what you want to track, then count it to set your opening stock.</EmptyState>;
  return <div className="st-table-wrap"><table className="st-table">
    <thead><tr><th scope="col">Item</th><th scope="col">Available</th><th scope="col">On hand</th><th scope="col">Held by open orders</th><th scope="col">State</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}>
      <th scope="row"><button type="button" className="st-row-button" onClick={() => onOpen(item)}>{item.name}</button>
        <br /><small>{item.dishes ? `${item.dishes} dish${item.dishes === 1 ? '' : 'es'} linked` : 'No dishes linked'}</small></th>
      <td><strong>{servings(item.available)}</strong></td>
      <td className={item.onHand < 0 ? 'is-minus' : ''}>{servings(item.onHand)}{item.onHand < 0 && <><br /><small>Count needed</small></>}</td>
      <td>{servings(item.reserved)}</td>
      <td><StateChip state={item.state} /></td>
    </tr>)}</tbody>
  </table></div>;
}

function LinkForm({ dish, items, onDone }) {
  const ids = useId();
  const [run, busy, error] = useCommand();
  const [values, setValues] = useState({ itemId: dish.link?.itemId || '', servings: String(dish.link?.servings ?? 1), allowWhenOut: Boolean(dish.link?.allowWhenOut) });
  async function submit(event) {
    event.preventDefault();
    const body = values.itemId ? { itemId: values.itemId, servings: Number(values.servings), allowWhenOut: values.allowWhenOut } : { itemId: null };
    if (await run(`/api/stock/links/${dish.id}`, body, { method: 'PUT', success: values.itemId ? `${dish.name} is now tracked.` : `${dish.name} is no longer tracked.` })) onDone();
  }
  return <form className="st-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-item`}>Stock item</label>
      <select id={`${ids}-item`} className="o-select" value={values.itemId} onChange={(event) => setValues({ ...values, itemId: event.target.value })}>
        <option value="">Don’t track this dish</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <p className="o-field-hint">When this dish is served, its servings come off this item.</p>
    </div>
    {values.itemId && <>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-servings`}>Servings per dish</label>
        <input id={`${ids}-servings`} className="o-input st-qty" type="number" inputMode="decimal" min="0" step="any" value={values.servings} onChange={(event) => setValues({ ...values, servings: event.target.value })} />
      </div>
      <label className="biz-checks-inline"><input type="checkbox" checked={values.allowWhenOut} onChange={(event) => setValues({ ...values, allowWhenOut: event.target.checked })} />
        Keep selling when the count says it’s out</label>
      <p className="o-field-hint">Use when the count is behind: the dish stays orderable and the balance shows what to recount.</p>
    </>}
    <FormError error={error} />
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function DishLinks({ data, onEdit }) {
  const name = (id) => data.items.find((item) => item.id === id)?.name || 'Item';
  if (!data.dishes.length) return <EmptyState icon="utensils" tone="neutral" title="No dishes yet">Add dishes in Products first.</EmptyState>;
  return <ul className="biz-people">{data.dishes.map((dish) => <li className="biz-person" key={dish.id}>
    <span className="biz-person-main"><strong>{dish.name}</strong>
      <span>{dish.link ? `${servings(dish.link.servings)} of ${name(dish.link.itemId)}${dish.link.allowWhenOut ? ' · keeps selling when out' : ''}` : 'Not tracked'}{dish.manuallySoldOut ? ' · marked sold out in Products' : ''}</span></span>
    <span className="biz-person-actions"><button type="button" className="o-btn is-quiet is-small" onClick={() => onEdit(dish)}>{dish.link ? 'Change' : 'Track'}</button></span>
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
    <p className="o-field-hint">The business owner approves all or part of it, or explains why not. Your stock changes when the delivery arrives.</p>
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
  const [run, busy, error] = useCommand();
  if (!data.requests.length) return <EmptyState icon="layers" tone="neutral" title="No requests yet">Use “Request stock” to ask the main center for servings.</EmptyState>;
  return <><FormError error={error} /><ul className="biz-people">{data.requests.map((request) => <li className="biz-person" key={request.id}>
    <span className="biz-person-main"><strong>Request #{request.number} · {REQUEST_STATUS[request.status]}</strong>
      <span>{request.lines.map((line) => `${line.name}: ${servings(line.requested)}${line.approved !== null && line.approved !== line.requested ? ` (approved ${line.approved})` : ''}`).join(' · ')}</span>
      {(request.note || request.reviewNote) && <span>{[request.note, request.reviewNote && `Owner: ${request.reviewNote}`].filter(Boolean).join(' — ')}</span>}
      <span>{when(request.createdAt)}</span></span>
    {request.status === 'submitted' && <span className="biz-person-actions">
      <button type="button" className="o-btn is-quiet is-small" disabled={busy} onClick={() => run(`/api/stock/requests/${request.id}/cancel`, {}, { success: `Request #${request.number} cancelled.` })}>Cancel request</button></span>}
  </li>)}</ul></>;
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
    <p className="o-field-hint">Count what actually arrived. Anything missing or damaged is recorded for the owner.</p>
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
      <button type="submit" className="o-btn is-primary" disabled={busy || (short && !note.trim())}>{busy ? 'Saving…' : 'Confirm receipt'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function Deliveries({ data, onReceive }) {
  if (!data.incoming.length) return <EmptyState icon="layers" tone="neutral" title="Nothing on its way">Deliveries from the main center appear here. Scanning a dispatch note’s QR code opens it directly.</EmptyState>;
  return <ul className="biz-people">{data.incoming.map((transfer) => <li className="biz-person" key={transfer.id}>
    <span className="biz-person-main"><strong>Dispatch #{transfer.number} · {TRANSFER_STATUS[transfer.status]}</strong>
      <span>{transfer.lines.map((line) => `${line.name}: ${servings(line.quantity)}${line.received !== null && line.received !== line.quantity ? ` (received ${line.received})` : ''}`).join(' · ')}</span>
      <span>Sent {when(transfer.dispatchedAt)}{transfer.receivedAt ? ` · received ${when(transfer.receivedAt)}` : ''}</span></span>
    {transfer.status === 'in_transit' && <span className="biz-person-actions"><button type="button" className="o-btn is-primary is-small" onClick={() => onReceive(transfer)}>Receive</button></span>}
  </li>)}</ul>;
}

function CorrectionForm({ items, orderId, onDone }) {
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
    <p className="o-field-hint">For changes after serving, like a Fanta swapped for a Coke. The bill stays the same.</p>
    {!orderId && <div className="o-field"><label className="o-label" htmlFor={`${ids}-order`}>Order</label>
      <input id={`${ids}-order`} className="o-input" value={order} onChange={(event) => setOrder(event.target.value.trim())} />
      <p className="o-field-hint">Easiest from the order itself: Orders → open the order → “Correct stock for this order”.</p></div>}
    <p className="o-label">Came back unused</p>
    <LineEditor items={items} lines={returned} onChange={setReturned} />
    <p className="o-label">Used instead</p>
    <LineEditor items={items} lines={used} onChange={setUsed} />
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
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : params.get('receive') ? 'deliveries' : 'stock';
  const setView = (next) => setParams(next === 'stock' ? {} : { view: next }, { replace: true });
  // One task at a time in the side sheet: { kind, item?, dish?, transfer?, orderId? }
  const [task, setTask] = useState(() => (params.get('correct') ? { kind: 'correct', orderId: params.get('correct') } : null));
  const close = () => { setTask(null); if (params.get('receive') || params.get('correct')) setParams(view === 'stock' ? {} : { view }, { replace: true }); };

  const header = <PageHeader title={section.label} description="Servings at this branch. They come off when an order is served; a dish with none left shows as sold out." />;
  if (error && !data) return <div className="biz-stack">{header}<StockError error={error} onRetry={refresh} /></div>;
  if (loading && !data) return <div className="biz-stack">{header}<Panel title="Stock"><SkeletonRows rows={5} thumb={false} label="Loading stock" /></Panel></div>;

  const receiveFromLink = params.get('receive') && data.incoming.find((t) => t.id === params.get('receive') && t.status === 'in_transit');
  const openTask = task || (receiveFromLink ? { kind: 'receive', transfer: receiveFromLink } : null);
  const pending = data.incoming.filter((t) => t.status === 'in_transit');
  const out = data.items.filter((item) => item.state === 'out');
  const low = data.items.filter((item) => item.state === 'low');
  const needs = [
    ...pending.map((t) => ({ key: t.id, tone: 'action', primary: true, title: `Dispatch #${t.number} is on its way`, detail: t.lines.map((l) => `${l.name} ${l.quantity}`).join(', '), action: 'Receive', onClick: () => setTask({ kind: 'receive', transfer: t }) })),
    ...(out.length ? [{ key: 'out', tone: 'urgent', title: `${out.length} item${out.length === 1 ? '' : 's'} out`, detail: `${out.map((i) => i.name).join(', ')} — sold out for guests`, action: 'Request stock', onClick: () => setTask({ kind: 'request' }) }] : []),
    ...(low.length ? [{ key: 'low', tone: 'info', title: `${low.length} running low`, detail: low.map((i) => `${i.name} (${i.available})`).join(', '), action: 'Request stock', onClick: () => setTask({ kind: 'request' }) }] : []),
  ];
  const titles = { adjust: openTask?.item?.name, item: 'New stock item', link: openTask?.dish?.name, request: 'Request stock', receive: openTask?.transfer && `Receive dispatch #${openTask.transfer.number}`, correct: 'Correct stock for an order' };
  const active = data.requests.filter((r) => ['submitted', 'approved', 'dispatched'].includes(r.status)).length;

  return <div className="biz-stack">
    {header}
    <NeedsYou items={needs} />
    <div className="st-toolbar">
      <Segmented label="Inventory views" value={view} onChange={setView} options={[
        { value: 'stock', label: 'Stock' }, { value: 'dishes', label: 'Dish links' },
        { value: 'requests', label: 'Requests', count: active || undefined },
        { value: 'deliveries', label: 'Deliveries', count: pending.length || undefined }, { value: 'history', label: 'History' },
      ]} />
      <div className="st-toolbar-actions">
        <button type="button" className="o-btn is-quiet" onClick={() => setTask({ kind: 'correct' })}>Correct an order</button>
        <button type="button" className="o-btn" onClick={() => setTask({ kind: 'item' })}><OIcon name="plus" size={15} />New item</button>
        <button type="button" className="o-btn is-primary" onClick={() => setTask({ kind: 'request' })} disabled={!data.items.length}>Request stock</button>
      </div>
    </div>
    {view === 'stock' && <Panel title="Stock" count={data.items.length} sub={`Select an item to count, add or record waste · updated ${when(data.generatedAt)}`}>
      <StockTable items={data.items} onOpen={(item) => setTask({ kind: 'adjust', item })} /></Panel>}
    {view === 'dishes' && <Panel title="Dish links" sub="Tracked dishes take their servings when served. Untracked dishes and extras don’t affect stock.">
      <DishLinks data={data} onEdit={(dish) => setTask({ kind: 'link', dish })} /></Panel>}
    {view === 'requests' && <Panel title="Requests to the main center" count={data.requests.length}><Requests data={data} /></Panel>}
    {view === 'deliveries' && <Panel title="Deliveries" count={data.incoming.length}><Deliveries data={data} onReceive={(transfer) => setTask({ kind: 'receive', transfer })} /></Panel>}
    {view === 'history' && <Panel title="History" sub="The latest 60 changes at this branch"><Movements movements={data.movements} /></Panel>}

    <TaskDrawer open={Boolean(openTask)} title={titles[openTask?.kind] || 'Inventory'} onClose={close}>
      {openTask?.kind === 'adjust' && <AdjustForm item={openTask.item} path="/api/stock/adjust" onDone={close} />}
      {openTask?.kind === 'item' && <NewItemForm path="/api/stock/items" onDone={close} />}
      {openTask?.kind === 'link' && <LinkForm dish={openTask.dish} items={data.items} onDone={close} />}
      {openTask?.kind === 'request' && <RequestForm items={data.items} onDone={close} />}
      {openTask?.kind === 'receive' && <ReceiveForm transfer={openTask.transfer} onDone={close} />}
      {openTask?.kind === 'correct' && <CorrectionForm items={data.items} orderId={openTask.orderId} onDone={close} />}
    </TaskDrawer>
  </div>;
}
