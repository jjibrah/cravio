// The owner's daily briefing: plain-language facts computed from recorded orders, guest requests and stock,
// across the branches the caller oversees. Deterministic (no AI model): every sentence comes from a query below.
// When an AI provider is connected later it should receive these facts, not raw tables, and respect the same scope.
import { oversight } from './business.js';

const TZ = 'Africa/Nairobi';
const kes = (value) => `Ksh ${Math.round(Number(value) || 0).toLocaleString('en-KE')}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function hasStock(db) {
  const { rows } = await db.query(`select to_regclass('public.stock_items') is not null as ok`);
  return rows[0].ok;
}

/** Per-branch facts for today (Nairobi) and the same weekday last week up to the same time. */
async function branchFacts(db, ids) {
  const { rows } = await db.query(`
    with bounds as (
      select date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}' as today,
             now() - interval '7 days' as week_now,
             date_trunc('day', (now() - interval '7 days') at time zone '${TZ}') at time zone '${TZ}' as week_start)
    select r.id,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status <> 'cancelled' and o.created_at >= b.today)::int as orders,
      (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = r.id and o.status = 'paid' and o.paid_at >= b.today)::float as paid,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status = 'cancelled' and o.created_at >= b.today)::int as cancelled,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status <> 'cancelled' and o.created_at >= b.week_start and o.created_at < b.week_now)::int as orders_last_week,
      (select coalesce(sum(o.total), 0) from public.orders o where o.restaurant_id = r.id and o.status = 'paid' and o.paid_at >= b.week_start and o.paid_at < b.week_now)::float as paid_last_week,
      (select count(*) from public.orders o where o.restaurant_id = r.id and o.status in ('taken', 'accepted', 'served'))::int as open_orders,
      (select count(*) from public.service_requests s where s.restaurant_id = r.id and s.status in ('open', 'acknowledged'))::int as open_requests,
      (select extract(epoch from now() - min(s.created_at))::int from public.service_requests s where s.restaurant_id = r.id and s.status = 'open') as oldest_request_seconds
    from public.restaurants r, bounds b where r.id = any($1::uuid[])`, [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

async function bestSellers(db, ids) {
  const { rows } = await db.query(`
    select oi.name, sum(oi.quantity)::int as quantity from public.order_items oi join public.orders o on o.id = oi.order_id
    where o.restaurant_id = any($1::uuid[]) and o.status <> 'cancelled'
      and o.created_at >= date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}'
    group by oi.name order by quantity desc, oi.name limit 5`, [ids]);
  return rows;
}

async function stockFacts(db, ids, businessIds) {
  const [levels, requests, transit, short] = await Promise.all([
    db.query(`select l.restaurant_id, i.name, b.on_hand::float as on_hand, i.low_level::float as low_level
      from public.stock_balances b join public.stock_locations l on l.id = b.location_id join public.stock_items i on i.id = b.item_id
      where l.restaurant_id = any($1::uuid[]) and (b.on_hand <= 0 or (i.low_level is not null and b.on_hand <= i.low_level))
      order by b.on_hand`, [ids]),
    db.query(`select restaurant_id, count(*)::int as n from public.stock_requests where restaurant_id = any($1::uuid[]) and status = 'submitted' group by restaurant_id`, [ids]),
    db.query(`select l.restaurant_id, count(*)::int as n from public.stock_transfers t join public.stock_locations l on l.id = t.to_location
      where l.restaurant_id = any($1::uuid[]) and t.status = 'in_transit' group by l.restaurant_id`, [ids]),
    db.query(`select l.restaurant_id, t.number from public.stock_transfers t join public.stock_locations l on l.id = t.to_location
      where t.business_id = any($2::uuid[]) and l.restaurant_id = any($1::uuid[]) and t.status = 'received' and t.received_at > now() - interval '7 days'
        and exists (select 1 from public.stock_transfer_lines x where x.transfer_id = t.id and x.received < x.quantity)`, [ids, businessIds]),
  ]);
  return { levels: levels.rows, requests: requests.rows, transit: transit.rows, short: short.rows };
}

function trend(now, before, money = false) {
  if (!before && !now) return 'quiet so far, as it was this time last week';
  if (!before) return 'nothing at this time last week';
  const diff = now - before;
  const pct = Math.round((diff / before) * 100);
  if (Math.abs(pct) < 5) return 'about the same as this time last week';
  return `${diff > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on this time last week (${money ? kes(before) : before})`;
}

/**
 * { generatedAt, name, headline, points[], attention[], answers{}, scope } for the caller's overseen branches.
 * attention items carry a link the UI turns into an action.
 */
export async function briefing(db, actor) {
  const branches = await oversight(db, actor.id);
  const ids = branches.map((b) => b.id);
  const generatedAt = new Date().toISOString();
  if (!ids.length) return { generatedAt, empty: true, headline: 'You don’t oversee any branches yet.', points: [], attention: [], answers: {} };
  const businessIds = [...new Set(branches.map((b) => b.business_id))];
  const [facts, best, stock] = await Promise.all([branchFacts(db, ids), bestSellers(db, ids), (await hasStock(db)) ? stockFacts(db, ids, businessIds) : null]);
  const name = (id) => branches.find((b) => b.id === id)?.name || 'A branch';
  const total = branches.reduce((sum, b) => {
    const f = facts.get(b.id);
    return { orders: sum.orders + f.orders, paid: sum.paid + f.paid, lastOrders: sum.lastOrders + f.orders_last_week, lastPaid: sum.lastPaid + f.paid_last_week,
      cancelled: sum.cancelled + f.cancelled, open: sum.open + f.open_orders, requests: sum.requests + f.open_requests };
  }, { orders: 0, paid: 0, lastOrders: 0, lastPaid: 0, cancelled: 0, open: 0, requests: 0 });

  const scope = branches.length === 1 ? branches[0].name : `your ${branches.length} branches`;
  const headline = total.orders
    ? `${scope} ${branches.length === 1 ? 'has' : 'have'} taken ${plural(total.orders, 'order')} today, with ${kes(total.paid)} marked paid.`
    : `No orders yet today at ${scope}.`;

  const points = [];
  points.push(`Orders are ${trend(total.orders, total.lastOrders)}. Paid sales are ${trend(total.paid, total.lastPaid, true)}.`);
  if (best.length) points.push(`Selling best today: ${best.slice(0, 3).map((row) => `${row.name} (${row.quantity})`).join(', ')}.`);
  if (total.open) points.push(`${plural(total.open, 'order')} still in progress.`);
  if (total.cancelled) points.push(`${plural(total.cancelled, 'order')} cancelled today.`);
  if (branches.length > 1 && total.orders) {
    const ranked = [...branches].sort((a, b) => facts.get(b.id).paid - facts.get(a.id).paid);
    points.push(`${ranked[0].name} leads on paid sales (${kes(facts.get(ranked[0].id).paid)}).`);
  }

  const attention = [];
  for (const b of branches) {
    const f = facts.get(b.id);
    if (f.open_requests) {
      const wait = f.oldest_request_seconds ? ` · oldest ${Math.max(1, Math.round(f.oldest_request_seconds / 60))} min` : '';
      attention.push({ kind: 'guests', tone: f.oldest_request_seconds > 600 ? 'urgent' : 'info', text: `${plural(f.open_requests, 'guest request')} open at ${b.name}${wait}`, branchId: b.id, link: `/owner/branches/${b.id}` });
    }
  }
  if (stock) {
    for (const row of stock.requests) attention.push({ kind: 'request', tone: 'action', text: `${plural(row.n, 'stock request')} from ${name(row.restaurant_id)} to review`, branchId: row.restaurant_id, link: '/owner/inventory?view=requests' });
    for (const row of stock.transit) attention.push({ kind: 'transit', tone: 'info', text: `${plural(row.n, 'delivery', 'deliveries')} on the way to ${name(row.restaurant_id)}`, branchId: row.restaurant_id, link: '/owner/inventory?view=dispatches' });
    for (const row of stock.short) attention.push({ kind: 'short', tone: 'urgent', text: `Dispatch #${row.number} arrived short at ${name(row.restaurant_id)}`, branchId: row.restaurant_id, link: '/owner/inventory?view=dispatches' });
    const out = stock.levels.filter((row) => row.on_hand <= 0);
    const low = stock.levels.filter((row) => row.on_hand > 0);
    if (out.length) attention.push({ kind: 'stock', tone: 'urgent', text: `Out: ${out.slice(0, 4).map((row) => `${row.name} at ${name(row.restaurant_id)}`).join(', ')}${out.length > 4 ? ` and ${out.length - 4} more` : ''}`, link: '/owner/inventory' });
    if (low.length) attention.push({ kind: 'stock', tone: 'action', text: `Running low: ${low.slice(0, 4).map((row) => `${row.name} at ${name(row.restaurant_id)} (${row.on_hand})`).join(', ')}`, link: '/owner/inventory' });
  }
  const rank = { urgent: 0, action: 1, info: 2 };
  attention.sort((a, b) => rank[a.tone] - rank[b.tone]);

  const perBranch = branches.map((b) => { const f = facts.get(b.id); return `${b.name}: ${plural(f.orders, 'order')}, ${kes(f.paid)} paid`; }).join('; ');
  const answers = {
    sales: `${headline} ${points[0]}${branches.length > 1 ? ` By branch — ${perBranch}.` : ''}`,
    best: best.length ? `Today’s best sellers by quantity: ${best.map((row, i) => `${i + 1}. ${row.name} (${row.quantity})`).join(', ')}.` : 'Nothing has sold yet today.',
    attention: attention.length ? `Needs you now: ${attention.slice(0, 5).map((a) => a.text).join('; ')}.` : 'Nothing needs your attention right now.',
    stock: !stock ? 'Inventory isn’t switched on yet, so I can’t see stock levels.'
      : stock.levels.length ? `Out or low: ${stock.levels.slice(0, 8).map((row) => `${row.name} at ${name(row.restaurant_id)} (${row.on_hand} servings)`).join(', ')}.`
        : 'No tracked item is out or below its low-stock level.',
    requests: !stock ? 'Inventory isn’t switched on yet, so there are no stock requests.'
      : stock.requests.length || stock.transit.length
        ? [stock.requests.length && `${stock.requests.map((r) => `${name(r.restaurant_id)} has ${plural(r.n, 'request')} waiting for your review`).join('; ')}`,
          stock.transit.length && `${stock.transit.map((r) => `${plural(r.n, 'delivery', 'deliveries')} on the way to ${name(r.restaurant_id)}`).join('; ')}`].filter(Boolean).join('. ') + '.'
        : 'No stock requests are waiting and nothing is in transit.',
  };
  return { generatedAt, timeZone: TZ, headline, points, attention, answers, branches: branches.length, scope };
}
