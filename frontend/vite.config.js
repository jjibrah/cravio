import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Early hints for the first paint, added to index.html at build time:
 * - preload the Latin Geist woff2 (the only subset most pages use), so text doesn't wait for the CSS to
 *   be parsed before the font request starts;
 * - on the landing and sign-in pages, preload the dining-room photo (their largest image) before the
 *   JavaScript that renders the <img> has loaded.
 */
function firstPaintHints() {
  let base = '/';
  return {
    name: 'cravio-first-paint-hints',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const font = Object.keys(ctx.bundle || {}).find((name) => /geist-latin-wght-normal-[\w-]+\.woff2$/.test(name));
        const tags = [];
        if (font) tags.push({ tag: 'link', attrs: { rel: 'preload', href: `${base}${font}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' });
        tags.push({
          tag: 'script',
          children: `if(/^\\/(login|forgot-password|reset-password)?\\/?$/.test(location.pathname)){var l=document.createElement('link');l.rel='preload';l.as='image';l.href='${base}images/dining-room.webp';l.fetchPriority='high';document.head.appendChild(l)}`,
          injectTo: 'head',
        });
        return tags;
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const backend = loadEnv(mode, fileURLToPath(new URL('../backend', import.meta.url)), 'PORT');
  return {
    plugins: [react(), firstPaintHints()],
    build: {
      rolldownOptions: {
        output: {
          // React, the router and the Supabase client change rarely: separate files cache across deploys.
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|cookie|set-cookie-parser)[\\/]/ },
              { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/ },
            ],
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${backend.PORT || 3002}` },
    },
  };
});
