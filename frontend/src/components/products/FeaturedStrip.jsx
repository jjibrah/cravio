import { useEffect, useState } from 'react';
import { useNotifications } from '../notifications/NotificationProvider';
import Drawer from '../owner/Drawer';
import { OIcon } from '../owner/ui';
import { PIcon, formatKsh, merchApi, moveIn } from './shared';

/** A slim strip of the featured dishes in their menu order, with a drawer to reorder them. */
export default function FeaturedStrip({ items, featuredIds, limit = 10, onOpen }) {
  const [open, setOpen] = useState(false);
  const byId = new Map(items.map((item) => [item.id, item]));
  const featured = featuredIds.map((id) => byId.get(id)).filter(Boolean);
  return <section className="pf-strip" aria-labelledby="featured-strip-title">
    <div className="pf-strip-head">
      <span className="pf-strip-icon"><PIcon name="star" size={15} filled /></span>
      <h2 id="featured-strip-title">Featured</h2>
      <span className="pf-strip-sub">{featured.length ? `Shown first on your menu · ${featured.length} of ${limit}` : 'Star a dish to show it first on your menu'}</span>
      {featured.length > 1 && <button type="button" className="o-btn is-quiet is-small pf-strip-btn" onClick={() => setOpen(true)}><PIcon name="sliders" size={15} />Reorder</button>}
    </div>
    {featured.length > 0 && <ol className="pf-chips">
      {featured.map((item, index) => <li key={item.id}>
        <button type="button" className="pf-chip" onClick={() => onOpen(item)} aria-label={`${index + 1}. ${item.name}${item.available ? '' : ', sold out'}`}>
          <span className="pf-chip-pos" aria-hidden="true">{index + 1}</span>
          <span className="pf-chip-thumb" aria-hidden="true">{item.photoUrl || item.videoPosterUrl ? <img src={item.photoUrl || item.videoPosterUrl} alt="" /> : item.name[0]}</span>
          <span className="pf-chip-name">{item.name}</span>
          {!item.available && <span className="pf-chip-flag">Sold out</span>}
        </button>
      </li>)}
    </ol>}
    <FeaturedDrawer open={open} onClose={() => setOpen(false)} featured={featured} />
  </section>;
}

export function FeaturedDrawer({ open, onClose, featured }) {
  const { notify } = useNotifications();
  const [list, setList] = useState(featured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setList(featured); setError(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = list.map((item) => item.id).join() !== featured.map((item) => item.id).join();

  async function save() {
    setBusy(true); setError('');
    try {
      await merchApi.setFeatured(list.map((item) => item.id));
      notify('Featured order saved.');
      onClose();
    } catch (problem) { setError(problem.message); } finally { setBusy(false); }
  }

  return <Drawer open={open} onClose={onClose} title="Featured order"
    footer={<><button type="button" className="o-btn is-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save order'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose}>Cancel</button></>}>
    <p className="mc-intro">Guests see featured dishes first, in this order. Sold-out dishes are skipped until they’re back.</p>
    {error && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{error}</span></p>}
    <ol className="pf-order">
      {list.map((item, index) => <li key={item.id} className="pf-order-row">
        <span className="mc-pos" aria-hidden="true">{index + 1}</span>
        <span className="pf-chip-thumb" aria-hidden="true">{item.photoUrl ? <img src={item.photoUrl} alt="" /> : item.name[0]}</span>
        <span className="pf-order-name">{item.name}<small>{formatKsh(item.price)}{item.available ? '' : ' · Sold out'}</small></span>
        <button type="button" className="o-icon-btn" disabled={index === 0} aria-label={`Move ${item.name} up`} onClick={() => setList((current) => moveIn(current, index, index - 1))}><OIcon name="arrowUp" size={16} /></button>
        <button type="button" className="o-icon-btn" disabled={index === list.length - 1} aria-label={`Move ${item.name} down`} onClick={() => setList((current) => moveIn(current, index, index + 1))}><OIcon name="arrowDown" size={16} /></button>
        <button type="button" className="o-icon-btn" aria-label={`Unfeature ${item.name}`} onClick={() => setList((current) => current.filter((entry) => entry.id !== item.id))}><OIcon name="close" size={16} /></button>
      </li>)}
    </ol>
    {!list.length && <p className="mc-intro">No featured dishes. Star a dish on its card to feature it.</p>}
  </Drawer>;
}
