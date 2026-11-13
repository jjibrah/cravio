import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { useErrorNotification } from './notifications/NotificationProvider';
import Icon from './Icon';
import './refresh.css';

export default function RefreshButton() {
  const { retry, accountLoading, accountError } = useAuth();
  const { showError, clearError } = useErrorNotification();
  const requested = useRef(false);

  useEffect(() => {
    if (accountLoading || !requested.current) return;
    requested.current = false;
    if (accountError) showError(accountError);
  }, [accountLoading, accountError, showError]);

  return <button type="button" className="icon-button refresh-button"
    aria-label={accountLoading ? 'Refreshing' : 'Refresh'} title="Refresh"
    aria-busy={accountLoading} aria-disabled={accountLoading}
    onClick={() => {
      if (accountLoading || requested.current) return;
      clearError();
      requested.current = true;
      retry();
    }}><Icon name="refresh" size={16} /></button>;
}
