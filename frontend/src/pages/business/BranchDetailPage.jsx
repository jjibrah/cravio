// One branch, seen from the owner interface: today's activity, the last 7 days, staff, and (business owners)
// adding branch staff. Changing the branch's menu, tables or orders happens in its own workspace.
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { Modal } from '../../components/owner/Drawer';
import '../../components/owner/overview.css';
import { api, useApi } from '../../lib/api';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { useAuth } from '../../lib/auth';
import { BranchStatus, OwnerError, WorkspaceLink, money, roleName, timeAgo } from './shared';
import './business.css';

function AddStaff({ branch, onDone }) {
  const ids = useId();
  const { notify } = useNotifications();
  const { account, retry } = useAuth();
  const [values, setValues] = useState({ email: '', name: '', role: 'waiter' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/owner/branches/${branch.id}/staff`, { method: 'POST', body: values });
      notify(result.invited ? `Invitation sent to ${values.email}.` : `${values.email} now works at ${branch.name}.`);
      onDone();
      // Adding yourself gives you a branch workspace: reload your account so the switcher offers it.
      if (values.email.trim().toLowerCase() === account?.email?.toLowerCase()) retry();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form className="biz-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-email`}>Email</label>
      <input id={`${ids}-email`} type="email" className="o-input" value={values.email} autoComplete="off" required data-autofocus
        onChange={(event) => setValues({ ...values, email: event.target.value })} aria-describedby={`${ids}-hint`} />
      <p className="o-field-hint" id={`${ids}-hint`}>Someone without a Cravio account gets an invitation email.</p>
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Name <span className="o-optional">For new accounts</span></label>
      <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={120} onChange={(event) => setValues({ ...values, name: event.target.value })} />
    </div>
    <fieldset className="biz-checks">
      <legend className="o-label">Role at this branch</legend>
      {['waiter', 'manager'].map((role) => <label key={role}><input type="radio" name={`${ids}-role`} value={role} checked={values.role === role}
        onChange={() => setValues({ ...values, role })} />{roleName[role]}</label>)}
    </fieldset>
    {error && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{error}</p>}
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Adding…' : 'Add to branch'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

export default function BranchDetailPage() {
  const { id } = useParams();
  const { data: branch, error, loading, refresh } = useApi(`/api/owner/branches/${id}`, { ttl: 20000 });
  const [adding, setAdding] = useState(false);
  const back = <Link className="biz-back" to="/owner/locations"><OIcon name="arrowLeft" size={16} />Locations</Link>;

  if (error && !branch) return <div className="biz-stack">{back}<OwnerError error={error} onRetry={refresh} what="this branch" /></div>;
  if (loading && !branch) return <div className="biz-stack">{back}<Panel title="Branch"><SkeletonRows rows={4} thumb={false} label="Loading branch" /></Panel></div>;

  const week = branch.last7Days || [];
  return <div className="biz-stack">
    {back}
    <PageHeader title={branch.name} description={`${branch.businessName}${branch.location ? ` · ${branch.location}` : ''}`}>
      <BranchStatus status={branch.status} />
      <WorkspaceLink branch={branch} small={false} />
    </PageHeader>
    {!branch.canOpenWorkspace && <p className="biz-meta">You can review this branch here. To change its menu, tables or orders, you need a branch manager role there{branch.businessRole === 'owner' ? ' (add yourself below)' : ''}.</p>}
    <section className="biz-grid" aria-label="Today">
      <div className="o-stat"><p className="o-stat-label">Orders today</p><p className="o-stat-value">{branch.today.orders}</p><p className="o-stat-hint">Excluding cancelled</p></div>
      <div className="o-stat"><p className="o-stat-label">Paid today</p><p className="o-stat-value">{money(branch.today.paidSales)}</p><p className="o-stat-hint">Marked paid by staff</p></div>
      <div className="o-stat"><p className="o-stat-label">In progress</p><p className="o-stat-value">{branch.today.openOrders}</p><p className="o-stat-hint">Last order {timeAgo(branch.today.lastOrderAt).toLowerCase()}</p></div>
      <div className="o-stat"><p className="o-stat-label">Menu</p><p className="o-stat-value">{branch.setup.items}</p><p className="o-stat-hint">{branch.setup.soldOut} marked sold out · {branch.setup.tables} tables</p></div>
    </section>
    <div className="biz-two">
      <Panel title="Last 7 days" sub="Recorded orders and payments, Nairobi time">
        <table className="biz-week">
          <thead><tr><th scope="col">Day</th><th scope="col">Orders</th><th scope="col">Paid</th></tr></thead>
          <tbody>{week.map((day) => <tr key={day.day}>
            <td>{new Date(`${day.day}T12:00:00+03:00`).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
            <td>{day.orders}</td><td>{money(day.paidSales)}</td></tr>)}</tbody>
        </table>
      </Panel>
      <Panel title="Staff" count={branch.staff.length}
        actions={branch.businessRole === 'owner' && <button type="button" className="o-btn is-small" onClick={() => setAdding(true)}><OIcon name="plus" size={15} />Add staff</button>}>
        {branch.staff.length ? <ul className="biz-people">{branch.staff.map((person) => <li className="biz-person" key={person.userId}>
          <span className="biz-person-main"><strong>{person.name}</strong><span>{roleName[person.role]}</span></span>
        </li>)}</ul> : <EmptyState icon="users" tone="neutral" title="No staff yet">Add a branch manager to run this branch.</EmptyState>}
      </Panel>
    </div>
    <Modal open={adding} onClose={() => setAdding(false)} title={`Add staff to ${branch.name}`}>
      {adding && <AddStaff branch={branch} onDone={() => setAdding(false)} />}
    </Modal>
    <p className="biz-meta">Branch stock and stock requests will appear here once the inventory rules are agreed (decisions D03–D07).</p>
  </div>;
}
