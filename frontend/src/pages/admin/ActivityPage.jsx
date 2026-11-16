// Admin Activity (/admin/activity): who gave, changed or removed access across Cravio (business owners, operations
// managers, branch staff added from the owner platform, branches created, reviewed mappings). Newest first, 100 at a time.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, ErrorState, Panel, SkeletonRows } from '../../components/owner/ui';
import { api, useApi } from '../../lib/api';
import { formatDateTime, timeAgo } from './platform-ui';
import './business.css';

const ROLE = { owner: 'owner', operations: 'operations manager', manager: 'branch manager', waiter: 'waiter' };

export function ActivityList({ events, showBusiness = true }) {
  if (!events.length) return <EmptyState icon="clock" tone="neutral" title="No access changes yet" />;
  return <ol className="ab-activity">{events.map((e) => <li key={e.id} className={`is-${e.action}`}>
    <span className="ab-activity-dot" aria-hidden="true" />
    <p>
      <strong>{e.actor.name}</strong>{e.viaAdmin && <span className="ab-tag">Cravio</span>} {e.text}
      {e.subject && <> for <strong>{e.subject.name}</strong></>}
      {e.role && ROLE[e.role] && <> as {ROLE[e.role]}</>}
      {e.branch && <> at {e.branch.name}</>}
      {showBusiness && e.business && e.business.name !== e.branch?.name && <> in <Link to={`/admin/businesses/${e.business.id}`}>{e.business.name}</Link></>}
    </p>
    <time dateTime={e.at} title={formatDateTime(e.at)}>{timeAgo(e.at)}</time>
  </li>)}</ol>;
}

export default function ActivityPage({ section }) {
  const { data, error, loading, refresh } = useApi('/api/admin/activity', { ttl: 15000 });
  const [more, setMore] = useState([]);
  const [busy, setBusy] = useState(false);
  const [end, setEnd] = useState(false);
  useEffect(() => { setMore([]); setEnd(false); }, [data]);
  const events = [...(data?.events || []), ...more];
  const loadMore = async () => {
    setBusy(true);
    try {
      const next = await api(`/api/admin/activity?before=${events[events.length - 1].id}`);
      setMore((list) => [...list, ...next.events]);
      if (next.events.length < 100) setEnd(true);
    } finally { setBusy(false); }
  };
  return <div className="in-page pl-page ab-page">
    <PageHeader title={section?.label || 'Activity'} description={section?.description} />
    <Panel title="Access changes" count={events.length || undefined}>
      {error && !data ? <ErrorState error={error} onRetry={refresh} what="activity" />
        : loading && !data ? <SkeletonRows rows={6} thumb={false} label="Loading activity" />
          : <div className="ab-body">
            <ActivityList events={events} />
            {events.length >= 100 && !end && <div className="ab-more"><button type="button" className="o-btn" onClick={loadMore} disabled={busy}>{busy ? 'Loading…' : 'Show older'}</button></div>}
          </div>}
    </Panel>
  </div>;
}
