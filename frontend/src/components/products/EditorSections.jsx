import { useEffect, useId, useMemo, useState } from 'react';
import { useNotifications } from '../notifications/NotificationProvider';
import { OIcon } from '../owner/ui';
import { PIcon, SaleSwitch, byPosition, formatKsh, merchApi, moveIn, parseMoney } from './shared';

/* The product editor's merchandising sections. Each saves on its own and shows its own "Saved" or error. */

function useFlash() {
  const [message, setMessage] = useState('');
  useEffect(() => { if (!message) return undefined; const timer = setTimeout(() => setMessage(''), 2500); return () => clearTimeout(timer); }, [message]);
  return [message, setMessage];
}
const Saved = ({ children }) => (children ? <span className="o-saved" role="status"><OIcon name="check" size={15} strokeWidth={2.4} />{children}</span> : null);
const Problem = ({ children }) => (children ? <p className="o-note is-error pe-error" role="alert"><OIcon name="alert" size={16} /><span>{children}</span></p> : null);

/* ---------- Extras ---------- */

export function ExtrasSection({ item, limit }) {
  const extras = useMemo(() => [...(item.extras || [])].sort(byPosition), [item.extras]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useFlash();
  const [busy, setBusy] = useState(false);

  async function run(work, message) {
    setError(''); setBusy(true);
    try { await work(); setSaved(message); return true; } catch (problem) { setError(problem.message); return false; } finally { setBusy(false); }
  }
  const move = (index, direction) => run(() => merchApi.orderExtras(item.id, moveIn(extras, index, index + direction).map((extra) => extra.id)), 'Order saved');

  return <div className="ex">
    {extras.length > 0 && <ol className="ex-list">
      {extras.map((extra, index) => <ExtraRow key={extra.id} extra={extra} first={index === 0} last={index === extras.length - 1} busy={busy}
        onMove={(direction) => move(index, direction)} run={run} />)}
    </ol>}
    {extras.length < limit ? <AddExtra itemName={item.name} existing={extras} onAdd={(body) => run(() => merchApi.addExtra(item.id, body), `${body.name} added`)} />
      : <p className="o-field-hint">This dish has the most extras it can have ({limit}). Remove one to add another.</p>}
    <div className="pe-status"><Saved>{saved}</Saved></div>
    <Problem>{error}</Problem>
  </div>;
}

function ExtraRow({ extra, first, last, busy, onMove, run }) {
  const [name, setName] = useState(extra.name);
  const [price, setPrice] = useState(String(extra.price));
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setName(extra.name); setPrice(String(extra.price)); }, [extra.name, extra.price]);
  const dirty = name.trim() !== extra.name || parseMoney(price) !== Number(extra.price);
  const nameId = useId();
  const priceId = useId();

  const save = (event) => {
    event.preventDefault();
    const value = parseMoney(price);
    if (!name.trim() || !Number.isFinite(value) || value < 0) return run(() => Promise.reject(new Error(!name.trim() ? 'Enter the extra’s name.' : 'Enter a price of 0 or more.')), '');
    return run(() => merchApi.updateExtra(extra.id, { name: name.trim(), price: value }), `${name.trim()} saved`);
  };

  return <li className={`ex-row${extra.available ? '' : ' is-off'}`}>
    <form className="ex-row-main" onSubmit={save} noValidate>
      <label className="visually-hidden" htmlFor={nameId}>Extra name</label>
      <input id={nameId} className="o-input ex-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
      <label className="visually-hidden" htmlFor={priceId}>Price of {extra.name} in Ksh</label>
      <div className="o-price-input ex-price"><span aria-hidden="true">Ksh</span>
        <input id={priceId} className="o-input" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} /></div>
      {dirty ? <button type="submit" className="o-btn is-primary is-small" disabled={busy}>Save</button>
        : <SaleSwitch on={extra.available} label={`${extra.name} available`} onText="On" offText="Off" busy={busy}
          onToggle={() => run(() => merchApi.updateExtra(extra.id, { available: !extra.available }), extra.available ? `${extra.name} is off` : `${extra.name} is on`)} />}
      <span className="ex-tools">
        <button type="button" className="o-icon-btn" disabled={first || busy} onClick={() => onMove(-1)} aria-label={`Move ${extra.name} up`}><OIcon name="arrowUp" size={15} /></button>
        <button type="button" className="o-icon-btn" disabled={last || busy} onClick={() => onMove(1)} aria-label={`Move ${extra.name} down`}><OIcon name="arrowDown" size={15} /></button>
        <button type="button" className="o-icon-btn ex-delete" onClick={() => setConfirm(true)} aria-label={`Delete ${extra.name}`}><OIcon name="trash" size={15} /></button>
      </span>
    </form>
    {confirm && <div className="ex-confirm" role="group" aria-label={`Delete ${extra.name}?`}>
      <span>Delete {extra.name}?</span>
      <button type="button" className="o-btn is-danger-solid is-small" disabled={busy} onClick={async () => { if (await run(() => merchApi.removeExtra(extra.id), `${extra.name} deleted`)) setConfirm(false); }}>Delete</button>
      <button type="button" className="o-btn is-quiet is-small" onClick={() => setConfirm(false)}>Keep</button>
    </div>}
  </li>;
}

