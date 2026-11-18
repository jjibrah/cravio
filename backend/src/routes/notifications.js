// Notifications API, base /api/notifications. Any signed-in user; every query is limited to the caller's own rows.
// Stock alerts (an item ran out, a dish was served short) are written by database triggers (013) to the owner and the branch managers.
// Before 013 is applied the lists are simply empty.
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { withBody } from '../lib/operations.js';
import { database } from '../lib/pool.js';
import { list, markRead, unreadCount } from '../inventory/notifications.js';

const MISSING = ['42P01', '42703'];

export function createRoutes({ authenticate = requireUser, pool = () => database() } = {}) {
  const flag = (q, key) => ['1', 'true', 'yes'].includes(String(q.get(key) || '').toLowerCase());
  return [
    { method: 'GET', path: /^\/api\/notifications$/, async handler({ request, url }) {
      const { user } = await authenticate(request);
      const q = url?.searchParams || new URLSearchParams();
      try { return await list(pool(), user.id, { unreadOnly: flag(q, 'unread'), limit: q.get('limit') || 30, before: q.get('before') || null }); } catch (error) {
        if (MISSING.includes(error?.code)) return { notifications: [], unreadCount: 0, nextBefore: null };
        throw error;
      }
    } },
    { method: 'GET', path: /^\/api\/notifications\/unread-count$/, async handler({ request }) {
      const { user } = await authenticate(request);
      try { return { unreadCount: await unreadCount(pool(), user.id) }; } catch (error) {
        if (MISSING.includes(error?.code)) return { unreadCount: 0 };
        throw error;
      }
    } },
    // Body: { ids: ['…'] } or { all: true }.
    { method: 'POST', path: /^\/api\/notifications\/read$/, handler: withBody(async ({ request, body }) => {
      const { user } = await authenticate(request);
      try { return await markRead(pool(), user.id, body.all === true ? 'all' : body.ids); } catch (error) {
        if (MISSING.includes(error?.code)) throw new HttpError(503, 'Notifications need database update 013, which hasn’t been applied yet.', { code: 'notifications_schema_missing' });
        throw error;
      }
    }) },
  ];
}

export const routes = createRoutes();
