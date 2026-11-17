# Table sessions: ordering together (proposed migration 011)

Everyone at a table adds to one shared order from their own phone. The waiter still confirms it at the table by
scanning one code (docs/ORDER-FLOW.md): that scan stays the proof a waiter is there, so nothing reaches the kitchen
without staff at the table.

Status: built and tested on PGlite (`node backend/tests/table-sessions.js`). Migration
`backend/db/proposed/011_table_sessions.sql` is **not applied** to the shared database. Until it is, every table-session
endpoint answers `{ available: false }` and guests get today's per-phone cart, unchanged.

## How it works for guests

1. The first guest to scan a table's QR opens the table's session and becomes its host.
2. The next guest to scan sees: “Table 7 already has an order going. Enter the code from someone at your table.” They
   type the 4-digit code shown on any member's phone (“Table code 4821 · share it with friends at your table”), or a
   waiter reads it from the waiter app. A name is optional, up to 24 characters. Without one they show as “Guest 2”.
   **Order on my own instead** gives them today's per-phone cart (remembered for that table for 6 hours).
3. Members see one live cart, polled every ~3 s. The order sheet groups lines by who added them (“Added by you”,
   “Amina”, “Guest 3”). Anyone can add, change, add a note to or remove any line.
4. Any member taps **Ready to order** and the table gets one code and QR. Tapping again after changes keeps the same
   code while it is waiting.
5. The waiter scans and confirms. Every member's phone shows “Order confirmed ✓”. The lines that were sent leave
   the cart, and lines added while the waiter was on the way stay for the next round. “Ordered so far” lists each
   confirmed round.
6. The session stays open for more rounds. It closes when staff close the table, when it has been idle for too long,
   when it reaches the 6-hour cap, when its last member leaves, or when everything it ordered has been paid and
   nothing is waiting.

Without a table number in the URL, and in the Studio preview, nothing changes.

## Security

- Anyone can view the menu. A non-member asking for a table gets `{ state: 'join', table, verified, locked, lockedUntil }`
  only: no cart, no names, no code. Every member endpoint answers 404 to non-members, the same answer as for a
  closed or unknown session.
- Visitor ids (the existing hashed `X-Cravio-Visitor`) never leave the server. Members appear as a name or “Guest N”.
- Join attempts: a phone gets 10 tries per 10 minutes (in memory). Each table session counts wrong codes in the
  database: 5 wrong codes inside 10 minutes lock joining for 10 minutes, even with the right code. **New code**
  in the waiter app lifts the lock.
- Orders still need the waiter's scan, so someone who isn't at the table can't create an order.

### A guest who isn't at the table (for example, with a photo of the table QR at home)

- Sessions start **unverified**. A session becomes **verified** when a waiter confirms an order from it (the scan at
  the table), or when staff tap **Confirm guests are here** on the table sheet.
- Unverified sessions close after **15 minutes** without activity. Verified sessions close after **45 minutes**.
  Both close at the **6-hour** cap. Only changes, joins and Ready to order count as activity, not polling.
- Unverified sessions never block real guests. A newcomer can always choose **Order on my own**. When a waiter
  confirms a solo cart at that table, any unverified session there is closed with `closed_reason = 'replaced'`.
  Verified sessions are never replaced.
- The waiter app shows unverified sessions as “Not confirmed at the table yet · 2 people”, with **Confirm guests
  are here**, **New code** and **Close table**.
- Ready to order from an unverified session works as usual: the waiter's scan is still the gate.

## Data (011)

