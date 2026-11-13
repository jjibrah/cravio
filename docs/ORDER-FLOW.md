# Order flow (agreed 2026-11-12)

The guest's QR code is the proof that a waiter stood at the table and confirmed the order with
the guest. The code exists only on the guest's phone, is tied to that table, expires after 2
hours and can be used once. There is no separate "Accept" step.

## Stages

| # | Stage | Who | Action | Signal |
| --- | --- | --- | --- | --- |
| 1 | Browsing | Guest | Builds an order on their phone. Nothing is sent. | none |
| 2 | Ready to order | Guest | Taps **Ready to order**: the cart is saved server-side and the QR and code are shown. | Waiters and owner: "Table 7 is ready to order" in Needs attention |
| 3 | Confirmed | Waiter, at the table | Scans the guest's QR, reviews it with the guest ("Is that all?"), edits, taps **Confirm order**. The order is created. | Order: "Confirmed with the guest by Jane, 10:45". The guest's phone shows "Order confirmed ✓". The ready-to-order alert clears. |
| 4 | Served | Waiter | **Mark served** | — |
| 5 | Paid | Waiter or cashier | **Mark paid** (cash, M-Pesa, card, other; PayHero POS prompt later) | Counted in sales |

Cancelled is possible from Confirmed or Served, by managers, or by the waiter who confirmed it.

## Validation

- **QR scan** (normal): the order is marked `confirmation: 'qr'`.
- **Typed 6-character code** from the guest's screen (camera fallback): `confirmation: 'code'`. This still counts as confirmed by the guest.
- **Manual order** (guest without a phone): allowed. It is marked `confirmation: 'manual'` and shown to the owner as "Entered by waiter, not confirmed by the guest".

## Data mapping (existing columns)

- `orders.status`: `taken` becomes "Confirmed". The `accepted` stage is skipped, so new orders go `taken → served → paid`. Existing accepted orders still display, as "Confirmed".
- New: `orders.confirmation` (`qr` | `code` | `manual`), and `guest_carts.ready_at`, used as the "ready to order" signal.
- Guest polling of their cart code (`GET /api/public/carts/:code/status`, every ~5 s, same phone only) returns
  `status: 'confirmed'` once the cart is claimed, plus the waiter's first name, the time and the order number, for
  the "Order confirmed ✓" screen (`'ready'` while waiting, `'expired'` after 2 hours).

## Implementation notes

- Migration `005_order_confirmation.sql` adds `orders.confirmation` and `guest_carts.ready_at`, and replaces 003's
  check that every served or paid order has an accepted time (new orders never have one).
- `POST /api/ops/orders` sets `confirmation` from the request: with `cartCode`, `via: 'scan'` → `qr`, `via: 'typed'`
  (or none) → `code`; without `cartCode` → `manual`. The cart is claimed, so its "ready to order" item clears.
- `/api/ops/live` lists ready carts as `readyToOrder` items (`type: 'ready_to_order'`, table, item count, total,
  `readyAt`); its cursor changes when a cart becomes ready, changes, is claimed or expires. The cart code is in the
  payload for matching only; the staff UI never shows it, because holding the guest's code is the proof the
  waiter is at the table.
- Cancelling: managers can cancel a Confirmed or Served order; the waiter who confirmed it can cancel it only
  while it is still Confirmed.
- Before 005 is applied the flow still works, without storing `confirmation`; every active cart counts as ready,
  and serving a `taken` order also records an accepted time (equal to the serving time) to satisfy 003's check.
- The waiter app: Services shows "Table 7 is ready to order · 3 items · Ksh 2,350" with **Scan code** and "Type code";
  both open **Check with the guest** (items with extras and deals, edit controls, "Is that all?", **Confirm order**).
  "No phone? Enter the order yourself" stays, marked as not confirmed by the guest.
