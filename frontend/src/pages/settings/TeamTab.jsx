import { useRef, useState } from 'react';
import { EmptyState, ErrorState, OIcon, SkeletonRows } from '../../components/owner/ui';
import { api, useApi } from '../../lib/api';
import { phoneError } from '../../lib/onboarding';
import { Confirm, Field, Note, SettingsCard, initials, useSaver } from './parts';

const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', waiter: 'Waiter' };
const ROLE_HINT = { manager: 'Runs service and edits the menu', waiter: 'Takes orders and serves tables' };
const blank = { name: '', email: '', phone: '', role: 'waiter' };
const TEAM = '/api/restaurant/team';

/** People who already joined, invites still on their way, and a form to add someone. */
export default function TeamTab({ state, actions, isOwner }) {
  const team = useApi(TEAM, { ttl: 30000 });
  const live = state.restaurant.status === 'live';
  const pending = state.invites.filter((invite) => invite.status !== 'sent');
  const canManage = team.data ? team.data.canManage : isOwner;

  return <>
    {canManage && <AddPerson invites={state.invites} live={live} actions={actions} />}
    <MembersCard team={team} canManage={canManage} />
    {pending.length > 0 && <InvitesCard invites={pending} live={live} actions={actions} canManage={canManage} />}
  </>;
}

function AddPerson({ invites, live, actions }) {
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [saving, run] = useSaver();
  const nameRef = useRef(null);
  const set = (key) => (event) => { setForm({ ...form, [key]: event.target.value }); setErrors({ ...errors, [key]: '' }); };

  async function add(event) {
    event.preventDefault();
    const next = {};
    const email = form.email.trim().toLowerCase();
    if (!form.name.trim()) next.name = 'Enter their name.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) next.email = email ? 'Enter a valid email, like name@example.com.' : 'Enter their email.';
    else if (invites.some((invite) => invite.email === email)) next.email = 'They’re already on your list.';
    if (form.phone.trim() && phoneError(form.phone)) next.phone = phoneError(form.phone);
    setErrors(next);
    if (Object.keys(next).length) return;
    const ok = await run(async () => {
      await actions.addInvite({ name: form.name.trim(), email, phone: form.phone.trim() || null, role: form.role });
      if (live) {
        const sent = await actions.sendInvites();
        const mine = sent?.find((invite) => invite.email === email);
        if (mine?.status === 'failed') throw new Error(`The invite to ${email} couldn’t be sent: ${mine.error}`);
      }
    }, live ? `Invite sent to ${email}` : `${form.name.trim()} will be invited when you go live`);
    if (ok) { setForm({ ...blank, role: form.role }); nameRef.current?.focus(); }
  }

  return <SettingsCard id="add-person" title="Add someone to your team" description="They get an email to set a password, then sign in to their own Cravio account.">
    <form className="st-stack" onSubmit={add} noValidate>
      <div className="st-grid">
        <Field label="Name" error={errors.name}>{(props) => <input {...props} ref={nameRef} className="o-input" value={form.name} onChange={set('name')} maxLength={120} autoComplete="off" placeholder="e.g. Wanjiru Kamau" />}</Field>
        <Field label="Email" error={errors.email}>{(props) => <input {...props} className="o-input" type="email" inputMode="email" value={form.email} onChange={set('email')} autoComplete="off" placeholder="name@example.com" />}</Field>
        <Field label="Phone" optional error={errors.phone}>{(props) => <input {...props} className="o-input" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} autoComplete="off" placeholder="+254 712 345 678" />}</Field>
        <fieldset className="st-roles">
          <legend className="st-label">Role</legend>
          {['waiter', 'manager'].map((role) => <label key={role} className={`st-role${form.role === role ? ' is-selected' : ''}`}>
            <input type="radio" name="role" value={role} checked={form.role === role} onChange={() => setForm({ ...form, role })} className="visually-hidden" />
            <strong>{ROLE_LABEL[role]}</strong><span>{ROLE_HINT[role]}</span>
          </label>)}
        </fieldset>
      </div>
      <div className="st-actions">
        <button type="submit" className="o-btn is-primary" disabled={saving}><OIcon name="plus" size={16} />{saving ? 'Adding…' : live ? 'Send invite' : 'Add to the list'}</button>
        {!live && <span className="st-hint">Invites go out when your restaurant goes live, so nobody joins an empty restaurant.</span>}
      </div>
    </form>
  </SettingsCard>;
}