- `table_sessions`: the restaurant and table, `join_code` (4 digits), `status` (`open` or `closed`), `cart` (a jsonb
  list of lines `{ id, kind, itemId | dealId, extraIds, quantity, note, addedBy }`), `cart_version`, `cart_code` (the
  waiting guest cart's code), `ready_lines` (what was sent), `verified_at` and `verified_by`, `failed_joins`,
  `failed_since` and `locked_until`, `opened_at`, `last_active_at`, `expires_at`, and `closed_at`, `closed_by` and
  `closed_reason` (`staff`, `idle`, `expired`, `paid`, `replaced` or `empty`). A partial unique index allows one
  open session per table.
- `table_session_members`: `(session_id, visitor_id)` as the key, plus `name` (up to 24 characters), `guest_number`,
  `is_host`, `joined_at` and `last_seen_at`.
- `guest_carts.session_id` links each saved table cart to its session. Orders link through
  `orders.guest_cart_id`, so no change is needed on `orders`.
- RLS is on, with no anon or authenticated grants. All access goes through the API.
- Rollback: `011_table_sessions.down.sql`.

`cart_version` goes up on every change visible to members: cart edits, joins, leaving, Ready to order, a confirmation,
a new code and closing. Polls with `?since=<version>` get `{ changed: false }` when nothing moved.

## API

Guest endpoints need the `X-Cravio-Visitor` header. Every response has `available`, which is `false` before 011 is
applied or when the server has no direct database connection.

| Endpoint | Body or query | Answer |
| --- | --- | --- |
| `POST /api/public/table-sessions` | `{ restaurantId, tableNumber, name? }` | `{ available, state: 'member', session }` or `{ available, state: 'join', table, verified, locked, lockedUntil }` |
| `POST /api/public/table-sessions/join` | `{ restaurantId, tableNumber, code, name? }` | `{ available, state: 'member', session }`. Errors: 400 for a bad code format, 403 `wrong_code`, 429 `locked`, 404 `closed` |
| `GET /api/public/table-sessions/:id?since=N` | | `{ available, changed: false, version }` or `{ available, changed: true, session }`. 404 for non-members or a closed session |
| `POST /api/public/table-sessions/:id/ops` | `{ type: 'add', line: { itemId \| dealId, quantity?, extraIds?, note? } }`, `{ type: 'change', lineId, delta }`, `{ type: 'quantity', lineId, quantity }` (0 removes the line), `{ type: 'note', lineId, note }`, `{ type: 'remove', lineId }`, `{ type: 'clear' }` | `{ available, session }`. 409 `line_gone` when someone else just removed the line |
| `POST /api/public/table-sessions/:id/ready` | | `{ available, session, cart }`. `cart` has the same shape as `POST /api/public/carts` (`code`, `qrValue`, `items`, `total`, …) |
| `POST /api/public/table-sessions/:id/leave` | | `{ available, left: true }` |
| `GET /api/public/carts/:code/status` | (existing) | Any member of the cart's table session can now follow it, not only the phone that saved it |

The `session` object has this shape:

```
{ id, table: { number }, joinCode, verified, version, openedAt, expiresAt,
  you: { guestNumber, name, label, isHost },
  members: [{ guestNumber, label, isHost, you }],
  cart: [{ id, kind, itemId, dealId, extraIds, quantity, note, addedBy: { label, guestNumber, you } }],
  ready: null | { code, qrValue, expiresAt, changedSinceReady },
  ordered: [{ orderShortId, status, confirmedAt, confirmedBy, items: [{ name, quantity }] }] }
```

Staff endpoints are authenticated and scoped to the branch like the other `/api/ops` routes:

| Endpoint | Answer |
| --- | --- |
| `GET /api/ops/table-sessions` | `{ available, sessions: [{ id, table, joinCode, people, verified, cartLines, waitingForWaiter, openedAt, lastActiveAt, idleClosesAt, joinLockedUntil }] }` |
| `POST /api/ops/table-sessions/:id/close` | `{ closed: true }`. A code still waiting in that session can no longer be confirmed |
| `POST /api/ops/table-sessions/:id/code` | `{ joinCode }` (also lifts a join lock) |
| `POST /api/ops/table-sessions/:id/verify` | `{ verified: true }` (“Confirm guests are here”) |

Hooks in `routes/operations.js` run on a best-effort basis and never fail the order. After `POST /api/ops/orders`
claims a cart, the server verifies the session and clears the sent lines, or, for a solo cart, replaces an
unverified session at that table. After `POST /api/ops/orders/:id/pay`, the server closes the session when all its
orders are paid or cancelled and nothing is in its cart or waiting.

## Implementation notes

- The logic is in `backend/src/lib/table-sessions.js`: plain SQL over `query(sql, params)`, run through `withDb` in
  routes and on PGlite in tests. Pricing is passed in: routes use `priceLines`, so dishes, extras, deals,
  sold-out items and the limits (30 lines, quantity 20) follow the same rules as solo carts. Each added line is
  checked, and the whole cart is checked again on Ready to order.
- Concurrency: each operation re-reads the cart, applies itself and writes with `where cart_version = v`. On a
  conflict it waits a short random time and retries, up to 8 times. The test runs 6 interleaved adds and checks
  that every one landed and that at least one retried.
- Ready to order writes the `guest_carts` row directly in SQL. That keeps it inside the same version check, and if
  the cart changed in the meantime, the new row is removed and the save is retried. It does not call
  `saveCart` in `public-guest.js`. `public-guest.js` now exports `liveRestaurant` and `limitGuest` for reuse.
- Same-person merging: adding the same dish with the same extras merges into that person's existing line. Other
  people's lines stay separate, so the “who added it” labels stay accurate.
- Confirmation clearing compares each line's id, quantity, note and extras with the snapshot that was sent. A line
  changed after Ready to order stays in the cart for the next round.
- Stale sessions close lazily, whenever the table, the session or the branch list is read. There is no background job.
- The frontend is in `useTableSession.js`, which gives the same cart interface as `useGuestCart`, plus
  `TableJoinSheet.jsx`, grouped lines and “Ordered so far” in `CartSheet.jsx`, the table strip in
  `MenuExperience.jsx`, and the session card in `waiter/TableSheet.jsx`. Cart changes wait for the server's answer
  and are not applied on the phone first.

## Not done yet

- Live updates in `/api/ops/live`. The table sheet polls `/api/ops/table-sessions` every 10 s instead, and the
  tables grid has no session badge yet.
- The join rate limit per phone is in memory, like the other public limits. The per-table lock is in the database.
- No browser test of the shared flow has been run yet.
