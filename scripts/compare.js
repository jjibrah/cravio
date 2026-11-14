import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = resolve(process.env.CRAVIO_MAIN_DIR || join(dirname(root), 'cravio-main-baseline'));
const branch = (cwd) => execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
if (branch(root) !== 'dev' || branch(baseline) !== 'main') throw new Error('Comparison requires this checkout on dev and CRAVIO_MAIN_DIR on main.');
const read = (cwd, app) => parseEnv(readFileSync(join(cwd, app, '.env'), 'utf8'));
const main = read(baseline, 'backend');
const dev = read(root, 'backend');
if (!main.SUPABASE_URL || !dev.SUPABASE_URL) throw new Error('Both checkouts need their Supabase environment configured.');
const shared = new URL(main.SUPABASE_URL).origin === new URL(dev.SUPABASE_URL).origin;
if (shared && !process.argv.includes('--shared-db')) throw new Error('The database is shared. Pass --shared-db only for the approved baseline comparison.');
for (const [cwd, backend] of [[baseline, main], [root, dev]]) {
  if (read(cwd, 'frontend').VITE_SUPABASE_URL !== backend.SUPABASE_URL) throw new Error(`Frontend/backend Supabase mismatch in ${cwd}.`);
}
if (shared) console.log('Shared database comparison: edits in either app affect the same records. No migrations or seeds are run.');
for (const port of [5173, 5174, 3003, 3004]) {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop its owning comparison process before restarting.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
}
for (const [label, cwd, port, frontendPort] of [['main', baseline, 3003, 5173], ['dev', root, 3004, 5174]]) {
  // Remove inherited credentials so each child reads only its checkout's .env.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SUPABASE_|VITE_|CRAVIO_ENV$|OPENROUTER_|AI_PROVIDER$|SUPER_ADMIN_EMAIL$)/.test(key)) delete env[key];
  Object.assign(env, { PORT: String(port), FRONTEND_URL: `http://localhost:${frontendPort}`, VITE_API_URL: '' });
  for (const [workspace, extra] of [['backend', []], ['frontend', ['--', '--port', String(frontendPort), '--strictPort']]]) {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--workspace', workspace, ...extra], {
      cwd, env, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    children.push(child);
    child.once('error', (error) => { console.error(error.message); stop(1); });
    child.once('exit', (code) => stop(code ?? 1));
  }
  console.log(`${label}: http://localhost:${frontendPort} (backend ${port})`);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
