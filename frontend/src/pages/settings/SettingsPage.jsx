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

const STATE = '/api/restaurant/onboarding';

const OWNER_TABS = [
  { key: 'restaurant', label: 'Restaurant', icon: 'store', hint: 'Name, contact, logo' },
  { key: 'hours', label: 'Opening hours', icon: 'clock', hint: 'When you’re open' },
  { key: 'floor', label: 'Tables & QR codes', icon: 'qr', hint: 'Tables, sections, menu link' },
  { key: 'team', label: 'Team', icon: 'users', hint: 'Waiters and managers' },
  { key: 'account', label: 'Your account', icon: 'user', hint: 'Name, password, sign out' },
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

function Summary({ state, onPick }) {
  const r = state.restaurant;
  const live = r.status === 'live';
  const facts = [
    { tab: 'restaurant', label: [kindLabel(r.kind), r.area].filter(Boolean).join(' · ') || 'Add your area' },
    { tab: 'hours', label: hoursSummary(r.openingHours) || 'Add opening hours' },
    { tab: 'floor', label: `${state.tables.length} table${state.tables.length === 1 ? '' : 's'}${state.sections.length ? ` in ${state.sections.length} section${state.sections.length === 1 ? '' : 's'}` : ''}` },
  ];
  return <section className="st-summary-card" aria-label="Your restaurant">
    {r.logoUrl ? <img className="st-summary-logo" src={r.logoUrl} alt="" /> : <span className="st-summary-logo is-empty" aria-hidden="true">{(r.name || '?')[0].toUpperCase()}</span>}
    <div className="st-summary-text">
      <p className="st-summary-name">{r.name}<span className={`st-status${live ? ' is-live' : ''}`}><span className="st-status-dot" aria-hidden="true" />{live ? 'Live' : 'Setting up'}</span></p>
      <p className="st-summary-facts">{facts.map((fact) => <button key={fact.tab} type="button" className="st-fact" onClick={() => onPick(fact.tab)}>{fact.label}</button>)}</p>
    </div>
    {!live && <Link className="o-btn is-primary is-small" to="/onboarding">Finish setup</Link>}
  </section>;
}

export default function SettingsPage({ section }) {
  const { account } = useOutletContext() || {};
  const owner = account?.role === 'owner';
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
    <PageHeader title={section.label} description={owner ? 'Change your restaurant’s details, hours, tables and team. Changes reach your guest menu straight away.' : 'Your name, password and sign-in.'} />
    {owner && state?.restaurant && <Summary state={state} onPick={pick} />}
    <div className={`st-layout${tabs.length > 1 ? '' : ' is-single'}`}>
      {tabs.length > 1 && <nav className="st-nav" aria-label="Settings sections">
        <ul>
          {tabs.map((tab) => <li key={tab.key}>
            <button type="button" className={`st-nav-item${tab === active ? ' is-active' : ''}`} aria-current={tab === active ? 'page' : undefined} onClick={() => pick(tab.key)}>
              <span className="st-nav-icon"><OIcon name={tab.icon} size={17} /></span>
              <span className="st-nav-text"><strong>{tab.label}</strong><span>{tab.hint}</span></span>
            </button>
          </li>)}
        </ul>
        <Link className="st-help" to="/owner/contact-cravio">
          <OIcon name="help" size={17} /><span><strong>Need a hand?</strong><span>Contact the Cravio team</span></span>
        </Link>
      </nav>}
      <div className="st-content" key={active.key}>{body}</div>
    </div>
  </>;
}
