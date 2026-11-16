// Owner Overview. Two views:
//   Briefing – the owner's daily brief (what happened, what needs you) and an assistant to ask about it.
//   Branches – today's recorded figures per branch.
// Everything comes from /api/owner/briefing and /api/owner/overview, computed from recorded orders, guest requests
// and stock. No AI model is connected yet; the assistant says so and answers from those records only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BranchStatus, OwnerError, WorkspaceLink, money, roleName, timeAgo } from './shared';
import './business.css';

export function BranchRows({ branches }) {
  return <ul className="biz-branches">
    {branches.map((branch) => <li className="biz-branch" key={branch.id}>
      <div className="biz-branch-name">
        <Link to={`/owner/branches/${branch.id}`}>{branch.name}</Link>
        <span className="biz-branch-sub"><BranchStatus status={branch.status} />{branch.location && <span>{branch.location}</span>}</span>
      </div>
      {branch.today ? <>
        <dl className="biz-figure"><dt>Orders today</dt><dd>{branch.today.orders}</dd></dl>
        <dl className="biz-figure"><dt>Paid today</dt><dd>{money(branch.today.paidSales)}</dd></dl>
        <dl className="biz-figure"><dt>Open requests</dt><dd className={branch.today.openRequests ? 'is-alert' : ''}>{branch.today.openRequests}</dd></dl>
        <dl className="biz-figure"><dt>Last order</dt><dd>{timeAgo(branch.today.lastOrderAt)}</dd></dl>
      </> : <><span /><span /><span /><span /></>}
      <div className="biz-branch-actions">
        <Link className="o-btn is-quiet is-small" to={`/owner/branches/${branch.id}`}>Details</Link>
        <WorkspaceLink branch={branch} />
      </div>
    </li>)}
  </ul>;
}

const greeting = () => { const h = Number(new Date().toLocaleString('en-KE', { hour: 'numeric', hour12: false, timeZone: 'Africa/Nairobi' })); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const clock = (iso) => new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });

/* ---------- Assistant ---------- */

const SUGGESTIONS = [
  { key: 'sales', label: 'How are sales today?' },
  { key: 'best', label: 'What’s selling best?' },
  { key: 'attention', label: 'What needs me?' },
  { key: 'stock', label: 'What’s running low?' },
  { key: 'requests', label: 'Any stock requests?' },
];
const INTENTS = [
  ['best', /best|top|popular|selling|dish|item/],
  ['stock', /stock|low|out|inventory|servings|run(ning)? out/],
  ['requests', /request|dispatch|deliver|transfer|approve/],
  ['attention', /attention|need|urgent|problem|issue|wrong|waiting|guest/],
  ['sales', /sale|revenue|money|paid|order|how.*(doing|going)|today|compare|week/],
];
const intentOf = (text) => INTENTS.find(([, pattern]) => pattern.test(text.toLowerCase()))?.[0] || null;

function Assistant({ brief }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  const ask = (question, key = intentOf(question)) => {
    const answer = key ? brief.answers[key]
      : 'I can answer about today’s sales, best sellers, what needs you, stock levels and stock requests. Wider questions will work once the AI connection is switched on.';
    setMessages((list) => [...list, { from: 'you', text: question }, { from: 'cravio', text: answer }]);
  };
  return <section className="pa-chat" aria-labelledby="pa-chat-title">
    <header className="pa-chat-head">
      <h2 id="pa-chat-title" className="o-panel-title">Ask about today</h2>
      <p className="pa-disclosure">Answers come from your Cravio records. No AI model is connected yet.</p>
    </header>
    <div className="pa-messages" role="log" aria-live="polite" aria-label="Conversation">
      {!messages.length && <p className="pa-empty">Pick a question or type your own.</p>}
      {messages.map((message, index) => <p key={index} className={`pa-bubble is-${message.from}`}>
        <span className="visually-hidden">{message.from === 'you' ? 'You: ' : 'Cravio: '}</span>{message.text}</p>)}
      <span ref={endRef} />
    </div>
    <div className="pa-suggestions" role="group" aria-label="Suggested questions">
      {SUGGESTIONS.map((s) => <button key={s.key} type="button" className="o-chip" onClick={() => ask(s.label, s.key)}>{s.label}</button>)}
    </div>
    <form className="pa-input" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { ask(draft.trim()); setDraft(''); } }}>
      <label className="visually-hidden" htmlFor="pa-question">Ask a question</label>
      <input id="pa-question" className="o-input" value={draft} maxLength={200} placeholder="Ask about sales, stock or requests" onChange={(event) => setDraft(event.target.value)} autoComplete="off" />
      <button type="submit" className="o-btn is-primary" disabled={!draft.trim()} aria-label="Ask"><OIcon name="arrowUp" size={16} /></button>
    </form>
  </section>;
}

