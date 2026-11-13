import { useEffect, useRef, useState } from 'react';

/* Small helpers shared by the Insights charts. */

/** Tracks an element's width (for responsive inline SVG). */
export function useWidth(initial = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 0 and three or four round steps above `max`. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= rough) || power * 10;
  const ticks = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks.length > 1 ? ticks : [0, step];
}

const compact = new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
export const formatAxis = (value) => (value >= 10000 ? compact.format(value) : whole.format(value));
export const formatWhole = (value) => whole.format(Number(value) || 0);
export const formatKsh = (value) => `Ksh ${whole.format(Math.round(Number(value) || 0))}`;

const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const tickLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
/** "Sat 8 Nov" and "8 Nov" for a YYYY-MM-DD Nairobi day (formatted as a calendar date, so no zone shift). */
export const longDay = (ymd) => dayLabel.format(new Date(`${ymd}T12:00:00Z`));
export const shortDay = (ymd) => tickLabel.format(new Date(`${ymd}T12:00:00Z`));

/** Arrow keys move a focused chart's active index. */
export function chartKeys(count, active, setActive) {
  return (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActive(count - 1); return; }
    if (event.key === 'Escape') { setActive(null); return; }
    if (!step) return;
    event.preventDefault();
    setActive(active === null ? (step > 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, active + step)));
  };
}
