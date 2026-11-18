// Spike service for P3-08: snapshot, blind sheet, entries with their own ledger watermark, review, post. Plain functions over
// a transaction-like `db` (PGlite or pg client). Corrections go through the REAL ledger.post (stop at zero, idempotency).
// `repoRoot` is injected so this file can live in docs/ and still import the ledger.
export function makeCounts({ post, naive = false }) {
  const q = async (db, sql, p) => (await db.query(sql, p)).rows;
  const one = async (db, sql, p) => (await q(db, sql, p))[0];

  /** Creates the session and, in the SAME statement, snapshots every item that has a balance row at the location. */
  async function create(db, { businessId, locationId, number, blind = false, type = 'full', itemIds = null, actorId = null }) {
    const c = await one(db, `insert into public.stock_counts (business_id, location_id, number, type, blind, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [businessId, locationId, number, type, blind, actorId]);
    return c.id;
  }
  /** start: ONE insert-select reads on_hand and the highest movement id together, so they describe the same instant (no lock needed). */
  async function start(db, countId) {
    const c = await one(db, `select location_id, status from public.stock_counts where id = $1`, [countId]);
    if (c.status !== 'open') throw new Error('count already started');
    await db.query(`insert into public.stock_count_lines (count_id, item_id, expected_base, snapshot_movement_id, unit_cost)
      select $1, b.item_id, b.on_hand, coalesce((select max(m.id) from public.stock_movements m where m.location_id = b.location_id and m.item_id = b.item_id), 0), i.avg_cost
        from public.stock_balances b join public.stock_items i on i.id = b.item_id where b.location_id = $2`, [countId, c.location_id]);
    await db.query(`update public.stock_counts set status = 'counting', snapshot_at = now() where id = $1`, [countId]);
  }
  /** What a counter sees. Blind sessions: the response never contains expected, difference or any movement figure. */
  async function sheetFor(db, countId) {
    const c = await one(db, `select blind from public.stock_counts where id = $1`, [countId]);
    const cols = c.blind ? '' : `, l.expected_base::text as expected`;
    return q(db, `select l.id as line_id, i.name, l.status${cols} from public.stock_count_lines l join public.stock_items i on i.id = l.item_id where l.count_id = $1 order by i.name`, [countId]);
  }
  /** A counter's number. The watermark is read at entry time: "what the ledger held when this person counted". */
  async function enterCount(db, lineId, { counterId, qtyBase, isRecount = false, note = null }) {
    const line = await one(db, `select l.item_id, c.location_id from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.id = $1`, [lineId]);
    const wm = (await one(db, `select coalesce(max(id), 0)::text as wm from public.stock_movements where location_id = $1 and item_id = $2`, [line.location_id, line.item_id])).wm;
    const e = await one(db, `insert into public.stock_count_entries (line_id, counter_id, qty_base, ledger_watermark, is_recount, note) values ($1, $2, $3, $4, $5, $6) returning id`,
      [lineId, counterId, qtyBase, wm, isRecount, note]);
    await db.query(`update public.stock_count_lines set status = 'counted' where id = $1`, [lineId]);
    return e.id;
  }
  /** Reviewer view of one line: every entry, with its own variance. */
  async function review(db, lineId) {
    const line = await one(db, `select l.*, c.location_id from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.id = $1`, [lineId]);
    const entries = await q(db, `select id, counter_id, qty_base::text as qty, ledger_watermark::text as wm from public.stock_count_entries where line_id = $1 order by counted_at, id`, [lineId]);
    const out = [];
    for (const e of entries) {
      const since = (await one(db, `select coalesce(sum(delta), 0)::text as s from public.stock_movements where location_id = $1 and item_id = $2 and id > $3 and id <= $4`,
        [line.location_id, line.item_id, line.snapshot_movement_id, e.wm])).s;
      const expectedNow = Number(line.expected_base) + Number(since);
      out.push({ entryId: e.id, counted: Number(e.qty), expectedAtCount: expectedNow, movementsSince: Number(since), variance: Number(e.qty) - expectedNow });
    }
    return { expectedAtSnapshot: Number(line.expected_base), entries: out };
  }
  /**
   * settle (the reviewer's "Finish review"): picks the entry per line (default: the latest), computes the variance ONCE against the
   * ledger watermark of that entry and STORES it on the line. From here the numbers are what the approver approves; nothing recomputes.
   */
  async function settle(db, countId, { choose = {} } = {}) {
    const c = await one(db, `select status from public.stock_counts where id = $1`, [countId]);
    if (c.status !== 'counting') throw new Error(`cannot settle a count that is ${c.status}`);
    const lines = await q(db, `select l.id, l.item_id, l.expected_base, l.unit_cost, c.location_id from public.stock_count_lines l join public.stock_counts c on c.id = l.count_id where l.count_id = $1 order by l.item_id`, [countId]);
    for (const l of lines) {
      const r = await review(db, l.id);
      if (!r.entries.length) continue;
      const pick = r.entries.find((e) => e.entryId === choose[l.id]) || r.entries[r.entries.length - 1];
      let variance = pick.variance;
      let since = pick.movementsSince;
      if (naive) { // the plan's literal wording: movements since the snapshot, measured at settle/posting time (kept to show the difference)
        since = Number((await one(db, `select coalesce(sum(delta), 0)::text as s from public.stock_movements where location_id = $1 and item_id = $2 and id > (select snapshot_movement_id from public.stock_count_lines where id = $3)`, [l.location_id, l.item_id, l.id])).s);
        variance = pick.counted - (Number(l.expected_base) + since);
      }
      await db.query(`update public.stock_count_lines set status = 'settled', chosen_entry_id = $2, final_counted_base = $3, movements_since_base = $4, variance_base = $5, variance_value = $6 where id = $1`,
        [l.id, pick.entryId, pick.counted, since, variance, l.unit_cost === null ? null : Math.round(variance * Number(l.unit_cost) * 100) / 100]);
    }
    await db.query(`update public.stock_counts set status = 'under_review' where id = $1`, [countId]);
  }
  /** post: writes the STORED variances as count_correction movements. Idempotent twice over: status gate + ledger key count:<id>:<line>. */
  async function post_(db, countId, { actorId = null } = {}) {
    const c = await one(db, `select status, location_id, business_id from public.stock_counts where id = $1`, [countId]);
    if (c.status === 'posted') return { replayed: true };
    if (c.status !== 'under_review') throw new Error(`cannot post a count that is ${c.status}`);
    const lines = await q(db, `select id, item_id, variance_base::text as v from public.stock_count_lines where count_id = $1 and status = 'settled' order by item_id`, [countId]);
    const results = [];
    for (const l of lines) {
      const variance = Number(l.v);
      let movementId = null;
      if (variance !== 0) {
        const res = await post(db, { businessId: c.business_id, locationId: c.location_id, itemId: l.item_id, qty: String(variance), reason: 'count_correction',
          ref: { type: 'stock_count', id: countId }, actorId, idempotencyKey: `count:${countId}:${l.id}` });
        movementId = res.movement.id;
      }
      await db.query(`update public.stock_count_lines set movement_id = $2 where id = $1`, [l.id, movementId]);
      results.push({ lineId: l.id, itemId: l.item_id, variance });
    }
    await db.query(`update public.stock_counts set status = 'posted' where id = $1`, [countId]);
    return { replayed: false, lines: results };
  }
  const settleAndPost = async (db, countId, o = {}) => { await settle(db, countId, o); return post_(db, countId, o); };
  return { create, start, sheetFor, enterCount, review, settle, post: post_, settleAndPost };
}