function Briefing() {
  const { data: brief, error, loading, refresh } = useApi('/api/owner/briefing', { ttl: 60000 });
  if (error && !brief) return <OwnerError error={error} onRetry={refresh} what="your briefing" />;
  if (loading && !brief) return <Panel title="Today"><SkeletonRows rows={4} thumb={false} label="Preparing your briefing" /></Panel>;
  if (brief.empty) return <EmptyState icon="store" tone="neutral" title="Nothing to brief yet">{brief.headline}</EmptyState>;
  return <div className="pa-layout">
    <article className="pa-brief" aria-labelledby="pa-brief-title">
      <p className="pa-eyebrow">Today · {brief.scope}</p>
      <h2 id="pa-brief-title" className="pa-headline">{brief.headline}</h2>
      <ul className="pa-points">{brief.points.map((point) => <li key={point}>{point}</li>)}</ul>
      <h3 className="pa-subhead">{brief.attention.length ? 'Needs you' : 'All clear'}</h3>
      {brief.attention.length ? <ul className="pa-attention">{brief.attention.map((item, index) => <li key={index} className={`is-${item.tone}`}>
        <span className="pa-dot" aria-hidden="true" />
        <span className="pa-attention-text">{item.text}</span>
        {item.link && <Link className="o-btn is-quiet is-small" to={item.link}>Open<span className="visually-hidden">: {item.text}</span></Link>}
      </li>)}</ul> : <p className="pa-clear">Nothing is waiting on you right now.</p>}
      <p className="pa-foot">Updated {clock(brief.generatedAt)} · Nairobi time · <button type="button" className="o-text-link" onClick={() => refresh()}>Refresh</button></p>
    </article>
    <Assistant brief={brief} />
  </div>;
}

function Branches() {
  const { data, error, loading, refresh } = useApi('/api/owner/overview', { ttl: 20000 });
  const businesses = data?.businesses || [];
  const branches = businesses.flatMap((business) => business.branches);
  const totals = useMemo(() => branches.reduce((sum, branch) => ({
    orders: sum.orders + (branch.today?.orders || 0), paid: sum.paid + (branch.today?.paidSales || 0),
    open: sum.open + (branch.today?.openOrders || 0), requests: sum.requests + (branch.today?.openRequests || 0),
  }), { orders: 0, paid: 0, open: 0, requests: 0 }), [branches]);
  if (error && !data) return <OwnerError error={error} onRetry={refresh} what="your branches" />;
  if (loading && !data) return <Panel title="Branches"><SkeletonRows rows={3} thumb={false} label="Loading branches" /></Panel>;
  if (!businesses.length) return <EmptyState icon="store" tone="neutral" title="No business access yet">Ask the business owner or Cravio to grant access.</EmptyState>;
  return <>
    <section className="biz-grid" aria-label="Today across your branches">
      <div className="o-stat"><p className="o-stat-label">Orders today</p><p className="o-stat-value">{totals.orders}</p><p className="o-stat-hint">Excluding cancelled</p></div>
      <div className="o-stat"><p className="o-stat-label">Paid today</p><p className="o-stat-value">{money(totals.paid)}</p><p className="o-stat-hint">Marked paid by staff</p></div>
      <div className="o-stat"><p className="o-stat-label">In progress</p><p className="o-stat-value">{totals.open}</p><p className="o-stat-hint">Not yet paid</p></div>
      <div className="o-stat"><p className="o-stat-label">Guest requests</p><p className="o-stat-value">{totals.requests}</p><p className="o-stat-hint">Waiter calls and bills</p></div>
    </section>
    {businesses.map((business) => <Panel key={business.id} title={business.name} count={business.branches.length}
      sub={`${roleName[business.role]} · updated ${clock(data.generatedAt)}`}
      actions={business.role === 'owner' && <Link className="o-btn is-quiet is-small" to="/owner/locations">Manage locations</Link>}>
      {business.branches.length ? <BranchRows branches={business.branches} />
        : <EmptyState icon="store" tone="neutral" title="No branches assigned">The business owner hasn’t assigned you any branches yet.</EmptyState>}
    </Panel>)}
  </>;
}

export default function OwnerOverviewPage() {
  const { account } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'branches' ? 'branches' : 'briefing';
  const first = account?.name?.split(/\s+/)[0] || '';
  const date = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' });
  return <div className="biz-stack">
    <PageHeader title={`${greeting()}${first ? `, ${first}` : ''}`} description={date} />
    <Segmented label="Overview" mode="tabs" idBase="overview" value={view}
      onChange={(next) => setParams(next === 'briefing' ? {} : { view: next }, { replace: true })}
      options={[{ value: 'briefing', label: 'Briefing', icon: 'sparkle' }, { value: 'branches', label: 'Branches', icon: 'store' }]} />
    <div id="overview-panel" role="tabpanel" aria-labelledby={`overview-tab-${view}`}>
      {view === 'briefing' ? <Briefing /> : <Branches />}
    </div>
  </div>;
}
