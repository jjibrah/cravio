// Admin business detail (/admin/businesses/:id): branches with their figures and staff, who has business access
// (make someone an owner, remove access), inventory health (counts only), add a branch, rename, and this business's
// access history. Reads GET /api/admin/businesses/:id; every change is audited by the server.
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Modal } from '../../components/owner/Drawer';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { api, useApi } from '../../lib/api';
import { KpiTiles, RestaurantStatus, formatDate, formatKsh, formatWhole, timeAgo } from './platform-ui';
import { BusinessStatus } from './BusinessesPage';
import { ActivityList } from './ActivityPage';
import './business.css';

const ROLE = { owner: 'Business owner', operations: 'Operations manager', manager: 'Branch manager', waiter: 'Waiter' };

function useAction() {
  const { notify } = useNotifications();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn, success) => {
    if (busy) return false;
    setBusy(true); setError('');
    try { const result = await fn(); if (success) notify(typeof success === 'function' ? success(result) : success); return result || true; }
    catch (failure) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  return [run, busy, error, setError];
}

function FormError({ error }) {
  return error ? <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{error}</p> : null;
}

function AddOwner({ business, onDone }) {
  const ids = useId();
  const [run, busy, error] = useAction();
  const [values, setValues] = useState({ email: '', name: '' });
  const submit = async (event) => {
    event.preventDefault();
    const ok = await run(() => api(`/api/admin/businesses/${business.id}/owners`, { method: 'POST', body: values }),
      (r) => (r.invited ? `Invitation sent to ${values.email}. They own ${business.name}.` : `${values.email} now owns ${business.name}.`));
    if (ok) onDone();
  };
  return <form className="ab-form" onSubmit={submit} noValidate>
    <p className="ab-form-intro">A business owner sees and manages every branch of {business.name} in the owner platform. Someone without a Cravio account gets an invitation email.</p>
    <label className="o-label" htmlFor={`${ids}-email`}>Email</label>
    <input id={`${ids}-email`} className="o-input" type="email" inputMode="email" value={values.email} autoComplete="off" placeholder="name@example.com" data-autofocus
      onChange={(event) => setValues({ ...values, email: event.target.value })} />
    <label className="o-label" htmlFor={`${ids}-name`}>Name <span className="o-optional">For new accounts</span></label>
    <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={120} autoComplete="off" onChange={(event) => setValues({ ...values, name: event.target.value })} />
    <FormError error={error} />
    <div className="ab-form-actions">
      <button type="button" className="o-btn" onClick={onDone} disabled={busy}>Cancel</button>
      <button type="submit" className="o-btn is-primary" disabled={busy || !values.email.trim()}>{busy ? 'Saving…' : 'Make owner'}</button>
    </div>
  </form>;
}

function AddBranch({ business, onDone }) {
  const ids = useId();
  const [run, busy, error] = useAction();
  const [values, setValues] = useState({ name: '', area: '' });
  const submit = async (event) => {
    event.preventDefault();
    const ok = await run(() => api(`/api/admin/businesses/${business.id}/branches`, { method: 'POST', body: values }), (r) => `${r.name} added. It stays in setup until the owner finishes it.`);
    if (ok) onDone();
  };
  return <form className="ab-form" onSubmit={submit} noValidate>
    <p className="ab-form-intro">The branch starts in setup and belongs to the business owner, who sets up its menu and tables.</p>
    <label className="o-label" htmlFor={`${ids}-name`}>Branch name</label>
    <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={120} autoComplete="off" data-autofocus onChange={(event) => setValues({ ...values, name: event.target.value })} />
    <label className="o-label" htmlFor={`${ids}-area`}>Area <span className="o-optional">Optional</span></label>
    <input id={`${ids}-area`} className="o-input" value={values.area} maxLength={120} placeholder="e.g. Westlands" autoComplete="off" onChange={(event) => setValues({ ...values, area: event.target.value })} />
    <FormError error={error} />
    <div className="ab-form-actions">
      <button type="button" className="o-btn" onClick={onDone} disabled={busy}>Cancel</button>
      <button type="submit" className="o-btn is-primary" disabled={busy || !values.name.trim()}>{busy ? 'Adding…' : 'Add branch'}</button>
    </div>
  </form>;
}

function Rename({ business, onDone }) {
  const ids = useId();
  const [run, busy, error] = useAction();
  const [name, setName] = useState(business.name);
  const submit = async (event) => {
    event.preventDefault();
    if (await run(() => api(`/api/admin/businesses/${business.id}`, { method: 'PATCH', body: { name } }), 'Business renamed.')) onDone();
  };
  return <form className="ab-form" onSubmit={submit} noValidate>
    <label className="o-label" htmlFor={`${ids}-name`}>Business name</label>
    <input id={`${ids}-name`} className="o-input" value={name} maxLength={120} autoComplete="off" data-autofocus onChange={(event) => setName(event.target.value)} />
    <p className="ab-form-intro">Branch names don’t change. Owners see this name in the owner platform.</p>
    <FormError error={error} />
    <div className="ab-form-actions">
      <button type="button" className="o-btn" onClick={onDone} disabled={busy}>Cancel</button>
      <button type="submit" className="o-btn is-primary" disabled={busy || !name.trim() || name.trim() === business.name}>Save</button>
    </div>
  </form>;
}

