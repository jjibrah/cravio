// Shared pieces for the Cravio admin platform pages (Overview, Restaurants, Performance, Money, Requests).
import { useId, useRef, useState } from 'react';
import { OIcon, Segmented } from '../../components/owner/ui';
import { chartKeys, formatAxis, formatKsh, formatWhole, longDay, niceTicks, shortDay, useWidth } from '../../components/insights/chartKit';
import '../../components/insights/insights.css';
import './platform.css';

export { formatKsh, formatWhole };

/** Keeps the last good answer on screen while a new range loads. */
export function useLast(fresh) {
  const last = useRef(null);
  if (fresh) last.current = fresh;
  return { data: fresh || last.current, stale: !fresh && Boolean(last.current) };
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const formatDate = (value) => (value ? dateFormat.format(new Date(value)) : '—');
export const formatDateTime = (value) => (value ? timeFormat.format(new Date(value)) : '—');

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function timeAgo(value, now = Date.now()) {
  if (!value) return '—';
  const minutes = Math.round((now - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(value);
}

export const RESTAURANT_STATUS = { live: 'Live', onboarding: 'Onboarding', suspended: 'Suspended' };
export function RestaurantStatus({ status }) {
  return <span className={`pl-pill is-${status || 'unknown'}`}><span className="pl-pill-dot" aria-hidden="true" />{RESTAURANT_STATUS[status] || status || 'Unknown'}</span>;
}

export const REQUEST_STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export function RequestStatus({ status }) {
  return <span className={`pl-pill is-req-${status}`}><span className="pl-pill-dot" aria-hidden="true" />{REQUEST_STATUS[status] || status}</span>;
}

export const REQUEST_TYPES = {
  lead: 'Lead', question: 'Question', problem: 'Something’s broken', billing: 'Billing', feature: 'Feature idea', complaint: 'Complaint',
};

/** KPI tiles. `tiles`: [{ key, label, value, sub, tone }] or null while loading. */
export function KpiTiles({ tiles, count = 4, label = 'Key numbers' }) {
  if (!tiles) {
    return <div className="pl-kpis" role="status" aria-label="Loading numbers">
      {Array.from({ length: count }, (_, i) => <div className="in-kpi" key={i} aria-hidden="true">
        <span className="sk sk-line" style={{ width: '50%' }} /><span className="sk" style={{ width: '60%', height: 28, marginTop: 12 }} /><span className="sk sk-line" style={{ width: '70%', marginTop: 14 }} />
      </div>)}
    </div>;
  }
  return <div className="pl-kpis" aria-label={label} role="group">
    {tiles.map((tile) => <article className={`in-kpi${tile.tone ? ` pl-kpi-${tile.tone}` : ''}`} key={tile.key} aria-label={tile.label}>
      <h3>{tile.label}</h3>
      <p className="in-kpi-value">{tile.value}</p>
      {tile.delta}
      {tile.sub && <p className="in-kpi-sub">{tile.sub}</p>}
    </article>)}
  </div>;
}

/** "▲ 12% vs the previous period" for money/count comparisons. */
export function Delta({ value, previous, label }) {
  if (!previous && !value) return <p className="in-delta is-flat">No activity yet</p>;
  if (!previous) return <p className="in-delta is-new"><span className="in-new">New</span><span className="in-delta-vs">none {label}</span></p>;
  const pct = ((value - previous) / previous) * 100;
  const direction = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  return <p className={`in-delta is-${direction}`}>
    {direction !== 'flat' && <OIcon name={direction === 'up' ? 'arrowUp' : 'arrowDown'} size={13} strokeWidth={2.4} />}
    <span>{direction === 'flat' ? 'No change' : `${Math.abs(pct).toLocaleString('en-KE', { maximumFractionDigits: 1 })}%`}</span>
    <span className="in-delta-vs">vs {label}</span>
  </p>;
}

/**
 * Day-by-day bars for one metric at a time. `series`: [{ date: 'YYYY-MM-DD', ...metrics }].
 * `metrics`: [{ value, label, name, money }]. Hover or arrow keys read each day; a table view is one click away.
 */
export function SeriesBars({ title, series, metrics, rangeLabel }) {
  const [metric, setMetric] = useState(metrics[0].value);
  const [active, setActive] = useState(null);
  const [table, setTable] = useState(false);
  const [box, width] = useWidth();
  const titleId = useId();
  const meta = metrics.find((entry) => entry.value === metric) || metrics[0];
  const format = (value) => (meta.money ? formatKsh(value) : formatWhole(value));
  const values = series.map((point) => Number(point[meta.value]) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const ticks = niceTicks(Math.max(1, ...values), 4);
  const top = ticks[ticks.length - 1];

  const H = 220;
  const padLeft = meta.money ? 48 : 34;
  const padRight = 8;
  const padTop = 12;
  const padBottom = 26;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = H - padTop - padBottom;
  const n = series.length;
  const slot = n ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(28, slot * 0.66));
  const x = (index) => padLeft + slot * index + (slot - barW) / 2;
  const y = (value) => padTop + plotH - (value / top) * plotH;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const point = active !== null ? series[active] : null;

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    setActive(Math.max(0, Math.min(n - 1, Math.floor((px - padLeft) / slot))));
  };

  return <section className="in-panel" aria-labelledby={titleId}>
    <header className="in-panel-head">
      <div>
        <h2 id={titleId}>{title}</h2>
        <p>{meta.name}, {rangeLabel}: <strong>{format(total)}</strong> in total.</p>
      </div>
      <div className="in-panel-tools">
        {metrics.length > 1 && <Segmented label="Show" size="sm" options={metrics} value={metric} onChange={(value) => { setMetric(value); setActive(null); }} />}
        <button type="button" className="o-btn is-quiet is-small" aria-pressed={table} onClick={() => setTable((value) => !value)}>{table ? 'Chart' : 'Table'}</button>
      </div>
    </header>
    {table ? <div className="in-table-wrap">
      <table className="in-data-table">
        <caption className="visually-hidden">{title} by day</caption>
        <thead><tr><th scope="col">Day</th>{metrics.map((m) => <th scope="col" key={m.value}>{m.name}</th>)}</tr></thead>
        <tbody>{series.map((entry) => <tr key={entry.date}><th scope="row">{longDay(entry.date)}</th>
          {metrics.map((m) => <td key={m.value}>{m.money ? formatKsh(entry[m.value]) : formatWhole(entry[m.value])}</td>)}</tr>)}</tbody>
      </table>
    </div> : <div className="in-chart" ref={box}>
      <div className={`in-tip${point ? ' is-on' : ''}`} aria-live="polite" style={point ? { left: Math.min(Math.max(x(active) + barW / 2, 90), width - 90) } : undefined}>
        {point && <><strong>{longDay(point.date)}</strong><span><i className="in-swatch is-1" aria-hidden="true" />{format(values[active])} {meta.unit || meta.name.toLowerCase()}</span></>}
      </div>
      <svg className="in-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" tabIndex={0}
        aria-label={`${meta.name} by day, ${rangeLabel}: ${format(total)} in total. Use the arrow keys to read each day.`}
        onMouseMove={n ? onMove : undefined} onMouseLeave={() => setActive(null)} onKeyDown={chartKeys(n, active, setActive)} onBlur={() => setActive(null)}>
        {ticks.map((tick) => <g key={tick} className="in-grid">
          <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} />
          <text x={padLeft - 8} y={y(tick) + 4} textAnchor="end">{formatAxis(tick)}</text>
        </g>)}
        {values.map((value, index) => <rect key={series[index].date} className={`in-bar${active !== null && active !== index ? ' pl-dim' : ''}`}
          x={x(index)} y={y(value)} width={barW} height={Math.max(0, padTop + plotH - y(value))} rx={Math.min(3, barW / 3)} />)}
        {series.map((entry, index) => (index % every === 0 || index === n - 1) && (n - 1 - index >= every * 0.6 || index === n - 1)
          ? <text key={entry.date} className="in-x" x={x(index) + barW / 2} y={H - 8} textAnchor={index === 0 ? 'start' : index === n - 1 ? 'end' : 'middle'}>{shortDay(entry.date)}</text> : null)}
        <line className="in-base" x1={padLeft} x2={width - padRight} y1={padTop + plotH} y2={padTop + plotH} />
      </svg>
    </div>}
  </section>;
}

export function ChartSkeleton({ title, bars = 30 }) {
  return <section className="in-panel" aria-label={`${title}, loading`}>
    <header className="in-panel-head"><div><h2>{title}</h2><span className="sk sk-line" style={{ width: 220, marginTop: 8 }} /></div></header>
    <div className="in-chart-sk" aria-hidden="true">{Array.from({ length: bars }, (_, i) => <span key={i} className="sk" style={{ height: `${18 + ((i * 37) % 70)}%` }} />)}</div>
  </section>;
}

/** Shown when a migration's tables are missing, so the page explains its empty numbers. */
export function NotInstalled({ what, migration }) {
  return <p className="o-note is-warning"><OIcon name="info" size={16} />
    <span>{what} aren’t available yet: database migration {migration} hasn’t been applied. Run <code>npm run db:migrate</code>.</span></p>;
}

/** A sortable column header for platform tables. */
export function SortHeader({ label, column, sort, onSort, numeric = false }) {
  const active = sort.key === column;
  const dir = active ? sort.dir : null;
  return <th scope="col" className={numeric ? 'is-num' : undefined} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={`in-sort${active ? ' is-active' : ''}`}
      onClick={() => onSort({ key: column, dir: active && dir === 'desc' ? 'asc' : active ? 'desc' : numeric ? 'desc' : 'asc' })}>
      {label}<span className="in-sort-icon" aria-hidden="true">{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span>
    </button>
  </th>;
}

/** Sorts rows by `sort.key` (numbers, strings, dates as ISO strings; nulls last). */
export function sortRows(rows, sort, get = (row, key) => row[key]) {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = get(a, sort.key);
    const right = get(b, sort.key);
    if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
    if (right === null || right === undefined) return -1;
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
    return String(left).localeCompare(String(right)) * factor;
  });
}
