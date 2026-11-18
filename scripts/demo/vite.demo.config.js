// Vite config used ONLY by the inventory demo (scripts/demo/inventory-demo-browser.js). The real frontend/vite.config.js is untouched.
// It never reads frontend/.env (so the real Supabase project is never contacted) and proxies the API and the fake Supabase auth
// endpoints to the demo server on 5189. Port 5190, strict.
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.DEMO_API_PORT || 5189}`;
export default defineConfig({
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  envDir: join(tmpdir(), 'cravio-demo-no-env'),          // an empty place: the real .env is not loaded; VITE_* come from the launcher
  cacheDir: join(tmpdir(), 'cravio-demo-vite-cache'),     // don't share node_modules/.vite with another Vite on this machine
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DEMO_WEB_PORT || 5190),
    strictPort: true,
    proxy: { '/api': api, '/auth/v1': api, '/demo': api },
  },
});
