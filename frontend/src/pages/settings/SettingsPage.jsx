// Settings: everything an owner changes about their restaurant after setup, in plain sections, plus the
// account settings every role has. The active section lives in the URL (?tab=team), so links and refresh work.
import { useCallback, useMemo } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { ErrorState, OIcon, SkeletonRows } from '../../components/owner/ui';
import '../../components/onboarding/onboarding.css';
import '../../components/owner/menu-config.css';
import { api, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hoursSummary, kindLabel } from '../../lib/onboarding';
import RestaurantTab from './RestaurantTab';
import HoursTab from './HoursTab';
import FloorTab from './FloorTab';
import TeamTab from './TeamTab';
import AccountTab from './AccountTab';
import './settings.css';
import { branchPath } from '../../lib/branch';

const STATE = '/api/restaurant/onboarding';

const OWNER_TABS = [
  { key: 'restaurant', label: 'Restaurant', icon: 'store' },
  { key: 'hours', label: 'Opening hours', icon: 'clock' },
  { key: 'floor', label: 'Tables & QR codes', icon: 'qr' },
  { key: 'team', label: 'Team', icon: 'users' },
  { key: 'account', label: 'Account', icon: 'user' },
];
const ACCOUNT_ONLY = [OWNER_TABS[4]];

/** Writes that also refresh the cached onboarding state, so every owner page sees the change. */
function useRestaurantActions(setData) {
  const { retry } = useAuth();
  const merge = useCallback((patch) => setData((current) => current && { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }), [setData]);
  return useMemo(() => ({
    async patchRestaurant(fields) {
      const { restaurant } = await api('/api/restaurant', { method: 'PATCH', body: fields });
      merge({ restaurant });
      // The sidebar's place card (name and area) comes from /api/me.
      if ('name' in fields || 'area' in fields || 'address' in fields) retry();
      return restaurant;
    },
    async setTables(count) { const { tables } = await api('/api/restaurant/tables', { method: 'PUT', body: { count } }); merge({ tables }); },
    async setSections(names) { const { sections } = await api('/api/restaurant/sections', { method: 'PUT', body: { names } }); merge({ sections }); },
    async addInvite(fields) { const { invite } = await api('/api/restaurant/invites', { method: 'POST', body: fields }); merge((s) => ({ invites: [...s.invites, invite] })); },
    async removeInvite(id) { await api(`/api/restaurant/invites/${id}`, { method: 'DELETE' }); merge((s) => ({ invites: s.invites.filter((i) => i.id !== id) })); },
    async sendInvites() {
      const { invites } = await api('/api/restaurant/invites/send', { method: 'POST' });
      merge((s) => ({ invites: s.invites.map((i) => invites.find((sent) => sent.id === i.id) || i) }));
      return invites;
    },
  }), [merge, retry]);
}

/** The restaurant in one line at the top of the Restaurant section: logo, name, status and the facts. */
function Identity({ state }) {
  const r = state.restaurant;
  const live = r.status === 'live';
  const facts = [[kindLabel(r.kind), r.area].filter(Boolean).join(' · '), hoursSummary(r.openingHours),
    `${state.tables.length} table${state.tables.length === 1 ? '' : 's'}`].filter(Boolean);
  return <div className="cs-identity">
    {r.logoUrl ? <img className="cs-identity-logo" src={r.logoUrl} alt="" /> : <span className="cs-identity-logo is-empty" aria-hidden="true">{(r.name || '?')[0].toUpperCase()}</span>}
    <div className="cs-identity-text">
      <p className="cs-identity-name">{r.name}<span className={`st-status${live ? ' is-live' : ''}`}><span className="st-status-dot" aria-hidden="true" />{live ? 'Live' : 'Setting up'}</span></p>
      <p className="cs-identity-facts">{facts.join(' · ')}</p>
    </div>
    {!live && <Link className="o-btn is-primary is-small" to="/onboarding">Finish setup</Link>}
  </div>;
}

export default function SettingsPage({ section }) {
  const { scope, account } = useOutletContext() || {};
  // Restaurant settings belong to the branch workspace; elsewhere (admin) only the account tab shows.
  const owner = scope?.area === 'branch';
  const tabs = owner ? OWNER_TABS : ACCOUNT_ONLY;
  const [params, setParams] = useSearchParams();
  const active = tabs.find((tab) => tab.key === params.get('tab')) || tabs[0];
  const restaurant = useApi(owner ? STATE : null, { ttl: 60000 });
  const actions = useRestaurantActions(restaurant.setData);
  const state = restaurant.data;
  const isOwner = state?.role ? state.role === 'owner' : true;

  const pick = (key) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (key === tabs[0].key) next.delete('tab'); else next.set('tab', key);
    return next;
  }, { replace: true });

  let body;
  if (active.key === 'account') body = <AccountTab account={account} />;
  else if (restaurant.loading) body = <div className="st-card"><SkeletonRows rows={4} thumb={false} label="Loading your settings" /></div>;
  else if (restaurant.error || !state?.restaurant) body = <div className="st-card"><ErrorState error={restaurant.error} onRetry={restaurant.refresh} what="your restaurant settings" /></div>;
  else if (active.key === 'restaurant') body = <RestaurantTab key={state.restaurant.id} restaurant={state.restaurant} patchRestaurant={actions.patchRestaurant} />;
  else if (active.key === 'hours') body = <HoursTab restaurant={state.restaurant} patchRestaurant={actions.patchRestaurant} />;
  else if (active.key === 'floor') body = <FloorTab state={state} actions={actions} />;
  else if (active.key === 'team') body = <TeamTab state={state} actions={actions} isOwner={isOwner} />;

  return <>
    <PageHeader title={section.label} description={owner ? 'Changes reach your guest menu straight away.' : 'Your name, password and sign-in.'} />
    <div className={`cs-panel${tabs.length > 1 ? '' : ' is-single'}`}>
      {tabs.length > 1 && <nav className="cs-nav" aria-label="Settings sections">
        <ul>
          {tabs.map((tab) => <li key={tab.key}>
            <button type="button" className={`cs-nav-item${tab === active ? ' is-active' : ''}`} aria-current={tab === active ? 'page' : undefined} onClick={() => pick(tab.key)}>
              <OIcon name={tab.icon} size={17} /><span>{tab.label}</span>
            </button>
          </li>)}
        </ul>
        <Link className="cs-help" to={branchPath('contact-cravio')}><OIcon name="help" size={16} /><span>Contact Cravio</span></Link>
      </nav>}
      <div className="cs-content" key={active.key}>
        <h2 className="cs-title">{active.label}</h2>
        {active.key === 'restaurant' && state?.restaurant && <Identity state={state} />}
        {body}
      </div>
    </div>
  </>;
}
