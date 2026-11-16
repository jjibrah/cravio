// Locations: the business's branches, and (business owners only) adding a new location.
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { Modal } from '../../components/owner/Drawer';
import '../../components/owner/overview.css';
import { api, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { BranchRows } from './OwnerOverviewPage';
import { OwnerError } from './shared';
import './business.css';

function AddBranch({ business, onDone }) {
  const ids = useId();
  const navigate = useNavigate();
  const { retry } = useAuth();
  const { notify } = useNotifications();
  const [values, setValues] = useState({ name: '', area: '', manageItMyself: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (!values.name.trim()) { setError('Enter the branch name.'); return; }
    setBusy(true); setError('');
    try {
      const branch = await api(`/api/owner/businesses/${business.id}/branches`, { method: 'POST', body: values });
      notify(`${branch.name} added. It stays in setup until its menu and tables are ready.`);
      onDone();
      // A new branch membership changes what /api/me returns; refresh it before opening the workspace.
      retry();
      if (values.manageItMyself) navigate(`/branch/${branch.id}`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <form className="biz-form" onSubmit={submit} noValidate>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-name`}>Branch name</label>
      <input id={`${ids}-name`} className="o-input" value={values.name} maxLength={120} autoComplete="off" data-autofocus
        onChange={(event) => setValues({ ...values, name: event.target.value })} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${ids}-error` : undefined} />
    </div>
    <div className="o-field">
      <label className="o-label" htmlFor={`${ids}-area`}>Area <span className="o-optional">Optional</span></label>
      <input id={`${ids}-area`} className="o-input" value={values.area} maxLength={120} placeholder="e.g. Westlands"
        onChange={(event) => setValues({ ...values, area: event.target.value })} />
    </div>
    <label className="biz-checks-inline"><input type="checkbox" checked={values.manageItMyself}
      onChange={(event) => setValues({ ...values, manageItMyself: event.target.checked })} /> I’ll set it up myself (adds me as its branch manager)</label>
    <p className="o-field-hint">The new branch has its own menu, prices and tables. It starts in setup and isn’t shown to guests until it goes live.</p>
    {error && <p className="o-field-error" id={`${ids}-error`} role="alert"><OIcon name="alert" size={14} />{error}</p>}
    <div className="biz-form-actions">
      <button type="submit" className="o-btn is-primary" disabled={busy}>{busy ? 'Adding…' : 'Add branch'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onDone} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

export default function LocationsPage({ section }) {
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const [adding, setAdding] = useState(null);
  const businesses = data?.businesses || [];

  return <div className="biz-stack">
    <PageHeader title={section.label} description={section.description} />
    {error && !data ? <OwnerError error={error} onRetry={refresh} what="your locations" />
      : loading && !data ? <Panel title="Branches"><SkeletonRows rows={3} thumb={false} label="Loading locations" /></Panel>
        : !businesses.length ? <EmptyState icon="store" tone="neutral" title="No business access yet">Ask the business owner or Cravio to grant access.</EmptyState>
          : businesses.map((business) => <Panel key={business.id} title={business.name} count={business.branches.length}
            sub={business.role === 'owner' ? 'You own this business' : 'Branches assigned to you'}
            actions={business.role === 'owner' && <button type="button" className="o-btn is-small" onClick={() => setAdding(business.id)}>
              <OIcon name="plus" size={15} />Add branch</button>}>
            {business.branches.length ? <BranchRows branches={business.branches} />
              : <EmptyState icon="store" tone="neutral" title="No branches yet">{business.role === 'owner' ? 'Add your first branch.' : 'None are assigned to you yet.'}</EmptyState>}
          </Panel>)}
    <Modal open={Boolean(adding)} onClose={() => setAdding(null)} title="Add a branch">
      {adding && <AddBranch business={businesses.find((b) => b.id === adding)} onDone={() => setAdding(null)} />}
    </Modal>
  </div>;
}
