// Admin Overview (/admin): platform health at a glance. Reads GET /api/admin/overview.
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { useApi } from '../../lib/api';
import { kindLabel } from '../../lib/format';
import {
  ChartSkeleton, KpiTiles, NotInstalled, REQUEST_TYPES, RequestStatus, RestaurantStatus, SeriesBars, formatKsh, formatWhole, timeAgo,
} from './platform-ui';

const SERIES_METRICS = [
  { value: 'orders', label: 'Orders', name: 'Orders', unit: 'orders' },
  { value: 'revenue', label: 'Revenue', name: 'Paid revenue', money: true, unit: 'paid' },
];

export default function AdminOverviewPage({ section }) {
  const { data, error, refresh } = useApi('/api/admin/overview', { ttl: 30000 });

  const tiles = data && [
    {
      key: 'restaurants', label: 'Restaurants', value: formatWhole(data.restaurants.total),
      sub: `${formatWhole(data.restaurants.byStatus.live || 0)} live · ${formatWhole(data.restaurants.byStatus.onboarding || 0)} onboarding${data.restaurants.byStatus.suspended ? ` · ${data.restaurants.byStatus.suspended} suspended` : ''}`,
    },
    { key: 'people', label: 'Owners & waiters', value: formatWhole(data.people.owners + data.people.waiters), sub: `${formatWhole(data.people.owners)} owners · ${formatWhole(data.people.waiters)} waiters` },
    { key: 'orders', label: 'Orders today', value: formatWhole(data.orders.today), sub: `${formatWhole(data.orders.last7d)} in the last 7 days` },
    { key: 'revenue', label: 'Paid today', value: formatKsh(data.orders.revenueToday), sub: `${formatKsh(data.orders.revenue7d)} in the last 7 days` },
    {
      key: 'requests', label: 'Open requests', value: formatWhole(data.requests.open + data.requests.complaints),
      sub: `${formatWhole(data.requests.open)} requests · ${formatWhole(data.requests.complaints)} complaints`,
      tone: data.requests.complaints > 0 ? 'alert' : undefined,
    },
  ];

  return <div className="in-page pl-page">
    <PageHeader title={section?.label || 'Overview'} description={section?.description} />
    {error && !data ? <div className="o-panel"><ErrorState error={error} onRetry={refresh} what="the overview" /></div> : <div className="pl-stack">
      {data && !data.available.operations && <NotInstalled what="Orders and revenue" migration="003" />}
      <KpiTiles tiles={tiles} count={5} />
      {error && data && <p className="o-note is-error"><OIcon name="alert" size={16} /><span>{error.message}</span></p>}

      <div className="pl-grid-2">
        <Panel title="Needs attention" count={data ? data.requests.open + data.requests.complaints : undefined}
          sub="Open requests and complaints, newest first"
          actions={<Link className="o-btn is-quiet is-small" to="/admin/leads-requests">All requests<OIcon name="arrowRight" size={15} /></Link>}>
          {!data ? <SkeletonRows rows={4} thumb={false} label="Loading requests" />
            : !data.available.support ? <div className="o-panel-body"><NotInstalled what="Support requests" migration="006" /></div>
              : !data.recentRequests.length ? <EmptyState title="Nothing waiting">No open requests or complaints. New ones from owners show up here.</EmptyState>
                : <ul className="pl-list">
                  {data.recentRequests.map((request) => <li key={request.id}>
                    <Link className="pl-row" to={`/admin/${request.type === 'complaint' ? 'complaints' : 'leads-requests'}?open=${request.id}`}>
                      <span className={`pl-type-dot is-${request.type}${request.urgency === 'urgent' ? ' is-urgent' : ''}`} aria-hidden="true" />
                      <span className="pl-row-main">
                        <strong>{request.subject}</strong>
                        <small>{request.restaurant?.name || request.contactName || 'No restaurant'} · {REQUEST_TYPES[request.type]}{request.urgency === 'urgent' ? ' · Urgent' : ''}</small>
                      </span>
                      <span className="pl-row-end"><RequestStatus status={request.status} /><small>{timeAgo(request.createdAt)}</small></span>
                    </Link>
                  </li>)}
                </ul>}
        </Panel>

        <Panel title="Newest restaurants" sub="Most recently added"
          actions={<Link className="o-btn is-quiet is-small" to="/admin/restaurants">All restaurants<OIcon name="arrowRight" size={15} /></Link>}>
          {!data ? <SkeletonRows rows={4} thumb={false} label="Loading restaurants" />
            : !data.newestRestaurants.length ? <EmptyState icon="utensils" title="No restaurants yet">Invite an owner from Users to add the first one.</EmptyState>
              : <ul className="pl-list">
                {data.newestRestaurants.map((restaurant) => <li key={restaurant.id}>
                  <Link className="pl-row" to={`/admin/restaurants?open=${restaurant.id}`}>
                    <span className="pl-avatar" aria-hidden="true">{restaurant.name.slice(0, 1).toUpperCase()}</span>
                    <span className="pl-row-main">
                      <strong>{restaurant.name}</strong>
                      <small>{[kindLabel(restaurant.kind), restaurant.area].filter(Boolean).join(' · ') || 'Details not set yet'}</small>
                    </span>
                    <span className="pl-row-end"><RestaurantStatus status={restaurant.status} /><small>Joined {timeAgo(restaurant.createdAt)}</small></span>
                  </Link>
                </li>)}
              </ul>}
        </Panel>
      </div>

      {data ? <SeriesBars title="Last 7 days" series={data.series} metrics={SERIES_METRICS} rangeLabel="the last 7 days, all restaurants" />
        : <ChartSkeleton title="Last 7 days" bars={7} />}
    </div>}
  </div>;
}
