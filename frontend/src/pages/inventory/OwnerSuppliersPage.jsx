// Owner Suppliers (/owner/inventory/suppliers): who you buy from. Search, filter by kind of supplier, and "needs details" for
// suppliers a branch added on the spot. One main action: Add supplier. A supplier opens in the side sheet (SupplierSheet), where you
// see what they supply and what they charge, add prices and keep the details right.
// /owner/inventory/suppliers?supplier=<id> opens that supplier; ?add=1 opens the empty form.
import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/api';
import { SUPPLIER_TYPE_LABEL, formatNumber, showPhone, termsText } from '../../lib/inventory';
import { EmptyState, ErrorState, OIcon, OwnerFrame, Panel, SkeletonRows } from './parts';
import SupplierSheet from './SupplierSheet';
import './purchasing.css';

const TYPE_FILTERS = [['', 'All'], ['formal', 'Formal'], ['informal', 'Informal'], ['one_off', 'One-off']];

function SuppliersBody({ ctx, task, setTask }) {
  const ids = useId();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const list = useApi(ctx.paths.suppliers(), { ttl: 15000 });
  const suppliers = list.data?.suppliers;

  const term = search.trim().toLowerCase();
  const rows = useMemo(() => (suppliers || []).filter((s) => (!type || s.type === type) && (!incompleteOnly || s.incomplete)
    && (!term || `${s.name} ${s.contactName || ''} ${s.phone || ''}`.toLowerCase().includes(term))), [suppliers, type, incompleteOnly, term]);
  const incomplete = (suppliers || []).filter((s) => s.incomplete).length;
  const wanted = params.get('supplier');
  const open = task || (wanted ? { id: wanted } : params.get('add') ? { id: null } : null);
  const close = () => { setTask(null); if (params.get('supplier') || params.get('add')) setParams({}, { replace: true }); };
  const clear = () => { setSearch(''); setType(''); setIncompleteOnly(false); };

  return <>
    {incomplete > 0 && !incompleteOnly && <section className="inv-attention" aria-label="Needs attention">
      <div className="inv-attention-card"><span><strong>{incomplete} {incomplete === 1 ? 'supplier needs' : 'suppliers need'} details</strong>Added on the spot by a branch.</span>
        <button type="button" className="o-btn is-small" onClick={() => setIncompleteOnly(true)}>Show</button></div>
    </section>}
    <Panel title="Suppliers" count={suppliers ? rows.length : undefined} sub="Select a supplier to see what they sell, what they charge and to add a price.">
      {list.error && !suppliers ? <ErrorState error={list.error} onRetry={list.refresh} what="suppliers" />
        : !suppliers ? <SkeletonRows rows={5} thumb={false} label="Loading suppliers" />
          : !suppliers.length ? <EmptyState icon="store" tone="neutral" title="No suppliers yet" >
            {ctx.can.purchaseCreate ? 'Press Add supplier at the top to add the people you buy from, then the prices they charge. After that you can order from them in a few taps.' : 'Suppliers are added by the business owner.'}</EmptyState>
            : <>
              <div className="inv-toolbar">
                <label className="visually-hidden" htmlFor={`${ids}-q`}>Search suppliers</label>
                <input id={`${ids}-q`} className="o-input inv-search" type="search" placeholder="Search by name, contact or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
                <label className="visually-hidden" htmlFor={`${ids}-type`}>Kind of supplier</label>
                <select id={`${ids}-type`} className="o-select" value={type} onChange={(event) => setType(event.target.value)}>
                  {TYPE_FILTERS.map(([value, label]) => <option key={value} value={value}>{value ? label : 'All kinds'}</option>)}
                </select>
                <label className="inv-check"><input type="checkbox" checked={incompleteOnly} onChange={(event) => setIncompleteOnly(event.target.checked)} />Needs details{incomplete ? ` (${incomplete})` : ''}</label>
              </div>
              {!rows.length ? <EmptyState icon="search" tone="neutral" title="No suppliers match" action={<button type="button" className="o-btn is-secondary" onClick={clear}>Clear filters</button>}>
                Try a different search or kind of supplier.</EmptyState>
                : <div className="inv-table-wrap"><table className="inv-table inv-cards">
                  <thead><tr><th scope="col">Supplier</th><th scope="col">Kind</th><th scope="col">Pays</th><th scope="col" className="is-num">Items</th><th scope="col">Status</th></tr></thead>
                  <tbody>{rows.map((s) => <tr key={s.id}>
                    <th scope="row"><button type="button" className="inv-link" onClick={() => setTask({ id: s.id, listed: s })}>{s.name}</button>
                      <small>{[s.contactName, s.phone ? showPhone(s.phone) : null].filter(Boolean).join(' · ') || 'No phone yet'}</small></th>
                    <td data-label="Kind">{SUPPLIER_TYPE_LABEL[s.type] || s.type}</td>
                    <td data-label="Pays">{termsText(s.paymentTermsDays)}</td>
                    <td className="is-num" data-label="Items">{formatNumber(s.itemCount)}</td>
                    <td data-label="Status">{s.incomplete ? <span className="inv-badge is-low">Needs details</span> : s.status !== 'active' ? <span className="inv-badge is-off">Deactivated</span> : <span className="inv-badge is-ok">Active</span>}</td>
                  </tr>)}</tbody>
                </table></div>}
            </>}
    </Panel>
    {open && <SupplierSheet key={open.id || 'new'} ctx={ctx} supplierId={open.id} listed={open.listed} onClose={close} onChanged={list.refresh}
      onOpen={(id) => setTask({ id })} />}
  </>;
}

export default function OwnerSuppliersPage() {
  const [task, setTask] = useState(null);
  return <OwnerFrame title="Suppliers" description="Who you buy from, what they sell and what they charge."
    actions={(ctx) => ctx.can.purchaseCreate && <button type="button" className="o-btn is-primary" onClick={() => setTask({ id: null })}><OIcon name="plus" size={15} />Add supplier</button>}>
    {(ctx) => <SuppliersBody ctx={ctx} task={task} setTask={setTask} />}
  </OwnerFrame>;
}
