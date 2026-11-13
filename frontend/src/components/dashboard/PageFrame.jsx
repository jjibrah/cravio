import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import Icon from '../Icon';

/*
 * Page frames: every page shows its real structure before data is connected.
 * Static UI (filters, settings sections, legends) uses real labels; only live
 * records are skeleton shapes. The top bar's Preview chip says so once.
 */

const repeat = (count) => Array.from({ length: count }, (_, index) => index);
const widths = ['62%', '48%', '71%', '55%', '66%', '40%', '58%', '50%'];

const toolbars = {
  orders: { filters: ['Today', 'All channels', 'Status'], end: 'Export' },
  restaurants: { filters: ['Status', 'Location'], end: 'Export' },
  'leads-requests': { filters: ['Type', 'Status'] },
  complaints: { filters: ['Status', 'Opened'] },
  insights: { filters: ['Last 7 days', 'Compare to previous'], end: 'Export', search: false },
  performance: { filters: ['Last 7 days', 'All restaurants'], end: 'Export', search: false },
  money: { filters: ['This month', 'All restaurants'], end: 'Export', search: false },
  tables: { filters: ['All areas', 'Status'] },
  products: { filters: ['Availability', 'Sort: Name'] },
};

export function PageHeader({ title, description, children }) {
  return <header className="page-header">
    <div className="page-heading"><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {children && <div className="page-actions">{children}</div>}
  </header>;
}

/** Toolbar preview: real control labels, shown inert until data is connected. */
export function Toolbar({ page, query = '', label = '' }) {
  const config = toolbars[page] || { filters: ['Status'] };
  return <div className="toolbar">
    {config.search !== false && (query
      ? <div className="toolbar-search has-query"><Icon name="search" size={15} /><span>{query}</span>
        <Link to="." relative="path" className="toolbar-clear" aria-label={`Clear search for ${query}`}><Icon name="close" size={13} /></Link></div>
      : <span className="toolbar-search" aria-hidden="true"><Icon name="search" size={15} /><span>Search {label.toLowerCase()}</span></span>)}
    <span className="toolbar-filters" aria-hidden="true">
      {config.filters.map((filter) => <span key={filter} className="toolbar-chip">{filter}<Icon name="chevron" size={12} className="toolbar-chevron" /></span>)}
    </span>
    {config.end && <span className="toolbar-end" aria-hidden="true"><span className="toolbar-chip">{config.end}</span></span>}
  </div>;
}

/** Inline result row when global search sends a query to a page. */
export function QueryEmpty({ query, label }) {
  if (!query) return null;
  return <div className="query-empty" role="status">
    <Icon name="search" size={16} />
    <span><strong>No {label.toLowerCase()} match “{query}” yet.</strong> Matching records will show here once live data is connected.</span>
  </div>;
}

function StatTiles({ count = 4 }) {
  return <div className="sk-stats" style={{ '--count': count }}>
    {repeat(count).map((i) => <div className="panel sk-stat" key={i}>
      <span className="sk sk-line" style={{ width: '45%' }} />
      <span className="sk sk-figure" />
      <span className="sk sk-line" style={{ width: '30%' }} />
    </div>)}
  </div>;
}

function ChartPanel({ bars = 14 }) {
  return <div className="panel sk-chart-panel">
    <div className="panel-head"><span className="sk sk-text" style={{ width: 140 }} /><span className="sk sk-line" style={{ width: 72 }} /></div>
    <div className="sk-chart">{repeat(bars).map((i) => <span key={i} className="sk" style={{ height: `${28 + ((i * 37) % 64)}%` }} />)}</div>
  </div>;
}

function ListPanel({ rows = 6 }) {
  return <div className="panel sk-list-panel">
    <div className="panel-head"><span className="sk sk-text" style={{ width: 110 }} /></div>
    {repeat(rows).map((i) => <div className="sk-list-row" key={i}>
      <span className="sk sk-avatar" />
      <span className="sk-stack"><span className="sk sk-line" style={{ width: widths[i % 8] }} /><span className="sk sk-line" style={{ width: '32%' }} /></span>
      <span className="sk sk-line" style={{ width: 40 }} />
    </div>)}
  </div>;
}

function TableSkeleton({ columns = ['', '', '', '', ''], rows = 8, query, label }) {
  const numeric = (column, i) => i === columns.length - 1 && column === 'Total';
  return <div className="panel sk-table">
    <div className="sk-table-row sk-table-head" style={{ '--cols': columns.length }}>
      {columns.map((column, i) => <span key={i} className={numeric(column, i) ? 'is-numeric' : undefined}>{column || <span className="sk sk-line" style={{ width: 56 }} />}</span>)}
    </div>
    {query && <QueryEmpty query={query} label={label} />}
    <div aria-hidden="true" className={query ? 'sk-dim' : undefined}>
      {repeat(query ? 3 : rows).map((row) => <div className="sk-table-row" key={row} style={{ '--cols': columns.length }}>
        {columns.map((column, i) => <span key={i} className={numeric(column, i) ? 'is-numeric' : undefined}>
          {column === 'Status' ? <span className="sk sk-pill" /> : <span className="sk sk-line" style={{ width: i === 0 ? '58%' : widths[(row + i) % 8] }} />}
        </span>)}
      </div>)}
    </div>
  </div>;
}

