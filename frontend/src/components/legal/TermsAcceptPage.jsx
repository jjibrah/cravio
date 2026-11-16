// /terms/accept: signed-in people whose terms need (re)accepting read and accept the current version, then carry on.
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { Loading, Notice, PageShell } from '../../pages/AuthPages';
import LegalText, { formatLegalDate } from './LegalText';
import './legal.css';

export default function TermsAcceptPage() {
  const { session, initializing, account, retry } = useAuth();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/public/legal/terms`).then((r) => (r.ok ? r.json() : null)).then(setDoc, () => setDoc(null));
  }, []);
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (account && !account.terms?.required) return <Navigate to={homeFor(account)} replace />;
  if (!doc) return <Loading />;

  async function submit(event) {
    event.preventDefault();
    if (!agreed || busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/me/terms/accept', { method: 'POST', body: { version: doc.version } });
      retry();
      navigate(homeFor(account), { replace: true });
    } catch (failure) {
      setError(failure.message);
      if (failure.status === 409) fetch(`${import.meta.env.VITE_API_URL || ''}/api/public/legal/terms`).then((r) => r.json()).then(setDoc).catch(() => {});
    } finally { setBusy(false); }
  }

  return <PageShell auth>
    <h1>{account?.terms?.accepted === false && account?.terms?.version > 1 ? 'Our terms have changed' : 'Before you continue'}</h1>
    <p className="intro">Please read and accept Cravio’s {doc.title.toLowerCase()} (version {doc.version}, {formatLegalDate(doc.publishedAt)}).</p>
    <div className="legal-scroll" tabIndex={0} aria-label={doc.title}><LegalText body={doc.body} /></div>
    <form onSubmit={submit} noValidate>
      <label className="legal-agree">
        <input type="checkbox" checked={agreed} onChange={(event) => { setAgreed(event.target.checked); setError(''); }} />
        <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">{doc.title}</a>.</span>
      </label>
      <Notice error>{error}</Notice>
      <button type="submit" className="button-block" disabled={!agreed || busy}>{busy ? 'Saving…' : 'Agree and continue'}</button>
    </form>
    <p className="auth-note"><button type="button" className="auth-link welcome-inline" onClick={() => supabase.auth.signOut({ scope: 'local' })}>Sign out</button></p>
  </PageShell>;
}