function MembersCard({ team, canManage }) {
  const [removing, setRemoving] = useState(null);
  const [saving, run] = useSaver();
  const members = team.data?.members || [];

  const changeRole = (member, role) => run(async () => {
    const result = await api(`${TEAM}/${member.userId}`, { method: 'PATCH', body: { role } });
    team.setData((current) => ({ ...current, members: result.members }));
  }, `${member.name} is now a ${ROLE_LABEL[role].toLowerCase()}`);

  async function remove() {
    const member = removing;
    const ok = await run(async () => {
      const result = await api(`${TEAM}/${member.userId}`, { method: 'DELETE' });
      team.setData((current) => ({ ...current, members: result.members }));
    }, `${member.name} no longer has access`);
    if (ok) setRemoving(null);
  }

  return <SettingsCard id="members" title="People on your team" description={canManage ? 'Change someone’s role, or remove their access when they leave.' : 'Only the restaurant owner can change the team.'}>
    {team.loading ? <SkeletonRows rows={3} label="Loading your team" />
      : team.error ? <ErrorState error={team.error} onRetry={team.refresh} what="your team" compact />
        : members.length <= 1 ? <EmptyState icon="heart" title="It’s just you for now">Add your waiters and managers above so orders reach the right person.</EmptyState>
          : <ul className="st-people">
            {members.map((member) => {
              const editable = canManage && member.role !== 'owner' && member.userId !== team.data.selfId;
              return <li key={member.userId} className="st-person">
                <span className="st-avatar" aria-hidden="true">{initials(member.name)}</span>
                <span className="st-person-text"><strong>{member.name}{member.userId === team.data.selfId && <span className="st-you"> (you)</span>}</strong>
                  <span>{member.email}{member.status === 'invited' ? ' · hasn’t signed in yet' : member.status === 'suspended' ? ' · suspended by Cravio' : ''}</span></span>
                {editable ? <>
                  <select className="o-select st-person-role" value={member.role} aria-label={`Role for ${member.name}`} disabled={saving}
                    onChange={(event) => changeRole(member, event.target.value)}>
                    <option value="waiter">Waiter</option><option value="manager">Manager</option>
                  </select>
                  <button type="button" className="o-icon-btn" aria-label={`Remove ${member.name}`} onClick={() => setRemoving(member)} disabled={saving}><OIcon name="trash" size={17} /></button>
                </> : <span className="o-tag">{ROLE_LABEL[member.role]}</span>}
              </li>;
            })}
          </ul>}
    <Confirm open={Boolean(removing)} title={`Remove ${removing?.name || ''}?`} confirmLabel="Remove access" busy={saving}
      onClose={() => setRemoving(null)} onConfirm={remove}>
      <p>They’ll be signed out of your restaurant straight away and won’t see orders or tables any more. Past orders they took stay in your records.</p>
      <p>You can invite them again later.</p>
    </Confirm>
  </SettingsCard>;
}

function InvitesCard({ invites, live, actions, canManage }) {
  const [saving, run] = useSaver();
  const failed = invites.filter((invite) => invite.status === 'failed').length;
  return <SettingsCard id="invites" title="Invites" description={live ? 'Invites that haven’t gone out yet, or couldn’t be delivered.' : 'These go out by email when your restaurant goes live.'}
    footer={live && canManage ? <div className="st-save"><span className="st-save-status">{failed ? `${failed} couldn’t be sent` : `${invites.length} waiting`}</span>
      <button type="button" className="o-btn is-primary" disabled={saving} onClick={() => run(async () => {
        const sent = await actions.sendInvites();
        const stillFailed = sent.filter((invite) => invite.status === 'failed').length;
        if (stillFailed) throw new Error(`${stillFailed} invite${stillFailed === 1 ? '' : 's'} still couldn’t be sent. Check the email addresses.`);
      }, 'Invites sent')}><OIcon name="refresh" size={16} />{saving ? 'Sending…' : failed ? 'Try again' : 'Send now'}</button></div> : null}>
    {failed > 0 && <Note tone="error" icon="alert">Fix the email address, or remove the invite and add the person again.</Note>}
    <ul className="st-people">
      {invites.map((invite) => <li key={invite.id} className="st-person">
        <span className="st-avatar is-pending" aria-hidden="true">{initials(invite.name)}</span>
        <span className="st-person-text"><strong>{invite.name}</strong><span>{invite.email}</span>
          {invite.status === 'failed' && <span className="st-person-error">{invite.error}</span>}</span>
        <span className={`o-tag${invite.status === 'failed' ? ' is-warning' : ''}`}>{ROLE_LABEL[invite.role]} · {invite.status === 'failed' ? 'Not delivered' : live ? 'Not sent' : 'Queued'}</span>
        {canManage && <button type="button" className="o-icon-btn" aria-label={`Remove the invite for ${invite.name}`} disabled={saving}
          onClick={() => run(() => actions.removeInvite(invite.id), `Invite for ${invite.name} removed`)}><OIcon name="trash" size={17} /></button>}
      </li>)}
    </ul>
  </SettingsCard>;
}
