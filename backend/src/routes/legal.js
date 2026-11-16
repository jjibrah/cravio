// Terms and conditions: public reading, admin editing/publishing, and acceptance by the signed-in user.
import { requireRole, requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { invalidateUser } from '../lib/cache.js';
import { withDb } from '../lib/db.js';
import { accept, adminView, current, publish, saveDraft } from '../lib/legal.js';

const KIND = '(?<kind>[a-z]{2,20})';
const legalDb = (fn, transaction = false) => withDb(fn, { transaction, feature: 'legal' });

export const routes = [
  // Public: the current version, for /terms and the welcome page. No sign-in.
  { method: 'GET', path: new RegExp(`^/api/public/legal/${KIND}$`), async handler({ params }) {
    const doc = await legalDb((db) => current(db, params.kind));
    if (!doc) throw new HttpError(404, 'These terms haven’t been published yet.', { code: 'not_published' });
    return doc;
  } },
  { method: 'GET', path: new RegExp(`^/api/admin/legal/${KIND}$`), async handler({ request, params }) {
    await requireRole(request, 'admin');
    return legalDb((db) => adminView(db, params.kind));
  } },
  { method: 'PUT', path: new RegExp(`^/api/admin/legal/${KIND}/draft$`), async handler({ request, params, body }) {
    const { user } = await requireRole(request, 'admin');
    return legalDb((db) => saveDraft(db, user.id, params.kind, body || {}), true);
  } },
  { method: 'POST', path: new RegExp(`^/api/admin/legal/${KIND}/publish$`), async handler({ request, params, body }) {
    const { user } = await requireRole(request, 'admin');
    return legalDb((db) => publish(db, user.id, params.kind, { requireExisting: body?.requireExisting !== false }), true);
  } },
  // The signed-in user accepts the version they were shown.
  { method: 'POST', path: '/api/me/terms/accept', async handler({ request, body }) {
    const { user } = await requireUser(request);
    const result = await legalDb((db) => accept(db, user.id, 'terms', body?.version), true);
    invalidateUser(user.id);
    return result;
  } },
];