const legend = [['free', 'Free'], ['seated', 'Seated'], ['ordered', 'Ordered'], ['bill', 'Bill requested']];

function FloorSkeleton({ query, label }) {
  const shapes = ['rect', 'round', 'rect', 'wide', 'round', 'rect', 'rect', 'round', 'wide', 'rect', 'round', 'rect'];
  return <div className="panel sk-floor-panel">
    {query && <QueryEmpty query={query} label={label} />}
    <div className="sk-floor" aria-hidden="true">
      {shapes.map((shape, i) => <div className={`sk-table-shape is-${shape}`} key={i}><span>T{i + 1}</span></div>)}
    </div>
    <div className="sk-legend">{legend.map(([key, text]) => <span key={key}><span className={`legend-dot is-${key}`} aria-hidden="true" />{text}</span>)}</div>
  </div>;
}

const settingsSections = ['Account', 'Restaurant', 'Team', 'Notifications', 'Security'];
const settingsForms = [['Account', ['Name', 'Email', 'Password']], ['Restaurant', ['Name', 'Location']]];

function SettingsSkeleton() {
  const { account } = useOutletContext() || {};
  const values = { 'Account:Name': account?.name, 'Account:Email': account?.email, 'Account:Password': '••••••••' };
  return <div className="sk-settings">
    <nav className="settings-subnav" aria-label="Settings sections">
      {settingsSections.map((name, i) => <span key={name} className={`settings-subnav-item${i === 0 ? ' is-active' : ''}`} aria-current={i === 0 ? 'true' : undefined}>{name}</span>)}
    </nav>
    <div className="sk-forms">
      {settingsForms.map(([title, fields]) => <div className="panel sk-form" key={title}>
        <div className="panel-head"><h2 className="panel-title">{title}</h2></div>
        {fields.map((field) => <div className="sk-form-row" key={field}><span className="sk-form-label">{field}</span>
          <span className={`settings-value${values[`${title}:${field}`] ? '' : ' is-empty'}`}>{values[`${title}:${field}`] || 'Not set'}</span></div>)}
      </div>)}
    </div>
  </div>;
}

function MenuSkeleton() {
  return <div className="sk-split">
    <div className="sk-stack-gap">
      {repeat(3).map((i) => <div className="panel sk-menu-card" key={i}>
        <span className="sk sk-thumb" />
        <span className="sk-stack"><span className="sk sk-text" style={{ width: widths[i] }} /><span className="sk sk-line" style={{ width: '40%' }} /></span>
        <span className="sk sk-pill" />
      </div>)}
    </div>
    <div className="panel sk-phone" aria-hidden="true">
      <span className="sk sk-phone-cover" />
      <span className="sk sk-text" style={{ width: '50%' }} />
      <div className="sk-chips">{repeat(3).map((i) => <span key={i} className="sk sk-pill" />)}</div>
      {repeat(3).map((i) => <div className="sk-list-row" key={i}><span className="sk sk-thumb-sm" /><span className="sk-stack"><span className="sk sk-line" style={{ width: widths[i + 2] }} /><span className="sk sk-line" style={{ width: '30%' }} /></span></div>)}
    </div>
  </div>;
}

function SupportSkeleton() {
  return <div className="sk-support">
    {['contact', 'info', 'team'].map((icon) => <div className="panel sk-support-card" key={icon}>
      <span className="sk-support-icon"><Icon name={icon} size={18} /></span>
      <span className="sk sk-text" style={{ width: '60%' }} />
      <span className="sk sk-line" style={{ width: '80%' }} />
      <span className="sk sk-line" style={{ width: '55%' }} />
    </div>)}
  </div>;
}

export function Skeleton({ section, query }) {
  const page = section.path || 'overview';
  switch (section.kind) {
    case 'overview': return <><StatTiles /><div className="sk-grid-2-1"><ChartPanel /><ListPanel /></div></>;
    case 'insights': return <><Toolbar page={page} label={section.label} /><StatTiles count={3} /><div className="sk-grid-1-1"><ChartPanel bars={12} /><ChartPanel bars={8} /></div></>;
    case 'table': return <><Toolbar page={page} query={query} label={section.label} /><TableSkeleton columns={section.columns} query={query} label={section.label} /></>;
    case 'floor': return <><Toolbar page={page} query={query} label={section.label} /><FloorSkeleton query={query} label={section.label} /></>;
    case 'settings': return <SettingsSkeleton />;
    case 'menu': return <MenuSkeleton />;
    case 'support': return <SupportSkeleton />;
    default: return <ListPanel />;
  }
}

export default function PageFrame({ section }) {
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() || '';
  return <>
    <PageHeader title={section.label} description={section.description} />
    <section className="page-body" aria-label={`${section.label} preview`}><Skeleton section={section} query={query} /></section>
  </>;
}