function AddExtra({ itemName, existing, onAdd }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const nameId = useId();
  const priceId = useId();
  async function add(event) {
    event.preventDefault();
    const value = parseMoney(price === '' ? '0' : price);
    if (!name.trim()) { setError('Enter the extra’s name, like Cheese.'); return; }
    if (!Number.isFinite(value) || value < 0) { setError('Enter a price of 0 or more.'); return; }
    if (existing.some((extra) => extra.name.toLowerCase() === name.trim().toLowerCase())) { setError(`${itemName} already has ${name.trim()}.`); return; }
    setError('');
    if (await onAdd({ name: name.trim(), price: value })) { setName(''); setPrice(''); document.getElementById(nameId)?.focus(); }
  }
  return <form className="ex-add" onSubmit={add} noValidate>
    <span className="ex-add-plus" aria-hidden="true"><OIcon name="plus" size={15} strokeWidth={2.2} /></span>
    <label className="visually-hidden" htmlFor={nameId}>New extra name</label>
    <input id={nameId} className="o-input ex-name" value={name} maxLength={60} placeholder="Cheese" onChange={(event) => { setName(event.target.value); setError(''); }} />
    <label className="visually-hidden" htmlFor={priceId}>New extra price in Ksh</label>
    <div className="o-price-input ex-price"><span aria-hidden="true">Ksh</span>
      <input id={priceId} className="o-input" inputMode="decimal" value={price} placeholder="150" onChange={(event) => { setPrice(event.target.value); setError(''); }} /></div>
    <button type="submit" className="o-btn is-secondary is-small">Add extra</button>
    {error && <p className="o-field-error ex-add-error" role="alert">{error}</p>}
  </form>;
}

/* ---------- Goes well with (pairings) ---------- */

