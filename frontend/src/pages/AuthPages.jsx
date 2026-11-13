import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { homeFor, useAuth } from '../lib/auth';
import { useNotifications } from '../components/notifications/NotificationProvider';
import Icon from '../components/Icon';
import LoadingScreen from '../components/loading/LoadingScreen';
import Brand from '../components/Brand';

const roleNames = { admin: 'Admin', owner: 'Owner', waiter: 'Waiter' };

export function PageShell({ children, role = '', auth = false }) {
  if (auth) return <div className="page auth-layout">
    <img className="auth-photo" src="/images/dining-room.webp" alt="" fetchPriority="high" />
    <div className="auth-shade" aria-hidden="true" />
    <main className="auth-stage"><div className="auth-card"><Brand />{children}</div></main>
    <footer className="auth-footer"><span>© {new Date().getFullYear()} Cravio</span></footer>
  </div>;
  return <div className="page">
    <header className="site-header"><Brand />{roleNames[role] && <span className="role-label">{roleNames[role]}</span>}</header>
    <main className="page-main"><div className="content">{children}</div></main>
  </div>;
}

export function Notice({ children, error = false, id }) {
  if (!children) return null;
  return error ? <div className="message error-pill" role="alert" id={id}><Icon name="info" size={16} /><span>{children}</span></div>
    : <p className="message" role="status" id={id}>{children}</p>;
}

export function Loading() {
  return <LoadingScreen />;
}

function BackToSignIn() {
  return <Link className="auth-link below-form" to="/login">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M19 12H5m7 7-7-7 7-7" />
    </svg>
    Back to sign in
  </Link>;
}

/** Field-level error wiring: the message sits inside the form and every field points at it. */
function useFormError() {
  const id = useId();
  const [error, setError] = useState('');
  const fieldProps = error ? { 'aria-invalid': true, 'aria-describedby': id } : {};
  return { error, setError, fieldProps, notice: <Notice error id={id}>{error}</Notice> };
}

export function LoginPage() {
  const { notify } = useNotifications();
  const { session, initializing, account, accountError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { setError, fieldProps, notice } = useFormError();

  if (initializing) return <Loading />;
  if (session) return <Navigate to={homeFor(account)} replace />;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      notify('Login successful');
    } catch (error) {
      setError(error.code === 'invalid_credentials' ? 'Email or password is incorrect.'
        : error.code === 'email_not_confirmed' ? 'Confirm your email address before signing in.'
        : 'Could not sign in. Check your details and try again.');
    } finally { setBusy(false); }
  }

  return <PageShell auth>
    <h1>Sign in</h1>
    <p className="intro">Welcome back to Cravio.</p>
    <form onSubmit={submit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" placeholder="name@restaurant.com" required value={email}
        onChange={(event) => { setEmail(event.target.value); setError(''); }} {...fieldProps} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" autoComplete="current-password" required value={password}
        onChange={(event) => { setPassword(event.target.value); setError(''); }} {...fieldProps} />
      <Link className="auth-link forgot-password" to="/forgot-password">Forgot password?</Link>
      {notice}
      <Notice error>{accountError}</Notice>
      <button type="submit" className="button-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p className="auth-note">No account? Your manager or the Cravio team sends you an invitation.</p>
  </PageShell>;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const { setError, fieldProps, notice } = useFormError();

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch {
      setError('Could not send a reset link. Please try again in a few minutes.');
    } finally { setBusy(false); }
  }

  return <PageShell auth>
    <h1>Reset your password</h1>
    {sent ? <Notice>If an account exists for {email.trim()}, you’ll receive a password reset link.</Notice> : <>
      <p className="intro">Enter the email you sign in with and we’ll send you a reset link.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" placeholder="name@restaurant.com" required value={email}
          onChange={(event) => { setEmail(event.target.value); setError(''); }} {...fieldProps} />
        {notice}
        <button className="button-block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
    </>}
    <BackToSignIn />
  </PageShell>;
}

export function ResetPasswordPage() {
  const { session, initializing } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { setError, fieldProps, notice } = useFormError();
  const [invalidLink] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    return hash.has('error') || hash.has('error_code') || query.has('error') || query.has('error_code');
  });

  if (initializing) return <Loading />;
  if (done) return <PageShell auth><h1>Password updated</h1><p>Sign in with your new password.</p>
    <Link className="button-link" to="/login">Back to sign in</Link></PageShell>;
  if (!session || invalidLink) return <PageShell auth>
    <h1>Request a new link</h1>
    <p>This password reset link is missing, invalid, or expired.</p>
    <Link className="button-link" to="/forgot-password">Send a new reset link</Link>
    <BackToSignIn />
  </PageShell>;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) await supabase.auth.signOut({ scope: 'local' });
      setDone(true);
      navigate('/reset-password', { replace: true });
    } catch (error) {
      setError(error.code === 'same_password' ? 'Choose a password different from your current password.'
        : 'Could not update your password. Try again or request a new reset link.');
    } finally { setBusy(false); }
  }

  return <PageShell auth>
    <h1>Reset password</h1>
    <p className="intro">Choose a new password with at least 8 characters.</p>
    <form onSubmit={submit}>
      <label htmlFor="password">New password</label>
      <input id="password" type="password" autoComplete="new-password" minLength={8} required value={password}
        onChange={(event) => { setPassword(event.target.value); setError(''); }} {...fieldProps} />
      <label htmlFor="confirm-password">Confirm password</label>
      <input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirm}
        onChange={(event) => { setConfirm(event.target.value); setError(''); }} {...fieldProps} />
      {notice}
      <button className="button-block" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
    </form>
  </PageShell>;
}
