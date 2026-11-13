import { OIcon } from '../owner/ui';
import { formatKsh, formatWhole } from './chartKit';

/** Five headline numbers with the change against the previous period ("New" when that period was empty). */
export default function KpiCards({ data, previousLabel }) {
  if (!data) {
    return <div className="in-kpis" role="status" aria-label="Loading numbers">
      {Array.from({ length: 5 }, (_, i) => <div className="in-kpi" key={i} aria-hidden="true">
        <span className="sk sk-line" style={{ width: '50%' }} /><span className="sk" style={{ width: '60%', height: 28, marginTop: 12 }} /><span className="sk sk-line" style={{ width: '70%', marginTop: 14 }} />
      </div>)}
    </div>;
  }
  const { kpis, totals } = data;
  const perScan = kpis.viewsPerScan?.value;
  const cards = [
    { key: 'scans', label: 'Menu scans', kpi: kpis.menuScans, sub: 'Times guests opened your menu' },
    { key: 'views', label: 'Dish views', kpi: kpis.dishViews, sub: perScan !== null && perScan !== undefined ? `${perScan.toFixed(1)} per scan` : 'Dishes guests opened' },
    { key: 'orders', label: 'Orders', kpi: kpis.orders, sub: 'Not counting cancelled ones' },
    { key: 'average', label: 'Average order', kpi: kpis.averageOrder, money: true, sub: `Across ${formatWhole(totals?.paidOrders)} paid ${totals?.paidOrders === 1 ? 'order' : 'orders'}` },
    { key: 'sales', label: 'Paid sales', kpi: kpis.paidSales, money: true, sub: 'Money from paid orders' },
  ];
  return <div className="in-kpis">
    {cards.map((card) => <article className="in-kpi" key={card.key} aria-label={card.label}>
      <h3>{card.label}</h3>
      <p className="in-kpi-value">{card.kpi?.value === null || card.kpi?.value === undefined ? '—' : card.money ? formatKsh(card.kpi.value) : formatWhole(card.kpi.value)}</p>
      <Delta kpi={card.kpi} previousLabel={previousLabel} />
      <p className="in-kpi-sub">{card.sub}</p>
    </article>)}
  </div>;
}

function Delta({ kpi, previousLabel }) {
  if (!kpi || kpi.value === null || kpi.value === undefined) return <p className="in-delta is-flat">Not tracked yet</p>;
  if (kpi.isNew) return <p className="in-delta is-new"><span className="in-new">New</span><span className="in-delta-vs">none before</span></p>;
  if (!kpi.previous && !kpi.value) return <p className="in-delta is-flat">No activity yet</p>;
  const pct = kpi.deltaPercent;
  const direction = kpi.delta > 0 ? 'up' : kpi.delta < 0 ? 'down' : 'flat';
  return <p className={`in-delta is-${direction}`}>
    {direction !== 'flat' && <OIcon name={direction === 'up' ? 'arrowUp' : 'arrowDown'} size={13} strokeWidth={2.4} />}
    <span>{direction === 'flat' ? 'No change' : `${Math.abs(pct ?? 0).toLocaleString('en-KE', { maximumFractionDigits: 1 })}%`}</span>
    <span className="in-delta-vs">vs {previousLabel}</span>
  </p>;
}
