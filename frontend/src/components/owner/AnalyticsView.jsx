import { useState } from 'react';
import { delta, formatKes, formatNumber, opsApi, plural, useResource } from '../../lib/ops';
import TrendChart from './TrendChart';
import { ErrorState, OIcon, Panel, Segmented } from './ui';

export const RANGES = [
  { value: 'today', label: 'Today', previous: 'yesterday at this time', caption: 'today' },
  { value: '7d', label: '7 days', previous: 'the 7 days before', caption: 'the last 7 days' },
  { value: '30d', label: '30 days', previous: 'the 30 days before', caption: 'the last 30 days' },
];
const METRICS = [
  { value: 'sales', label: 'Sales' },
  { value: 'orders', label: 'Orders' },
  { value: 'scans', label: 'Menu scans' },
];

/** Analytics: range picker, five plain-language stat cards with change vs the previous period, and a trend chart. */
export default function AnalyticsView({ range, onRange }) {
  const { data, error, loading, reload } = useResource((signal) => opsApi.analytics(range, signal), [range]);
  const [metric, setMetric] = useState('sales');
  const meta = RANGES.find((option) => option.value === range) || RANGES[0];
  const totals = data?.totals;
  const previous = data?.previousTotals;
  const stale = loading && data;

  const cards = totals ? [
    { key: 'scans', label: 'Menu scans', hint: 'Times guests opened your menu', value: formatNumber(totals.menuScans), change: delta(totals.menuScans, previous?.menuScans) },
    { key: 'orders', label: 'Orders', hint: 'Not counting cancelled ones', value: formatNumber(totals.orders), change: delta(totals.orders, previous?.orders) },
    { key: 'sales', label: 'Sales', hint: 'Money from paid orders', value: formatKes(totals.sales), change: delta(totals.sales, previous?.sales), money: true },
    { key: 'bills', label: 'Open bills', hint: 'Not paid yet, right now', value: plural(totals.openBills?.count || 0, 'bill'), sub: formatKes(totals.openBills?.amount || 0), change: null },
    { key: 'tables', label: 'Tables served', hint: 'Tables with at least one order', value: formatNumber(totals.tablesServed), change: delta(totals.tablesServed, previous?.tablesServed) },
  ] : null;

  return <div className="o-analytics">
    <div className="o-analytics-bar">
      <Segmented label="Time range" options={RANGES} value={range} onChange={onRange} />
      <p className="o-analytics-compare">Compared with {meta.previous}</p>
    </div>

    {error && !data && <ErrorState error={error} onRetry={reload} what="your numbers" />}

    <div className={`o-stats${stale ? ' is-stale' : ''}`} aria-busy={loading ? 'true' : 'false'}>
      {cards ? cards.map((card) => <article className="o-stat" key={card.key} aria-label={card.label}>
        <h3 className="o-stat-label">{card.label}</h3>
        <p className="o-stat-value">{card.value}</p>
        {card.sub && <p className="o-stat-sub">{card.sub} waiting</p>}
        {card.change && <Change change={card.change} money={card.money} />}
        {!card.change && !card.sub && <p className="o-stat-change is-flat">No earlier data</p>}
        <p className="o-stat-hint">{card.hint}</p>
      </article>) : Array.from({ length: 5 }, (_, i) => <div className="o-stat" key={i} aria-hidden="true">
        <span className="sk sk-line" style={{ width: '50%' }} /><span className="sk" style={{ width: '60%', height: 28, marginTop: 10 }} /><span className="sk sk-line" style={{ width: '40%', marginTop: 12 }} />
      </div>)}
    </div>

    <Panel title="Trend" sub={`${METRICS.find((m) => m.value === metric).label} ${data?.seriesUnit === 'hour' ? 'by hour' : 'by day'}, ${meta.caption}`}
      actions={<Segmented label="Show" options={METRICS} value={metric} onChange={setMetric} size="sm" />} className="o-trend">
      <div className="o-panel-body">
        {data ? <TrendChart series={data.series} unit={data.seriesUnit} metric={metric}
          caption={`${METRICS.find((m) => m.value === metric).label}, ${meta.caption}`} />
          : <div className="sk-chart" aria-hidden="true" style={{ minHeight: 220 }}>{Array.from({ length: 12 }, (_, i) => <span key={i} className="sk" style={{ height: `${28 + ((i * 37) % 64)}%` }} />)}</div>}
      </div>
    </Panel>
  </div>;
}

function Change({ change, money }) {
  const { diff, percent, direction } = change;
  const amount = money ? formatKes(Math.abs(diff)) : formatNumber(Math.abs(diff));
  const words = direction === 'flat' ? 'Same as before' : `${direction === 'up' ? 'Up' : 'Down'} ${percent !== null ? `${Math.abs(percent)}%` : amount}`;
  return <p className={`o-stat-change is-${direction}`}>
    {direction !== 'flat' && <OIcon name={direction === 'up' ? 'arrowUp' : 'arrowDown'} size={13} strokeWidth={2.4} />}
    <span>{words}</span>
    {direction !== 'flat' && percent !== null && <span className="o-stat-change-abs">({direction === 'up' ? '+' : '−'}{amount})</span>}
  </p>;
}
