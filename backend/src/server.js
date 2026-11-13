import { createServer } from 'node:http';
import { HttpError, readJson, sendJson } from './lib/http.js';
import { routes } from './routes/index.js';

const port = Number(process.env.PORT || 3002);
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
// LOG_TIMING=1 prints one line per request: method, path, status, milliseconds.
const logTiming = process.env.LOG_TIMING === '1';

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string' && route.path === pathname) return { route, params: {} };
    if (route.path instanceof RegExp) {
      const match = pathname.match(route.path);
      if (match) return { route, params: match.groups || {} };
    }
  }
  return null;
}

async function handle(request, response, url) {
  if (request.method === 'OPTIONS') { await sendJson(response, 204); return; }
  if (request.method === 'GET' && url.pathname === '/health') { await sendJson(response, 200, { status: 'ok' }); return; }

  const found = findRoute(request.method, url.pathname);
  if (!found) { await sendJson(response, 404, { error: 'Not found' }); return; }
  try {
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) ? await readJson(request) : undefined;
    const result = await found.route.handler({ request, response, url, params: found.params, body });
    if (!response.writableEnded && !response.headersSent) {
      await sendJson(response, response.statusCode !== 200 ? response.statusCode : result === undefined ? 204 : 200, result, request);
    }
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof HttpError) {
      await sendJson(response, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) }, request);
      return;
    }
    console.error(`${request.method} ${url.pathname} failed:`, error.message);
    await sendJson(response, 503, { error: 'Something went wrong. Please try again.' }, request);
  }
}

const server = createServer(async (request, response) => {
  const started = performance.now();
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.headers.origin === frontendUrl) {
    response.setHeader('Access-Control-Allow-Origin', frontendUrl);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Cravio-Visitor, If-None-Match');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'ETag');
  }
  const url = new URL(request.url, 'http://localhost');
  if (logTiming) {
    response.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      console.log(`[timing] ${request.method} ${url.pathname} ${response.statusCode} ${ms}ms${response.getHeader('Content-Encoding') ? ' gzip' : ''}`);
    });
  }
  await handle(request, response, url);
});

server.listen(port, () => {
  console.log(`CRAVIO backend listening on http://localhost:${server.address().port}`);
});
