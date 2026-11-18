// Guards against broken imports: loads the server's whole route table (every route module and what it imports)
// without starting the server or touching a database. Added after P1-02 deleted a file lib/db.js still imported.
import assert from 'node:assert/strict';

const { routes } = await import('../../src/routes/index.js');
assert.ok(Array.isArray(routes) && routes.length > 50, `route table loaded (${routes?.length} routes)`);
const matches = (url) => routes.some((r) => (r.path instanceof RegExp ? r.path.test(url) : r.path === url));
const biz = '00000000-0000-4000-8000-000000000000';
assert.ok(matches(`/api/owner/inventory/${biz}`), 'new owner inventory routes are registered');
assert.ok(matches('/api/stock'), 'live 009 stock routes are still registered');
assert.ok(matches(`/api/owner/inventory/${biz}/recipes`), 'owner recipe routes are registered');
assert.ok(matches('/api/inventory') && matches('/api/inventory/recipes') && matches('/api/inventory/availability'), 'branch inventory + recipe routes are registered');
assert.ok(matches('/api/notifications'), 'notification routes are registered');
console.log(`Server load: 6 checks passed (${routes.length} routes).`);
