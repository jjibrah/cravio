# Spike: count snapshot maths (18 Nov 2026) — de-risks P3-07 / P3-08

Run it: `node docs/inventory-kb/spikes/count-snapshot/spike_test.mjs` (PGlite, 009 + proposed 012…017 + `spike_020.sql`; **328/328 checks pass**; output in `output.txt`). Corrections go through the **real** `ledger.post`.

| File | What it is |
| --- | --- |
| `spike_020.sql` | Count tables (`stock_counts`, `stock_count_lines`, `stock_count_entries`) with the snapshot freeze trigger, an append-only entries trigger and the one-open-full-count index |
| `counts_spike.js` | Service sketch: `create`, `start` (snapshot), `sheetFor` (blind), `enterCount`, `review`, `settle`, `post`; a `naive` switch reproduces the plan's literal wording so the two can be compared |
| `spike_test.mjs` | Scenarios C1–C10 |
| `output.txt` | Output of the last run |

## Verdict

**The plan's example works** (snapshot 100, 20 sold during the count, counter counts 70 → variance −10, correction −10, not −30), **but the plan's wording of the formula has a flaw that the spike found and fixed** (next section). With the fix, 150 random sessions match a physical-stock model exactly.

## The finding: measure movements up to the moment the counter counted, not up to posting

Plan (D3-5 / P3-08): variance = counted − (expected at snapshot + movements **since snapshot**), "movements since snapshot (computed at close)". If sales continue between the count and the moment the manager posts, those later sales are wrongly treated as *found stock*:

| | |
| --- | --- |
| Snapshot 100, 20 sold, counter counts **70** (the shelf), then 5 more sold before posting | the shelf holds 65, the system says 75 |
| Literal wording (movements since snapshot, at posting time): variance = 70 − (100 − 25) = **−5** → system ends at **70** | 5 units of phantom stock (C2) |
| **Per-entry watermark**: variance = 70 − (100 − 20) = **−10** → system ends at **65** | correct: counted + movements after the count |

So: **every counter entry stores `ledger_watermark` = the highest `stock_movements.id` for that (location, item) at the moment it is entered**, and the variance is `counted − (expected_base + Σ delta where snapshot_movement_id < id ≤ entry.ledger_watermark)`. Property test C10 (sales, deliveries and unrecorded shrinkage before and after the count, 150 seeded sessions): variance always equals minus the shrinkage that happened **before** the count, and after posting the system always equals `counted + recorded movements after the count`.

## What was proved

| # | Scenario | Result |
| --- | --- | --- |
| C1 | Plan example | expected at snapshot 100, since −20, expected at count 80, variance −10, one `count_correction` −10, system 70 |
| C2 | Sales after the count, before posting | watermark method ends 65 (= shelf); literal wording ends 70 (phantom 5) |
| C3 | Delivery +50 and sales −8 during the count | since +42, expected 142, counted 140, variance −2 |
| C4 | Receipt **back-dated** 3 days (`occurred_at`) entered during the count | counted as "since the snapshot" (variance 0); a timestamp comparison would have missed it and reported +30 |
| C5 | Blind sheet | the response has no `expected`, no variance, no quantity anywhere (JSON scanned); a non-blind sheet shows expected |
| C6 | Two counters 70 and 69, a sale between them | both entries kept; each judged against the ledger at **its own** moment (−10 and −8); the reviewer's pick decides; system 67 after posting entry 1 |
| C7 | Replay | `post` on a posted count returns `replayed` and posts nothing; **numbers are frozen at review**: a 40-unit sale after `settle` and before `post` does not change the approved −10; the ledger refuses the same key with another quantity |
| C8 | DB guards | `expected_base` cannot change once started (`count_snapshot_frozen`); entries cannot be edited or deleted (`count_entry_append_only`); a second open **full** count at one location is refused by the partial unique index |
| C9 | Item counted at zero | variance −5, on hand 0 |
| C10 | 150 random sessions | variance = −(shrinkage before the count); system = counted + movements after; ledger reconciliation clean |

## Decisions the spike settles (carry into 10 → P3-07/P3-08)

1. **Watermark by movement id, not by time.** Ids are monotone per (location, item) in commit order because every writer (`ledger.post`, the serve trigger, `main`'s 009 code) takes the `stock_balances` row lock before inserting; `occurred_at` can be back-dated and clocks skew.
2. **Migration 020 gains two columns**: `stock_count_lines.snapshot_movement_id bigint` and `stock_count_entries.ledger_watermark bigint` (both `not null`, default 0 for the line). The plan's `movements_since_base` column stays as the **stored result** at review.
3. **Snapshot = one `insert … select`** reading `on_hand` and `max(movement id)` together (one MVCC snapshot), no lock on the stock rows, so a count never blocks serving.
4. **Numbers freeze at review ("settle"), before approval.** The approver approves stored `variance_base`/`variance_value`; `post` writes exactly those with key `count:<id>:<line>` and is gated by status (`posted` → no-op). Do not recompute at posting.
5. **A line may have several entries**; the reviewer's choice (default: latest) is `chosen_entry_id`. Recounts are new entries, never edits.
6. **Counts of items with `reserved > 0`** (Warehouse): reservations untouched; the watermark logic ignores them (they do not change `on_hand`).

## Recommendation

Adopt the watermark rule in P3-07/P3-08 and fix the wording in D3-5, P3-07 and P3-08 and the T-CTL-2 test list ("sales **after the count but before posting**" becomes a named test). Keep this spike's C2 and C10 as real tests in `counts.test.js` (C10 is ~2 s on PGlite). No change to the estimate.

## Limits

PGlite is single-connection, so "a sale commits while a counter's request is open" is simulated by ordering, not truly concurrent; the monotone-id argument rests on the row lock and must be re-checked in the real-Postgres pass (P3-37: 10 parallel count posts plus a sales load).
