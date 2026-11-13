import { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNotifications } from '../notifications/NotificationProvider';
import Icon from '../Icon';
import { shortcutLabel } from '../search/GlobalSearch';

export default function ProfileMenu({ account, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();
  const { notify } = useNotifications();
  const initials = account.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  useEffect(() => {
    if (!open) return;
    const outside = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      notify('Signed out successfully');
    } catch { notify('Could not sign out. Please try again.', { type: 'error', duration: 7000 }); }
    finally { setBusy(false); }
  }

  return <div className="profile-menu" ref={ref} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={buttonRef} className="profile-trigger" aria-label="Profile options" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((value) => !value)}>
      <span className="profile-avatar" aria-hidden="true">{initials}</span>
      <span className="profile-identity"><strong>{account.name}</strong><span>{account.email}</span></span>
      <Icon name="chevrons" size={14} />
    </button>
    {open && <div className="profile-panel" id={panelId}>
      <div className="profile-panel-head">
        <span className="profile-avatar is-large" aria-hidden="true">{initials}</span>
        <span className="profile-identity"><strong>{account.name}</strong><span>{account.email}</span></span>
      </div>
      <div className="profile-panel-group">
        <button className="menu-item" onClick={() => { setOpen(false); onNavigate(); window.dispatchEvent(new Event('cravio:open-search')); }}>
          <Icon name="search" size={16} />Search<kbd className="menu-kbd">{shortcutLabel}</kbd>
        </button>
      </div>
      <div className="profile-panel-group">
        <button className="menu-item" onClick={logout} disabled={busy}><Icon name="logout" size={16} />{busy ? 'Signing out…' : 'Log out'}</button>
      </div>
    </div>}
  </div>;
}
