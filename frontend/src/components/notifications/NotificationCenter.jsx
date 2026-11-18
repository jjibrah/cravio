import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import { useNotifications } from './NotificationProvider';
import Sheet from '../Sheet';
import useStoredNotices from './useStoredNotices';

export default function NotificationCenter({ presentation = 'popover' }) {
  const { history, markAllRead, clearHistory } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const id = useId();
  const { pathname } = useLocation();
  const stored = useStoredNotices();
  const navigate = useNavigate();
  const unread = history.filter((item) => !item.read).length + stored.unread;
  const close = useCallback(() => { setOpen(false); buttonRef.current?.focus(); }, []);
  useEffect(() => setOpen(false), [pathname]);
  const { load: loadStored } = stored;
  useEffect(() => { if (open) loadStored(); }, [open, loadStored]);
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
    <button onClick={() => { markAllRead(); if (stored.unread) stored.markRead('all'); }} disabled={!unread}>Mark all read</button>
    <button onClick={clearHistory} disabled={!history.length}>Clear all</button>
  </div>;
  const openStored = (item) => {
    if (!item.read) stored.markRead([item.id]);
    setOpen(false);
    if (item.link) navigate(item.link);
  };
  const alerts = stored.items.length > 0 && <section className="notification-alerts" aria-label="Stock alerts">
    <h3>Stock alerts</h3>
    <ul className="notification-history">
      {stored.items.map((item) => <li key={item.id} className={item.read ? '' : 'is-unread'}>
        <Icon name="info" size={18} />
        <button type="button" className="notification-alert" onClick={() => openStored(item)}>
          <span className="notification-alert-title">{item.title}</span>
          {item.body && <span className="notification-alert-body">{item.body}</span>}
          <time dateTime={item.createdAt}>{new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(item.createdAt))}</time>
        </button>
      </li>)}
    </ul>
  </section>;
  const list = <>
    {alerts}
    {history.length ? <ul className="notification-history">
      {history.map((item) => <li key={item.id} className={item.read ? '' : 'is-unread'}>
        <Icon name={item.type === 'success' ? 'success' : 'info'} size={18} />
        <div><p>{item.message}</p><time dateTime={new Date(item.createdAt).toISOString()}>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(item.createdAt)}</time></div>
      </li>)}
    </ul> : !stored.items.length && <div className="notification-empty"><Icon name="bell" size={24} /><p>No notifications yet.</p></div>}
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
