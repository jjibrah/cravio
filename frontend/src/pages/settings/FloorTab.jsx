import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { OIcon } from '../../components/owner/ui';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { SECTION_SUGGESTIONS, guestMenuUrl } from '../../lib/onboarding';
import { Note, SaveActions, SettingsCard, useSaver } from './parts';

const MAX_TABLES = 200;

/** How many tables, the sections they sit in, and the QR codes / guest-menu link that go on them. */
export default function FloorTab({ state, actions }) {
  const { restaurant, tables, sections } = state;
  return <>
    <TablesCard tables={tables} setTables={actions.setTables} />
    <SectionsCard sections={sections} setSections={actions.setSections} />
    <QrCard restaurant={restaurant} />
  </>;
}

function TablesCard({ tables, setTables }) {
  const [count, setCount] = useState(tables.length || 1);
  const [saving, run] = useSaver();
  const value = Number(count) || 0;
  const dirty = value !== tables.length;
  const removing = value > 0 && value < tables.length ? tables.length - value : 0;
  const clamp = (number) => Math.min(MAX_TABLES, Math.max(1, number));

  return <SettingsCard id="tables" title="Tables" description="Each table gets its own QR code, numbered from 1."
    footer={<SaveActions dirty={dirty && value >= 1} saving={saving} label={removing ? `Remove ${removing} table${removing === 1 ? '' : 's'}` : 'Save tables'}
      onSave={() => run(() => setTables(clamp(value)), `You now have ${clamp(value)} table${clamp(value) === 1 ? '' : 's'}`)} onReset={() => setCount(tables.length)} />}>
    <div className="st-stack">
      <div className="st-counter" role="group" aria-label="Number of tables">
        <button type="button" className="o-icon-btn st-counter-btn" onClick={() => setCount(clamp(value - 1))} disabled={value <= 1} aria-label="One table fewer"><OIcon name="minus" /></button>
        <input className="o-input st-counter-value" type="number" inputMode="numeric" min={1} max={MAX_TABLES} value={count} aria-label="Tables"
          onChange={(event) => setCount(event.target.value === '' ? '' : clamp(Math.round(Number(event.target.value))))} onBlur={() => { if (!value) setCount(1); }} />
        <button type="button" className="o-icon-btn st-counter-btn" onClick={() => setCount(clamp(value + 1))} disabled={value >= MAX_TABLES} aria-label="One more table"><OIcon name="plus" /></button>
        <span className="st-counter-unit">tables</span>
      </div>
      {removing > 0 && <Note tone="warning" icon="alert">Tables {value + 1}–{tables.length} will be removed, along with their QR codes. Tables with unpaid orders can’t be removed.</Note>}
      <p className="st-hint">Assign tables to sections, rename them or see who’s seated on <Link className="o-text-link" to="/owner/tables">Tables</Link>.</p>
    </div>
  </SettingsCard>;
}

function SectionsCard({ sections, setSections }) {
  const initial = useMemo(() => sections.map((section) => section.name), [sections]);
  const [names, setNames] = useState(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saving, run] = useSaver();
  const dirty = names.join('|') !== initial.join('|');
  const suggestions = SECTION_SUGGESTIONS.filter((name) => !names.some((n) => n.toLowerCase() === name.toLowerCase()));

  function add(name) {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    if (clean.length > 40) { setError('Keep section names under 40 characters.'); return; }
    if (names.some((n) => n.toLowerCase() === clean.toLowerCase())) { setError(`“${clean}” is already there.`); return; }
    if (names.length >= 12) { setError('You can have up to 12 sections.'); return; }
    setNames([...names, clean]);
    setDraft('');
    setError('');
  }

  return <SettingsCard id="sections" title="Sections" description="Indoor, outdoor, rooftop: sections help waiters find the right table."
    footer={<SaveActions dirty={dirty} saving={saving} onSave={() => run(() => setSections(names), 'Sections saved')} onReset={() => { setNames(initial); setError(''); }} />}>
    <div className="st-stack">
      {names.length ? <ul className="st-tags" aria-label="Your sections">
        {names.map((name) => <li key={name} className="st-tag">{name}
          <button type="button" className="st-tag-remove" aria-label={`Remove ${name}`} onClick={() => setNames(names.filter((n) => n !== name))}><OIcon name="close" size={14} /></button></li>)}
      </ul> : <p className="st-hint">No sections yet. Add one below, or skip this if your floor is one room.</p>}
      <form className="st-inline" onSubmit={(event) => { event.preventDefault(); add(draft); }}>
        <input className="o-input" value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} placeholder="Add a section, e.g. Garden" aria-label="New section name" maxLength={40} />
        <button type="submit" className="o-btn" disabled={!draft.trim()}><OIcon name="plus" size={16} />Add</button>
      </form>
      {error && <p className="st-error" role="alert">{error}</p>}
      {suggestions.length > 0 && <div className="st-suggest"><span className="st-hint">Quick add:</span>
        {suggestions.map((name) => <button type="button" key={name} className="o-chip" onClick={() => add(name)}><OIcon name="plus" size={13} />{name}</button>)}</div>}
    </div>
  </SettingsCard>;
}

function QrCard({ restaurant }) {
  const { notify } = useNotifications();
  const url = guestMenuUrl(restaurant.id);
  const live = restaurant.status === 'live';
  async function copy() {
    try { await navigator.clipboard.writeText(url); notify('Menu link copied'); }
    catch { notify('Could not copy. Select the link and copy it instead.', { type: 'error' }); }
  }
  return <SettingsCard id="qr" title="QR codes and menu link" description="Print a QR code for every table, or share your menu link anywhere.">
    <div className="st-stack">
      {!live && <Note tone="warning" icon="alert">Your restaurant isn’t live yet, so guests who scan won’t see your menu yet.</Note>}
      <div className="o-link-box st-link">
        <span className="st-link-url" title={url}>{url}</span>
        <button type="button" className="o-btn is-small" onClick={copy}><OIcon name="copy" size={15} />Copy</button>
      </div>
      <div className="st-actions">
        <Link className="o-btn is-primary" to="/onboarding/qr"><OIcon name="printer" size={16} />Print QR codes</Link>
        <a className="o-btn" href={url} target="_blank" rel="noreferrer"><OIcon name="external" size={16} />Open guest menu</a>
        <Link className="o-btn is-quiet" to="/owner/menu"><OIcon name="sparkle" size={16} />Change the menu’s look</Link>
      </div>
    </div>
  </SettingsCard>;
}
