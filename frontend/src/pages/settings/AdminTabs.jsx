// Admin-only Settings sections: the Cravio team (who has admin access) and platform status.
import { Link } from 'react-router-dom';
import { ErrorState, OIcon, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import { SettingsCard, initials } from './parts';

const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function AdminTeamTab() {
  const { data, error, loading, refresh } = useApi('/api/admin/users?role=admin', { ttl: 30000 });
  const admins = data?.users || [];
  return <SettingsCard id="admins" title="People with admin access" description="Admins manage every business, user and support request on Cravio."
    actions={<Link className="o-btn is-small" to="/admin/users?tab=admin"><OIcon name="users" size={15} />Manage in Users</Link>}>
    {loading && !data ? <SkeletonRows rows={3} label="Loading admins" />
      : error && !data ? <ErrorState error={error} onRetry={refresh} what="the admin list" compact />
        : <ul className="st-people">{admins.map((a) => <li key={a.id} className="st-person">
          <span className="st-avatar" aria-hidden="true">{initials(a.name)}</span>
          <span className="st-person-text"><strong>{a.name}{a.isSelf && <span className="st-you"> (you)</span>}</strong>
            <span>{a.email}{a.isPrimaryAdmin ? ' · primary admin, can’t be removed' : ''}</span></span>
          <span className="o-tag">{a.status === 'active' ? 'Active' : a.status === 'invited' ? 'Invited' : 'Suspended'}</span>
        </li>)}</ul>}
  </SettingsCard>;
}

export function PlatformTab() {
  const { data, error, loading, refresh } = useApi('/api/admin/system', { ttl: 60000 });
  if (loading && !data) return <SkeletonRows rows={4} label="Checking the platform" />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} what="platform status" compact />;
  return <>
    <SettingsCard id="features" title="Features" description="What the database currently switches on for every business.">
      <ul className="st-people">{data.features.map((f) => <li key={f.key} className="st-person">
        <span className={`cs-dot${f.on ? ' is-on' : ''}`} aria-hidden="true" />
        <span className="st-person-text"><strong>{f.name}</strong>
          <span>{f.on ? 'On' : f.note || `Off · needs database update ${f.needs}`}</span></span>
        <span className="o-tag">{f.on ? 'On' : 'Off'}</span>
      </li>)}</ul>
    </SettingsCard>
    <SettingsCard id="migrations" title="Database updates" description={`Applied in order. Checked ${new Date(data.checkedAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}.`}>
      <ul className="st-people">{data.migrations.map((m) => <li key={m.name} className="st-person cs-compact">
        <span className="st-person-text"><strong>{m.name.replace(/\.sql$/, '')}</strong></span>
        <span className="cs-muted">{when(m.appliedAt)}</span>
      </li>)}</ul>
    </SettingsCard>
  </>;
}
