import { useEffect, useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { homeFor, useAuth } from '../../lib/auth';
import { Loading, Notice, PageShell } from '../AuthPages';
import OnbIcon from '../../components/onboarding/OnbIcon';
import { api } from '../../lib/api';
import '../../components/legal/legal.css';
import '../../components/onboarding/onboarding.css';

const PENDING_KEY = 'cravio-welcome-pending';

// Captured at startup, before the Supabase client consumes the invite tokens and cleans the URL.
const landing = (() => {
  if (typeof window === 'undefined') return { invite: false, error: '' };
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const error = hash.get('error_description') || query.get('error_description') || hash.get('error') || query.get('error') || '';
  let invite = hash.get('type') === 'invite' || query.get('type') === 'invite';
  // Survives a reload after the tokens leave the URL, until a password is set.
  try { if (invite) sessionStorage.setItem(PENDING_KEY, '1'); else invite = sessionStorage.getItem(PENDING_KEY) === '1'; } catch { /* storage blocked */ }
  return { invite, error };
})();

/** Invited owners and staff land here from their email, choose a password on one screen, and carry on. */
export default function WelcomePage() {
  const { session, initializing, account, accountLoading, accountError, retry } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const errorId = useId();
  const hintId = useId();
  // The current terms, if Cravio has published any: creating an account requires agreeing to them.
  const [terms, setTerms] = useState(undefined);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/public/legal/terms`)
      .then((response) => (response.ok ? response.json() : null)).then((doc) => live && setTerms(doc), () => live && setTerms(null));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!done || !account) return;
    navigate(account.onboardingRequired ? '/onboarding' : homeFor(account), { replace: true });
  }, [done, account, navigate]);

  if (initializing) return <Loading />;
  if (!session) return <PageShell auth>
    <h1>{landing.error ? 'This invite link has expired' : 'Open your invite link'}</h1>
    <p className="intro">{landing.error
      ? 'Invite links work once and expire after a while. Ask the person who invited you to send a new one.'
      : 'Use the link in your invitation email to set up your account. If you’ve already set a password, sign in.'}</p>
    <Link className="button-link" to="/login">Go to sign in</Link>
  </PageShell>;
  if (!landing.invite && account && !done) return <Navigate to={account.onboardingRequired ? '/onboarding' : homeFor(account)} replace />;

  const firstName = account?.name?.split(/\s+/)[0] || session.user.user_metadata?.name?.split(/\s+/)[0] || '';

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (terms && !agreed) { setError('Tick the box to agree to the terms and conditions.'); return; }
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      if (terms) {
        try { await api('/api/me/terms/accept', { method: 'POST', body: { version: terms.version } }); }
        catch (acceptError) { setError(acceptError.message); return; }
      }
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
      setDone(true);
      if (!account || terms) retry(); // the account now reports the terms as accepted
    } catch (updateError) {
      setError(updateError.code === 'weak_password' ? 'Choose a stronger password: mix letters, numbers and symbols.'
        : updateError.code === 'same_password' ? 'That’s your current password. Choose a new one.'
        : 'Couldn’t save your password. Check your connection and try again.');
    } finally { setBusy(false); }
  }

  return <PageShell auth>
    <h1>{firstName ? `Welcome to Cravio, ${firstName}` : 'Welcome to Cravio'}</h1>
    <p className="intro">Create a password for <strong className="welcome-email">{session.user.email}</strong>. You’ll use it to sign in from now on.</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor="new-password">Password</label>
      <div className="welcome-password">
        <input id="new-password" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={8} required autoFocus value={password}
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : hintId}
          onChange={(event) => { setPassword(event.target.value); setError(''); }} />
        <button type="button" className="welcome-reveal" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}>
          <OnbIcon name={visible ? 'eyeOff' : 'eye'} size={18} /></button>
      </div>
      {!error && <p className="welcome-hint" id={hintId}>At least 8 characters.</p>}
      {terms && <label className="legal-agree">
        <input type="checkbox" checked={agreed} onChange={(event) => { setAgreed(event.target.checked); setError(''); }} required />
        <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">{terms.title}</a> (version {terms.version}).</span>
      </label>}
      <Notice error id={errorId}>{error}</Notice>
      {accountError && done && <Notice error>{accountError}</Notice>}
      <button type="submit" className="button-block" disabled={busy || (done && accountLoading) || terms === undefined || (terms && !agreed)}>
        {busy ? 'Saving…' : done ? 'Opening Cravio…' : 'Continue'}</button>
    </form>
    <p className="auth-note">Not you? <button type="button" className="auth-link welcome-inline" onClick={async () => {
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
      await supabase.auth.signOut({ scope: 'local' });
      navigate('/login', { replace: true });
    }}>Sign in with another account</button></p>
  </PageShell>;
}
