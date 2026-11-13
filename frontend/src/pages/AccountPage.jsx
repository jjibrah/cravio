import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, homeFor } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { Loading, Notice, PageShell } from './AuthPages';

export default function AccountPage() {
  const { session, initializing, account, accountLoading, accountError, retry } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (accountLoading || (!account && !accountError)) return <Loading />;
  if (account && location.pathname !== homeFor(account)) return <Navigate to={homeFor(account)} replace />;

  async function logout() {
    setBusy(true);
    setError('');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch { setError('Could not log out. Please try again.'); }
    finally { setBusy(false); }
  }

  return <PageShell role={account?.role}>
    {accountError ? <>
      <h1>Could not load account</h1>
      <Notice error>{accountError}</Notice>
      <button onClick={retry}>Try again</button>
    </> : <>
      <h1>{account.name}</h1>
      <p className="account-email">{account.email}</p>
      {!account.role && <Notice>Your account is waiting for a role to be assigned.</Notice>}
    </>}
    <Notice error>{error}</Notice>
    <button className="logout" onClick={logout} disabled={busy}>{busy ? 'Logging out…' : 'Log out'}</button>
  </PageShell>;
}