export function PairingsSection({ item, items, limit }) {
  const { notify } = useNotifications();
  const byId = useMemo(() => new Map(items.map((entry) => [entry.id, entry])), [items]);
  const savedIds = item.pairedItemIds || [];
  const [ids, setIds] = useState(savedIds);
  const [mirror, setMirror] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useFlash();
  const searchId = useId();
  useEffect(() => { setIds(item.pairedItemIds || []); }, [item.pairedItemIds?.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = ids.join() !== savedIds.join() || (mirror && ids.length > 0);

  const q = query.trim().toLowerCase();
  const candidates = items.filter((entry) => entry.id !== item.id && !ids.includes(entry.id) && (!q || entry.name.toLowerCase().includes(q))).slice(0, q ? 8 : 6);

  async function save() {
    setBusy(true); setError('');
    try {
      const result = await merchApi.setPairings(item.id, ids, mirror);
      setMirror(false);
      const mirrored = (result.mirroredItemIds || []).map((id) => byId.get(id)?.name).filter(Boolean);
      setSaved(mirrored.length ? `Saved. Also suggested on ${mirrored.join(', ')}` : 'Saved');
      if (mirrored.length) notify(`${item.name} is now suggested on ${mirrored.join(', ')}.`);
    } catch (problem) { setError(problem.message); } finally { setBusy(false); }
  }

  return <div className="pp">
    {ids.length ? <ol className="pp-list">
      {ids.map((id, index) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return <li key={id} className="pp-row">
          <span className="mc-pos" aria-hidden="true">{index + 1}</span>
          <Thumb item={entry} />
          <span className="pp-name">{entry.name}<small>{formatKsh(entry.price)}{entry.available ? '' : ' · Sold out, hidden for now'}</small></span>
          <button type="button" className="o-icon-btn" disabled={index === 0} onClick={() => setIds((current) => moveIn(current, index, index - 1))} aria-label={`Move ${entry.name} up`}><OIcon name="arrowUp" size={15} /></button>
          <button type="button" className="o-icon-btn" disabled={index === ids.length - 1} onClick={() => setIds((current) => moveIn(current, index, index + 1))} aria-label={`Move ${entry.name} down`}><OIcon name="arrowDown" size={15} /></button>
          <button type="button" className="o-icon-btn" onClick={() => setIds((current) => current.filter((value) => value !== id))} aria-label={`Remove ${entry.name}`}><OIcon name="close" size={15} /></button>
        </li>;
      })}
    </ol> : <p className="pp-empty">No suggestions yet. Chips with a burger, or a drink with a main, are a good start.</p>}

    {ids.length < limit ? <div className="pp-picker">
      <div className="o-search pp-search">
        <OIcon name="search" size={16} />
        <label className="visually-hidden" htmlFor={searchId}>Find a dish to suggest</label>
        <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a dish to suggest" autoComplete="off" />
      </div>
      <ul className="pp-options" aria-label="Dishes you can suggest">
        {candidates.map((entry) => <li key={entry.id}>
          <button type="button" className="pp-option" onClick={() => { setIds((current) => [...current, entry.id]); setQuery(''); }} aria-label={`Suggest ${entry.name}`}>
            <Thumb item={entry} /><span className="pp-name">{entry.name}<small>{formatKsh(entry.price)}</small></span><OIcon name="plus" size={15} />
          </button>
        </li>)}
        {!candidates.length && <li className="pp-none">No other dishes match “{query}”.</li>}
      </ul>
    </div> : <p className="o-field-hint">That’s the most suggestions a dish can have ({limit}).</p>}

    <label className="pp-mirror">
      <input type="checkbox" checked={mirror} onChange={(event) => setMirror(event.target.checked)} />
      <span>Also suggest {item.name} there<small>Adds {item.name} to each chosen dish’s list, if it has room.</small></span>
    </label>
    <div className="pe-actions">
      <button type="button" className="o-btn is-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save suggestions'}</button>
      <Saved>{saved}</Saved>
    </div>
    <Problem>{error}</Problem>
  </div>;
}

export function Thumb({ item, size = 36 }) {
  const src = item.photoUrl || item.videoPosterUrl;
  return <span className="pp-thumb" style={{ width: size, height: size }} aria-hidden="true">{src ? <img src={src} alt="" /> : (item.name || '·')[0].toUpperCase()}</span>;
}

/* ---------- Featured ---------- */

export function FeaturedSection({ item, featuredIds, limit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useFlash();
  const selectId = useId();
  const position = featuredIds.indexOf(item.id);
  const featured = position >= 0;

  async function run(work, message) {
    setBusy(true); setError('');
    try { await work(); setSaved(message); } catch (problem) { setError(problem.message); } finally { setBusy(false); }
  }
  const toggle = () => run(() => merchApi.updateItem(item.id, { featured: !featured }), featured ? 'Removed from featured' : 'Featured');
  const place = (to) => run(() => merchApi.setFeatured(moveIn(featuredIds, position, to)), 'Position saved');

  return <div className="pf">
    <div className="pf-row">
      <button type="button" role="switch" aria-checked={featured} className={`pf-toggle${featured ? ' is-on' : ''}`} onClick={toggle} disabled={busy || (!featured && featuredIds.length >= limit)}>
        <PIcon name="star" size={18} filled={featured} />
        <span>{featured ? 'Featured on your menu' : 'Feature on your menu'}</span>
      </button>
      {featured && <div className="pf-position">
        <label htmlFor={selectId}>Position</label>
        <select id={selectId} className="o-select" value={position} disabled={busy} onChange={(event) => place(Number(event.target.value))}>
          {featuredIds.map((id, index) => <option key={id} value={index}>{index + 1} of {featuredIds.length}</option>)}
        </select>
      </div>}
    </div>
    {!featured && featuredIds.length >= limit && <p className="o-field-hint">You already feature {limit} dishes. Unfeature one first.</p>}
    <div className="pe-status"><Saved>{saved}</Saved></div>
    <Problem>{error}</Problem>
  </div>;
}
