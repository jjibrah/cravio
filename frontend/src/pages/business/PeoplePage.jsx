// People & access: who has business-level access (owners, operations managers and their branches) and who works
// at each overseen branch. Only business owners change operations access; nobody can change their own.
import { useId, useState } from 'react';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { api, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { OwnerError, roleName } from './shared';
import './business.css';

function BranchChecks({ branches, value, onChange, legend }) {
  return <fieldset className="biz-checks">
    <legend className="o-label">{legend}</legend>
    {branches.map((branch) => <label key={branch.id}><input type="checkbox" checked={value.includes(branch.id)}
      onChange={(event) => onChange(event.target.checked ? [...value, branch.id] : value.filter((id) => id !== branch.id))} />{branch.name}</label>)}
  </fieldset>;
}

/** Grant operations access by email, or edit an existing operations manager's branches. */
function OperationsForm({ businessId, branches, person, onDone }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [values, setValues] = useState({ email: '', name: '', branchIds: person?.branchIds || [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (!values.branchIds.length) { setError('Choose at least one branch.'); return; }
    setBusy(true); setError('');
    try {
      if (person) {
        await api(`/api/owner/businesses/${businessId}/operations/${person.userId}`, { method: 'PUT', body: { branchIds: values.branchIds } });
        notify(`${person.name}’s branches updated.`);
      } else {
        const result = await api(`/api/owner/businesses/${businessId}/operations`, { method: 'POST', body: values });
        notify(result.invited ? `Invitation sent to ${values.email}.` : `${values.email} now has operations access.`);
      }
      onDone();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <form className="biz-form" onSubmit={submit} noValidate>
    {!person && <>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-email`}>Email</label>
        <input id={`${ids}-email`} type="email" className="o-input" value={values.email} autoComplete="off" required
          onChange={(event) => setValues({ ...values, email: event.target.value })} />
        <p className="o-field-hint">Someone without a Cravio account gets an invitation email.</p>
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-name`}>Name <span className="o-optional">For new accounts</span></label>
        <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={120} onChange={(event) => setValues({ ...values, name: event.target.value })} />
      </div>
    </>}
    <BranchChecks branches={branches} value={values.branchIds} onChange={(branchIds) => setValues({ ...values, branchIds })}
      legend={person ? `Branches ${person.name} oversees` : 'Branches they oversee'} />
    <p className="o-field-hint">Operations managers see these branches’ activity and staff. They can’t change access, and they only run a branch’s menu or orders if they also have a branch role there.</p>
    {error && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{error}</p>}
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Saving…' : person ? 'Save branches' : 'Grant access'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

function BusinessPeople({ business }) {
  const { account } = useAuth();
  const { notify } = useNotifications();
  const { data, error, loading, refresh } = useApi(`/api/owner/businesses/${business.id}/people`, { ttl: 20000 });
  const [editing, setEditing] = useState(null); // 'new' | userId
  const [revoking, setRevoking] = useState(null);
  const branchName = (id) => data?.branches.find((branch) => branch.id === id)?.name || 'A branch';

  async function revoke(person) {
    if (revoking) return;
    if (!window.confirm(`Remove ${person.name}’s operations access to ${business.name}? Their branch roles are not changed.`)) return;
    setRevoking(person.userId);
    try {
      await api(`/api/owner/businesses/${business.id}/operations/${person.userId}`, { method: 'DELETE' });
      notify(`${person.name} no longer has operations access.`);
    } catch (failure) { notify(failure.message, { type: 'error', duration: 7000 }); }
    finally { setRevoking(null); }
  }

  if (error && !data) return <OwnerError error={error} onRetry={refresh} what="people" />;
  if (loading && !data) return <Panel title={business.name}><SkeletonRows rows={3} thumb={false} label="Loading people" /></Panel>;

  return <>
    <Panel title={`Business access · ${business.name}`} count={data.businessAccess.length}
      sub={data.canManageAccess ? 'Business owners see every branch. Operations managers see the branches you choose.' : 'Only the business owner changes access.'}
      actions={data.canManageAccess && editing !== 'new' && data.branches.length > 0
        && <button type="button" className="o-btn is-small" onClick={() => setEditing('new')}><OIcon name="plus" size={15} />Grant operations access</button>}>
      {editing === 'new' && <OperationsForm businessId={business.id} branches={data.branches} onDone={() => setEditing(null)} />}
      <ul className="biz-people">{data.businessAccess.map((person) => <li key={person.userId}>
        <div className="biz-person">
          <span className="biz-person-main">
            <strong>{person.name}{person.userId === account?.id ? ' (you)' : ''}</strong>
            <span>{roleName[person.role]} · {person.branchIds === null ? 'All branches' : person.branchIds.map(branchName).join(', ') || 'No branches'}</span>
          </span>
          {data.canManageAccess && person.role === 'operations' && person.userId !== account?.id && <span className="biz-person-actions">
            <button type="button" className="o-btn is-quiet is-small" onClick={() => setEditing(person.userId)}>Branches</button>
            <button type="button" className="o-btn is-quiet is-small" onClick={() => revoke(person)} disabled={revoking === person.userId}>Remove</button>
          </span>}
        </div>
        {editing === person.userId && <OperationsForm businessId={business.id} branches={data.branches} person={person} onDone={() => setEditing(null)} />}
      </li>)}</ul>
    </Panel>
    <Panel title="Branch staff" count={data.branchStaff.length} sub="Add staff from a branch’s page. Change branch roles in that branch’s Settings → Team.">
      {data.branchStaff.length ? <ul className="biz-people">{data.branchStaff.map((person) => <li className="biz-person" key={`${person.branchId}:${person.userId}`}>
        <span className="biz-person-main"><strong>{person.name}</strong><span>{roleName[person.role]} · {branchName(person.branchId)}</span></span>
      </li>)}</ul> : <EmptyState icon="users" tone="neutral" title="No branch staff yet" />}
    </Panel>
  </>;
}

export default function PeoplePage({ section }) {
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  return <div className="biz-stack">
    <PageHeader title={section.label} description={section.description} />
    {error && !data ? <OwnerError error={error} onRetry={refresh} what="people" />
      : loading && !data ? <Panel title="People"><SkeletonRows rows={3} thumb={false} label="Loading people" /></Panel>
        : !businesses.length ? <EmptyState icon="users" tone="neutral" title="No business access yet" />
          : businesses.map((business) => <BusinessPeople key={business.id} business={business} />)}
  </div>;
}
