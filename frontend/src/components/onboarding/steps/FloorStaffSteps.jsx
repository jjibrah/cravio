import { useEffect, useRef, useState } from 'react';
import { SECTION_SUGGESTIONS, phoneError } from '../../../lib/onboarding';
import { AddOwn, Chip, Field, InlineError, Stepper, useStep } from '../controls';
import OnbIcon from '../OnbIcon';

const QUICK_COUNTS = [5, 10, 20, 30];

export function TablesStep({ state, actions, setDraft }) {
  const [count, setCount] = useState(state.tables.length || 10);
  useEffect(() => { setDraft({ tableCount: Number(count) || 0 }); }, [count, setDraft]);
  useStep({
    canContinue: Number(count) >= 1,
    onContinue: () => (Number(count) === state.tables.length ? undefined : actions.setTables(Number(count))),
  });
  const removing = state.tables.length > count ? state.tables.length - count : 0;
  return <div className="onb-stack is-center">
    <Stepper value={count} onChange={setCount} min={1} max={200} label="Tables" />
    <div className="onb-quick" role="group" aria-label="Quick picks">
      {QUICK_COUNTS.map((n) => <button type="button" key={n} className={`onb-quick-pick${count === n ? ' is-selected' : ''}`} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
    </div>
    <p className="onb-note">{removing ? `Tables ${count + 1}–${state.tables.length} will be removed.` : 'Each table gets its own QR code. You can change this any time.'}</p>
  </div>;
}

export function SectionsStep({ state, actions, setDraft }) {
  const [names, setNames] = useState(state.sections.map((section) => section.name));
  const options = [...new Set([...SECTION_SUGGESTIONS.slice(0, 3), ...names, ...SECTION_SUGGESTIONS.slice(3)])];
  useEffect(() => { setDraft({ sections: names }); }, [names, setDraft]);
  const unchanged = names.join('|') === state.sections.map((section) => section.name).join('|');
  useStep({
    canContinue: names.length > 0 || state.sections.length > 0,
    onContinue: () => (unchanged ? undefined : actions.setSections(names)),
  });
  const toggle = (name) => setNames((current) => current.includes(name) ? current.filter((n) => n !== name) : [...current, name]);
  return <div className="onb-stack">
    <div className="onb-chips" role="group" aria-label="Sections">
      {options.map((name) => <Chip key={name} selected={names.includes(name)} onToggle={() => toggle(name)}>{name}</Chip>)}
    </div>
    <AddOwn placeholder="Add your own, e.g. Garden" label="Add a section" onAdd={(name) => {
      if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return;
      if (names.length >= 12) return;
      setNames((current) => [...current, name]);
    }} />
    <p className="onb-note">Sections help waiters find tables. You’ll assign tables to them later from Tables.</p>
  </div>;
}

const ROLES = [['waiter', 'Waiter', 'Takes orders and serves tables'], ['manager', 'Manager', 'Runs service and edits the menu']];
const blank = { name: '', email: '', phone: '', role: 'waiter' };

export function StaffStep({ state, actions, live }) {
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [listError, setListError] = useState('');
  const nameRef = useRef(null);
  const filled = Boolean(form.name.trim() || form.email.trim());
  const invites = state.invites;
  const pending = invites.filter((invite) => invite.status !== 'sent');

  async function add() {
    const next = {};
    if (!form.name.trim()) next.name = 'Enter their name.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) next.email = form.email.trim() ? 'Enter a valid email, like name@example.com.' : 'Enter their email.';
    const phoneProblem = form.phone.trim() ? phoneError(form.phone) : '';
    if (phoneProblem) next.phone = phoneProblem;
    if (invites.some((invite) => invite.email === form.email.trim().toLowerCase())) next.email = 'They’re already on your list.';
    setErrors(next);
    if (Object.keys(next).length) return false;
    setBusy(true);
    try {
      await actions.addInvite({ name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || null, role: form.role });
      setForm({ ...blank, role: form.role });
      nameRef.current?.focus();
      return true;
    } catch (error) {
      if (error.status === 400 || error.status === 409) { setErrors({ email: error.message }); return false; }
      throw error;
    } finally { setBusy(false); }
  }

  useStep({
    canContinue: invites.length > 0 || filled,
    hideContinue: invites.length === 0 && !filled,
    skipLabel: 'I’ll add staff later',
    hideSkip: invites.length > 0,
    async onContinue() { if (filled) return add(); },
  });

  const set = (key) => (event) => { setForm({ ...form, [key]: event.target.value }); setErrors({ ...errors, [key]: '' }); };

  return <div className="onb-stack">
    <div className="onb-card" role="group" aria-label="Add a person"
      onKeyDown={(event) => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); event.stopPropagation(); add().catch((error) => setErrors({ email: error.message })); } }}>
      <div className="onb-grid-2">
        <Field label="Name" error={errors.name}>{(props) => <input {...props} ref={nameRef} value={form.name} onChange={set('name')} autoComplete="off" maxLength={120} placeholder="e.g. Wanjiru Kamau" />}</Field>
        <Field label="Email" error={errors.email}>{(props) => <input {...props} type="email" inputMode="email" value={form.email} onChange={set('email')} autoComplete="off" placeholder="name@example.com" />}</Field>
      </div>
      <Field label="Phone" optional error={errors.phone}>{(props) => <input {...props} type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} autoComplete="off" placeholder="+254 712 345 678" />}</Field>
      <div className="onb-segment" role="radiogroup" aria-label="Role">
        {ROLES.map(([key, label, hint]) => <button type="button" key={key} role="radio" aria-checked={form.role === key}
          className={form.role === key ? 'is-selected' : undefined} onClick={() => setForm({ ...form, role: key })}>
          <strong>{label}</strong><span>{hint}</span>
        </button>)}
      </div>
      <button type="button" className="onb-secondary onb-add-button" onClick={() => add().catch((error) => setErrors({ email: error.message }))} disabled={busy}>
        <OnbIcon name="plus" size={16} />{busy ? 'Adding…' : invites.length ? 'Add another person' : 'Add to the list'}
      </button>
    </div>

    {invites.length > 0 && <ul className="onb-people" aria-label="People to invite">
      {invites.map((invite) => <li key={invite.id} className="onb-person">
        <span className="onb-avatar" aria-hidden="true">{invite.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
        <span className="onb-person-text"><strong>{invite.name}</strong><span>{invite.email}</span>
          {invite.status === 'failed' && <span className="onb-person-error">{invite.error}</span>}</span>
        <span className={`onb-pill is-${invite.status}`}>{invite.role === 'manager' ? 'Manager' : 'Waiter'} · {invite.status === 'queued' ? (live ? 'Not sent' : 'Queued') : invite.status === 'sent' ? 'Sent' : 'Failed'}</span>
        {invite.status !== 'sent' && <button type="button" className="icon-button onb-remove" aria-label={`Remove ${invite.name}`}
          onClick={() => actions.removeInvite(invite.id).catch((error) => setListError(error.message))}><OnbIcon name="trash" size={16} /></button>}
      </li>)}
    </ul>}
    <InlineError>{listError}</InlineError>

    {live ? pending.length > 0 && <button type="button" className="onb-secondary" disabled={sending} onClick={async () => {
      setSending(true); setListError('');
      try { await actions.sendInvites(); } catch (error) { setListError(error.message); } finally { setSending(false); }
    }}><OnbIcon name="mail" size={16} />{sending ? 'Sending…' : `Send ${pending.length} invite${pending.length === 1 ? '' : 's'} now`}</button>
      : <p className="onb-note"><OnbIcon name="mail" size={14} />Invites are sent when you go live, so nobody joins an empty restaurant.</p>}
  </div>;
}
