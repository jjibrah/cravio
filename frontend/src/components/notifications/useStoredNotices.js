import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { notices, notificationPaths, send } from '../../lib/inventory';
import usePolling from '../../lib/usePolling';

/*
 * Stored notifications (stock alerts: an item ran out, a dish was served short) for the bell. Only for signed-in owners and
 * branch managers; waiters and admins never get them. The unread count is polled gently (every 60 s, paused while the tab is
 * hidden); the list itself is fetched when the bell opens. When the server has no notifications table yet it answers with
 * empty lists, and any other failure is ignored here: the bell simply shows what it always showed.
 */
export default function useStoredNotices() {
  const { account } = useAuth() || {};
  const eligible = Boolean(account && (account.businesses?.length || (account.branches || []).some((branch) => branch.role === 'manager')));
  const [items, setItems] = useState([]);
  const [local, setLocal] = useState(null); // unread count after an action here, until the next poll
  const poll = usePolling(useCallback(async () => {
    const answer = await notices.unreadCount();
    return Number(answer?.unreadCount ?? answer?.count ?? 0) || 0;
  }, []), { interval: 60000, enabled: eligible });
  useEffect(() => setLocal(null), [poll.data]); // a fresh poll answer replaces what an action here said
  const unread = eligible ? (local ?? poll.data ?? 0) : 0;

  const load = useCallback(async () => {
    if (!eligible) return;
    try {
      const answer = await notices.list({ limit: 10 });
      setItems(answer?.notifications || []);
      setLocal(Number(answer?.unreadCount) || 0);
    } catch { /* quiet: stored alerts are an extra */ }
  }, [eligible]);

  const markRead = useCallback(async (ids) => {
    setItems((current) => current.map((item) => (ids === 'all' || ids.includes(item.id) ? { ...item, read: true } : item)));
    try {
      const answer = await (ids === 'all' ? send('POST', notificationPaths.read, { all: true }) : notices.markRead(ids));
      setLocal(Number(answer?.unreadCount) || 0);
    } catch { /* it will show as unread again after the next refresh */ }
  }, []);

  return { eligible, items, unread, load, markRead };
}
