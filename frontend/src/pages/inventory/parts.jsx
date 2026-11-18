// Shared pieces of the new inventory screens (owner today; branch screens in P1-15 can import the same ones).
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import Drawer from '../../components/owner/Drawer';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import '../../components/owner/overview.css';
import '../business/business.css';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ownerPaths } from '../../lib/inventory';
import './inventory.css';

export { EmptyState, ErrorState, OIcon, Panel, SkeletonRows, PageHeader };

/** A short task (add an item, set opening stock, import…) in the side sheet: one job, an obvious way out. */
export function TaskDrawer({ open, title, onClose, children, wide = false }) {
  return <Drawer open={open} onClose={onClose} title={title} className="st-drawer inv-drawer" wide={wide}>{open ? children : null}</Drawer>;
}

/** A write's error in plain words (accepts an `explain()` object, an Error or a string). */
export function FormError({ error }) {
  const message = typeof error === 'string' ? error : error?.message;
  return message ? <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{message}</p> : null;
}

/** Text → file download, entirely in the browser. */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n');

/** Low / Out / In stock chip. */
export function StockBadge({ state }) {
  if (!state || state === 'ok') return null;
  return <span className={`inv-badge is-${state}`}>{state === 'out' ? 'Out' : 'Low'}</span>;
}

/** Where a stock level stands at one location: 'out' | 'low' | 'ok'. */
export const levelState = (entry) => (!entry?.low ? 'ok' : Number(entry.onHand) <= 0 ? 'out' : 'low');

/** The three steps of getting started, shown when there is nothing yet. */
export function StartGuide() {
  return <ol className="inv-guide" aria-label="How to get started">
    <li><strong>Add your items</strong> <span>Everything you buy or make: chicken, flour, oil, buns.</span></li>
    <li><strong>Set opening stock</strong> <span>Say how much you have now, in the warehouse and at each branch.</span></li>
    <li><strong>Add recipes</strong> <span>Tell Cravio what goes into each dish, so stock goes down as you serve and you see what a dish costs.</span></li>
  </ol>;
}

const CHOICE_KEY = 'cravio-inventory-business';
const readChoice = () => { try { return sessionStorage.getItem(CHOICE_KEY); } catch { return null; } };

/**
 * The frame every owner inventory page shares: header, business picker (only when the account has several),
 * the overview (one cached request for every page), and the three states: loading, switched off, error.
 * `children(ctx)` renders when inventory is on. ctx = { business, data, can, paths, refresh, businesses }.
 * `actions(ctx)` renders the page's main action(s) in the header.
 */
export function OwnerFrame({ title, description, actions, children }) {
  const { account } = useAuth();
  const businesses = account?.businesses || [];
  const [chosen, setChosen] = useState(readChoice);
  const business = businesses.find((b) => b.id === chosen) || businesses[0];
  const paths = ownerPaths(business?.id);
  const { data, error, loading, refresh } = useApi(business ? paths.overview() : null, { ttl: 15000 });
  const pickerId = useId();
  const ctx = business && data?.enabled ? { business, businesses, data, can: data.capabilities || {}, paths, refresh } : null;
  const pick = (id) => { setChosen(id); try { sessionStorage.setItem(CHOICE_KEY, id); } catch { /* storage blocked */ } };

  return <div className="biz-stack">
    <PageHeader title={title} description={description}>
      {businesses.length > 1 && <>
        <label className="visually-hidden" htmlFor={pickerId}>Business</label>
        <select id={pickerId} className="o-select" value={business?.id} onChange={(event) => pick(event.target.value)}>
          {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </>}
      {ctx && actions?.(ctx)}
    </PageHeader>
    {!business ? <EmptyState icon="store" tone="neutral" title="No business access yet" />
      : error && !data ? <ErrorState error={error} onRetry={refresh} what="inventory" />
        : loading && !data ? <Panel title="Loading"><SkeletonRows rows={6} thumb={false} label="Loading inventory" /></Panel>
          : !data?.enabled ? <OffPanel />
            : children(ctx)}
  </div>;
}

/** Shown to owners whose business doesn't have inventory yet. */
export function OffPanel() {
  return <EmptyState icon="info" tone="neutral" title="Inventory isn’t switched on for this business yet.">
    Contact Cravio to switch it on.
  </EmptyState>;
}

/** "Add items" empty state with the one clear action. */
export function NoItems({ can }) {
  return <>
    <EmptyState icon="layers" tone="neutral" title="No items yet"
      action={can.itemEdit ? <Link className="o-btn is-primary" to="/owner/inventory/items?add=1"><OIcon name="plus" size={15} />Add your first item</Link> : null}>
      {can.itemEdit ? 'Start with a few things you buy or make. You can import a whole list from a spreadsheet later.' : 'Items are added by the business owner.'}
    </EmptyState>
    <StartGuide />
  </>;
}

/** A number input with its unit next to it, so no quantity is ever unitless. `unit`: text, or `choices` for a dropdown. */
export function QuantityInput({ id, label, value, onChange, unit, choices, onUnit, placeholder }) {
  return <div className="inv-row">
    <label className="visually-hidden" htmlFor={id}>{label}</label>
    <input id={id} className="o-input inv-qty" type="number" inputMode="decimal" min="0" step="any" placeholder={placeholder}
      value={value} onChange={(event) => onChange(event.target.value)} />
    {choices?.length > 1 ? <>
      <label className="visually-hidden" htmlFor={`${id}-unit`}>Unit for {label}</label>
      <select id={`${id}-unit`} className="o-select inv-unit" value={unit} onChange={(event) => onUnit(event.target.value)}>
        {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
    </> : unit ? <span className="inv-unit-text">{choices?.[0]?.label || unit}</span> : null}
  </div>;
}
