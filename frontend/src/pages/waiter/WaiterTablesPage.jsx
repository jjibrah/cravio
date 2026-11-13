import { useMemo, useState } from 'react';
import TableTile from '../../components/tables/TableTile';
import TableSheet from '../../components/waiter/TableSheet';
import { LiveNote, PageHeader } from '../../components/waiter/WaiterBits';
import { useLive } from '../../components/waiter/LiveProvider';
import Glyph from '../../components/media/Glyph';

const stateLabel = (table) => {
  if (table.state === 'bill') return table.requestTypes?.includes('bill') ? 'Wants the bill' : 'Wants to pay';
  return undefined;
};
const metaFor = (table) => {
  const parts = [];
  if (table.readyToOrder) parts.push('Ready to order');
  if (table.openOrders) parts.push(`${table.openOrders} order${table.openOrders === 1 ? '' : 's'}`);
  if (table.requestTypes?.length > 1) parts.push(`${table.requestTypes.length} requests`);
  return parts.join(' · ') || undefined;
};

/** Every table at a glance (3 per row on phones); tap one for its requests, orders and "New order". */
export default function WaiterTablesPage({ section }) {
  const { live, loading } = useLive();
  const [openNumber, setOpenNumber] = useState(null);
  const tables = live?.tables;

  const groups = useMemo(() => {
    if (!tables) return [];
    const map = new Map();
    for (const table of [...tables].sort((a, b) => a.number - b.number)) {
      const key = table.section?.name || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(table);
    }
    return [...map.entries()].map(([name, list]) => ({ name, list }));
  }, [tables]);

  const summary = live?.summary?.tables;
  const needing = summary ? summary.attention + summary.bill : 0;
  const line = !summary ? section.description
    : needing ? `${needing} table${needing === 1 ? ' needs' : 's need'} you · ${summary.free} free`
      : `${summary.ordering} ordering · ${summary.free} free`;

  return <>
    <PageHeader title={section.label} subtitle={line} />
    <LiveNote />
    {loading && !tables && <div className="w-tile-grid" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} className="w-tile-skeleton" />)}</div>}
    {tables && tables.length === 0 && <div className="w-empty"><Glyph name="utensils" size={28} /><h2>No tables yet</h2><p>Your manager adds tables in Cravio. They show up here straight away.</p></div>}
    {groups.map((group) => <section key={group.name || 'all'} className="w-tile-section" aria-label={group.name || 'Tables'}>
      {groups.length > 1 && <h2 className="w-subhead">{group.name || 'Other tables'}</h2>}
      <div className="w-tile-grid">
        {group.list.map((table) => <TableTile key={table.id} number={table.number} state={table.state} label={stateLabel(table)} meta={metaFor(table)} onClick={() => setOpenNumber(table.number)} />)}
      </div>
    </section>)}
    <TableSheet number={openNumber} onClose={() => setOpenNumber(null)} />
  </>;
}
