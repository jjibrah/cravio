import { useState } from 'react';
import { OIcon } from '../../components/owner/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { Field, SaveActions, SettingsCard, useSaver } from './parts';

const ROLE_NAME = { admin: 'Cravio admin', owner: 'Restaurant owner', waiter: 'Waiter' };

/** Your name, email, password, and signing out. Works for every role. */
export default function AccountTab({ account }) {
  return <>
    <ProfileCard account={account} />
    <PasswordCard />
    <SessionsCard />
  </>;
}

function ProfileCard({ account }) {
  const { retry } = useAuth();
  const [name, setName] = useState(account.name || '');
  const [error, setError] = useState('');
  const [saving, run] = useSaver();
  const dirty = name.trim() !== (account.name || '');

  async function save() {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) { setError('Enter your name.'); return; }
    if (clean.length > 120) { setError('Keep it under 120 characters.'); return; }
    if (await run(() => api('/api/me', { method: 'PATCH', body: { name: clean } }), 'Your name is updated')) retry();
  }

  return <SettingsCard id="profile" title="Your profile" description="Your name appears on orders you take and in the sidebar."
    footer={<SaveActions dirty={dirty} saving={saving} onSave={save} onReset={() => { setName(account.name || ''); setError(''); }} />}>
    <form className="st-grid" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Field label="Your name" error={error}>
        {(props) => <input {...props} className="o-input" value={name} maxLength={120} autoComplete="name" onChange={(event) => { setName(event.target.value); setError(''); }} />}
      </Field>
      <Field label="Email" hint="You sign in with this. Contact Cravio to change it.">
        {(props) => <input {...props} className="o-input" value={account.email || ''} readOnly />}
      </Field>
      <Field label="Role">
        {(props) => <input {...props} className="o-input" value={ROLE_NAME[account.role] || 'No role yet'} readOnly />}
      </Field>
    </form>
  </SettingsCard>;
}

function PasswordCard() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, run] = useSaver();

  async function save(event) {
    event.preventDefault();
    const next = {};
    if (password.length < 8) next.password = 'Use at least 8 characters.';
    else if (password !== confirm) next.confirm = 'The two passwords don’t match.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const ok = await run(async () => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(error.code === 'same_password' ? 'Choose a password different from your current one.'
        : error.code === 'weak_password' ? 'That password is too easy to guess. Try a longer one.'
          : error.code === 'reauthentication_needed' ? 'For your security, sign out and sign in again, then change your password.'
            : 'Could not change your password. Please try again.');
    }, 'Password changed');
    if (ok) { setPassword(''); setConfirm(''); }
  }

  return <SettingsCard id="password" title="Password" description="Choose a new password with at least 8 characters.">
    <form className="st-stack" onSubmit={save} noValidate>
      <div className="st-grid">
        <Field label="New password" error={errors.password}>
          {(props) => <input {...props} className="o-input" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setErrors({}); }} />}
        </Field>
        <Field label="Repeat new password" error={errors.confirm}>
          {(props) => <input {...props} className="o-input" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setErrors({}); }} />}
        </Field>
      </div>
      <div className="st-actions">
        <button type="submit" className="o-btn is-primary" disabled={saving || !password}>{saving ? 'Saving…' : 'Change password'}</button>
        <label className="st-check"><input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} />Show passwords</label>
      </div>
    </form>
  </SettingsCard>;
}

function SessionsCard() {
  const [saving, run] = useSaver();
  const signOut = (scope) => run(async () => {
    const { error } = await supabase.auth.signOut({ scope });
    if (error) throw new Error('Could not sign out. Please try again.');
  }, scope === 'others' ? 'Signed out on your other devices' : '');

  return <SettingsCard id="sessions" title="Signing in" description="Lost a phone or shared a computer? Sign out everywhere else in one tap.">
    <div className="st-actions">
      <button type="button" className="o-btn" disabled={saving} onClick={() => signOut('others')}><OIcon name="close" size={16} />Sign out of other devices</button>
      <button type="button" className="o-btn is-danger" disabled={saving} onClick={() => signOut('local')}>Log out of this device</button>
    </div>
  </SettingsCard>;
}
