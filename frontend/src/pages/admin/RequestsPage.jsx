// Admin support queue. One page for two sections, picked by section.path:
//   /admin/leads-requests: leads, questions, problems, billing and feature ideas;
//   /admin/complaints:     complaints.
// Status chips (?status=), search (?q=), and a drawer (?open=<id>) to change status and write Cravio's reply,
// which the owner sees on their Contact Cravio page. Reads GET /api/admin/requests, saves with PATCH.
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import Drawer from '../../components/owner/Drawer';
import { EmptyState, ErrorState, OIcon, Segmented, SkeletonRows } from '../../components/owner/ui';
import { api, useApi } from '../../lib/api';
import { NotInstalled, REQUEST_STATUS, REQUEST_TYPES, RequestStatus, formatDateTime, timeAgo } from './platform-ui';

const STATUS_CHIPS = ['all', 'open', 'in_progress', 'resolved', 'closed'];
const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'closed'].map((value) => ({ value, label: REQUEST_STATUS[value] }));
const LEAD_TYPES = ['lead', 'question', 'problem', 'billing', 'feature'];

const matches = (row, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.subject, row.message, row.contactName, row.contactEmail, row.contactPhone, row.restaurant?.name, row.adminNote, REQUEST_TYPES[row.type]]
    .some((value) => value && value.toLowerCase().includes(needle));
};

export default function RequestsPage({ section }) {
  const complaints = section?.path === 'complaints';
  const path = `/api/admin/requests?type=${complaints ? 'complaint' : LEAD_TYPES.join(',')}`;
  const { data, error, refresh, loading, setData } = useApi(path, { ttl: 20000 });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const status = STATUS_CHIPS.includes(params.get('status')) ? params.get('status') : 'all';
  const type = !complaints && LEAD_TYPES.includes(params.get('type')) ? params.get('type') : 'all';
  const openId = params.get('open');

  const set = (patch) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(patch).forEach(([key, value]) => { if (value && value !== 'all') next.set(key, value); else next.delete(key); });
    return next;
  }, { replace: true });

  const all = data?.requests || [];
  const searched = useMemo(() => all.filter((row) => matches(row, q) && (type === 'all' || row.type === type)), [all, q, type]);
  const visible = useMemo(() => searched.filter((row) => status === 'all' || row.status === status), [searched, status]);
  const count = (key) => (key === 'all' ? searched.length : searched.filter((row) => row.status === key).length);
  const selected = all.find((row) => row.id === openId) || null;
  const noun = complaints ? 'complaints' : 'requests';

  const onSaved = (row) => setData((current) => current && { ...current, requests: current.requests.map((r) => (r.id === row.id ? row : r)) });

  return <div className="in-page pl-page">
    <PageHeader title={section?.label || 'Requests'} description={section?.description} />
    {data && data.available === false && <NotInstalled what="Support requests" migration="006" />}

    <div className="pl-toolbar">
      <div className="o-search pl-search">
        <OIcon name="search" size={16} />
        <input type="search" value={q} onChange={(event) => set({ q: event.target.value })} placeholder={`Search ${noun}, restaurants or contacts`}
          aria-label={`Search ${noun}`} autoComplete="off" />
      </div>
      {!complaints && <select className="o-select pl-type-select" value={type} onChange={(event) => set({ type: event.target.value })} aria-label="Filter by type">
        <option value="all">All types</option>
        {LEAD_TYPES.map((key) => <option key={key} value={key}>{REQUEST_TYPES[key]}</option>)}
      </select>}
    </div>
    <div className="o-chips pl-status-chips" role="radiogroup" aria-label="Filter by status">
      {STATUS_CHIPS.map((key) => <button key={key} type="button" role="radio" aria-checked={status === key} className="o-chip" onClick={() => set({ status: key })}>
        {key === 'all' ? 'All' : REQUEST_STATUS[key]}<span className="o-chip-count">{data ? count(key) : '·'}</span>
      </button>)}
    </div>

    <section className="o-panel pl-table-panel" aria-label={section?.label || 'Requests'}>
      {error && !data ? <ErrorState error={error} onRetry={refresh} what={noun} />
        : loading ? <SkeletonRows rows={5} thumb={false} label={`Loading ${noun}`} />
          : !visible.length ? <EmptyState icon={q ? 'search' : 'check'} tone="calm"
            title={q ? `Nothing matches “${q}”` : all.length ? `No ${status === 'all' ? '' : `${REQUEST_STATUS[status].toLowerCase()} `}${noun}` : `No ${noun} yet`}
            action={(q || status !== 'all' || type !== 'all') ? <button type="button" className="o-btn is-secondary" onClick={() => set({ q: '', status: '', type: '' })}>Clear filters</button> : null}>
            {all.length ? 'Try another search or status.' : complaints ? 'Complaints owners send from Contact Cravio land here.' : 'Questions, problems and ideas owners send from Contact Cravio land here.'}
          </EmptyState>
            : <ul className="pl-list pl-requests">
              {visible.map((row) => <li key={row.id}>
                <button type="button" className={`pl-row${row.id === openId ? ' is-selected' : ''}`} onClick={() => set({ open: row.id })}>
                  <span className={`pl-type-dot is-${row.type}${row.urgency === 'urgent' ? ' is-urgent' : ''}`} aria-hidden="true" />
                  <span className="pl-row-main">
                    <strong>{row.subject}</strong>
                    <small>
                      {row.restaurant?.name || row.contactName || 'No restaurant'} · {REQUEST_TYPES[row.type]}
                      {row.urgency === 'urgent' && <span className="pl-urgent"> · Urgent</span>}
                      {row.adminNote && ' · Replied'}
                    </small>
                    <span className="pl-row-preview">{row.message}</span>
                  </span>
                  <span className="pl-row-end"><RequestStatus status={row.status} /><small>{timeAgo(row.createdAt)}</small></span>
                </button>
              </li>)}
            </ul>}
    </section>

    <Drawer open={Boolean(selected)} onClose={() => set({ open: '' })} title={selected?.subject || 'Request'} wide
      header={selected && <RequestStatus status={selected.status} />}>
      {selected && <RequestDetails key={selected.id} request={selected} onSaved={onSaved} />}
    </Drawer>
  </div>;
}

