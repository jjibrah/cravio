import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OnbIcon from './OnbIcon';
import './onboarding.css';

const visible = (element) => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
const find = (selectors) => selectors.map((selector) => document.querySelector(selector)).find(visible) || null;

/**
 * Lightweight coach marks over the real dashboard. Each stop lists selectors in order of preference
 * (e.g. the desktop sidebar, then the phone's menu button). Escape or "Skip tour" ends it.
 */
export default function Tour({ stops, onFinish, onSkip }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const cardRef = useRef(null);
  const stop = stops[index];
  const last = index === stops.length - 1;

  const measure = useCallback(() => {
    const target = find(stop.selectors);
    if (!target) { setRect(null); return; }
    const r = target.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [stop]);

  useLayoutEffect(() => {
    const target = find(stop.selectors);
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    measure();
  }, [measure, stop]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [measure]);
  useEffect(() => { cardRef.current?.focus(); }, [index]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); onSkip(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardWidth = Math.min(340, vw - 32);
  let cardStyle = { width: cardWidth, left: (vw - cardWidth) / 2, top: vh / 2 - 90 };
  if (rect) {
    const roomRight = vw - (rect.left + rect.width);
    if (rect.height > vh * 0.5 && roomRight > cardWidth + 32) cardStyle = { width: cardWidth, left: rect.left + rect.width + 20, top: Math.max(16, Math.min(vh - 260, rect.top + 40)) };
    else {
      const below = rect.top + rect.height + 16;
      const top = below + 220 < vh ? below : Math.max(16, rect.top - 236);
      cardStyle = { width: cardWidth, left: Math.max(16, Math.min(vw - cardWidth - 16, rect.left + rect.width / 2 - cardWidth / 2)), top };
    }
  }

  return createPortal(<div className="tour" role="presentation">
    {rect ? <div className="tour-spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} aria-hidden="true" />
      : <div className="tour-scrim" aria-hidden="true" />}
    <div ref={cardRef} className="tour-card" style={cardStyle} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const items = [...event.currentTarget.querySelectorAll('button')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      }}>
      <p className="tour-count">{index + 1} of {stops.length}</p>
      <h2 id="tour-title">{stop.title}</h2>
      <p id="tour-body">{stop.body}</p>
      <div className="tour-actions">
        <button type="button" className="onb-text-button" onClick={onSkip}>Skip tour</button>
        <span className="tour-dots" aria-hidden="true">{stops.map((s, i) => <span key={s.title} className={i === index ? 'is-active' : undefined} />)}</span>
        <button type="button" className="onb-primary" onClick={() => (last ? onFinish() : setIndex(index + 1))}>
          {last ? 'Done' : 'Next'}{!last && <OnbIcon name="arrow" size={16} />}</button>
      </div>
    </div>
  </div>, document.body);
}
