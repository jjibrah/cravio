import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatDayLabel, formatKes, formatKesCompact, formatNumber } from '../../lib/ops';

/**
 * A single-series bar chart in inline SVG: recessive grid, thin rounded bars anchored to the baseline,
 * a hover/focus readout in the header, and a visually hidden table for screen readers.
 */
export default function TrendChart({ series = [], unit = 'day', metric = 'sales', height = 220, caption }) {
  const tableId = useId();
  const [active, setActive] = useState(null);
  const box = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const money = metric === 'sales';
  const values = series.map((point) => Number(point[metric]) || 0);
  const max = Math.max(1, ...values);
  const ticks = useMemo(() => niceTicks(max), [max]);
  const top = ticks[ticks.length - 1] || 1;
  const total = values.reduce((sum, value) => sum + value, 0);
  const format = (value) => (money ? formatKes(value) : formatNumber(value));
  const label = (point) => (unit === 'hour' ? point.label : formatDayLabel(point.label));
  const short = (point, index) => {
    if (unit === 'hour') return point.label.slice(0, 2);
    const date = new Date(`${point.label}T12:00:00+03:00`);
    return series.length > 10 ? (index % 5 === 0 || index === series.length - 1 ? String(date.getUTCDate()) : '') : formatDayLabel(point.label).split(' ')[0];
  };

  const W = width;
  const H = height;
  const padLeft = 52;
  const padBottom = 26;
  const padTop = 8;
  const plotW = W - padLeft - 4;
  const plotH = H - padBottom - padTop;
  const step = series.length ? plotW / series.length : plotW;
  const barW = Math.max(3, Math.min(32, step * 0.62));
  const point = active !== null ? series[active] : null;

  return <figure className="o-chart" ref={box}>
    <figcaption className="o-chart-readout" aria-live="polite">
      <span className="o-chart-readout-label">{point ? label(point) : caption}</span>
      <span className="o-chart-readout-value">{point ? format(values[active]) : format(total)}</span>
    </figcaption>
    <svg className="o-chart-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-describedby={tableId}
      aria-label={`${caption}: ${format(total)} in total`} onMouseLeave={() => setActive(null)}>
      {ticks.map((tick) => {
        const y = padTop + plotH - (tick / top) * plotH;
        return <g key={tick} className="o-chart-grid">
          <line x1={padLeft} x2={W} y1={y} y2={y} />
          <text x={padLeft - 8} y={y + 4} textAnchor="end">{money ? formatKesCompact(tick).replace('Ksh ', '') : formatNumber(tick)}</text>
        </g>;
      })}
      {series.map((entry, index) => {
        const value = values[index];
        const h = value > 0 ? Math.max(3, (value / top) * plotH) : 0;
        const x = padLeft + index * step + (step - barW) / 2;
        const y = padTop + plotH - h;
        const r = Math.min(4, barW / 2, h);
        return <g key={entry.start || index} className={`o-chart-bar${active === index ? ' is-active' : ''}${active !== null && active !== index ? ' is-dim' : ''}`}
          onMouseEnter={() => setActive(index)}>
          <rect className="o-chart-hit" x={padLeft + index * step} y={padTop} width={step} height={plotH} />
          {h > 0 && <path d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`} />}
          <text className="o-chart-x" x={x + barW / 2} y={H - 8} textAnchor="middle">{short(entry, index)}</text>
        </g>;
      })}
      <line className="o-chart-base" x1={padLeft} x2={W} y1={padTop + plotH} y2={padTop + plotH} />
    </svg>
    <table className="visually-hidden" id={tableId}>
      <caption>{caption}</caption>
      <thead><tr><th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th><th scope="col">Value</th></tr></thead>
      <tbody>{series.map((entry, index) => <tr key={entry.start || index}><th scope="row">{label(entry)}</th><td>{format(values[index])}</td></tr>)}</tbody>
    </table>
  </figure>;
}

function niceTicks(max) {
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= rough) || power * 10;
  return [0, unit, unit * 2, unit * 3];
}