function RequestDetails({ request, onSaved }) {
  const { notify } = useNotifications();
  const [status, setStatus] = useState(request.status);
  const [note, setNote] = useState(request.adminNote || '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const noteId = useId();
  const dirty = status !== request.status || note.trim() !== (request.adminNote || '');

  useEffect(() => { setStatus(request.status); setNote(request.adminNote || ''); }, [request.status, request.adminNote]);

  const save = async (event) => {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true); setProblem('');
    try {
      const result = await api(`/api/admin/requests/${request.id}`, { method: 'PATCH', body: { status, adminNote: note.trim() || null } });
      onSaved(result.request);
      notify(result.message || 'Request updated');
    } catch (error) {
      setProblem(error.message);
      notify(error.message, { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const r = request;
  return <form className="pl-details" onSubmit={save}>
    <div className="pl-request-meta">
      <span className={`pl-tag is-${r.type}`}>{REQUEST_TYPES[r.type]}</span>
      {r.urgency === 'urgent' && <span className="pl-tag is-urgent">Urgent</span>}
      {r.urgency === 'low' && <span className="pl-tag">Low urgency</span>}
      <span className="pl-request-time">Received {formatDateTime(r.createdAt)}</span>
    </div>
    <p className="pl-message">{r.message}</p>

    <h3 className="pl-detail-title">From</h3>
    <dl className="pl-dl">
      <div><dt>Restaurant</dt><dd>{r.restaurant ? <Link to={`/admin/restaurants?open=${r.restaurant.id}`}>{r.restaurant.name}</Link> : '—'}</dd></div>
      <div><dt>Person</dt><dd>{r.contactName || r.createdByName || '—'}</dd></div>
      <div><dt>Phone</dt><dd>{r.contactPhone ? <a href={`tel:${r.contactPhone}`}>{r.contactPhone}</a> : '—'}</dd></div>
      <div><dt>Email</dt><dd>{r.contactEmail ? <a href={`mailto:${r.contactEmail}?subject=${encodeURIComponent(`Re: ${r.subject}`)}`}>{r.contactEmail}</a> : '—'}</dd></div>
      {r.resolvedAt && <div><dt>Resolved</dt><dd>{formatDateTime(r.resolvedAt)}</dd></div>}
    </dl>

    <h3 className="pl-detail-title">Status</h3>
    <Segmented label="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} size="sm" className="pl-status-seg" />

    <div className="o-field pl-note-field">
      <label className="o-label" htmlFor={noteId}>Reply to the owner</label>
      <textarea id={noteId} className="o-input" rows={5} maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="What you did or what happens next. The owner sees this on their Contact Cravio page." />
      <p className="o-field-hint">Visible to the restaurant’s owner and managers.</p>
    </div>
    {problem && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{problem}</p>}
    <div className="pl-detail-actions">
      <button type="submit" className="o-btn is-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
      {dirty && !saving && <button type="button" className="o-btn is-quiet" onClick={() => { setStatus(r.status); setNote(r.adminNote || ''); }}>Discard changes</button>}
    </div>
  </form>;
}
