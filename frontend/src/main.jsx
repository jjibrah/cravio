import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import App from './App.jsx';
import { prefetchRoute } from './lib/prefetch';
import './index.css';

// Fetch every chunk the first route needs in parallel, and render once they're in, so the first paint
// is the page itself rather than a chain of loaders. A failed chunk still renders (React.lazy retries).
const start = () => createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
prefetchRoute(window.location.pathname, { data: false }).then(start, start);
