import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from './supabase';
import { setCacheScope } from './cache';
import { useNotifications } from '../components/notifications/NotificationProvider';
import LoadingScreen from '../components/loading/LoadingScreen';

const AuthContext = createContext(null);

/*
 * The last /api/me answer is kept in sessionStorage (this tab only), keyed by user id, so a reload
 * renders the app at once while /api/me revalidates in the background. A 401 or 403 drops it, and so
 * does signing out. An account that still needs onboarding is never served from the copy, so routing
 * decisions about setup always use a fresh answer.
 */
const ACCOUNT_KEY = 'cravio-account:';
function readAccount(userId) {
  try {
    const account = JSON.parse(sessionStorage.getItem(ACCOUNT_KEY + userId) || 'null');
    return account && account.id === userId && !account.onboardingRequired ? account : null;
  } catch { return null; }
}
function writeAccount(userId, account) {
  try { sessionStorage.setItem(ACCOUNT_KEY + userId, JSON.stringify(account)); } catch { /* storage full or blocked */ }
}
function forgetAccounts(exceptUserId) {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(ACCOUNT_KEY) && key !== ACCOUNT_KEY + exceptUserId) sessionStorage.removeItem(key);
    }
  } catch { /* storage blocked */ }
}

export function AuthProvider({ children }) {
  const { setUser } = useNotifications();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  const [session, setSession] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [account, setAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const accessToken = session?.access_token;
  const userId = session?.user.id;
  const accountRef = useRef(null);
  accountRef.current = account;
  const handledRetry = useRef(0);

  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  // In the same render as the session, so pages never see "signed in, no account yet" for a reload.
  const adoptCached = useCallback((next) => {
    const id = next?.user.id;
    if (id) setAccount((current) => (current?.id === id ? current : readAccount(id)));
  }, []);

  useEffect(() => {
    if (!supabase) { setInitializing(false); return; }
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setCacheScope(nextSession?.user.id || null);
      adoptCached(nextSession);
      setSession(nextSession);
      setUser(nextSession?.user.id || null);
      if (event === 'PASSWORD_RECOVERY') navigateRef.current('/reset-password', { replace: true });
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAccountError('Your sign-in link is invalid or expired. Request a new one.');
      setCacheScope(data.session?.user.id || null);
      adoptCached(data.session);
      setSession(data.session);
      setUser(data.session?.user.id || null);
      setInitializing(false);
    }).catch(() => {
      if (active) {
        setAccountError('Could not restore your session. Please sign in again.');
        setInitializing(false);
      }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [setUser, adoptCached]);

  // API responses cached in memory belong to one user: setCacheScope above empties them when the
  // user changes or signs out, before any page renders for the new session.
  useEffect(() => { if (!initializing) forgetAccounts(userId); }, [initializing, userId]);

  useEffect(() => {
    if (!accessToken) { setAccount(null); setAccountLoading(false); setAccountError(''); return; }
    const controller = new AbortController();
    const explicit = retryCount !== handledRetry.current; // the Refresh button (or a retry) asked for this
    handledRetry.current = retryCount;
    const current = accountRef.current?.id === userId ? accountRef.current : readAccount(userId);
    setAccount(current);
    setAccountError('');
    // With an account to show, a background check doesn't block the page or the Refresh button.
    const blocking = explicit || !current;
    if (blocking) setAccountLoading(true);
    const api = import.meta.env.VITE_API_URL || '';
    fetch(`${api}/api/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || 'Could not load your account.');
        error.status = response.status;
        throw error;
      }
      if (!controller.signal.aborted) {
        const changed = JSON.stringify(data) !== JSON.stringify(current);
        setAccount(data);
        writeAccount(userId, data);
        // Remount the page content after an explicit refresh, or when the account itself changed.
        if (explicit || changed) setRefreshVersion((version) => version + 1);
      }
    }).catch((error) => {
      if (!controller.signal.aborted) {
        if (error.status === 401 || error.status === 403) {
          setAccount(null);
          try { sessionStorage.removeItem(ACCOUNT_KEY + userId); } catch { /* storage blocked */ }
        }
        setAccountError(error.message === 'Failed to fetch'
          ? 'Could not reach the server. Check your connection and try again.' : error.message);
      }
    }).finally(() => {
      if (!controller.signal.aborted && blocking) setAccountLoading(false);
    });
    return () => { controller.abort(); if (blocking) setAccountLoading(false); };
  }, [accessToken, userId, retryCount]);

  const retry = useCallback(() => setRetryCount((count) => count + 1), []);
  // Restoring the session takes a few milliseconds (longer only when the token must be refreshed), so
  // pages wait for it behind a delayed loader instead of each flashing the full-screen one.
  return <AuthContext.Provider value={{ session, initializing, account, accountLoading, accountError, retry, refreshVersion }}>
    {initializing ? <LoadingScreen delay={400} /> : children}
  </AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
export const homeFor = (account) => ['admin', 'owner', 'waiter'].includes(account?.role) ? `/${account.role}` : '/account';
