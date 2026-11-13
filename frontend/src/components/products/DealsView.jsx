import { useState } from 'react';
import { useNotifications } from '../notifications/NotificationProvider';
import { OIcon } from '../owner/ui';
import { PIcon, SaleSwitch, formatCount, formatKsh, merchApi, moveIn } from './shared';

/* The Deals tab: deal cards with stacked dish photos, prices, status in words, an Active switch and reordering. */

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short' });
/** "31 Dec". An end time is the end of a day, so step back a moment to name that day. */
export const dealDay = (iso, end = false) => (iso ? dayFormat.format(new Date(Date.parse(iso) - (end ? 1 : 0))) : '');

export function dealStatus(deal) {
  switch (deal.status) {
    case 'live': return { tone: 'live', label: 'Active', detail: deal.endsAt ? `Until ${dealDay(deal.endsAt, true)}` : 'Guests see it now' };
    case 'scheduled': return { tone: 'scheduled', label: 'Scheduled', detail: `Starts ${dealDay(deal.startsAt)}` };
    case 'ended': return { tone: 'ended', label: 'Ended', detail: `Ended ${dealDay(deal.endsAt, true)}` };
    case 'inactive': return { tone: 'off', label: 'Off', detail: 'Guests don’t see it' };
    default: return { tone: 'hidden', label: 'Hidden', detail: deal.issues?.[0]?.message || 'Guests can’t see it right now' };
  }
}

export default function DealsView({ deals, loading, onOpen, onNew, onChange }) {
  const { notify } = useNotifications();
  const [busy, setBusy] = useState({});

  async function toggle(deal) {
    const active = !deal.active;
    setBusy((current) => ({ ...current, [deal.id]: true }));
    onChange((menu) => ({ ...menu, deals: menu.deals.map((entry) => (entry.id === deal.id ? { ...entry, active, status: active ? entry.status : 'inactive' } : entry)) }));
    try {
      await merchApi.updateDeal(deal.id, { active });
      notify(active ? `${deal.name} is on.` : `${deal.name} is off. Guests won’t see it.`);
    } catch (problem) {
      onChange((menu) => ({ ...menu, deals: menu.deals.map((entry) => (entry.id === deal.id ? deal : entry)) }));
      notify(problem.message, { type: 'error' });
    } finally { setBusy((current) => { const next = { ...current }; delete next[deal.id]; return next; }); }
  }

  async function move(index, direction) {
    const next = moveIn(deals, index, index + direction);
    const before = deals;
    onChange((menu) => ({ ...menu, deals: next.map((deal, position) => ({ ...deal, position })) }));
    requestAnimationFrame(() => document.querySelector(`[data-deal-move="${deals[index].id}:${direction}"]`)?.focus());
    try { await merchApi.orderDeals(next.map((deal) => deal.id)); } catch (problem) {
      onChange((menu) => ({ ...menu, deals: before }));
      notify(problem.message, { type: 'error' });
    }
  }

  if (loading) {
    return <ul className="dl-grid" role="status" aria-label="Loading deals">{[0, 1, 2].map((i) => <li key={i} className="dl-card is-skeleton" aria-hidden="true">
      <div className="dl-photos"><span className="sk" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} /></div>
      <div className="dl-body"><span className="sk sk-text" style={{ width: '60%' }} /><span className="sk sk-line" style={{ width: '40%', marginTop: 10 }} /></div>
    </li>)}</ul>;
  }

  if (!deals.length) {
    return <div className="dl-empty">
      <span className="dl-empty-art" aria-hidden="true"><PIcon name="tag" size={26} /></span>
      <h2>No deals yet</h2>
      <p>Bundle a main with a drink to lift average orders. Guests see the saving on your menu.</p>
      <button type="button" className="o-btn is-primary" onClick={onNew}><OIcon name="plus" size={16} />New deal</button>
    </div>;
  }

  const live = deals.filter((deal) => deal.status === 'live').length;
  return <section aria-labelledby="deals-title">
    <div className="dl-head">
      <div><h2 id="deals-title">Pairs & deals</h2><p>{deals.length} {deals.length === 1 ? 'deal' : 'deals'} · {live} live · Guests see them in this order</p></div>
    </div>
    <ul className="dl-grid">
      {deals.map((deal, index) => <DealCard key={deal.id} deal={deal} first={index === 0} last={index === deals.length - 1} busy={busy[deal.id]}
        onOpen={() => onOpen(deal)} onToggle={() => toggle(deal)} onMove={(direction) => move(index, direction)} />)}
    </ul>
  </section>;
}

function DealCard({ deal, first, last, busy, onOpen, onToggle, onMove }) {
  const status = dealStatus(deal);
  const stats = deal.stats30d || {};
  return <li className={`dl-card is-${status.tone}`}>
    <DealPhotos deal={deal} />
    <div className="dl-body">
      <div className="dl-title-row">
        <button type="button" className="pc-open dl-open" onClick={onOpen}><span className="dl-name">{deal.name}</span></button>
        <span className={`dl-status is-${status.tone}`}><span className="dl-status-dot" aria-hidden="true" />{status.label}</span>
      </div>
      <p className="dl-items">{deal.items.map((line) => `${line.quantity > 1 ? `${line.quantity}× ` : ''}${line.name}`).join(' + ')}</p>
      <p className="dl-prices">
        <strong>{formatKsh(deal.price)}</strong>
        {deal.regularPrice > deal.price && <s aria-label={`Regular price ${formatKsh(deal.regularPrice)}`}>{formatKsh(deal.regularPrice)}</s>}
        {deal.saving > 0 ? <span className="dl-save">Save {formatKsh(deal.saving)}</span> : <span className="dl-save is-none">No saving</span>}
      </p>
      <p className={`dl-detail${status.tone === 'hidden' ? ' is-issue' : ''}`}>
        {status.tone === 'hidden' && <OIcon name="alert" size={14} />}{status.detail}
      </p>
      <p className="pc-stats">{formatCount(stats.orderedQuantity)} sold · {formatKsh(stats.sales)} <span className="pc-stats-range">· 30d</span></p>
    </div>
    <div className="pc-foot dl-foot">
      <SaleSwitch on={deal.active} onToggle={onToggle} label={`${deal.name} active`} busy={busy} onText="Active" offText="Off" />
      <span className="dl-move">
        <button type="button" className="o-icon-btn" disabled={first} onClick={onMove.bind(null, -1)} data-deal-move={`${deal.id}:-1`} aria-label={`Move ${deal.name} earlier`}><OIcon name="arrowLeft" size={15} /></button>
        <button type="button" className="o-icon-btn" disabled={last} onClick={onMove.bind(null, 1)} data-deal-move={`${deal.id}:1`} aria-label={`Move ${deal.name} later`}><OIcon name="arrowRight" size={15} /></button>
      </span>
    </div>
  </li>;
}

/** The deal's own photo, or up to three dish photos (or initials) fanned out. */
export function DealPhotos({ deal, photoUrl = deal.photoUrl }) {
  if (photoUrl) return <div className="dl-photos"><img src={photoUrl} alt="" loading="lazy" /></div>;
  const tiles = deal.items.slice(0, 3);
  return <div className="dl-photos is-stack" data-count={tiles.length}>
    {tiles.map((line, index) => <span key={line.itemId || index} className={`dl-tile${line.available === false ? ' is-off' : ''}`} style={{ '--i': index }}>
      {line.photoUrl ? <img src={line.photoUrl} alt="" loading="lazy" /> : <span className="dl-tile-initial">{line.name[0]}</span>}
      <span className="dl-tile-name">{line.name}</span>
    </span>)}
  </div>;
}
