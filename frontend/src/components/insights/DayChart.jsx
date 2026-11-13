import { useId, useState } from 'react';
import { Segmented } from '../owner/ui';
import { chartKeys, formatAxis, formatKsh, formatWhole, longDay, niceTicks, shortDay, useWidth } from './chartKit';

const METRICS = [
  { value: 'scans', label: 'Scans', name: 'Menu scans' },
  { value: 'orders', label: 'Orders', name: 'Orders' },
  { value: 'sales', label: 'Sales', name: 'Paid sales' },
];

/**
 * Day by day: one 2px ink line (Scans, Orders or Sales) on a recessive grid, with date ticks, a crosshair
 * and tooltip on hover or focus (arrow keys step through days), and a table view.
 */
export default function DayChart({ series = [], rangeLabel }) {
  const [metric, setMetric] = useState('orders');
  const [active, setActive] = useState(null);
  const [table, setTable] = useState(false);
  const [box, width] = useWidth();
  const titleId = useId();
  const meta = METRICS.find((entry) => entry.value === metric);
  const money = metric === 'sales';
  const format = (value) => (money ? formatKsh(value) : formatWhole(value));
  const values = series.map((point) => Number(point[metric]) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const best = values.length ? values.indexOf(Math.max(...values)) : -1;
  const ticks = niceTicks(Math.max(1, ...values), 4);
  const top = ticks[ticks.length - 1];

  const H = 260;
  const padLeft = money ? 48 : 36;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const n = series.length;
  const x = (index) => padLeft + (n <= 1 ? plotW / 2 : (index / (n - 1)) * plotW);
  const y = (value) => padTop + plotH - (value / top) * plotH;
  const path = values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const area = n ? `${path} L${x(n - 1).toFixed(1)},${padTop + plotH} L${x(0).toFixed(1)},${padTop + plotH} Z` : '';
  // About six date ticks, always including the first and last day.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
  const tickIndexes = series.map((_, index) => index).filter((index) => index % every === 0 && (n - 1 - index >= every * 0.6 || index === n - 1));
  if (n > 1 && !tickIndexes.includes(n - 1)) tickIndexes.push(n - 1);

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((px - padLeft) / plotW) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, index)));
  };
  const point = active !== null ? series[active] : null;
  const gradient = `in-area-${titleId.replace(/:/g, '')}`;

  return <section className="in-panel" aria-labelledby={titleId}>
    <header className="in-panel-head">
      <div>
        <h2 id={titleId}>Day by day</h2>
        <p>{meta.name} each day, {rangeLabel}: <strong>{format(total)}</strong> in total{best >= 0 && values[best] > 0 ? `, best on ${longDay(series[best].label)}` : ''}.</p>
      </div>
      <div className="in-panel-tools">
        <Segmented label="Show" size="sm" options={METRICS} value={metric} onChange={(value) => { setMetric(value); setActive(null); }} />
        <button type="button" className="o-btn is-quiet is-small" aria-pressed={table} onClick={() => setTable((value) => !value)}>{table ? 'Chart' : 'Table'}</button>
      </div>
    </header>

    {table ? <div className="in-table-wrap">
      <table className="in-data-table">
        <caption className="visually-hidden">Menu scans, orders and paid sales by day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Menu scans</th><th scope="col">Orders</th><th scope="col">Paid sales</th></tr></thead>
        <tbody>{series.map((entry) => <tr key={entry.label}><th scope="row">{longDay(entry.label)}</th><td>{formatWhole(entry.scans)}</td><td>{formatWhole(entry.orders)}</td><td>{formatKsh(entry.sales)}</td></tr>)}</tbody>
      </table>
    </div> : <div className="in-chart" ref={box}>
      <div className={`in-tip${point ? ' is-on' : ''}`} aria-live="polite" style={point ? { left: Math.min(Math.max(x(active), 90), width - 90) } : undefined}>
        {point && <><strong>{longDay(point.label)}</strong>
          <span><i className="in-swatch is-1" aria-hidden="true" />{format(values[active])} {money ? 'paid' : metric === 'scans' ? (values[active] === 1 ? 'scan' : 'scans') : (values[active] === 1 ? 'order' : 'orders')}</span></>}
      </div>
      <svg className="in-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" tabIndex={0}
        aria-label={`${meta.name} by day, ${rangeLabel}: ${format(total)} in total. Use the arrow keys to read each day.`}
        onMouseMove={n ? onMove : undefined} onMouseLeave={() => setActive(null)} onKeyDown={chartKeys(n, active, setActive)} onBlur={() => setActive(null)}>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--ink)" stopOpacity=".09" />
            <stop offset="1" stopColor="var(--ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => <g key={tick} className="in-grid">
          <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} />
          <text x={padLeft - 8} y={y(tick) + 4} textAnchor="end">{formatAxis(tick)}</text>
        </g>)}
        {n > 0 && <path d={area} fill={`url(#${gradient})`} />}
        {n > 0 && <path className="in-line" d={path} />}
        {tickIndexes.map((index) => <text key={index} className="in-x" x={x(index)} y={H - 8} textAnchor={index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle'}>{shortDay(series[index].label)}</text>)}
        <line className="in-base" x1={padLeft} x2={width - padRight} y1={padTop + plotH} y2={padTop + plotH} />
        {point && <g className="in-cross">
          <line x1={x(active)} x2={x(active)} y1={padTop} y2={padTop + plotH} />
          <circle cx={x(active)} cy={y(values[active])} r={5} />
        </g>}
        {!point && best >= 0 && values[best] > 0 && <circle className="in-best" cx={x(best)} cy={y(values[best])} r={4.5} />}
      </svg>
    </div>}
  </section>;
}
