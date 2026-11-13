import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Icon from '../Icon';
import { useNotifications } from './NotificationProvider';
import Sheet from '../Sheet';

export default function NotificationCenter({ presentation = 'popover' }) {
  const { history, markAllRead, clearHistory } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const id = useId();
  const { pathname } = useLocation();
  const unread = history.filter((item) => !item.read).length;
  const close = useCallback(() => { setOpen(false); buttonRef.current?.focus(); }, []);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open || presentation === 'sheet') return;
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
  }, [open, presentation]);

  const actions = <div className="notification-panel-actions">
    <button onClick={markAllRead} disabled={!unread}>Mark all read</button>
    <button onClick={clearHistory} disabled={!history.length}>Clear all</button>
  </div>;
  const list = <>
    {history.length ? <ul className="notification-history">
      {history.map((item) => <li key={item.id} className={item.read ? '' : 'is-unread'}>
        <Icon name={item.type === 'success' ? 'success' : 'info'} size={18} />
        <div><p>{item.message}</p><time dateTime={new Date(item.createdAt).toISOString()}>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(item.createdAt)}</time></div>
      </li>)}
    </ul> : <div className="notification-empty"><Icon name="bell" size={24} /><p>No notifications yet.</p></div>}
  </>;

  return <div className="notification-center" ref={ref} onBlur={(event) => {
    if (presentation !== 'sheet' && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={buttonRef} className="icon-button notification-toggle"
      aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup={presentation === 'sheet' ? 'dialog' : undefined} onClick={() => setOpen((value) => !value)}>
      <Icon name="bell" />
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {presentation === 'sheet' ? <Sheet id={id} open={open} onClose={close} title="Notifications" className="notification-sheet">{actions}{list}</Sheet> : open && <section className="notification-panel" id={id} aria-labelledby={`${id}-title`}>
      <header className="notification-panel-header"><h2 id={`${id}-title`}>Notifications</h2>{actions}</header>
      {list}
    </section>}
  </div>;
}
