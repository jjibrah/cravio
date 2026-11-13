// Admin Restaurants (/admin/restaurants): every customer restaurant with owner, setup and 30-day usage.
// Search (?q=), status chips (?status=), sortable columns, and a details drawer (?open=<id>).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import Drawer from '../../components/owner/Drawer';
import { EmptyState, ErrorState, OIcon, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import { kindLabel } from '../../lib/format';
import {
  NotInstalled, RESTAURANT_STATUS, RestaurantStatus, SortHeader, formatDate, formatDateTime, formatKsh, formatWhole, sortRows, timeAgo,
} from './platform-ui';

const STATUS_ORDER = ['live', 'onboarding', 'suspended'];

const matches = (row, q) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [row.name, row.area, row.address, row.owner?.name, row.owner?.email, row.phone, kindLabel(row.kind)]
    .some((value) => value && value.toLowerCase().includes(needle));
};

export default function RestaurantsPage({ section }) {
  const [params, setParams] = useSearchParams();
  const { data, error, refresh, loading } = useApi('/api/admin/restaurants', { ttl: 30000 });
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const q = params.get('q') || '';
  const status = params.get('status') || 'all';
  const openId = params.get('open');

  const set = (patch) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(patch).forEach(([key, value]) => { if (value && value !== 'all') next.set(key, value); else next.delete(key); });
    return next;
  }, { replace: true });

  const rows = data?.restaurants || [];
  const searched = useMemo(() => rows.filter((row) => matches(row, q)), [rows, q]);
  const visible = useMemo(() => sortRows(searched.filter((row) => status === 'all' || row.status === status), sort,
    (row, key) => (key === 'owner' ? row.owner?.name || row.owner?.email : row[key])), [searched, status, sort]);
  const statuses = STATUS_ORDER.filter((key) => key !== 'suspended' || rows.some((row) => row.status === key))
    .concat([...new Set(rows.map((row) => row.status))].filter((key) => !STATUS_ORDER.includes(key)));
  const chips = [{ value: 'all', label: 'All', count: searched.length },
    ...statuses.map((key) => ({ value: key, label: RESTAURANT_STATUS[key] || key, count: searched.filter((row) => row.status === key).length }))];
  const selected = rows.find((row) => row.id === openId) || null;

  return <div className="in-page pl-page">
    <PageHeader title={section?.label || 'Restaurants'} description={section?.description} />
    {data && data.available?.operations === false && <NotInstalled what="Orders and revenue" migration="003" />}

    <div className="pl-toolbar">
      <div className="o-search pl-search">
        <OIcon name="search" size={16} />
        <input type="search" value={q} onChange={(event) => set({ q: event.target.value })} placeholder="Search name, owner, email or area"
          aria-label="Search restaurants" autoComplete="off" />
      </div>
      <div className="o-chips" role="radiogroup" aria-label="Filter by status">
        {chips.map((chip) => <button key={chip.value} type="button" role="radio" aria-checked={status === chip.value} className="o-chip"
          onClick={() => set({ status: chip.value })}>{chip.label}<span className="o-chip-count">{data ? chip.count : '·'}</span></button>)}
      </div>
    </div>

    <section className="o-panel pl-table-panel" aria-label="Restaurants">
      {error && !data ? <ErrorState error={error} onRetry={refresh} what="restaurants" />
        : loading ? <SkeletonRows rows={6} label="Loading restaurants" />
          : !visible.length ? <EmptyState icon={q ? 'search' : 'utensils'} title={q ? `No restaurants match “${q}”` : rows.length ? 'No restaurants with this status' : 'No restaurants yet'}
            action={(q || status !== 'all') ? <button type="button" className="o-btn is-secondary" onClick={() => set({ q: '', status: '' })}>Clear filters</button>
              : <Link className="o-btn is-secondary" to="/admin/users">Invite an owner</Link>}>
            {rows.length ? 'Try another search or status.' : 'Restaurants appear here once an owner is invited.'}
          </EmptyState>
            : <>
              <div className="pl-table-scroll">
                <table className="pl-table">
                  <caption className="visually-hidden">Restaurants, sorted by {sort.key}</caption>
                  <thead><tr>
                    <SortHeader label="Restaurant" column="name" sort={sort} onSort={setSort} />
                    <SortHeader label="Owner" column="owner" sort={sort} onSort={setSort} />
                    <SortHeader label="Status" column="status" sort={sort} onSort={setSort} />
                    <SortHeader label="Tables" column="tables" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Dishes" column="menuItems" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Orders 30d" column="orders30d" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Paid 30d" column="revenue30d" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Last order" column="lastOrderAt" sort={sort} onSort={setSort} numeric />
                    <SortHeader label="Joined" column="created_at" sort={sort} onSort={setSort} numeric />
                  </tr></thead>
                  <tbody>{visible.map((row) => <tr key={row.id} className={row.id === openId ? 'is-selected' : undefined}>
                    <th scope="row">
                      <button type="button" className="pl-cell-link" onClick={() => set({ open: row.id })}>
                        <strong>{row.name}</strong>
                        <small>{[kindLabel(row.kind), row.area].filter(Boolean).join(' · ') || 'Details not set'}</small>
                      </button>
                    </th>
                    <td className="pl-owner"><span>{row.owner?.name || '—'}</span><small>{row.owner?.email || ''}</small></td>
                    <td><RestaurantStatus status={row.status} /></td>
                    <td className="is-num">{formatWhole(row.tables)}</td>
                    <td className="is-num">{formatWhole(row.menuItems)}</td>
                    <td className="is-num">{formatWhole(row.orders30d)}</td>
                    <td className="is-num">{formatKsh(row.revenue30d)}</td>
                    <td className="is-num">{row.lastOrderAt ? timeAgo(row.lastOrderAt) : 'Never'}</td>
                    <td className="is-num">{formatDate(row.created_at)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <ul className="pl-cards">
                {visible.map((row) => <li key={row.id}>
                  <button type="button" className="pl-card" onClick={() => set({ open: row.id })}>
                    <span className="pl-card-head"><strong>{row.name}</strong><RestaurantStatus status={row.status} /></span>
                    <small>{[row.owner?.name, row.area].filter(Boolean).join(' · ') || 'Details not set'}</small>
                    <dl>
                      <div><dt>Orders 30d</dt><dd>{formatWhole(row.orders30d)}</dd></div>
                      <div><dt>Paid 30d</dt><dd>{formatKsh(row.revenue30d)}</dd></div>
                      <div><dt>Last order</dt><dd>{row.lastOrderAt ? timeAgo(row.lastOrderAt) : 'Never'}</dd></div>
                    </dl>
                  </button>
                </li>)}
              </ul>
              <p className="pl-foot">{visible.length === rows.length ? `${formatWhole(rows.length)} restaurants` : `Showing ${formatWhole(visible.length)} of ${formatWhole(rows.length)} restaurants`}</p>
            </>}
    </section>

    <Drawer open={Boolean(selected)} onClose={() => set({ open: '' })} title={selected?.name || 'Restaurant'}
      header={selected && <RestaurantStatus status={selected.status} />}>
      {selected && <RestaurantDetails restaurant={selected} />}
    </Drawer>
  </div>;
}

function RestaurantDetails({ restaurant: r }) {
  const setup = [
    { label: 'Tables', done: r.tables > 0, text: `${formatWhole(r.tables)} tables` },
    { label: 'Menu', done: r.menuItems > 0, text: `${formatWhole(r.menuItems)} dishes` },
    { label: 'Staff', done: r.staff > 0, text: `${formatWhole(r.staff)} staff` },
    { label: 'Live', done: r.status === 'live', text: r.went_live_at ? `Since ${formatDate(r.went_live_at)}` : 'Not yet' },
  ];
  return <div className="pl-details">
    <div className="pl-detail-kpis">
      <div><span>Orders, 30 days</span><strong>{formatWhole(r.orders30d)}</strong></div>
      <div><span>Paid, 30 days</span><strong>{formatKsh(r.revenue30d)}</strong></div>
      <div><span>Last order</span><strong>{r.lastOrderAt ? timeAgo(r.lastOrderAt) : 'Never'}</strong></div>
    </div>

    <h3 className="pl-detail-title">Setup</h3>
    <ul className="pl-setup">
      {setup.map((step) => <li key={step.label} className={step.done ? 'is-done' : undefined}>
        <span className="pl-setup-icon" aria-hidden="true"><OIcon name={step.done ? 'check' : 'minus'} size={13} strokeWidth={2.6} /></span>
        <span>{step.label}</span><small>{step.text}</small>
      </li>)}
    </ul>

    <h3 className="pl-detail-title">Details</h3>
    <dl className="pl-dl">
      <div><dt>Owner</dt><dd>{r.owner?.name || '—'}{r.owner?.email && <><br /><a href={`mailto:${r.owner.email}`}>{r.owner.email}</a></>}</dd></div>
      <div><dt>Phone</dt><dd>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : '—'}</dd></div>
      <div><dt>Type</dt><dd>{kindLabel(r.kind) || '—'}</dd></div>
      <div><dt>Area</dt><dd>{r.area || '—'}</dd></div>
      <div><dt>Address</dt><dd>{r.address || '—'}</dd></div>
      <div><dt>Joined</dt><dd>{formatDateTime(r.created_at)}</dd></div>
      <div><dt>Went live</dt><dd>{r.went_live_at ? formatDateTime(r.went_live_at) : 'Not yet'}</dd></div>
    </dl>

    <div className="pl-detail-links">
      <a className="o-btn is-secondary is-small" href={`/guest-menu?r=${r.id}`} target="_blank" rel="noreferrer"><OIcon name="external" size={15} />Guest menu</a>
      <Link className="o-btn is-quiet is-small" to={`/admin/users?q=${encodeURIComponent(r.owner?.email || r.name)}`}>People</Link>
    </div>
  </div>;
}
