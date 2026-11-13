import { useId, useState } from 'react';
import { Segmented } from '../owner/ui';
import { chartKeys, formatAxis, formatWhole, niceTicks, useWidth } from './chartKit';

const SERIES = [
  { value: 'scans', label: 'Menu scans' },
  { value: 'orders', label: 'Orders' },
  { value: 'both', label: 'Both' },
];
const NAMES = { scans: 'Menu scans', orders: 'Orders' };

/**
 * Busy hours: 24 bars (Nairobi hours) of menu scans, orders, or both side by side, summed over the range.
 * Ink for the first series, a muted second series; the busiest hour is highlighted in ember when one
 * series shows. Hover, focus and arrow keys show the hour's numbers; a table view is one click away.
 */
export default function BusyHoursChart({ busyHours, rangeLabel }) {
  const [series, setSeries] = useState('both');
  const [active, setActive] = useState(null);
  const [table, setTable] = useState(false);
  const [box, width] = useWidth();
  const titleId = useId();
  const hours = busyHours?.hours || [];
  const peak = busyHours?.peakHour || null;
  const keys = series === 'both' ? ['scans', 'orders'] : [series];
  const max = Math.max(1, ...hours.flatMap((hour) => keys.map((key) => hour[key] || 0)));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1];

  const H = 240;
  const padLeft = 36;
  const padRight = 4;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const slot = plotW / 24;
  const gap = series === 'both' ? 2 : 0;
  const groupW = Math.min(30, slot * 0.72);
  const barW = Math.max(2, (groupW - gap * (keys.length - 1)) / keys.length);
  const y = (value) => padTop + plotH - (value / top) * plotH;
  const shown = active !== null ? hours[active] : null;
  const caption = peak
    ? `Staff up around ${peak.label}: ${formatWhole(peak.scans)} ${peak.scans === 1 ? 'scan' : 'scans'} and ${formatWhole(peak.orders)} ${peak.orders === 1 ? 'order' : 'orders'} in that hour over ${rangeLabel}.`
    : 'No scans or orders yet in this period.';

  return <section className="in-panel" aria-labelledby={titleId}>
    <header className="in-panel-head">
      <div>
        <h2 id={titleId}>Busy hours</h2>
        <p>{caption}</p>
      </div>
      <div className="in-panel-tools">
        <Segmented label="Show" size="sm" options={SERIES} value={series} onChange={(value) => { setSeries(value); setActive(null); }} />
        <button type="button" className="o-btn is-quiet is-small" aria-pressed={table} onClick={() => setTable((value) => !value)}>{table ? 'Chart' : 'Table'}</button>
      </div>
    </header>
    {series === 'both' && !table && <ul className="in-legend" aria-label="Legend">
      <li><span className="in-swatch is-1" aria-hidden="true" />Menu scans</li>
      <li><span className="in-swatch is-2" aria-hidden="true" />Orders</li>
    </ul>}

    {table ? <HoursTable hours={hours} /> : <div className="in-chart" ref={box}>
      <div className={`in-tip${shown ? ' is-on' : ''}`} aria-live="polite" style={shown ? { left: Math.min(Math.max(padLeft + slot * (active + 0.5), 90), width - 90) } : undefined}>
        {shown && <><strong>{shown.label}–{String((shown.hour + 1) % 24).padStart(2, '0')}:00</strong>
          {keys.map((key) => <span key={key}><i className={`in-swatch is-${series === 'both' && key === 'orders' ? 2 : 1}`} aria-hidden="true" />{formatWhole(shown[key])} {key === 'scans' ? (shown[key] === 1 ? 'scan' : 'scans') : (shown[key] === 1 ? 'order' : 'orders')}</span>)}
          {peak && shown.hour === peak.hour && <em>Busiest hour</em>}</>}
      </div>
      <svg className="in-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" tabIndex={0}
        aria-label={`Busy hours by hour of the day, ${series === 'both' ? 'menu scans and orders' : NAMES[series].toLowerCase()}. ${caption} Use the arrow keys to read each hour.`}
        onKeyDown={chartKeys(24, active, setActive)} onBlur={() => setActive(null)} onMouseLeave={() => setActive(null)}>
        {ticks.map((tick) => <g key={tick} className="in-grid">
          <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} />
          <text x={padLeft - 8} y={y(tick) + 4} textAnchor="end">{formatAxis(tick)}</text>
        </g>)}
        {hours.map((hour, index) => {
          const x0 = padLeft + index * slot + (slot - groupW) / 2;
          const isPeak = peak && hour.hour === peak.hour;
          return <g key={hour.hour} className={`in-hour${active === index ? ' is-active' : ''}${active !== null && active !== index ? ' is-dim' : ''}`} onMouseEnter={() => setActive(index)}>
            <rect className="in-hit" x={padLeft + index * slot} y={padTop} width={slot} height={plotH} />
            {keys.map((key, k) => {
              const value = hour[key] || 0;
              if (!value) return null;
              const h = Math.max(2, (value / top) * plotH);
              const x = x0 + k * (barW + gap);
              const r = Math.min(4, barW / 2, h);
              const tone = series === 'both' ? (k === 0 ? 'is-1' : 'is-2') : isPeak ? 'is-peak' : 'is-1';
              const yTop = padTop + plotH - h;
              return <path key={key} className={`in-bar ${tone}`}
                d={`M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`} />;
            })}
            {index % 3 === 0 && <text className="in-x" x={padLeft + index * slot + slot / 2} y={H - 8} textAnchor="middle">{hour.label.slice(0, 2)}</text>}
          </g>;
        })}
        {peak && series !== 'both' && (() => {
          const index = hours.findIndex((hour) => hour.hour === peak.hour);
          const value = hours[index]?.[series] || 0;
          return index >= 0 && value > 0 ? <text className="in-peak-label" x={padLeft + index * slot + slot / 2} y={Math.max(10, y(value) - 6)} textAnchor="middle">Busiest</text> : null;
        })()}
        <line className="in-base" x1={padLeft} x2={width - padRight} y1={padTop + plotH} y2={padTop + plotH} />
      </svg>
      <p className="in-axis-note">Hour of the day, Nairobi time</p>
    </div>}
  </section>;
}

function HoursTable({ hours }) {
  return <div className="in-table-wrap">
    <table className="in-data-table">
      <caption className="visually-hidden">Menu scans and orders by hour of the day</caption>
      <thead><tr><th scope="col">Hour</th><th scope="col">Menu scans</th><th scope="col">Orders</th></tr></thead>
      <tbody>{hours.map((hour) => <tr key={hour.hour}><th scope="row">{hour.label}</th><td>{formatWhole(hour.scans)}</td><td>{formatWhole(hour.orders)}</td></tr>)}</tbody>
    </table>
  </div>;
}
