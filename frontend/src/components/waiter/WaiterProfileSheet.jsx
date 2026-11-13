import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Notice } from '../../pages/AuthPages';
import { useNotifications } from '../notifications/NotificationProvider';
import Icon from '../Icon';
import Sheet from '../Sheet';

export default function WaiterProfileSheet({ account, open, onClose, id }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { notify } = useNotifications();
  const initials = account.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  useEffect(() => { if (open) setError(''); }, [open]);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      notify('Signed out successfully');
    } catch { setError('Could not log out. Please try again.'); }
    finally { setBusy(false); }
  }

  return <Sheet id={id} open={open} onClose={onClose} title="Profile" className="waiter-profile-sheet">
    <div className="waiter-profile-details">
      <span className="waiter-profile-avatar" aria-hidden="true">{initials}</span>
      <span className="waiter-profile-text"><strong>{account.name}</strong><p>{account.email}</p></span>
    </div>
    <Notice error>{error}</Notice>
    <button className="waiter-logout" onClick={logout} disabled={busy}><Icon name="logout" size={18} />{busy ? 'Logging out…' : 'Log out'}</button>
  </Sheet>;
}
