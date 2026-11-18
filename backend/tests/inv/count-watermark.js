// The count watermark formula on the REAL migration-020 schema (proof for P3-07; the service is P3-08). Ported from the count-snapshot spike
// (docs/inventory-kb/spikes/count-snapshot): snapshot = one insert..select; every entry stores the highest movement id of (location, item) at the moment it
// is entered; variance = counted - (expected_base + sum(delta) of movements with snapshot_movement_id < id <= entry.ledger_watermark);
// posting writes exactly the stored variance as ONE count_correction with key count:<id>:<line>.
import { post } from '../../src/inventory/ledger.js';

/** Creates a session at a location (status open) and takes the snapshot of the given items (all items of the business when none are named). */
export async function startCount(db, { businessId, locationId, number, type = 'full', blind = false, itemIds = null, actorId = null }) {
  const id = (await db.query(`insert into public.stock_counts (business_id, location_id, number, type, blind, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [businessId, locationId, number, type, blind, actorId])).rows[0].id;
  await db.query(`insert into public.stock_count_lines (count_id, business_id, item_id, expected_base, snapshot_movement_id, unit_cost)
    select $1, $2, i.id, coalesce(b.on_hand, 0), coalesce((select max(m.id) from public.stock_movements m where m.location_id = $3 and m.item_id = i.id), 0), i.avg_cost
    from public.stock_items i left join public.stock_balances b on b.item_id = i.id and b.location_id = $3
    where i.business_id = $2 and i.archived_at is null and ($4::uuid[] is null or i.id = any($4::uuid[]))`, [id, businessId, locationId, itemIds]);
  await db.query(`update public.stock_counts set status = 'counting', snapshot_at = now(), started_at = now(),
    snapshot_movement_id = (select coalesce(max(id), 0) from public.stock_movements where business_id = $2) where id = $1`, [id, businessId]);
  return id;
}

export const lineOf = async (db, countId, itemId) => (await db.query('select id from public.stock_count_lines where count_id = $1 and item_id = $2', [countId, itemId])).rows[0].id;

/** A counter enters a number (base units): the entry carries the ledger watermark of that moment. */
export async function enter(db, lineId, qtyBase, { counterId = null, isRecount = false } = {}) {
  return (await db.query(`insert into public.stock_count_entries (line_id, counter_id, qty_base, ledger_watermark, is_recount)
    select l.id, $2, $3, coalesce((select max(m.id) from public.stock_movements m where m.location_id = c.location_id and m.item_id = l.item_id), 0), $4
    from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.id = $1 returning id`, [lineId, counterId, String(qtyBase), isRecount])).rows[0].id;
}

/** { expectedAtSnapshot, movementsSince, expectedAtCount, counted, variance } for one entry, from the ledger as it stands now. */
export async function varianceOf(db, entryId) {
  const r = (await db.query(`select l.expected_base::text as snap, e.qty_base::text as counted,
      coalesce((select sum(m.delta) from public.stock_movements m where m.location_id = c.location_id and m.item_id = l.item_id and m.id > l.snapshot_movement_id and m.id <= e.ledger_watermark), 0)::text as since
    from public.stock_count_entries e join public.stock_count_lines l on l.id = e.line_id join public.stock_counts c on c.id = l.count_id where e.id = $1`, [entryId])).rows[0];
  const since = Number(r.since);
  return { expectedAtSnapshot: Number(r.snap), movementsSince: since, expectedAtCount: Number(r.snap) + since, counted: Number(r.counted), variance: Number(r.counted) - (Number(r.snap) + since) };
}

/** Review: stores the chosen entry's numbers on the line (frozen from here on), then posts exactly that variance. Returns the variance. */
export async function settleAndPost(db, { businessId, locationId, countId, lineId, entryId, actorId = null }) {
  const v = await varianceOf(db, entryId);
  await db.query(`update public.stock_counts set status = 'under_review', finished_at = now() where id = $1`, [countId]);
  await db.query(`update public.stock_count_lines set status = 'settled', decision = 'accepted', chosen_entry_id = $2, final_counted_base = $3, movements_since_base = $4, variance_base = $5 where id = $1`,
    [lineId, entryId, v.counted, v.movementsSince, v.variance]);
  await db.query(`update public.stock_counts set status = 'approved', approved_at = now() where id = $1`, [countId]);
  const itemId = (await db.query('select item_id from public.stock_count_lines where id = $1', [lineId])).rows[0].item_id;
  if (v.variance !== 0) {
    const out = await post(db, { businessId, locationId, itemId, qty: String(v.variance), reason: 'count_correction', ref: { type: 'count', id: countId }, actorId, idempotencyKey: `count:${countId}:${lineId}` });
    await db.query('update public.stock_count_lines set movement_id = $2 where id = $1', [lineId, out.movement.id]);
  }
  await db.query(`update public.stock_counts set status = 'posted', posted_at = now() where id = $1`, [countId]);
  return v.variance;
}
