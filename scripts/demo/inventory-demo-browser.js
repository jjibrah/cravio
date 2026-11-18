// One command for the inventory demo: starts the demo API (in-memory database, port 5189), a Vite dev server on port 5190 that talks to it,
// and opens real Chromium windows: the owner at /owner/inventory and the Westlands branch manager at /branch/<id>/inventory.
//   npm run demo:inventory
// Nothing touches Supabase or the shared database: the demo env points the frontend at a fake Supabase URL on port 5190 that the demo
// API answers, and the browser also blocks any other network host. Ctrl+C stops everything.
//   DEMO_HEADLESS=1   no visible windows (for checks)       DEMO_AFTER=/path/module.js   default export ({ windows, info, base }) runs once the windows are up, then everything stops
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_PORT = Number(process.env.DEMO_API_PORT || 5189);
const WEB_PORT = Number(process.env.DEMO_WEB_PORT || 5190);
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const headless = process.env.DEMO_HEADLESS === '1';
const children = [];
let browser = null;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping the demo...');
  try { await browser?.close(); } catch { /* already closed */ }
  for (const child of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } } process.exit(code); }, 1500).unref();
  setTimeout(() => process.exit(code), 600).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const up = async (url) => { try { return (await fetch(url)).ok; } catch { return false; } };
async function waitFor(url, label, ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopping) return;
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not start within ${Math.round(ms / 1000)}s`);
}
function run(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const prefix = (stream) => stream.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim()) console.log(`[${name}] ${line}`); });
  prefix(child.stdout); prefix(child.stderr);
  child.on('exit', (code) => { if (!stopping) { console.log(`[${name}] exited (${code}). Stopping.`); stop(1); } });
  children.push(child);
  return child;
}

try {
  if (await up(`${API}/health`) || await up(WEB)) throw new Error(`Port ${API_PORT} or ${WEB_PORT} is already in use. Stop what is using it first (this demo never touches port 5173).`);

  run('api', process.execPath, ['scripts/demo/inventory-demo-server.js'], { env: { ...process.env, DEMO_API_PORT: String(API_PORT) } });
  await waitFor(`${API}/health`, 'The demo API');
  const info = await (await fetch(`${API}/demo/info`)).json();

  run('web', process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/demo/vite.demo.config.js', '--strictPort', '--host', '127.0.0.1', '--port', String(WEB_PORT)], {
    env: { ...process.env, VITE_API_URL: '', VITE_SUPABASE_URL: WEB, VITE_SUPABASE_PUBLISHABLE_KEY: 'demo-publishable-key', DEMO_API_PORT: String(API_PORT), DEMO_WEB_PORT: String(WEB_PORT) },
  });
  await waitFor(WEB, 'The web server');

  browser = await chromium.launch({ headless, args: headless ? [] : ['--window-size=1280,900'] });
  const windows = {};
  const open = async (key, person, path, position) => {
    const context = await browser.newContext({ viewport: headless ? { width: 1280, height: 900 } : null });
    // Only localhost may be reached: anything else (Supabase, fonts, analytics) is refused.
    await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
    await context.route('**/auth/v1/**', (route) => route.fulfill({ json: { id: person.userId, aud: 'authenticated', email: person.email } }));
    const session = { access_token: person.token, refresh_token: 'demo-refresh', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
      user: { id: person.userId, aud: 'authenticated', role: 'authenticated', email: person.email, app_metadata: {}, user_metadata: { name: person.name }, created_at: '2026-01-01T00:00:00Z' } };
    // supabase-js keeps its session under sb-<first label of the URL host>-auth-token: here sb-127-auth-token.
    await context.addInitScript(([key_, value]) => { try { localStorage.setItem(key_, value); } catch { /* ignore */ } }, ['sb-127-auth-token', JSON.stringify(session)]);
    const page = await context.newPage();
    await page.goto(`${WEB}${path}`);
    windows[key] = { context, page, person };
    return page;
  };
  await open('owner', info.people.owner, '/owner/inventory');
  await open('westlands', info.people.westlands, `/branch/${info.branches.westlands.id}/inventory`);

  console.log(`
==================== DEMO IS RUNNING ====================
Owner window      ${WEB}/owner/inventory                          ${info.people.owner.name}
Branch window     ${WEB}/branch/${info.branches.westlands.id}/inventory   ${info.people.westlands.name}
Other logins (bearer tokens; to switch, see docs/inventory-kb/DEMO.md): ${Object.values(info.people).map((p) => p.token).join(', ')}
Everything is in memory. Close the windows or press Ctrl+C here to stop.
=========================================================`);

  if (process.env.DEMO_AFTER) {
    const after = await import(process.env.DEMO_AFTER);
    try { await after.default({ windows, info, base: WEB, api: API, browser }); } finally { await stop(0); }
  } else {
    browser.on('disconnected', () => stop(0));
    await new Promise(() => {});
  }
} catch (error) {
  console.error(`\nDemo failed to start: ${error.message}`);
  await stop(1);
}