function RemoveAccess({ business, person, onDone }) {
  const [run, busy, error] = useAction();
  return <div className="ab-form">
    <p className="ab-form-intro">{person.name} will no longer see {business.name} in the owner platform. Their branch roles (manager or waiter) don’t change.</p>
    <FormError error={error} />
    <div className="ab-form-actions">
      <button type="button" className="o-btn" onClick={onDone} disabled={busy} data-autofocus>Cancel</button>
      <button type="button" className="o-btn is-danger-solid" disabled={busy}
        onClick={async () => { if (await run(() => api(`/api/admin/businesses/${business.id}/access/${person.userId}`, { method: 'DELETE' }), `${person.name}’s access removed.`)) onDone(); }}>
        {busy ? 'Removing…' : 'Remove access'}</button>
    </div>
  </div>;
}

export default function BusinessDetailPage() {
  const { id } = useParams();
  const { data: b, error, loading, refresh } = useApi(`/api/admin/businesses/${id}`, { ttl: 15000 });
  const [task, setTask] = useState(null); // { kind: 'owner'|'branch'|'rename'|'remove', person? }
  const close = () => setTask(null);
  const back = <Link className="ab-back" to="/admin/businesses"><OIcon name="arrowLeft" size={16} />Businesses</Link>;
  if (error && !b) return <div className="in-page pl-page">{back}<ErrorState error={error} onRetry={refresh} what="this business" /></div>;
  if (loading && !b) return <div className="in-page pl-page">{back}<Panel title="Business"><SkeletonRows rows={5} label="Loading business" /></Panel></div>;

  const live = b.branches.some((x) => x.status === 'live');
  const owners = b.access.filter((a) => a.role === 'owner');
  const branchName = (bid) => b.branches.find((x) => x.id === bid)?.name || 'A branch';
  const totals = b.branches.reduce((sum, x) => ({ today: sum.today + x.ordersToday, orders: sum.orders + x.orders30d, paid: sum.paid + x.paid30d, staff: sum.staff + x.staff.length }), { today: 0, orders: 0, paid: 0, staff: 0 });
  const tiles = [
    { key: 'o', label: 'Orders today', value: formatWhole(totals.today), sub: `${formatWhole(totals.orders)} in the last 30 days` },
    { key: 'p', label: 'Paid, 30 days', value: formatKsh(totals.paid), sub: 'Orders marked paid' },
    { key: 'b', label: 'Branches', value: formatWhole(b.branches.length), sub: `${b.branches.filter((x) => x.status === 'live').length} live` },
    { key: 's', label: 'Staff', value: formatWhole(totals.staff), sub: `${owners.length} business owner${owners.length === 1 ? '' : 's'}` },
  ];
  const titles = { owner: 'Add a business owner', branch: 'Add a branch', rename: 'Rename business', remove: task?.person ? `Remove ${task.person.name}?` : 'Remove access' };

  return <div className="in-page pl-page ab-page">
    {back}
    <header className="page-header ab-head">
      <div className="page-heading">
        <h1>{b.name} <button type="button" className="ab-icon" onClick={() => setTask({ kind: 'rename' })} aria-label="Rename business"><OIcon name="edit" size={16} /></button></h1>
        <p><BusinessStatus status={live ? 'live' : b.branches.length ? 'onboarding' : 'empty'} /> <span className="ab-sub">On Cravio since {formatDate(b.createdAt)}</span></p>
      </div>
      <div className="page-actions">
        <button type="button" className="o-btn" onClick={() => setTask({ kind: 'branch' })}><OIcon name="plus" size={16} />Add branch</button>
        <button type="button" className="o-btn is-primary" onClick={() => setTask({ kind: 'owner' })}><OIcon name="plus" size={16} />Add owner</button>
      </div>
    </header>
    {!owners.length && <p className="o-note is-warning ab-note"><OIcon name="alert" size={16} /><span>This business has no owner, so nobody can use the owner platform for it. Add one.</span></p>}
    <KpiTiles tiles={tiles} count={4} label="This business at a glance" />

    <Panel title="Branches" count={b.branches.length}>
      {b.branches.length ? <div className="pl-table-scroll ab-body-table"><table className="pl-table">
        <thead><tr><th scope="col">Branch</th><th scope="col">Status</th><th scope="col" className="is-num">Today</th><th scope="col" className="is-num">Orders 30d</th>
          <th scope="col" className="is-num">Paid 30d</th><th scope="col" className="is-num">Tables</th><th scope="col" className="is-num">Dishes</th><th scope="col">Last order</th><th scope="col"><span className="visually-hidden">Links</span></th></tr></thead>
        <tbody>{b.branches.map((x) => <tr key={x.id}>
          <th scope="row"><strong>{x.name}</strong><small className="ab-block">{x.location || 'Area not set'}</small></th>
          <td><RestaurantStatus status={x.status} /></td>
          <td className="is-num">{formatWhole(x.ordersToday)}</td><td className="is-num">{formatWhole(x.orders30d)}</td><td className="is-num">{formatKsh(x.paid30d)}</td>
          <td className="is-num">{formatWhole(x.tables)}</td><td className="is-num">{formatWhole(x.dishes)}</td>
          <td>{x.lastOrderAt ? timeAgo(x.lastOrderAt) : 'Never'}</td>
          <td className="is-num"><a className="o-btn is-quiet is-small" href={`/guest-menu?r=${x.id}`} target="_blank" rel="noreferrer">Guest menu<OIcon name="external" size={13} /></a></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon="store" tone="neutral" title="No branches yet" />}
    </Panel>

    <div className="ab-two">
      <Panel title="Business access" count={b.access.length} sub="Owners see every branch; operations managers see the branches the owner gave them.">
        {b.access.length ? <ul className="ab-people ab-body">{b.access.map((p) => <li key={p.userId}>
          <span className="ab-person"><strong>{p.name}</strong><small>{p.email} · {ROLE[p.role]}{p.branchIds ? ` · ${p.branchIds.map(branchName).join(', ') || 'no branches'}` : ''}</small>
            <small>{p.lastSignInAt ? `Last signed in ${timeAgo(p.lastSignInAt)}` : 'Hasn’t signed in yet'}</small></span>
          <button type="button" className="o-btn is-quiet is-small is-danger" onClick={() => setTask({ kind: 'remove', person: p })}>Remove</button>
        </li>)}</ul> : <EmptyState icon="users" tone="neutral" title="Nobody has business access" />}
      </Panel>
      <Panel title="Inventory health" sub="Counts only. Stock records stay with the business.">
        {b.stock ? <dl className="ab-stats ab-body">
          <div><dt>Stock items</dt><dd>{formatWhole(b.stock.items)}</dd></div>
          <div><dt>Dishes tracked</dt><dd>{formatWhole(b.stock.trackedDishes)}</dd></div>
          <div><dt>Out at a branch</dt><dd className={b.stock.out ? 'is-warn' : ''}>{formatWhole(b.stock.out)}</dd></div>
          <div><dt>Requests waiting</dt><dd className={b.stock.requestsWaiting ? 'is-warn' : ''}>{formatWhole(b.stock.requestsWaiting)}</dd></div>
          <div><dt>Deliveries on the way</dt><dd>{formatWhole(b.stock.inTransit)}</dd></div>
          <div><dt>Short deliveries, 30 days</dt><dd className={b.stock.shortDeliveries30d ? 'is-warn' : ''}>{formatWhole(b.stock.shortDeliveries30d)}</dd></div>
        </dl> : <EmptyState icon="layers" tone="neutral" title="Inventory isn’t switched on" />}
      </Panel>
    </div>

    <Panel title="Branch staff" count={totals.staff} sub="Managers and waiters change their own team from the branch’s Settings.">
      {b.branches.some((x) => x.staff.length) ? <div className="ab-staff ab-body">{b.branches.filter((x) => x.staff.length).map((x) => <section key={x.id}>
        <h3>{x.name}</h3>
        <ul className="ab-people">{x.staff.map((s) => <li key={s.userId}>
          <span className="ab-person"><strong>{s.name}</strong><small>{s.email} · {ROLE[s.role]}</small></span>
          <small className="ab-sub">{s.lastSignInAt ? timeAgo(s.lastSignInAt) : 'Not signed in'}</small>
        </li>)}</ul>
      </section>)}</div> : <EmptyState icon="users" tone="neutral" title="No staff yet" />}
    </Panel>

    <Panel title="Access history" sub="Who gave or removed access, and when" actions={<Link className="o-btn is-quiet is-small" to="/admin/activity">All activity</Link>}>
      <div className="ab-body"><ActivityList events={b.history} showBusiness={false} /></div>
    </Panel>

    <Modal open={Boolean(task)} onClose={close} title={titles[task?.kind] || ''}>
      {task?.kind === 'owner' && <AddOwner business={b} onDone={close} />}
      {task?.kind === 'branch' && <AddBranch business={b} onDone={close} />}
      {task?.kind === 'rename' && <Rename business={b} onDone={close} />}
      {task?.kind === 'remove' && <RemoveAccess business={b} person={task.person} onDone={close} />}
    </Modal>
  </div>;
}
