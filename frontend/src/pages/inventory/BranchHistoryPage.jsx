// Branch History (/branch/:id/inventory/history): every stock change at this branch, newest first, optionally for one item.
// 60 rows at a time; "Load more" asks for the page before the last one (nextBefore).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi } from '../../lib/api';
import { branchPaths, formatStamp } from '../../lib/inventory';
import { EmptyState, ErrorState, FormError, PageHeader, Panel, SkeletonRows } from './parts';
import './branch.css';

const PAGE = 60;

function Rows({ itemId }) {
  const [state, setState] = useState({ rows: null, next: null, error: null, more: false });
  const token = useRef(0);
  const load = useCallback(async (before) => {
    const mine = ++token.current;
    setState((current) => (before ? { ...current, more: true, error: null } : { rows: null, next: null, error: null, more: false }));
    try {
      const page = await api(branchPaths.history({ itemId, limit: PAGE, before }), { cache: before ? undefined : 'swr', ttl: 5000, force: !before });
      if (mine !== token.current) return;
      setState((current) => ({ rows: before ? [...(current.rows || []), ...page.movements] : page.movements, next: page.nextBefore, error: null, more: false }));
    } catch (error) {
      if (mine === token.current) setState((current) => ({ ...current, error, more: false }));
    }
  }, [itemId]);
  useEffect(() => { load(null); }, [load]);

  const { rows, next, error, more } = state;
  if (error && !rows) return <ErrorState error={error} onRetry={() => load(null)} what="history" />;
  if (!rows) return <SkeletonRows rows={6} thumb={false} label="Loading history" />;
  if (!rows.length) return <EmptyState icon="clock" tone="neutral" title="No stock changes yet">Count or add stock on the Stock page, and every change shows here.</EmptyState>;
  return <>
    <div className="inv-table-wrap"><table className="inv-table inv-history-table">
      <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Item</th><th scope="col" className="is-num">Change</th><th scope="col">Who</th><th scope="col">Note</th></tr></thead>
      <tbody>{rows.map((m) => <tr key={m.id}>
        <td>{formatStamp(m.occurredAt)}</td>
        <td>{m.reasonLabel}{m.order && <small><Link className="inv-link" to={m.order.link}>Order #{m.order.shortId}</Link></small>}</td>
        <th scope="row">{m.itemName}{m.entered && <small>Entered as {m.entered.quantity} {m.entered.unit}</small>}</th>
        <td className={`is-num${m.display.delta.startsWith('-') ? ' is-minus' : ''}`}>{m.display.delta}<small>{m.display.balanceAfter} left</small></td>
        <td>{m.by?.name || <span className="is-muted">System</span>}</td>
        <td>{m.note || <span className="is-muted">–</span>}</td>
      </tr>)}</tbody>
    </table></div>
    <FormError error={error} />
    {next && <div className="inv-more"><button type="button" className="o-btn" onClick={() => load(next)} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}
  </>;
}

export default function BranchHistoryPage({ section }) {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const itemId = params.get('item') || '';
  const items = useApi(branchPaths.snapshot({ all: true }), { ttl: 15000 });
  const choose = (value) => setParams(value ? { item: value } : {}, { replace: true });
  return <div className="biz-stack">
    <PageHeader title={section?.label || 'History'} description={section?.description || 'Every stock change at this branch, newest first.'} />
    <Panel title="Stock changes" sub="Newest first. Times are East Africa Time.">
      <div className="inv-toolbar">
        <label className="visually-hidden" htmlFor={id}>Item</label>
        <select id={id} className="o-select inv-search" value={itemId} onChange={(event) => choose(event.target.value)}>
          <option value="">All items</option>
          {(items.data?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <Rows key={itemId} itemId={itemId} />
    </Panel>
  </div>;
}
