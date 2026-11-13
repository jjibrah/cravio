import { useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import BusyHoursChart from '../../components/insights/BusyHoursChart';
import DayChart from '../../components/insights/DayChart';
import DishTable from '../../components/insights/DishTable';
import KpiCards from '../../components/insights/KpiCards';
import '../../components/insights/insights.css';
import { ErrorState, OIcon, Segmented } from '../../components/owner/ui';
import { useApi } from '../../lib/api';

/*
 * Insights (/owner/insights): the one-line summary, a 7/30/90-day range (in ?range=), five KPI cards with the
 * change against the previous period, busy hours, day by day, and dish performance (server sort in ?sort=&dir=).
 * Reads GET /api/ops/analytics through the SWR cache; while a new range or sort loads, the last answer stays
 * on screen, dimmed.
 */

export const RANGES = [
  { value: '7d', label: '7 days', caption: 'the last 7 days', previous: 'the 7 days before' },
  { value: '30d', label: '30 days', caption: 'the last 30 days', previous: 'the 30 days before' },
  { value: '90d', label: '90 days', caption: 'the last 90 days', previous: 'the 90 days before' },
];
const SORTS = ['sales', 'quantity', 'views', 'plays', 'conversion', 'name'];

export const analyticsPath = (range = '30d', sort = 'sales', dir = 'desc') => `/api/ops/analytics?range=${range}&sort=${sort}&dir=${dir}`;

export default function InsightsPage({ section }) {
  const [params, setParams] = useSearchParams();
  const range = RANGES.some((option) => option.value === params.get('range')) ? params.get('range') : '30d';
  const sort = SORTS.includes(params.get('sort')) ? params.get('sort') : 'sales';
  const dir = ['asc', 'desc'].includes(params.get('dir')) ? params.get('dir') : (sort === 'name' ? 'asc' : 'desc');
  const meta = RANGES.find((option) => option.value === range);
  const { data: fresh, error, refresh } = useApi(analyticsPath(range, sort, dir), { ttl: 60000 });

  // Keep showing the last answer while another range or sort loads.
  const last = useRef(null);
  if (fresh) last.current = fresh;
  const data = fresh || last.current;
  const stale = !fresh && Boolean(data);
  const sameRange = data?.range === range;

  const go = (patch) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(patch).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key); });
    return next;
  }, { replace: true });

  const empty = data && sameRange && !data.kpis?.menuScans?.value && !data.kpis?.orders?.value && !data.kpis?.paidSales?.value;
  const summary = data && sameRange ? data.summary : null;

  return <div className="in-page">
    <PageHeader title={section?.label || 'Insights'} description={summary || (error && !data ? section?.description : undefined)}>
      <Segmented label="Time range" options={RANGES} value={range} onChange={(value) => go({ range: value === '30d' ? '' : value })} />
    </PageHeader>
    {!summary && !(error && !data) && <span className="sk sk-text in-summary-sk" aria-hidden="true" />}

    {error && !data ? <div className="o-panel"><ErrorState error={error} onRetry={refresh} what="your insights" /></div> : <div className={`in-body${stale ? ' is-stale' : ''}`} aria-busy={stale ? 'true' : 'false'}>
      <KpiCards data={sameRange ? data : null} previousLabel={meta.previous} />

      {error && data && <p className="o-note is-error"><OIcon name="alert" size={16} /><span>{error.message} <button type="button" className="o-text-link" onClick={refresh}>Try again</button></span></p>}

      {empty ? <div className="in-empty">
        <span className="in-empty-art" aria-hidden="true"><OIcon name="qr" size={26} /></span>
        <h2>Insights fill in as guests scan your menu</h2>
        <p>Put a table QR code on every table. Scans, dish views and orders show up here within a minute.</p>
        <Link to="/owner/tables" className="o-btn is-primary">Get table QR codes</Link>
      </div> : <>
        <div className="in-charts">
          {data && sameRange ? <>
            <BusyHoursChart busyHours={data.busyHours} rangeLabel={meta.caption} />
            <DayChart series={data.series} rangeLabel={meta.caption} />
          </> : <>
            <ChartSkeleton title="Busy hours" bars={24} />
            <ChartSkeleton title="Day by day" bars={30} />
          </>}
        </div>
        <DishTable rows={data && sameRange ? data.dishPerformance : null} sort={data?.dishPerformanceSort?.sort || sort} dir={data?.dishPerformanceSort?.dir || dir}
          loading={stale || !data} onSort={(nextSort, nextDir) => go({ sort: nextSort === 'sales' ? '' : nextSort, dir: nextDir === (nextSort === 'name' ? 'asc' : 'desc') ? '' : nextDir })} />
      </>}
    </div>}
  </div>;
}

function ChartSkeleton({ title, bars }) {
  return <section className="in-panel" aria-label={`${title}, loading`}>
    <header className="in-panel-head"><div><h2>{title}</h2><span className="sk sk-line" style={{ width: 220, marginTop: 8 }} /></div></header>
    <div className="in-chart-sk" aria-hidden="true">{Array.from({ length: bars }, (_, i) => <span key={i} className="sk" style={{ height: `${18 + ((i * 37) % 70)}%` }} />)}</div>
  </section>;
}
