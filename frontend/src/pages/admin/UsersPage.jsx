// Admin Users: invite people, change roles, suspend and reactivate access.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { api } from '../../lib/api';
import InviteDialog from './InviteDialog';
import UserDrawer from './UserDrawer';
import UserIcon from './UserIcon';
import { UserCards, UserTable } from './UserList';
import {
  ROLE_OPTIONS, SORTS, TABS, activeAdminCount, blockedReason, firstName, matchesSearch, roleArticle, sortUsers, tabCounts,
} from './users-model';
import './users.css';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, [query]);
  return matches;
}

function Tabs({ tab, counts, onChange, controls }) {
  const refs = useRef({});
  function onKeyDown(event) {
    const index = TABS.findIndex((item) => item.id === tab);
    const delta = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next = null;
    if (delta) next = TABS[(index + delta + TABS.length) % TABS.length];
    if (event.key === 'Home') next = TABS[0];
    if (event.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  }
  return <div className="u-tabs" role="tablist" aria-label="Filter users" onKeyDown={onKeyDown}>
    {TABS.map((item) => <button key={item.id} ref={(element) => { refs.current[item.id] = element; }} type="button" role="tab"
      id={`users-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={controls} tabIndex={tab === item.id ? 0 : -1}
      className={`u-tab${tab === item.id ? ' is-active' : ''}`} onClick={() => onChange(item.id)}>
      {item.label}{counts ? <span className="u-tab-count" aria-label={`, ${counts[item.id] ?? 0} users`}>{counts[item.id] ?? 0}</span>
        : <span className="u-tab-count is-loading sk" aria-hidden="true" />}
    </button>)}
  </div>;
}

function EmptyState({ query, tab, onClear }) {
  const tabLabel = TABS.find((item) => item.id === tab)?.label.toLowerCase();
  const title = query ? `No users match “${query}”` : `No ${tab === 'all' ? 'users' : tabLabel} yet`;
  const text = query ? 'Check the spelling, or search by another name or email address.'
    : tab === 'invited' ? 'Everyone you invited has accepted.' : tab === 'suspended' ? 'Nobody is suspended right now.' : 'Invite someone to get started.';
  return <div className="u-state" role="status">
    <span className="u-state-icon"><UserIcon name={query ? 'search' : 'team'} size={20} /></span>
    <p className="u-state-title">{title}{query && tab !== 'all' ? ` in ${tabLabel}` : ''}</p>
    <p className="u-state-text">{text}</p>
    {(query || tab !== 'all') && <button type="button" className="u-btn is-secondary" onClick={onClear}>Clear filters</button>}
  </div>;
}

function ErrorState({ message, onRetry }) {
  return <div className="u-state is-error" role="alert">
    <span className="u-state-icon"><UserIcon name="alert" size={20} /></span>
    <p className="u-state-title">Couldn’t load users</p>
    <p className="u-state-text">{message}</p>
    <button type="button" className="u-btn is-secondary" onClick={onRetry}><UserIcon name="refresh" size={15} />Try again</button>
  </div>;
}

export default function UsersPage({ section }) {
  const { notify } = useNotifications();
  const [params, setParams] = useSearchParams();
  const [users, setUsers] = useState([]);
  const [load, setLoad] = useState({ state: 'loading', message: '' });
  const [attempt, setAttempt] = useState(0);
  const [sort, setSort] = useState('recent');
  const [selected, setSelected] = useState({ id: null, open: false, intent: null });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const usersRef = useRef(users);
  const searchRef = useRef(null);
  const mobile = useMediaQuery('(max-width: 767px)');
  const panelId = useId();
  usersRef.current = users;

  const query = params.get('q') || '';
  const tab = TABS.some((item) => item.id === params.get('tab')) ? params.get('tab') : 'all';
  const updateParams = useCallback((changes) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(changes)) { if (value && value !== 'all') next.set(key, value); else next.delete(key); }
    return next;
  }, { replace: true }), [setParams]);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: 'loading', message: '' });
    api('/api/admin/users', { signal: controller.signal })
      .then((data) => { setUsers(data.users || []); setLoad({ state: 'ready', message: '' }); })
      .catch((error) => { if (error.name !== 'AbortError') setLoad({ state: 'error', message: error.message }); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (!highlightId) return undefined;
    const timer = window.setTimeout(() => setHighlightId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const searched = useMemo(() => users.filter((user) => matchesSearch(user, query)), [users, query]);
  const counts = useMemo(() => tabCounts(searched), [searched]);
  const visible = useMemo(() => sortUsers(searched.filter(TABS.find((item) => item.id === tab).test), sort), [searched, tab, sort]);
  const activeAdmins = activeAdminCount(users);
  const selectedUser = users.find((user) => user.id === selected.id) || null;

  const clearFilters = () => { updateParams({ q: '', tab: '' }); searchRef.current?.focus(); };

  /** Optimistic update: apply `patch` now, replace with the server row, roll back on failure. */
  const mutate = useCallback(async (user, patch, request, success) => {
    const previous = usersRef.current.find((item) => item.id === user.id);
    if (!previous) return;
    setUsers((list) => list.map((item) => (item.id === user.id ? { ...item, ...patch, pending: true } : item)));
    try {
      const data = await request();
      setUsers((list) => list.map((item) => (item.id === user.id ? data.user : item)));
      notify(success(data.user, data));
    } catch (error) {
      setUsers((list) => list.map((item) => (item.id === user.id ? previous : item)));
      notify(error.message, { type: 'error', duration: 7000 });
    }
  }, [notify]);

  const changeRole = useCallback((user, role) => mutate(user, { role },
    () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { role } }),
    (next) => `${firstName(next.name)} is now ${roleArticle[role]}.`), [mutate]);
  const rename = useCallback((user, name) => mutate(user, { name },
    () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { name } }),
    (next) => `Renamed to ${next.name}.`), [mutate]);
  const suspend = useCallback((user) => mutate(user, { status: 'suspended' },
    () => api(`/api/admin/users/${user.id}/suspend`, { method: 'POST' }),
    (next) => `${firstName(next.name)} is suspended and can’t sign in.`), [mutate]);
  const reactivate = useCallback((user) => mutate(user, { status: user.last_sign_in_at ? 'active' : 'invited' },
    () => api(`/api/admin/users/${user.id}/reactivate`, { method: 'POST' }),
    (next) => `${firstName(next.name)} can sign in again.`), [mutate]);
  const resend = useCallback((user) => mutate(user, {},
    () => api(`/api/admin/users/${user.id}/resend-invite`, { method: 'POST' }),
    (next) => `Invite sent again to ${next.email}.`), [mutate]);

  const openUser = useCallback((user, intent = null) => setSelected({ id: user.id, open: true, intent }), []);
  const closeUser = useCallback(() => setSelected((current) => ({ ...current, open: false, intent: null })), []);

  const menuFor = useCallback((user) => {
    const roleLock = user.isSelf || user.isPrimaryAdmin ? blockedReason(user, 'role') : null;
    const items = [{ label: 'View details', icon: 'panel', onSelect: () => openUser(user) }, { separator: true }];
    if (roleLock) items.push({ label: 'Change role', icon: 'team', disabled: true, reason: roleLock });
    else {
      items.push({ group: 'Change role' });
      for (const option of ROLE_OPTIONS) {
        const reason = option.value === user.role ? null : blockedReason(user, 'role', { activeAdmins, nextRole: option.value });
        items.push({
          label: option.label, checked: user.role === option.value, disabled: Boolean(reason) || user.pending, reason,
          onSelect: () => {
            if (option.value === user.role) return;
            if (option.value === 'admin' || user.role === 'admin') openUser(user, { type: 'role', role: option.value });
            else changeRole(user, option.value);
          },
        });
      }
    }
    items.push({ separator: true });
    if (user.status === 'invited') items.push({ label: 'Resend invite', icon: 'mail', disabled: user.pending, onSelect: () => resend(user) });
    if (user.status === 'suspended') {
      const reason = blockedReason(user, 'reactivate');
      items.push({ label: 'Reactivate', icon: 'restore', disabled: Boolean(reason) || user.pending, reason, onSelect: () => reactivate(user) });
    } else {
      const reason = blockedReason(user, 'suspend', { activeAdmins });
      items.push({ label: 'Suspend…', icon: 'ban', danger: true, disabled: Boolean(reason) || user.pending, reason, onSelect: () => openUser(user, { type: 'suspend' }) });
    }
    return items;
  }, [activeAdmins, changeRole, openUser, reactivate, resend]);

  function onInvited(user) {
    setInviteOpen(false);
    setUsers((list) => [user, ...list.filter((item) => item.id !== user.id)]);
    const currentTab = TABS.find((item) => item.id === tab);
    updateParams({ q: matchesSearch(user, query) ? query : '', tab: currentTab.test(user) ? tab : '' });
    setHighlightId(user.id);
    notify(`Invite sent to ${user.email}.`);
    requestAnimationFrame(() => document.querySelector(`[data-user-id="${user.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  const caption = `${TABS.find((item) => item.id === tab).label} users${query ? ` matching “${query}”` : ''}`;
  const List = mobile ? UserCards : UserTable;
  const loading = load.state === 'loading';

  return <div className="users-page">
    <PageHeader title={section.label} description={section.description}>
      <button type="button" className="u-btn is-primary u-invite-button" onClick={() => setInviteOpen(true)}>
        <UserIcon name="plus" size={16} />Invite user
      </button>
    </PageHeader>

    <section className="panel u-panel" aria-label="Users">
      <Tabs tab={tab} counts={loading ? null : counts} controls={panelId} onChange={(id) => updateParams({ tab: id })} />
      <div className="u-toolbar">
        <div className={`u-search${query ? ' has-query' : ''}`}>
          <UserIcon name="search" size={15} />
          <input ref={searchRef} type="search" value={query} placeholder="Search by name or email" aria-label="Search users by name or email"
            onChange={(event) => updateParams({ q: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); updateParams({ q: '' }); } }} />
          {query && <button type="button" className="u-search-clear" onClick={() => { updateParams({ q: '' }); searchRef.current?.focus(); }} aria-label="Clear search">
            <UserIcon name="close" size={12} /></button>}
        </div>
        <p className="u-result-count" aria-live="polite">{loading ? '' : `${visible.length} ${visible.length === 1 ? 'user' : 'users'}`}</p>
        <label className="u-sort">
          <span className="visually-hidden">Sort users</span>
          <UserIcon name="sort" size={15} />
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {SORTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <UserIcon name="chevron" size={13} className="u-select-chevron" />
        </label>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`users-tab-${tab}`} className="u-panel-body">
        {load.state === 'error' ? <ErrorState message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
          : !loading && visible.length === 0 ? <EmptyState query={query} tab={tab} onClear={clearFilters} />
            : <List users={visible} loading={loading} onOpen={openUser} menuFor={menuFor} highlightId={highlightId} caption={caption} />}
      </div>
    </section>

    <UserDrawer user={selectedUser} open={selected.open && Boolean(selectedUser)} intent={selected.intent} onClose={closeUser}
      activeAdmins={activeAdmins} onChangeRole={changeRole} onRename={rename} onSuspend={suspend} onReactivate={reactivate} onResend={resend} />
    <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={onInvited} />
  </div>;
}
