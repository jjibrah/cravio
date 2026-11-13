import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../Icon';
import './notifications.css';

const NotificationContext = createContext(null);

function Notification({ notification, dismiss }) {
  const [paused, setPaused] = useState(false);
  const { id, message, type, duration } = notification;
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismiss(id), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, paused, dismiss]);

  return <div className={`notification notification-${type}`}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <Icon name={type === 'success' ? 'success' : 'info'} size={16} />
    <span role={type === 'error' ? 'alert' : 'status'} aria-atomic="true">{message}</span>
    <button className="notification-dismiss" aria-label="Dismiss notification" onClick={() => dismiss(id)}><Icon name="close" size={16} /></button>
  </div>;
}

export function NotificationProvider({ children }) {
  const [state, setState] = useState({ userId: null, toasts: [], history: [] });
  const dismiss = useCallback((id) => setState((current) => ({ ...current, toasts: current.toasts.filter((item) => item.id !== id) })), []);
  const setUser = useCallback((userId) => setState((current) => current.userId === userId ? current : { userId, toasts: [], history: [] }), []);
  const markAllRead = useCallback(() => setState((current) => ({ ...current, history: current.history.map((item) => ({ ...item, read: true })) })), []);
  const clearHistory = useCallback(() => setState((current) => ({ ...current, history: [] })), []);
  const notify = useCallback((message, { type = 'success', duration = 5000 } = {}) => {
    const id = crypto.randomUUID();
    const notification = { id, message, type, duration, createdAt: Date.now(), read: false };
    setState((current) => ({
      ...current,
      toasts: [...current.toasts.filter((item) => item.message !== message), notification].slice(-3),
      history: current.userId ? [notification, ...current.history].slice(0, 20) : current.history,
    }));
    return id;
  }, []);
  const value = useMemo(() => ({ notify, dismiss, setUser, history: state.history, markAllRead, clearHistory }), [notify, dismiss, setUser, state.history, markAllRead, clearHistory]);
  return <NotificationContext.Provider value={value}>
    {children}
    <div className="notifications" aria-label="Notifications">
      {state.toasts.map((notification) => <Notification key={notification.id} notification={notification} dismiss={dismiss} />)}
    </div>
  </NotificationContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotifications requires NotificationProvider.');
  return context;
}

export function useErrorNotification() {
  const { notify, dismiss } = useNotifications();
  const idRef = useRef(null);
  const clearError = useCallback(() => {
    if (idRef.current) dismiss(idRef.current);
    idRef.current = null;
  }, [dismiss]);
  const showError = useCallback((message) => {
    clearError();
    idRef.current = notify(message, { type: 'error', duration: 7000 });
  }, [clearError, notify]);
  useEffect(() => clearError, [clearError]);
  return { showError, clearError };
}
