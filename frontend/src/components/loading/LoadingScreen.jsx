import { useEffect, useState } from 'react';
import { BrandMark } from '../Brand';
import './loading.css';

/**
 * The full-screen CRAVIO loader. With `delay` (ms) it shows a plain ground first and only brings in
 * the logo if loading takes longer, so a fast load (cached code, cached account) never flashes it.
 */
export default function LoadingScreen({ delay = 0 }) {
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (shown) return undefined;
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay, shown]);
  if (!shown) return <main className="loading-screen" aria-busy="true" />;
  return <main className="loading-screen" aria-busy="true">
    <div className="loading-brand" role="status" aria-label="Loading CRAVIO">
      <span className="loading-wordmark" aria-hidden="true">Cravio<BrandMark /></span>
      <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
    </div>
  </main>;
}
