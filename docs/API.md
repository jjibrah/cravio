# Cravio API: live operations and menu merchandising

This is the contract for Cravio's live restaurant operations: guest menu, guest carts, guest requests, orders, tables, analytics, system health, menu management including dish video, and menu merchandising (pairings, extras, featured dishes, deals, the menu design "Studio" and guest menu events).

It is written for the frontend. Everything here matches `backend/src/routes/operations.js`, `public-guest.js`, `public-menu.js`, `restaurant.js` and `menu-merch.js`.

> **Needs migration 003.** Until `backend/db/migrations/003_operations.sql` is applied:
> - Every `/api/ops/*` endpoint and the public cart and request endpoints return `503 { "error": "Live operations aren’t available yet. The database update hasn’t been applied." }`.
> - The guest menu and the menu endpoints keep working, with the video fields set to `null`.

> **Needs migration 004 for merchandising.** Until `backend/db/migrations/004_menu_merchandising.sql` is applied (and for up to a minute after, while the server notices):
> - The [merchandising endpoints](#14-menu-merchandising-owners-and-managers) return `503 { "error": "Menu extras, pairings and deals aren’t available yet. The database update hasn’t been applied." }`.
> - The guest menu still returns the new keys, empty: `featuredItemIds: []`, `deals: []`, `items[].extras: []`, `items[].pairedItemIds: []`, `items[].featured: false`, and the default `design`.
> - Cart and order lines with `extraIds` or a `dealId` return that 503; plain lines work as before.
> - `POST /api/public/events` still answers 202, but nothing is stored.
> - Analytics returns `busyHours: null`, `dishPerformance: null` and `kpis.dishViews.value: null` (and `viewsPerScan`, `videoPlays`); everything else works.

> **Needs migration 006 for support requests.** Until `backend/db/migrations/006_support_requests.sql` is applied, `GET /api/restaurant/support` returns `{ "available": false, "requests": [] }`, `POST` returns `503`, and the admin requests endpoints return `available: false`. See [§17](#17-contact-cravio-and-the-cravio-admin-platform).

> **Needs migration 005 for the agreed order flow** ([ORDER-FLOW.md](ORDER-FLOW.md)). Until `backend/db/migrations/005_order_confirmation.sql` is applied (and for up to a minute after, while the server notices):
> - The flow works: guests tap "Ready to order", staff see it on `/api/ops/live`, waiters confirm orders, and orders go `taken → served → paid`.
> - `order.confirmation` is always `null` (nothing is stored), so owners can't tell scanned, typed and manual orders apart.
> - Every unclaimed, unexpired cart counts as ready to order (there is no `ready_at` yet).
> - Serving a `taken` order also fills `acceptedAt`/`acceptedBy` with the serving time and person, because 003's check still requires it. The timeline doesn't show it.

## Contents

1. [Conventions](#1-conventions)
2. [Concepts: order lifecycle, requests, table states](#2-concepts)
3. [Public guest endpoints](#3-public-guest-endpoints-no-sign-in)
4. [Staff: live screen and guest requests](#4-staff-live-screen-and-guest-requests)
5. [Staff: guest carts and orders](#5-staff-guest-carts-and-orders)
6. [Tables](#6-tables)
7. [Analytics](#7-analytics)
8. [System health](#8-system-health)
9. [Menu management (Products and Menu configuration)](#9-menu-management)
10. [Dish photos and videos: storage conventions](#10-dish-photos-and-videos-storage)
11. [Polling guidance](#11-polling-guidance)
12. [Shared object shapes](#12-shared-object-shapes)
13. [Error reference](#13-error-reference)
14. [Menu merchandising: pairings, extras, featured, deals (owners and managers)](#14-menu-merchandising-owners-and-managers)
15. [Menu design ("Studio") and the `menu_design` schema](#15-menu-design-studio)
16. [Speed: caching, compression and timing](#16-speed-caching-compression-and-timing)
17. [Contact Cravio and the Cravio admin platform](#17-contact-cravio-and-the-cravio-admin-platform)

---

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Base | Paths start with `/api`. In development the Vite proxy forwards `/api` to the backend on port 3002. Use `api()` from `frontend/src/lib/api.js` for signed-in calls; it adds the bearer token. |
| Auth | Staff endpoints need `Authorization: Bearer <Supabase access token>`. Public endpoints need no auth. |
| Bodies | JSON. Send `Content-Type: application/json`. A body that isn't an object counts as `{}`. |
| Naming | camelCase everywhere. |
| Money | Numbers in KES with up to 2 decimal places, for example `1650` or `99.5`. `currency` is always `"KES"`. Format with `formatPrice()` from `lib/onboarding.js`. |
| Times | ISO 8601 UTC strings, for example `"2026-10-31T07:45:00.000Z"`. Show them in the restaurant's local time, Africa/Nairobi (UTC+3). |
| Days and hours | Analytics buckets, "today" and date filters use Nairobi days (midnight to midnight, EAT). |
| Ids | UUIDs. The order display id is `shortId`: the first 6 hex characters of the order id. Show it as `#92da2e`. |
| Errors | `{ "error": "Human sentence to show the user", "details"?: { … } }`. The message is written for end users, so you can show it as-is. `details.field` names the offending input when there is one. See [§13](#13-error-reference). |
| Caching | Every response is `Cache-Control: no-store`, except the public menu, which is `public, no-cache` with an `ETag` (send `If-None-Match` to get a `304` when nothing changed). See [§16](#16-speed-caching-compression-and-timing). |
| Compression | JSON bodies over 1 KB are gzipped when the request sends `Accept-Encoding: gzip` (browsers always do; `fetch` decompresses for you). |
| Empty success | `DELETE` endpoints return `204` with no body. |

### Who may call what

| Term | Who |
| --- | --- |
| **Guest** | Anyone. No sign-in. |
| **Staff** | Any member of the restaurant: owner, manager or waiter. |
| **Managers** | Owner or manager. Managers sign in with profile role `owner` and have membership role `manager`. |

- The server works out the caller's restaurant from their membership. You never send a `restaurantId` on staff endpoints.
- Owners and waiters each belong to exactly one restaurant today.
- A signed-in user with no membership gets `403 "You aren’t part of a restaurant yet. Ask your manager to add you."`.
- Admins get `403 "You do not have access to this."` on staff endpoints.
- Anything that belongs to another restaurant returns `404`, as if it didn't exist.

### The visitor header (guests)

The guest app generates one random id per phone and keeps it in `localStorage`. For example:

```js
const KEY = 'cravio-visitor';
let id = localStorage.getItem(KEY);
if (!id) { id = crypto.randomUUID().replaceAll('-', ''); localStorage.setItem(KEY, id); }
```

Send it on every public call as `X-Cravio-Visitor: <id>`, where `<id>` is 8–64 characters of `A–Z a–z 0–9 _ -`.

The server uses this id to:
- deduplicate menu scans;
- rate-limit carts and requests;
- let only the same phone edit its cart.

It stores only a hash of the id, never the raw value, and stores no IP address or personal data. If the header is missing or malformed:
- scans can't be deduplicated;
- the rate limit falls back to the connection address, held in memory only.

---

## 2. Concepts

### Order state machine

The agreed flow is in [ORDER-FLOW.md](ORDER-FLOW.md). Guests never create orders. The guest taps **Ready to order** (their cart is saved and staff see "Table 7 is ready to order"); a waiter at the table scans the guest's QR (or types the code), checks the order with the guest and taps **Confirm order**, which creates the order. The QR is the proof that the waiter confirmed it with the guest, so there is **no accept step**. Staff can also enter an order without a guest cart (a guest without a phone); it is marked as not confirmed by the guest.

```
  POST /api/ops/orders      advance            pay {method}
  ───────────────────▶ taken ──────────▶ served ─────────────▶ paid
                   "Confirmed"             │
                        │                  │
                        └───── cancel ─────┘──────▶ cancelled
```

| status | `statusLabel` (UI text) | `nextAction` | What the primary button does |
| --- | --- | --- | --- |
| `taken` | Confirmed | `serve` | `POST /api/ops/orders/:id/advance` ("Mark served") |
| `accepted` | Confirmed | `serve` | Older orders only (before the agreed flow). `advance` serves them. |
| `served` | Served | `pay` | `POST /api/ops/orders/:id/pay` with a method |
| `paid` | Paid | `null` | No action; finished |
| `cancelled` | Cancelled | `null` | No action; finished |

**How the order was confirmed** (`order.confirmation`, migration 005):

| `confirmation` | When | Show owners |
| --- | --- | --- |
| `qr` | Created with `cartCode` and `via: "scan"` (the waiter scanned the guest's QR) | "Confirmed with the guest by Jane at 10:45 (QR)" |
| `code` | Created with `cartCode` and `via: "typed"`, or no `via` (the code typed from the guest's screen) | "… (typed code)". Still confirmed by the guest. |
| `manual` | Created without `cartCode` | "Entered by waiter, not confirmed by the guest", with a warning tag |
| `null` | Orders from before migration 005 | No tag |

**Rules**
- Each stage records who and when: `takenBy/takenAt` (confirmed by), `servedBy/servedAt`, `paidBy/paidAt`, `cancelledBy/cancelledAt`. `acceptedBy/acceptedAt` are only set on older orders.
- New orders are created `taken` and never enter `accepted`.
- `advance` moves `taken` (or an older `accepted` order) to `served`. On a `served` order it returns `409`, because paying needs a method.
- `pay` is allowed only from `served`. It returns `409 "Serve this order before marking it paid."` otherwise.
- **Who can cancel:**
  - managers can cancel any order that is `taken`, `accepted` or `served`;
  - the waiter who confirmed the order can cancel it only while it is still Confirmed (`taken` or `accepted`), not after it is served.
  - `order.canCancel` tells you whether the **current user** may cancel now. Use it to show or hide "Cancel order".
- `paid` and `cancelled` are final. Any further transition returns `409`.
- **Double-tap and concurrency safety:**
  - send `from: <the status you're looking at>` with `advance`, `pay` and `cancel`;
  - if someone else already moved the order, you get `409` with `details.status` set to the current status;
  - then refresh instead of moving it twice.
- When an order is paid and its table has no other unpaid orders, the server automatically resolves that table's open `bill` and `payment` requests.

Prices and totals are always computed on the server from the current menu, and stored on the order as a snapshot. `subtotal` and `total` are equal today; `total` exists so service charges can be added later.

### Guest request types

| `type` | Guest button | `typeLabel` | Meaning |
| --- | --- | --- | --- |
| `call_waiter` | "Call waiter" | Call waiter | The guest wants someone to come over |
| `bill` | "Ask for the bill" | Bill requested | The guest wants the bill or receipt |
| `payment` | "Pay" | Wants to pay | The guest is ready to pay |

Request status:
- `open`: new, nobody has responded.
- `acknowledged`: a staff member tapped "On my way". The guest UI shows "Waiter is on the way".
- `resolved`: done. It leaves every list.

There is at most **one unresolved request per table and type**. A second tap returns the existing request with `deduped: true`. After it is resolved, a new tap creates a new request.

### Table state derivation

Every table has one `state`, the most urgent that applies:

| Priority | `state` | When | Suggested UI |
| --- | --- | --- | --- |
| 1 | `bill` | It has an unresolved (`open` or `acknowledged`) `bill` or `payment` request | Bill or pay badge |
| 2 | `attention` | It has an unresolved `call_waiter` request | Attention badge |
| 3 | `ordering` | It has an order in `taken`, `accepted` or `served` (unpaid) | Busy |

A table whose guest tapped "Ready to order" also has `readyToOrder: true` on `/api/ops/live` (it doesn't change `state`).
| 4 | `free` | None of the above | Free |

---

## 3. Public guest endpoints (no sign-in)

### `GET /api/public/menu/:restaurantId?t=<tableNumber>`

The guest menu, for live restaurants only. **Each call logs a menu scan** (also when the answer is a `304`):
- it records the restaurant, the table (when `t` is a real table), the time and the hashed visitor id;
- the same visitor and table is counted once per 30 minutes;
- logging never fails or slows the response.

Send `X-Cravio-Visitor`. The response has an `ETag`; send it back as `If-None-Match` to get an empty `304` when the menu hasn't changed. The server caches the built menu for up to 60 seconds and drops it the moment an owner or manager changes anything guests see, so edits show up on the next request.

**200**

```json
{
  "restaurant": {
    "id": "106fe2fb-94bb-4f5d-bd0d-bd694004424c", "name": "Demo Restaurant", "kind": "restaurant",
    "area": "Westlands, Nairobi", "address": null, "openingHours": { "preset": "everyday", "days": { "mon": { "open": true, "from": "08:00", "to": "22:00" } } },
    "phone": "+254712345678", "logoUrl": "https://…/logo.jpg", "coverUrl": null, "theme": "classic"
  },
  "categories": [{ "id": "…", "name": "Mains" }],
  "items": [{
    "id": "…", "categoryId": "…", "name": "Chicken wings", "description": "Peri-peri wings, chilli lime dip.",
    "price": 750, "currency": "KES", "available": true,
    "photoUrl": "https://<project>.supabase.co/storage/v1/object/public/restaurant-media/<rid>/items/<uuid>.jpg",
    "videoUrl": "https://<project>.supabase.co/storage/v1/object/public/restaurant-media/<rid>/videos/<uuid>.mp4",
    "videoPosterUrl": "https://<project>.supabase.co/storage/v1/object/public/restaurant-media/<rid>/posters/<uuid>.jpg",
    "videoDurationSeconds": 12.4,
    "featured": true,
    "extras": [{ "id": "…", "name": "Cheese", "price": 150 }, { "id": "…", "name": "Bacon", "price": 200 }],
    "pairedItemIds": ["<Chips id>", "<Stoney id>"]
  }],
  "featuredItemIds": ["<Nyama choma id>", "<Classic beef burger id>"],
  "deals": [{
    "id": "…", "name": "Burger meal", "description": "Classic beef burger, chips and a Stoney.",
    "price": 1150, "regularPrice": 1320, "saving": 170, "savingPercent": 13, "currency": "KES",
    "photoUrl": null, "photoUrls": ["https://…/items/burger.jpg", "https://…/items/chips.jpg"],
    "startsAt": null, "endsAt": null,
    "items": [
      { "itemId": "…", "name": "Classic beef burger", "quantity": 1, "unitPrice": 950, "photoUrl": "https://…/items/burger.jpg" },
      { "itemId": "…", "name": "Chips", "quantity": 1, "unitPrice": 250, "photoUrl": "https://…/items/chips.jpg" },
      { "itemId": "…", "name": "Stoney tangawizi", "quantity": 1, "unitPrice": 120, "photoUrl": null }
    ]
  }],
  "design": { "version": 1, "theme": "classic", "fonts": { "display": "playfair", "body": "dm-sans" }, "…": "see §15",
    "sections": [
      { "key": "featured", "type": "featured", "title": "Featured", "visible": true, "layout": "carousel" },
      { "key": "deals", "type": "deals", "title": "Pairs & deals", "visible": true, "layout": "carousel" },
      { "key": "category:<id>", "type": "category", "categoryId": "<id>", "title": "Mains", "visible": true, "layout": "list" }
    ] },
  "table": { "id": "…", "number": 7 }
}
```

- `table` is present only when `t` is a whole number of an existing table.
- Sold-out items (`available: false`) are left out of `items`, so the guest never sees them.
- `videoUrl`, `videoPosterUrl` and `videoDurationSeconds` are `null` when a dish has no video.
- `items[].extras`: the dish's **available** extras, in the owner's order. Let the guest pick any of them in the dish sheet and send their ids as `extraIds` on the cart line.
- `items[].pairedItemIds`: "Goes well with", in the owner's order, at most 6, **only dishes that are in `items`** (available). Tapping one adds that dish to the cart as its own line.
- `featuredItemIds`: the "Featured" carousel, in order. Every id is in `items` (sold-out featured dishes are left out). `items[].featured` says the same per dish.
- `deals`: only deals a guest can order right now: active, inside their date window, and every dish in them available. In the owner's order. `photoUrl` is the deal's own photo or `null`; when it is `null`, compose a picture from `photoUrls` (up to 4 distinct dish photos). `saving = regularPrice − price` (never negative); `regularPrice` is today's dish prices × quantities.
- `design`: the menu design merged with the defaults, with `sections` already resolved in display order (see [§15](#15-menu-design-studio)). Render sections in this order and skip `visible: false`. Hide a featured or deals section when it has nothing to show.
- **404** `"This menu isn’t available."` for unknown, malformed or not-live restaurants.

### `POST /api/public/carts`: "Ready to order"

The guest taps **Ready to order**: the cart is saved on the server and marked ready (`ready_at`), which puts "Table 7 is ready to order" on the staff live screens. The guest gets a 6-character code plus a QR value to show the waiter. This does **not** create an order: the waiter creates it when they confirm it with the guest at the table. While browsing, nothing is sent.

Request:

```json
{
  "restaurantId": "106fe2fb-94bb-4f5d-bd0d-bd694004424c",
  "tableNumber": 7,
  "items": [
    { "itemId": "…", "quantity": 2, "note": "Extra spicy" },
    { "itemId": "<burger id>", "quantity": 1, "extraIds": ["<cheese id>"] },
    { "dealId": "<Burger meal id>", "quantity": 1 },
    { "itemId": "…", "quantity": 1 }
  ],
  "code": "ACD347"
}
```

| Field | Rules |
| --- | --- |
| `restaurantId` | Required. Must be a live restaurant. |
| `tableNumber` | Optional. When given, it must be a table of this restaurant. |
| `items` | 1–30 lines. A line is **either a dish** `{ itemId, quantity?, note?, extraIds? }` **or a deal** `{ dealId, quantity?, note? }`. `quantity` is a whole number 1–20 (default 1); `note` is up to 140 characters. A dish must be **available**. `extraIds` (optional, up to 10, no duplicates) must be **available extras of that dish**. A deal must be one the guest menu shows (active, in its window, every dish available); deals can't have extras. The same dish with different extras is two lines. |
| `code` | Optional. Send the code you already have to **replace that cart's items**. This works while the cart is active, unclaimed and was created from the same phone; the expiry restarts at 2 hours. If the code is unknown, expired or from another phone, a **new** cart with a **new** code is created, so always use the code in the response. |

**200**

```json
{
  "code": "ACD347",
  "status": "ready",
  "readyAt": "2026-10-31T07:45:00.000Z",
  "expiresAt": "2026-10-31T09:45:00.000Z",
  "table": { "id": "…", "number": 7 },
  "items": [
    { "kind": "item", "itemId": "…", "dealId": null, "name": "Chicken wings", "unitPrice": 750, "extras": [], "extrasTotal": 0, "unitTotal": 750, "quantity": 2, "note": "Extra spicy", "lineTotal": 1500 },
    { "kind": "item", "itemId": "…", "dealId": null, "name": "Classic beef burger", "unitPrice": 950,
      "extras": [{ "id": "…", "name": "Cheese", "price": 150 }], "extrasTotal": 150, "unitTotal": 1100, "quantity": 1, "note": null, "lineTotal": 1100 },
    { "kind": "deal", "itemId": null, "dealId": "…", "name": "Burger meal", "unitPrice": 1150, "extras": [], "extrasTotal": 0, "unitTotal": 1150, "quantity": 1, "note": null, "lineTotal": 1150,
      "regularPrice": 1320,
      "components": [{ "itemId": "…", "name": "Classic beef burger", "quantity": 1, "unitPrice": 950 }, { "itemId": "…", "name": "Chips", "quantity": 1, "unitPrice": 250 }, { "itemId": "…", "name": "Stoney tangawizi", "quantity": 1, "unitPrice": 120 }] },
    { "kind": "item", "itemId": "…", "dealId": null, "name": "Kenyan chai", "unitPrice": 150, "extras": [], "extrasTotal": 0, "unitTotal": 150, "quantity": 1, "note": null, "lineTotal": 150 }
  ],
  "total": 3900,
  "currency": "KES",
  "qrValue": "http://localhost:5175/waiter/cart/ACD347"
}
```

**Prices.** Everything is priced on the server from the current menu: `unitTotal = unitPrice + extrasTotal`, `lineTotal = unitTotal × quantity`, `total = Σ lineTotal`. For a deal, `unitPrice` is the deal price and `components` lists its dishes (per one deal). Show a dish line in the cart as "Classic Beef Burger · + Cheese · Ksh 1,100" (`extrasLabel`: `extras.map(e => '+ ' + e.name).join(', ')`).

**About the code and QR**
- The code uses the alphabet `ACDEFHJKMNPRTUVWXY34679`: no 0/O, 1/I/L, 2/Z, 5/S, 8/B.
- Show it large, perhaps grouped as `ACD 347`.
- Render `qrValue` as the QR. It is `<FRONTEND_URL>/waiter/cart/<code>`, so:
  - a waiter scanning it with the phone camera opens the waiter app (add a `/waiter/cart/:code` route that loads the import screen);
  - an in-app scanner can extract the code with `/([ACDEFHJKMNPRTUVWXY34679]{6})\b/`.
- Carts expire 2 hours after the last save. Saving again (same code) marks the cart ready again.
- Then poll [`GET /api/public/carts/:code/status`](#get-apipubliccartscodestatusrestaurantidid) to show "Order confirmed ✓".

**Errors**

| Status | `error` | `details` |
| --- | --- | --- |
| 400 | `Add at least one dish.` / `An order can have up to 30 lines.` / `Quantity must be between 1 and 20.` / `Line 2 needs a dish.` | `{ field: "items", index }` |
| 400 | `One of the dishes is no longer on the menu.` | `{ field: "items", index, itemId, reason: "missing" }` |
| 400 | `That cart code isn’t valid.` | `{ field: "code" }` |
| 400 | `Table numbers go from 1 to 999.` | `{ field: "tableNumber" }` |
| 404 | `This menu isn’t available.` | |
| 404 | `Table 14 doesn’t exist here.` | `{ field: "tableNumber" }` |
| 409 | `Chicken wings is sold out.` | `{ field: "items", index, itemId, reason: "sold_out" }`: remove the line and retry |
| 400 | `Line 2 must be a dish or a deal, not both.` / `Line 2 needs a deal.` / `extraIds must be a list of extra ids.` / `Choose up to 10 extras.` / `Deals can’t have extras.` | `{ field: "items", index }` |
| 400 | `One of the extras for Classic beef burger is no longer on the menu.` | `{ field: "items", index, itemId, extraId, reason: "extra_missing" }` |
| 409 | `Bacon (for Classic beef burger) is sold out.` | `{ field: "items", index, itemId, extraId, reason: "extra_sold_out" }`: drop that extra and retry |
| 400 | `That deal is no longer on the menu.` | `{ field: "items", index, dealId, reason: "missing" }` |
| 409 | `Burger meal isn’t available: Chips is sold out.` | `{ field: "items", index, dealId, itemId, reason: "sold_out" }` |
| 409 | `Weekend special isn’t available right now.` | `{ field: "items", index, dealId, reason: "deal_unavailable" }` (inactive, not started or ended) |
| 409 | `Your waiter has already entered this order. Start a new one to add more.` | `{ reason: "claimed" }`: clear the code and the cart, and start fresh |
| 429 | `That’s a lot of taps. Please wait a few minutes, or ask a member of staff.` | `{ retryAfterSeconds }` |

### `GET /api/public/carts/:code/status?restaurantId=<id>`

After "Ready to order", the guest's phone polls this about **every 5 seconds** to learn when a waiter confirmed the order. Send `X-Cravio-Visitor`: only the phone that saved the cart can read it.

**200**

```json
{ "status": "ready", "expiresAt": "2026-10-31T09:45:00.000Z" }
{ "status": "confirmed", "confirmedBy": "Jane", "confirmedAt": "2026-10-31T07:52:00.000Z", "orderShortId": "92da2e" }
{ "status": "expired", "expiresAt": "2026-10-31T09:45:00.000Z" }
```

- `confirmed`: a waiter confirmed it and the order exists. `confirmedBy` is the waiter's first name. Show "Order confirmed ✓ · Jane confirmed your order at 10:45 · #92da2e", then reset the cart. Stop polling.
- `expired`: nobody confirmed it within 2 hours. Show "This code expired. Tap Ready to order again." and forget the code.
- **Errors:** 400 `restaurantId is required.`, `Send the X-Cravio-Visitor header.`, `That cart code isn’t valid.`; 404 `We couldn’t find that code. Tap Ready to order again.` (unknown code, purged, or another phone's); 429 after 300 checks in 10 minutes per phone.

### `POST /api/public/requests`: call the waiter, ask for the bill, ask to pay

Request: `{ "restaurantId": "…", "tableNumber": 7, "type": "call_waiter" | "bill" | "payment" }`

**200** (also returned for a duplicate tap)

```json
{
  "request": {
    "id": "…", "type": "bill", "typeLabel": "Bill requested", "status": "open",
    "createdAt": "2026-10-31T07:45:00.000Z", "acknowledgedAt": null
  },
  "deduped": false
}
```

- `deduped: true` means an unresolved request of this type already existed for the table; it is returned unchanged.
- **Errors:**
  - 400 `Choose call_waiter, bill or payment.` (`field: "type"`);
  - 400 `Choose a table.` or `Table numbers go from 1 to 999.`;
  - 404 `This menu isn’t available.` or `Table 7 doesn’t exist here.`;
  - 429, as for carts.

### `GET /api/public/requests?restaurantId=<id>&tableNumber=<n>`

The table's unresolved requests, so the guest UI can show "Waiter is on the way" once a request is `acknowledged`. Not rate-limited.

**200**

```json
{
  "table": { "id": "…", "number": 7 },
  "requests": [
    { "id": "…", "type": "call_waiter", "typeLabel": "Call waiter", "status": "acknowledged", "createdAt": "…", "acknowledgedAt": "…" }
  ]
}
```

When a request disappears from this list, it was resolved.

### `POST /api/public/events`: dish views, video plays, deal views

Insights tracking from the guest menu. Send `X-Cravio-Visitor`. **Answers `202` at once**; the events are written in the background, and a failure there never reaches the guest. Fire and forget: don't retry, don't show errors.

```json
{
  "restaurantId": "106fe2fb-94bb-4f5d-bd0d-bd694004424c",
  "tableNumber": 7,
  "events": [
    { "type": "dish_view", "itemId": "…" },
    { "type": "video_play", "itemId": "…", "at": "2026-11-12T17:02:11.000Z" },
    { "type": "deal_view", "dealId": "…" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `restaurantId` | Required, a live restaurant (events for other restaurants are silently ignored). |
| `tableNumber` | Optional. Recorded when it's an existing table. |
| `events` | Required list, **at most 50**. `type` is `dish_view` (the guest opened a dish sheet), `video_play` (a dish video started playing) or `deal_view` (the guest opened a deal). `dish_view` and `video_play` need `itemId`; `deal_view` needs `dealId`. |
| `events[].at` | Optional ISO time when it happened (for batches sent later). Accepted if within the last 24 hours; otherwise the server's time is used. |

**202** `{ "accepted": 3, "dropped": 0 }`: `dropped` counts events with an unknown type or a missing/invalid id. Ids of another restaurant's dishes count as accepted but are ignored when stored.

- **Dedupe:** the same visitor, type and dish (or deal) is stored once per 10 minutes, and once per batch. Without `X-Cravio-Visitor`, nothing is deduped.
- **Batching:** collect events and send them every ~10 seconds, on `visibilitychange` to hidden (use `navigator.sendBeacon` with a JSON `Blob`, or `fetch(…, { keepalive: true })`), and when the batch reaches 50.
- **Errors (400, only for malformed batches):** `restaurantId is required.`, `Send events as a list.`, `Send up to 50 events at a time.`. **429** after 60 batches per visitor in 10 minutes (`Too many events. Please slow down.`).

### Abuse limits (public writes)

| Endpoint | Per visitor id (or connection) | Per table |
| --- | --- | --- |
| `POST /api/public/carts` | 10 per 10 minutes | 20 per 10 minutes |
| `POST /api/public/requests` | 10 per 10 minutes | 20 per 10 minutes |
| `POST /api/public/events` | 60 batches per 10 minutes | none |

- Every accepted call counts, including duplicate taps.
- Over the limit returns `429` with `details.retryAfterSeconds`.
- The limiter is in memory: it resets when the backend restarts and isn't shared between instances.

---

## 4. Staff: live screen and guest requests

### `GET /api/ops/live?since=<cursor>` (staff)

One call for the waiter's main screen and the owner's live views: the needs-attention feed, unpaid orders and table states. Poll it about every 10 seconds (see [§11](#11-polling-guidance)).

- **Without `since`, or with an old cursor**, you get everything:

```json
{
  "changed": true,
  "cursor": "d993976e8cd00a4565cd5879dc0a47f0",
  "serverTime": "2026-10-31T07:50:00.000Z",
  "requests": [
    {
      "id": "…", "type": "bill", "typeLabel": "Bill requested", "status": "open",
      "table": { "id": "…", "number": 7 },
      "createdAt": "2026-10-31T07:48:00.000Z", "ageSeconds": 120,
      "acknowledgedAt": null, "acknowledgedBy": null, "resolvedAt": null, "resolvedBy": null
    }
  ],
  "orders": [ /* Order objects (§12), status taken | accepted | served, oldest first, no timeline */ ],
  "readyToOrder": [
    {
      "type": "ready_to_order", "tableNumber": 7, "table": { "id": "…", "number": 7 }, "cartCode": "ACD347",
      "itemCount": 3, "total": 2350, "currency": "KES",
      "readyAt": "2026-10-31T07:47:00.000Z", "expiresAt": "2026-10-31T09:47:00.000Z"
    }
  ],
  "tables": [
    {
      "id": "…", "number": 7, "label": null, "section": { "id": "…", "name": "Indoor" },
      "state": "bill", "readyToOrder": false, "openOrders": 1, "unpaidTotal": 1650,
      "requestTypes": ["bill"], "oldestRequestAt": "2026-10-31T07:48:00.000Z"
    }
  ],
  "summary": {
    "openRequests": 3, "activeRequests": 4, "activeOrders": 6, "readyToOrder": 1,
    "tables": { "free": 5, "ordering": 3, "attention": 2, "bill": 2 }
  }
}
```

- **With `since` equal to the latest cursor, when nothing has changed**, you get a tiny response. Keep showing what you have:

```json
{ "changed": false, "cursor": "d993976e8cd00a4565cd5879dc0a47f0", "serverTime": "2026-10-31T07:50:10.000Z" }
```

**Notes**
- `requests` holds unresolved requests (`open` and `acknowledged`): `open` first, then oldest first.
- `ageSeconds` is computed at `serverTime`. Between polls, compute the age as `now − createdAt`, correcting for the clock offset `Date.now() − Date.parse(serverTime)`.
- `readyToOrder` holds guests who tapped "Ready to order" and whom no waiter has confirmed yet (unclaimed, unexpired carts), oldest first. Show "Table 7 is ready to order · 3 items · Ksh 2,350" with **Scan code** (and "Type code"). An item clears when a waiter confirms the order (the cart is claimed) or the code expires. `tableNumber` is `null` when the guest opened the menu without a table. `itemCount` and `total` count only lines still available today. `cartCode` is there for matching; don't show it to staff, since having the guest's code in hand is the proof the waiter was at the table.
- The cursor changes whenever any order or request changes (including paid, cancelled or resolved), when a cart becomes ready, is edited, confirmed or expires, or when tables or sections are added, removed or renamed.

### `POST /api/ops/requests/:id/acknowledge` (staff)

Marks the request "On my way". No body.

**200**

```json
{
  "request": {
    "id": "…", "type": "call_waiter", "typeLabel": "Call waiter", "status": "acknowledged",
    "table": { "id": "…", "number": 4 },
    "createdAt": "…", "ageSeconds": 95,
    "acknowledgedAt": "…", "acknowledgedBy": { "id": "…", "name": "Waiter" },
    "resolvedAt": null, "resolvedBy": null
  }
}
```

- Acknowledging an already acknowledged request is harmless and returns it unchanged.
- 409 `This request is already resolved.` (`details.status: "resolved"`).
- 404 `That request doesn’t exist.`

### `POST /api/ops/requests/:id/resolve` (staff)

Marks it done, from `open` or `acknowledged`. Resolving twice is harmless. Returns `{ request }` with `status: "resolved"`, `resolvedAt` and `resolvedBy`.

- 404 `That request doesn’t exist.`

---

## 5. Staff: guest carts and orders

### `GET /api/ops/carts/:code` (staff): look up a guest cart before importing

`:code` is case-insensitive, and dashes are ignored: `acd-347` works. Only active, unclaimed, unexpired carts of the caller's restaurant are found.

**200**

```json
{
  "cart": {
    "code": "ACD347",
    "table": { "id": "…", "number": 7 },
    "items": [
      { "kind": "item", "itemId": "…", "dealId": null, "name": "Chicken wings", "unitPrice": 750, "extras": [], "extrasTotal": 0, "unitTotal": 750, "quantity": 2, "note": "Extra spicy", "lineTotal": 1500, "available": true },
      { "kind": "item", "itemId": "…", "dealId": null, "name": "Whole tilapia", "unitPrice": 1200, "extras": [], "extrasTotal": 0, "unitTotal": 1200, "quantity": 1, "note": null, "lineTotal": 1200, "available": false, "unavailableReason": "sold_out", "unavailableMessage": "Whole tilapia is sold out." },
      { "kind": "deal", "itemId": null, "dealId": "…", "name": "Burger meal", "unitPrice": 1150, "extras": [], "extrasTotal": 0, "unitTotal": 1150, "quantity": 1, "note": null, "lineTotal": 1150, "available": true,
        "components": [{ "itemId": "…", "name": "Classic beef burger", "quantity": 1, "unitPrice": 950 }, { "itemId": "…", "name": "Chips", "quantity": 1, "unitPrice": 250 }] }
    ],
    "total": 1500,
    "currency": "KES",
    "hasUnavailableItems": true,
    "createdAt": "…",
    "expiresAt": "…"
  }
}
```

- Prices are today's menu prices.
- `total` counts only available lines.
- A line whose dish was deleted has `available: false` and `unavailableReason: "missing"`.
- Lines have the same shape as cart lines (`kind`, `extras`, `components` for deals). Other reasons: `"extra_unavailable"` (a chosen extra was removed or sold out) and `"deal_unavailable"` (the deal is inactive, outside its window or gone). A deal with a sold-out dish is `"sold_out"`. `unavailableMessage` is a sentence you can show.
- Carts saved before extras and deals existed (`{ itemId, quantity, note }`) still work unchanged.
- If `hasUnavailableItems` is true, show it to the waiter and let them drop or replace those lines before submitting.

| Status | `error` | `details` |
| --- | --- | --- |
| 400 | `Cart codes are 6 letters and numbers, like ACD347.` | `{ field: "cartCode" }` |
| 404 | `We couldn’t find cart ACD347. Check the code, or ask the guest to show it again.` | |
| 409 | `This cart was already entered as order #92da2e.` | `{ orderId, shortId }`: offer to open that order |
| 410 | `This code has expired. Ask the guest to tap “Ready to order” again.` | |

### `POST /api/ops/orders` (staff): confirm an order

"Confirm order" after checking it with the guest. The new order is `taken` ("Confirmed"), confirmed by the caller, with `confirmation` set by the server: `qr` or `code` with a `cartCode` (from `via`), `manual` without one. The guest's cart is claimed, which clears its "ready to order" item and turns the guest's phone to "Order confirmed ✓".

```json
{
  "tableNumber": 7,
  "items": [{ "itemId": "…", "quantity": 2, "note": "Extra spicy" }],
  "note": "Birthday",
  "cartCode": "ACD347",
  "via": "scan"
}
```

| Field | Rules |
| --- | --- |
| `items` | 1–50 lines, the same shapes as cart lines: a dish `{ itemId, quantity?, note?, extraIds? }` or a deal `{ dealId, quantity?, note? }`, with quantities 1–50. **With `cartCode`, you may omit `items` or send `[]` to import the cart's items as they are** (extras and deals included). Send `items` explicitly if the waiter edited them. |
| `tableNumber` | An existing table. **With `cartCode`, if omitted, the cart's table is used.** Send `null` for takeaway (no table). |
| `note` | Optional, up to 280 characters. |
| `cartCode` | Optional. Imports and **claims** the guest's cart. The order gets `source: "guest_cart"`; otherwise `source` is `"waiter"` and `confirmation` is `"manual"`. |
| `via` | With `cartCode`: `"scan"` (the guest's QR was scanned, `confirmation: "qr"`) or `"typed"` (the code was typed, `confirmation: "code"`; the default). Ignored without `cartCode`. Anything else: 400 `via must be scan or typed.` |

**200**: `{ "order": Order }` with a `timeline`. See [§12](#12-shared-object-shapes). Every line is priced on the server from the current menu, and the chosen extras (`[{ id, name, price }]`) and a deal's dishes (`components`) are **snapshotted** on the order, so later menu changes never alter it.

| Status | `error` |
| --- | --- |
| 400 / 409 | Extra and deal errors, as for carts (`reason`: `extra_missing`, `extra_sold_out`, `missing`, `sold_out`, `deal_unavailable`) |
| 400 | `Choose a table, or send tableNumber: null for takeaway.` (`field: "tableNumber"`) |
| 400 | Line errors as for carts, with limits of 50. `One of the dishes is no longer on the menu.` |
| 400 | `Cart codes are 6 letters and numbers, like ACD347.` |
| 404 | `Table 14 doesn’t exist here.` / cart not found |
| 409 | `Chicken wings is sold out.` (`details.reason: "sold_out"`, `itemId`, `index`) |
| 409 | `This cart was already entered as order #92da2e.` / `Someone just entered this cart. Check the orders list.` |
| 410 | Cart expired |

### `GET /api/ops/orders` (staff): list and search

| Query | Meaning |
| --- | --- |
| `status` | Comma list, for example `taken,accepted,served` or `paid`. |
| `tableNumber` | Exact table. Matches the table number snapshot on the order, so it still works after a table is deleted. |
| `from`, `to` | Filter on when the order was taken (`createdAt`). Use `YYYY-MM-DD` (a Nairobi day) or an ISO time. `from` is inclusive. A date-only `to` includes that whole day; an ISO `to` is exclusive. |
| `q` | Short id search, with or without `#`: `92da2e`, `#92d`. Prefix match on 1–6 hex characters. |
| `limit`, `offset` | Pagination. `limit` 1–100 (default 50), `offset` ≥ 0 (default 0). |

Results are newest first.

**200**

```json
{ "orders": [ /* Order objects, no timeline */ ], "total": 132, "limit": 50, "offset": 0, "hasMore": true }
```

**Errors**
- 400 `status must be a comma list of taken, accepted, served, paid, cancelled.`
- 400 `Search by order number, like 92da2e.`
- 400 `limit must be between 1 and 100.` / `offset must be 0 or more.`
- 400 `from must be a date like 2026-10-31 or an ISO time.`

### `GET /api/ops/orders/:id` (staff)

**200**: `{ "order": Order }` with `timeline`. 404 `That order doesn’t exist.`

The client's sample screen maps onto the order object like this:

```
Table 7 · #92da2e · Confirmed · Placed 31 Oct 10:45  ← table.number, shortId, statusLabel, takenAt
Items   1× Chicken Wings  Ksh750                      ← items[] (quantity, name, lineTotal)
        1× Classic Beef Burger · + Cheese  Ksh1,100   ← items[].extras
        1× Burger meal  Ksh1,150                      ← kind: "deal"; components[] underneath
           Classic beef burger, Chips, Stoney
What happened                                         ← timeline[]
  Confirmed with the guest by Jane at 10:45 (QR)      ← { stage: "taken", label: "Confirmed", confirmation: "qr", at, by }
  Served    Not yet                                   ← at: null
  Paid      Not yet
Next step: Mark served · Cancel order                 ← nextAction: "serve", canCancel: true

A manual order reads "Entered by Jane at 10:45" with a "Not confirmed by the guest" tag (label: "Entered").
```

### `POST /api/ops/orders/:id/advance` (staff)

Body: `{ "from": "taken" }`. `from` is optional but recommended (see the state machine). "Mark served": the order moves taken → served (older `accepted` orders: accepted → served).

**200**: `{ "order": Order }` with `timeline`.

| Status | `error` | `details` |
| --- | --- | --- |
| 409 | `This order has been served. Mark it paid to finish.` | `{ status: "served" }` |
| 409 | `This order is already paid.` / `This order was cancelled.` | `{ status }` |
| 409 | `This order just changed: it’s served now. Refresh to see the latest.` | `{ status }` (your `from` was stale, or there was a race) |
| 400 | `from must be taken, accepted, served, paid or cancelled.` | `{ field: "from" }` |
| 404 | `That order doesn’t exist.` | |

### `POST /api/ops/orders/:id/pay` (staff)

Body: `{ "method": "cash" | "mpesa" | "card" | "other", "reference": "SKL4ABC12X", "from": "served" }`

- `method` is required. It is case-insensitive, and spaces and dashes are ignored, so `"M-Pesa"` becomes `mpesa`.
- `reference` is optional, up to 60 characters: an M-Pesa code, card slip number and so on.
- The order is set to `paid`, and a succeeded `manual` payment for the order total is recorded.
- No payment provider is called.

**200**: `{ "order": Order }`. `order.payment` is now:

```json
{ "status": "paid", "method": "mpesa", "reference": "SKL4ABC12X", "amount": 1650, "provider": "manual", "paidAt": "…" }
```

**Errors**
- 400 `Choose how they paid: cash, mpesa, card or other.` (`field: "method"`)
- 409 `Serve this order before marking it paid.` (`details.status`)
- 409 `This order is already paid.` / `This order was cancelled.`
- 409 stale `from`
- 404 `That order doesn’t exist.`

### `POST /api/ops/orders/:id/cancel` (staff, with rules)

Body: `{ "reason": "Guest left", "from": "taken" }`. `reason` is optional, up to 200 characters.

**200**: `{ "order": Order }`, with `status: "cancelled"`, `cancelledBy`, `cancelledAt` and `cancelReason`.

| Status | `error` |
| --- | --- |
| 403 | `This order has been served, so only a manager can cancel it now.` (the waiter who confirmed it, after it was served) |
| 403 | `Only a manager, or the waiter who took it, can cancel this order.` |
| 409 | `A paid order can’t be cancelled.` / `This order is already cancelled.` / stale `from` |
| 404 | `That order doesn’t exist.` |

---

## 6. Tables

### `GET /api/ops/tables` (staff)

**200**

```json
{
  "tables": [
    {
      "id": "…", "number": 7, "label": null, "section": { "id": "…", "name": "Indoor" },
      "state": "ordering", "requestTypes": [],
      "scans": { "last7Days": 18, "allTime": 64 },
      "revenue": { "last30Days": 48200, "allTime": 61350 },
      "ordersLast30Days": 21,
      "openOrders": 1,
      "lastScanAt": "2026-10-31T07:41:00.000Z",
      "guestMenuPath": "/guest-menu?r=106fe2fb-…&t=7"
    }
  ],
  "sections": [{ "id": "…", "name": "Indoor", "position": 0 }]
}
```

- "last7Days" and "last30Days" are rolling windows ending now.
- Revenue is paid order totals, counted by when they were paid.
- For the full guest URL or a QR, prefix `guestMenuPath` with `window.location.origin`, as `guestMenuUrl()` in `lib/onboarding.js` does.

### `POST /api/ops/tables` (managers)

Send **one** of:
- `{ "count": 3 }` adds 3 tables after the highest number (1–50 at a time);
- `{ "number": 15 }` adds table 15.

Optionally include `"sectionId": "…"`.

**200**

```json
{ "tables": [{ "id": "…", "number": 13, "label": null, "sectionId": null, "guestMenuPath": "/guest-menu?r=…&t=13" }], "total": 13 }
```

**Errors**
- 400 `Send either count (add that many tables) or number (add one table).`
- 400 `Add between 1 and 50 tables at a time.`
- 400 `Table numbers can’t go above 999.`
- 400 `You can have up to 200 tables. Contact Cravio for more.`
- 400 `That section doesn’t exist.`
- 409 `Table 15 already exists.`
- 403 for waiters.

### `DELETE /api/ops/tables/:number` (managers)

**204** on success.
- 409 `Table 7 has 2 unpaid orders. Finish or cancel them first.` (`details.openOrders`)
- 404 `Table 7 doesn’t exist here.`
- 403 for waiters.

When a table is deleted:
- its past orders keep their `table.number`, and `table.id` becomes `null`;
- its unresolved requests are removed.

### `GET /api/ops/tables/:number` (staff)

**200**

```json
{
  "table": { "id": "…", "number": 7, "label": null, "section": { "id": "…", "name": "Indoor" }, "state": "free", "guestMenuPath": "/guest-menu?r=…&t=7" },
  "totals": {
    "scans": { "last7Days": 18, "allTime": 64 },
    "revenue": { "last30Days": 48200, "allTime": 61350 },
    "ordersLast30Days": 21, "openOrders": 0, "lastScanAt": "…"
  },
  "scansByDay": [{ "date": "2026-10-18", "scans": 4, "orders": 2, "sales": 3100 }],
  "recentOrders": [ /* up to 10 Order objects, newest first, no timeline */ ],
  "requests": [ /* this table's unresolved requests (staff request shape) */ ]
}
```

- `scansByDay` always has 14 entries: the last 14 Nairobi days, oldest first, including today.
- Each entry also carries that day's orders and sales for the table.

---

## 7. Analytics

### `GET /api/ops/analytics?range=today|7d|30d|90d&sort=<key>&dir=<asc|desc>` (managers)

The default range is `today`. `sort` and `dir` order `dishPerformance` only: `sort` is `sales` (default), `quantity`, `views`, `plays`, `conversion` or `name`; `dir` defaults to `desc` (`asc` for `name`).

| range | Current period | Previous period (for deltas) | Series |
| --- | --- | --- | --- |
| `today` | Nairobi midnight → now | The same span yesterday (midnight → this time yesterday) | Hourly, from 00:00 to the current hour |
| `7d` | Midnight 6 days ago → now (7 days including today) | The 7 days before, shifted back exactly 7 days | 7 daily points |
| `30d` | Midnight 29 days ago → now | The 30 days before, shifted back 30 days | 30 daily points |
| `90d` | Midnight 89 days ago → now | The 90 days before, shifted back 90 days | 90 daily points |

**200**

```json
{
  "range": "7d", "timeZone": "Africa/Nairobi", "currency": "KES",
  "from": "2026-10-24T21:00:00.000Z", "to": "2026-10-31T07:50:00.000Z",
  "previousFrom": "2026-10-17T21:00:00.000Z", "previousTo": "2026-10-24T07:50:00.000Z",
  "totals": {
    "menuScans": 169, "orders": 75, "sales": 149490,
    "openBills": { "count": 6, "amount": 9800 },
    "tablesServed": 12, "paidOrders": 69, "cancelledOrders": 3
  },
  "previousTotals": {
    "menuScans": 152, "orders": 70, "sales": 138200,
    "openBills": null,
    "tablesServed": 12, "paidOrders": 66, "cancelledOrders": 2
  },
  "kpis": {
    "menuScans":    { "value": 609, "previous": 540, "delta": 69, "deltaPercent": 12.8, "isNew": false },
    "dishViews":    { "value": 1284, "previous": 0, "delta": 1284, "deltaPercent": null, "isNew": true },
    "viewsPerScan": { "value": 2.11, "previous": 0, "delta": 2.11, "deltaPercent": null, "isNew": true },
    "videoPlays":   { "value": 142, "previous": 0, "delta": 142, "deltaPercent": null, "isNew": true },
    "orders":       { "value": 293, "previous": 270, "delta": 23, "deltaPercent": 8.5, "isNew": false },
    "averageOrder": { "value": 2152.4, "previous": 2088.1, "delta": 64.3, "deltaPercent": 3.1, "isNew": false,
                      "basis": "Paid sales ÷ paid orders in the period (by time paid)." },
    "paidSales":    { "value": 580000, "previous": 532000, "delta": 48000, "deltaPercent": 9, "isNew": false }
  },
  "seriesUnit": "day",
  "series": [{ "start": "2026-10-24T21:00:00.000Z", "label": "2026-10-25", "scans": 27, "orders": 13, "sales": 22100 }],
  "busyHours": {
    "hours": [{ "hour": 0, "label": "00:00", "scans": 0, "orders": 0 }, "… 24 entries …", { "hour": 20, "label": "20:00", "scans": 269, "orders": 142 }],
    "peakHour": { "hour": 20, "label": "20:00", "scans": 269, "orders": 142 },
    "peakBy": "orders"
  },
  "bestSellers": [{ "itemId": "…", "name": "Tusker lager", "quantity": 53, "revenue": 18550 }],
  "dishPerformance": [
    { "kind": "item", "id": "…", "itemId": "…", "name": "Classic beef burger", "categoryId": "…", "categoryName": "Mains", "price": 950, "available": true, "photoUrl": "…",
      "views": 153, "videoPlays": 13, "orderedQuantity": 240, "directQuantity": 200, "dealQuantity": 40,
      "sales": 241206.06, "directSales": 208100, "dealSales": 33106.06, "conversionRate": 1.57 },
    { "kind": "deal", "id": "…", "dealId": "…", "name": "Burger meal",
      "views": 37, "videoPlays": 0, "orderedQuantity": 40, "directQuantity": 40, "dealQuantity": 0,
      "sales": 46000, "directSales": 46000, "dealSales": 0, "conversionRate": 1.08 }
  ],
  "dishPerformanceSort": { "sort": "sales", "dir": "desc" },
  "soldOut": [{ "id": "…", "name": "Whole tilapia", "price": 1200, "categoryId": "…", "categoryName": "Mains" }],
  "topTablesByScans": [{ "tableId": "…", "number": 7, "scans": 31 }],
  "topTablesByRevenue": [{ "tableId": "…", "number": 7, "revenue": 18400, "orders": 9 }],
  "summary": "609 menu scans led to 293 orders; the busiest hour is 20:00."
}
```

| Metric | Definition |
| --- | --- |
| `menuScans` | Logged guest menu opens in the period (deduped per visitor and table for 30 minutes) |
| `orders` | Orders taken in the period, excluding cancelled ones |
| `sales` | Sum of `total` of orders **paid** in the period (by `paidAt`) |
| `openBills` | **Right now** (not period-based): the count and amount of unpaid orders (`taken`, `accepted`, `served`). `previousTotals.openBills` is always `null`. |
| `tablesServed` | Distinct tables with at least one non-cancelled order taken in the period |
| `series[].label` | `YYYY-MM-DD` for days, `HH:00` for hours, in Nairobi time. `start` is the bucket's start instant. |
| `bestSellers` | Top 5 dishes by quantity in non-cancelled orders taken in the period, with line revenue |
| `soldOut` | Every item currently marked unavailable |
| `topTablesByScans` / `topTablesByRevenue` | Top 5 current tables in the period. Tables with zero are left out. |
| `kpis.*` | Headline numbers with the previous period: `delta = value − previous`; `deltaPercent` is a percentage with one decimal, or `null` when `previous` is 0; **`isNew: true` when the previous period had nothing and this one has something** (show "New" instead of a percentage). |
| `kpis.menuScans` / `kpis.orders` | Same as `totals.menuScans` / `totals.orders`. |
| `kpis.dishViews` | Dish sheets opened (`dish_view` events, deduped per visitor and dish for 10 minutes). |
| `kpis.viewsPerScan` | `dishViews ÷ menuScans`, 2 decimals (0 when there were no scans). |
| `kpis.videoPlays` | Dish videos started. |
| `kpis.averageOrder` | **Paid sales ÷ paid orders**, both by time paid (`basis` says so). Cancelled and unpaid orders don't count. 0 when nothing was paid. |
| `kpis.paidSales` | Same as `totals.sales`: totals of orders paid in the period. |
| `busyHours` | 24 entries, one per hour of the day **in Nairobi time**, with scans and non-cancelled orders (by time taken) **summed over the whole range**. `peakHour` is the hour with the most orders (ties: more scans); if there were no orders, the most scans (`peakBy: "scans"`); `null` when both are empty. |
| `series` | Unchanged: one point per hour (`today`) or per day, with scans, orders and paid sales. 90 points for `90d`. |
| `dishPerformance` | **Every current dish** (including sold-out ones and dishes with zero) **and every deal**, for non-cancelled orders taken in the period. For a dish: `directQuantity` = sold on its own; `dealQuantity` = units inside deals sold (deal quantity × units per deal); `orderedQuantity` = both. `directSales` = its own lines' totals **including extras**; `dealSales` = each deal line's total split across its dishes in proportion to their regular prices at the time of the order; `sales` = both. For a deal row, `orderedQuantity`/`sales` are the deal lines themselves. `views` = dish views (deal views for deals); `conversionRate = orderedQuantity ÷ views` (2 decimals) or `null` with no views. **Don't add dish and deal rows together**: deal revenue appears in both. Sorted by `sort`/`dir`, ties by sales, then quantity, then name. |
| `summary` | One sentence for the top of the page, e.g. `609 menu scans led to 293 orders; the busiest hour is 20:00.` (`No menu scans or orders yet in this period.` when empty). |

Compute deltas on the client for `totals` if you still use them:
- `delta = totals.x − previousTotals.x`;
- show a percentage only when the previous value is above 0.

Errors:
- 400 `range must be today, 7d, 30d or 90d.`
- 400 `sort must be one of sales, quantity, views, plays, conversion, name.` / `dir must be asc or desc.`
- 403 `Only owners and managers can do this.` for waiters.

---

## 8. System health

### `GET /api/ops/health` (managers)

**200**

```json
{
  "status": "ok",
  "checkedAt": "2026-10-31T07:50:00.000Z",
  "checks": [
    { "key": "api", "label": "Cravio server", "status": "ok", "detail": "Responding normally." },
    { "key": "database", "label": "Database", "status": "ok", "detail": "Answered in 84 ms." },
    { "key": "menu", "label": "Guest menu", "status": "ok", "detail": "Live with 12 dishes available." },
    { "key": "scans", "label": "Menu scans", "status": "ok", "detail": "Guests are opening your menu." },
    { "key": "orders", "label": "Orders", "status": "ok", "detail": "Staff are entering orders." },
    { "key": "staff", "label": "Staff", "status": "ok", "detail": "3 active, 1 invited." },
    { "key": "soldOut", "label": "Sold out", "status": "ok", "detail": "2 dishes are marked sold out." }
  ],
  "api": { "ok": true },
  "database": { "ok": true, "latencyMs": 84 },
  "menu": { "live": true, "restaurantStatus": "live", "availableItems": 12, "unavailableItems": 2 },
  "lastScanAt": "2026-10-31T07:41:00.000Z",
  "lastOrderAt": "2026-10-31T07:47:00.000Z",
  "staff": { "active": 3, "invited": 1, "suspended": 0, "total": 4 },
  "pendingInvites": { "queued": 0, "failed": 0, "total": 0 },
  "unavailableItems": 2
}
```

- `status` is `warning` if any check is `warning`. Otherwise it is `ok`.
- **Warnings are raised when:**
  - the database is slow (1000 ms or more) or doesn't answer;
  - the restaurant isn't live, or every dish is sold out;
  - no menu scan in 7 days at a live restaurant;
  - a staff invite failed.
- `staff` counts members other than the owner. Their status is `invited` until they first sign in.
- Render `checks` as a friendly list; the other fields are there for custom layouts.

---

## 9. Menu management

These endpoints are for the Products and Menu configuration pages. They live in `routes/restaurant.js`. **Only owners and managers** can call them; waiters get `403 "You do not have access to this."`.

**Item object** (as returned by every endpoint below):

```json
{
  "id": "…", "categoryId": "…", "name": "Chicken wings", "description": "…", "price": 750, "currency": "KES",
  "photoUrl": "https://…/items/<uuid>.jpg", "position": 0, "available": true, "source": "manual",
  "videoUrl": null, "videoPosterUrl": null, "videoDurationSeconds": null,
  "featured": false, "featuredPosition": null
}
```

`featured` and `featuredPosition` are `false`/`null` until migration 004 is applied. For extras, pairings, deals and per-dish numbers use `GET /api/restaurant/menu` ([§14](#14-menu-merchandising-owners-and-managers)).

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/restaurant/onboarding` | none | Everything for the menu editor: `{ restaurant, sections, tables, categories, items, invites, progress, steps, role }`. Items include the video fields. |
| `PATCH /api/restaurant` | Any of `name, kind, area, address, lat, lng, openingHours, phone, logoUrl, coverUrl, theme` | `{ restaurant }` |
| `POST /api/restaurant/categories` | `{ name }` (up to 40 characters; up to 20 categories) | `{ category: { id, name, position } }` |
| `PATCH /api/restaurant/categories/:id` | `{ name?, position? }` | `{ category }` |
| `DELETE /api/restaurant/categories/:id` | none | 204. **Deletes the category's items.** |
| **`PUT /api/restaurant/categories/order`** (new) | `{ ids: [every category id, in the new order] }` | `{ categories }` sorted by position |
| `POST /api/restaurant/items` | `{ categoryId, name, price, description?, photoUrl?, available?, position?, videoUrl?, videoPosterUrl?, videoDurationSeconds? }` | `{ item }` |
| `POST /api/restaurant/items/bulk` | `{ items: [ … up to 60 ] }`, with no video fields | `{ items }` |
| `PATCH /api/restaurant/items/:id` | Any of `name, price, description, photoUrl, available, position, categoryId, videoUrl, videoPosterUrl, videoDurationSeconds, featured` | `{ item }`. `featured: true` appends the dish to the end of the featured list (400 when 10 are already featured); `false` removes it. Needs 004. |
| `DELETE /api/restaurant/items/:id` | none | 204. Also removes the dish from pairings, extras and deals (a deal left with fewer than 2 units is flagged `too_few_items` and hidden from guests). Orders keep their snapshots. |
| **`PUT /api/restaurant/items/order`** (new) | `{ categoryId, ids: [item ids in order] }` | `{ categoryId, items }`: that category's items by position |

**Sold-out toggle.** `PATCH /api/restaurant/items/:id { "available": false }` marks an item sold out; `true` brings it back. Sold-out items:
- disappear from the guest menu (and from featured, pairings, and every deal that contains them, until they're back);
- can't be added to carts or orders (409);
- appear in `analytics.soldOut`.

Every write on this page (and in §14–15) takes effect on the guest menu immediately.

**Moving and reordering items**
- `PUT /api/restaurant/items/order` puts the listed items into `categoryId`, at positions 0, 1, 2 … in the order given. Items listed from another category are moved in.
- Items already in that category but not listed keep their relative order after the listed ones.
- To move a single item to the end of another category, use `PATCH /api/restaurant/items/:id { "categoryId": "…" }` without a `position`.

**Category reorder.** Send every category id exactly once. Otherwise you get `400 "Send every category once, in the new order. Refresh and try again."`.

**Video field rules** (PATCH or POST items)

| Rule | Error (400) |
| --- | --- |
| `videoUrl` must be a public URL in this restaurant's folder of the `restaurant-media` bucket (`…/storage/v1/object/public/restaurant-media/<restaurantId>/…`) | `The video must be uploaded to this restaurant.` / `The video must be an uploaded video.` |
| `videoUrl` must end in `.mp4`, `.webm` or `.mov` | `The video must be an MP4, WebM or MOV file.` |
| `videoPosterUrl` must be an image in the same folder (`.jpg/.jpeg/.png/.webp/.gif/.avif`) | `The video poster must be an image.` |
| `videoDurationSeconds` must be a number > 0 and ≤ 15. It is rounded to 0.1. | `Videos can be up to 15 seconds. Trim it and try again.` / `The video length must be a number of seconds.` |
| A video needs its duration, either in the same request or already saved | `Send the video’s length in seconds (15 or less).` |
| A poster or duration without a video | `Add the video first, then its poster and length.` |
| `videoUrl: null` removes the video **and** clears the poster and duration | none |

The server can't inspect the file. The browser must measure the duration (see §10) and send it.

---

## 10. Dish photos and videos: storage

Uploads go **directly from the browser** to Supabase Storage, with the signed-in owner's or manager's session. The bucket's policies only allow writes under the caller's own restaurant folder. Then save the public URL on the item with `PATCH /api/restaurant/items/:id`.

| What | Path in the `restaurant-media` bucket | Types | Size limit |
| --- | --- | --- | --- |
| Dish photo | `<restaurantId>/items/<uuid>.<jpg|png|webp|gif|avif>` | image/jpeg, png, webp, gif, avif | **5 MB**, enforced in the browser (`MAX_UPLOAD` in `lib/onboarding.js`) |
| Dish video | `<restaurantId>/videos/<uuid>.<mp4|webm|mov>` | video/mp4, video/webm, video/quicktime | **25 MB**, enforced by the bucket and the browser |
| Video poster | `<restaurantId>/posters/<uuid>.<jpg|png|webp>` | image types | 5 MB |
| Logo / cover (existing) | `<restaurantId>/logo/…`, `<restaurantId>/cover/…` | image types | 5 MB |
| **Deal photo** (new) | `<restaurantId>/deals/<uuid>.<jpg|png|webp|gif|avif>` | image types | 5 MB |

- **After migration 004** the bucket only accepts these folders: `logo`, `cover`, `items`, `videos`, `posters`, `deals` (and `design`, reserved for Studio assets). Any other folder is refused by the storage policy. Upload deal photos with `uploadMedia(restaurantId, 'deals', file, …)`; the API rejects a deal `photoUrl` outside `<restaurantId>/deals/` (`400 The deal photo must be uploaded to this restaurant.`).

- The bucket allows up to 25 MB for any file, so the 5 MB image limit is the browser's job.
- Keep `imageFileError()` for images.
- Add an equivalent check for video files.

Suggested video upload, mirroring `uploadImage()`:

```js
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const MAX_VIDEO = 25 * 1024 * 1024;

function videoDuration(file) {               // seconds, measured in the browser
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => { URL.revokeObjectURL(video.src); resolve(video.duration); };
    video.onerror = () => reject(new Error('That video can’t be read. Try an MP4.'));
    video.src = URL.createObjectURL(file);
  });
}

async function uploadVideo(restaurantId, file) {
  if (!VIDEO_TYPES[file.type]) throw new Error('Use an MP4, WebM or MOV video.');
  if (file.size > MAX_VIDEO) throw new Error('That video is over 25 MB. Trim or compress it.');
  const seconds = await videoDuration(file);
  if (!(seconds > 0) || seconds > 15) throw new Error('Videos can be up to 15 seconds.');
  const path = `${restaurantId}/videos/${crypto.randomUUID()}.${VIDEO_TYPES[file.type]}`;
  const { error } = await supabase.storage.from('restaurant-media')
    .upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return { videoUrl: supabase.storage.from('restaurant-media').getPublicUrl(path).data.publicUrl, videoDurationSeconds: Math.round(seconds * 10) / 10 };
}
// then: api(`/api/restaurant/items/${id}`, { method: 'PATCH', body: { videoUrl, videoDurationSeconds, videoPosterUrl } })
```

- A poster is optional but recommended: a frame grabbed to a canvas, or an uploaded image, saved under `posters/`.
- On the guest menu, play videos `muted playsinline loop` with `poster={videoPosterUrl || photoUrl}`.
- Deleting or replacing an item's video doesn't delete the old file from storage.

---

## 11. Polling guidance

**Waiter and owner live screens (`/api/ops/live`)**
- Poll every **10 seconds** with `?since=<last cursor>`.
  - On `changed: false`, keep the current data and only refresh "age" labels.
  - On `changed: true`, replace everything with the response.
- Pause polling while `document.visibilityState === 'hidden'`, and poll immediately when the tab becomes visible.
- After your own mutation (acknowledge, advance, pay, create order and so on), call `/api/ops/live` immediately **without** `since`, or apply the returned object locally and then poll.
- **On errors**, back off: 10s, 20s, 40s, then 60s maximum.
  - Show a quiet "Reconnecting…" state.
  - On `401`, the session expired: send the user to sign in.
- When nothing changed, one poll costs one small database query (the signed-in context is cached for 30 seconds; see [§16](#16-speed-caching-compression-and-timing)), so every 10 seconds per device is fine.

**Other staff screens**
- **Orders list, tables, table detail:** fetch on open and on Refresh. Optionally re-fetch when `/api/ops/live` reports `changed: true`.
- **Analytics and health:** fetch on open and on Refresh. Don't poll faster than once a minute.

**Guest phone**
- The menu: fetch once on open. If you refetch (pull to refresh, returning to the tab), send the last `ETag` as `If-None-Match`; a `304` means keep what you have. Browsers do this for you because the response is `no-cache` with an `ETag`.
- Events: batch them and send at most every ~10 seconds, plus on `visibilitychange` (hidden). See `POST /api/public/events`.
- After sending a request, poll `GET /api/public/requests` every **10–15 seconds** while the list is non-empty. Stop when it's empty, or after 30 minutes.
- **After "Ready to order":** poll `GET /api/public/carts/:code/status` about every **5 seconds** while the code is pending (paused while hidden). Stop on `confirmed` (show "Order confirmed ✓" and reset the cart) or `expired`. A later save of a confirmed cart also returns `409 { reason: "claimed" }`.

---

## 12. Shared object shapes

### Order

```json
{
  "id": "92da2e4b-1c55-4c3e-9e0a-6a1f0d6d1e11",
  "shortId": "92da2e",
  "status": "taken",
  "statusLabel": "Confirmed",
  "table": { "id": "…", "number": 7 },
  "note": null,
  "items": [
    { "id": "…", "kind": "item", "itemId": "…", "dealId": null, "name": "Chicken wings", "unitPrice": 750,
      "extras": [], "extrasTotal": 0, "unitTotal": 750, "quantity": 1, "note": null, "lineTotal": 750, "components": null }
  ],
  "itemCount": 1,
  "subtotal": 750,
  "total": 750,
  "currency": "KES",
  "source": "guest_cart",
  "confirmation": "qr",
  "confirmationLabel": "Confirmed with the guest (QR)",
  "takenAt": "2026-10-31T07:45:00.000Z", "takenBy": { "id": "…", "name": "Waiter" },
  "acceptedAt": null, "acceptedBy": null,
  "servedAt": null, "servedBy": null,
  "paidAt": null, "paidBy": null,
  "cancelledAt": null, "cancelledBy": null, "cancelReason": null,
  "payment": { "status": "unpaid", "method": null, "reference": null, "amount": null, "paidAt": null },
  "nextAction": "serve",
  "canCancel": true,
  "createdAt": "2026-10-31T07:45:00.000Z",
  "updatedAt": "2026-10-31T07:45:00.000Z",
  "timeline": [
    { "stage": "taken", "label": "Confirmed", "confirmation": "qr", "at": "2026-10-31T07:45:00.000Z", "by": { "id": "…", "name": "Waiter" } },
    { "stage": "served", "label": "Served", "at": null, "by": null },
    { "stage": "paid", "label": "Paid", "at": null, "by": null }
  ]
}
```

- `table` is `null` for takeaway.
- After a table is deleted, `table.id` is `null` but `table.number` remains.
- `items[].itemId` is `null` if the dish was later deleted. `name` and `unitPrice` are always the snapshot from when the order was taken.
- **Order line** (`items[]`): `kind` is `"item"` (a dish) or `"deal"`.
  - `extras`: the chosen extras as they were priced, `[{ id, name, price }]` (`[]` when none, and for every line saved before migration 004). `extrasTotal` = their sum; `unitTotal = unitPrice + extrasTotal`; `lineTotal = unitTotal × quantity`.
  - Deal lines: `itemId` is `null`, `dealId` is the deal (or `null` if it was deleted later), `name`/`unitPrice` are the deal's, and `components` is the snapshot of its dishes per one deal: `[{ itemId, name, quantity, unitPrice }]` (`unitPrice` = each dish's regular price at the time). `components` is `null` for dish lines.
  - `itemCount` sums line quantities (a deal counts as 1 per quantity).
- `timeline` is included by `GET /api/ops/orders/:id` and by every mutation (create, advance, pay, cancel). It is not included in lists or on the live screen.
- Staff in `takenBy` and the other `…By` fields have the shape `{ id, name }`. `name` is `"Former staff"` if the profile is gone.
- `payment.status` is `"paid"` or `"unpaid"`. When paid, it also carries `method`, `reference`, `amount`, `provider` and `paidAt`.
- `source` is `"waiter"` (typed in) or `"guest_cart"` (imported from a guest's cart).
- `confirmation` is `"qr"`, `"code"`, `"manual"` or `null` (before migration 005, or older orders); `confirmationLabel` is the matching sentence (or `null`). See the state machine.
- `timeline` has three steps: `taken` (label `"Confirmed"`, or `"Entered"` for a manual order, with `confirmation`), `served`, `paid`. Older orders' accepted step isn't listed.

### Staff request

```json
{
  "id": "…", "type": "call_waiter", "typeLabel": "Call waiter", "status": "open",
  "table": { "id": "…", "number": 4 },
  "createdAt": "…", "ageSeconds": 42,
  "acknowledgedAt": null, "acknowledgedBy": null, "resolvedAt": null, "resolvedBy": null
}
```

### Guest request

`{ id, type, typeLabel, status, createdAt, acknowledgedAt }`

---

## 13. Error reference

| Status | When | What the UI should do |
| --- | --- | --- |
| 400 | Invalid input. `details.field` names the input; `details.index` names the line for item lists. | Show `error` next to the field |
| 401 | `Please sign in to continue.` / `Your session expired. Please sign in again.` | Go to sign-in |
| 403 | `You do not have access to this.`, `Only owners and managers can do this.`, `You aren’t part of a restaurant yet. Ask your manager to add you.`, cancel rules, `Your access has been suspended…` | Show the message; hide the control for that role |
| 404 | The thing doesn't exist **or belongs to another restaurant**: `That order doesn’t exist.`, `That request doesn’t exist.`, `Table 7 doesn’t exist here.`, `This menu isn’t available.`, cart not found | Show the message; refresh the list |
| 409 | State conflicts: invalid order transitions, stale `from`, sold-out dishes (`details.reason: "sold_out"`), cart already entered (`details.reason: "claimed"` for guests; `details.orderId/shortId` for staff), duplicate table, table with unpaid orders | Show the message, refresh, and offer the obvious next step |
| 410 | Guest cart expired (staff lookup or import) | Ask the guest to show the cart again |
| 413 | `Request is too large.` (body over 1 MB) | |
| 429 | Public rate limit; `details.retryAfterSeconds` | Show the message; disable the button for that long |
| 503 | `Something went wrong. Please try again.`, or `Live operations aren’t available yet…` before migration 003, or `Menu extras, pairings and deals aren’t available yet…` before migration 004 | Retry with backoff; hide merchandising UI on the 004 message |

---

## 14. Menu merchandising (owners and managers)

These endpoints live in `routes/menu-merch.js` and need migration 004. **Only owners and managers**; waiters get `403 "Only owners and managers can do this."`. Every write takes effect on the guest menu immediately. Ids of another restaurant's dishes, extras or deals behave as if they didn't exist (400 or 404).

| Limit | Value |
| --- | --- |
| Pairings per dish | 6 |
| Extras per dish | 12 (a cart line can choose up to 10) |
| Featured dishes | 10 |
| Deals per restaurant | 50 |
| Different dishes per deal | 10 (each with quantity 1–20; at least 2 units in total) |

### `GET /api/restaurant/menu`: everything for the menu and merchandising screens

**200**

```json
{
  "categories": [{ "id": "…", "name": "Mains", "position": 0 }],
  "items": [{
    "id": "…", "categoryId": "…", "name": "Classic beef burger", "description": "…", "price": 950, "currency": "KES",
    "photoUrl": "…", "position": 0, "available": true, "source": "manual",
    "videoUrl": null, "videoPosterUrl": null, "videoDurationSeconds": null,
    "featured": true, "featuredPosition": 1,
    "extras": [{ "id": "…", "itemId": "…", "name": "Cheese", "price": 150, "position": 0, "available": true }],
    "pairedItemIds": ["<Chips id>"],
    "stats30d": { "views": 153, "videoPlays": 13, "orderedQuantity": 81, "sales": 80412.5 }
  }],
  "featuredItemIds": ["<Nyama choma id>", "<Classic beef burger id>"],
  "deals": [ /* Deal objects (below), each with stats30d */ ],
  "limits": { "pairingsPerDish": 6, "extrasPerDish": 12, "extrasPerLine": 10, "featured": 10, "deals": 50, "dealComponents": 10 }
}
```

- `items` are in category order, then position. All extras are listed, including unavailable ones (`available: false`).
- `pairedItemIds` lists every pairing, including sold-out targets (guests only see available ones).
- `stats30d` (dishes and deals): the last 30 days, as defined for `dishPerformance` in [§7](#7-analytics): dish views, video plays, units ordered (alone and inside deals) and sales.

### Featured

| Method and path | Body | Returns |
| --- | --- | --- |
| `PUT /api/restaurant/featured` | `{ itemIds: [up to 10 dish ids, in order] }`; `[]` clears | `{ featuredItemIds }` |
| `PATCH /api/restaurant/items/:id` | `{ featured: true \| false }` | `{ item }` (appends / removes one dish) |

Errors: 400 `Choose up to 10 featured dishes.`, `Each of the featured dishes can appear only once.`, `One of those dishes no longer exists. Refresh and try again.`; `You can feature up to 10 dishes. Unfeature one first.` on PATCH.

### Pairings ("Goes well with")

| Method and path | Body | Returns |
| --- | --- | --- |
| `PUT /api/restaurant/items/:id/pairings` | `{ itemIds: [up to 6 dish ids, in order], mirror?: boolean }` | `{ itemId, pairedItemIds, mirroredItemIds }` |
| `DELETE /api/restaurant/items/:id/pairings/:pairedItemId` | none | 204 |

- `PUT` **replaces** the dish's list, in the order given (that's also how you reorder). `[]` clears it.
- Pairings are one-way: "Chips goes well with Grilled chicken" doesn't add the reverse. With `mirror: true`, the server also appends this dish to each paired dish's list when that dish doesn't have it yet and has room; `mirroredItemIds` says which.
- Errors (400, `field: "itemIds"`): `A dish can’t be paired with itself.`, `Choose up to 6 paired dishes.`, `Each of the paired dishes can appear only once.`, `One of those dishes no longer exists. Refresh and try again.`. 404 `That item no longer exists.` for `:id`.

### Extras (paid add-ons)

**Extra object**: `{ id, itemId, name, price, position, available }`. `price` ≥ 0 (0 is fine: "Swap to ugali").

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /api/restaurant/items/:id/extras` | `{ name, price, available?, position? }` (name 1–60 characters) | `{ extra }`, added at the end |
| `PATCH /api/restaurant/extras/:id` | Any of `name, price, available, position` | `{ extra }` |
| `DELETE /api/restaurant/extras/:id` | none | 204 (orders keep their snapshot) |
| `PUT /api/restaurant/items/:id/extras/order` | `{ ids: [every extra id of the dish, in order] }` | `{ itemId, extras }` |

- `available: false` is the extra's own sold-out toggle: it disappears from the guest menu and can't be chosen.
- Errors: 400 `Enter the extra’s name.` (`field: "name"`), `Price can’t be negative.` (`field: "price"`), `A dish can have up to 12 extras.`, `Send every extra of this dish once, in the new order. Refresh and try again.`; 409 `Classic beef burger already has an extra called “Cheese”.` (names are unique per dish, ignoring case); 404 `That item no longer exists.` / `That extra no longer exists.`.

### Deals ("Pairs & deals")

**Deal object** (owner view):

```json
{
  "id": "…", "name": "Burger meal", "description": "Classic beef burger, chips and a Stoney.",
  "price": 1150, "regularPrice": 1320, "saving": 170, "savingPercent": 13, "currency": "KES",
  "active": true, "startsAt": null, "endsAt": "2026-12-31T21:00:00.000Z",
  "photoUrl": null, "photoUrls": ["https://…/items/burger.jpg"], "position": 0,
  "items": [
    { "itemId": "…", "name": "Classic beef burger", "quantity": 1, "unitPrice": 950, "photoUrl": "…", "available": true },
    { "itemId": "…", "name": "Chips", "quantity": 1, "unitPrice": 250, "photoUrl": "…", "available": false }
  ],
  "units": 3,
  "status": "unavailable",
  "visibleToGuests": false,
  "issues": [{ "code": "item_unavailable", "itemId": "…", "name": "Chips", "message": "Chips is sold out." }]
}
```

| Field | Meaning |
| --- | --- |
| `regularPrice` | Σ (current dish price × quantity). `saving = max(0, regularPrice − price)`; `savingPercent` rounded. A deal may cost more than its dishes (saving 0): allowed, but worth a warning in the UI. |
| `status` | `live` (guests see it) · `inactive` (`active: false`) · `scheduled` (before `startsAt`) · `ended` (after `endsAt`) · `unavailable` (active and in its window, but has an issue). `visibleToGuests` is `status === "live"`. |
| `issues` | Why it's unavailable: `item_unavailable` (a dish is sold out), `item_missing` (a dish was deleted), `too_few_items` (fewer than 2 units left after a dish was deleted). Show these as flags on the owner's deal card. |
| `units` | Total dish units in the deal. |
| `photoUrls` | Up to 4 distinct dish photos, to compose a picture when `photoUrl` is `null`. |
| `stats30d` | Only on `GET /api/restaurant/menu`. |

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/restaurant/deals` | none | `{ deals }` in position order |
| `GET /api/restaurant/deals/:id` | none | `{ deal }` |
| `POST /api/restaurant/deals` | `{ name, description?, price, items: [{ itemId, quantity? }], active?, startsAt?, endsAt?, photoUrl?, position? }` | `{ deal }`, added at the end |
| `PATCH /api/restaurant/deals/:id` | Any of the same fields. `items` **replaces** the whole list. | `{ deal }` |
| `DELETE /api/restaurant/deals/:id` | none | 204 (orders keep their snapshot; their `dealId` becomes `null`) |
| `PUT /api/restaurant/deals/order` | `{ ids: [every deal id, in order] }` | `{ deals }` |

| Field | Rules (400 with `details.field`) |
| --- | --- |
| `name` | Required, 1–60 characters. |
| `description` | Optional, up to 200 characters. |
| `price` | Required, ≥ 0 (KES). |
| `items` | 1–10 entries `{ itemId, quantity }`, `quantity` 1–20 (default 1), each dish once, **at least 2 units in total**, every dish from this restaurant (sold-out dishes are allowed; the deal is then flagged). |
| `active` | Boolean, default `true`. |
| `startsAt`, `endsAt` | Optional. A date `YYYY-MM-DD` (a Nairobi day: `startsAt` from its midnight, `endsAt` through the end of that day) or an ISO time; `null` clears. `endsAt` must be after `startsAt`. |
| `photoUrl` | Optional, an uploaded image under `<restaurantId>/deals/` ([§10](#10-dish-photos-and-videos-storage)); `null` removes it. |

Errors: `Add the dishes in this deal.`, `A deal needs at least 2 dishes (or one dish with quantity 2).`, `Each dish can appear once in a deal; raise its quantity instead.`, `The deal must end after it starts.`, `One of those dishes no longer exists. Refresh and try again.`, `You can have up to 50 deals.`, `Send every deal once, in the new order. Refresh and try again.`; 404 `That deal no longer exists.`.

**Guests** add a deal as one line `{ dealId, quantity }` ([§3](#3-public-guest-endpoints-no-sign-in)); **waiters** import it with the cart, or enter it the same way in `POST /api/ops/orders`. The order stores the deal line with a snapshot of its dishes.

---

## 15. Menu design ("Studio")

Owners customise how the guest menu looks: theme, fonts, colours, header, section order and layouts, cards and footer. It's stored in `restaurants.menu_design` (migration 004), validated by the server. A missing design means the defaults.

### Endpoints (owners and managers)

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/restaurant/menu-design` | none | `{ design, isDefault, resolved, options }` |
| `PUT /api/restaurant/menu-design` | `{ design: { … } }` to save, or `{ design: null }` to go back to the defaults | same as GET |

- `design`: the saved design, normalised (every key present, defaults filled in, unknown keys dropped). Edit this and send it back whole: **PUT replaces the design**; keys you leave out get their defaults.
- `resolved`: what guests get (also returned as `design` by the public menu): `theme` filled in and `sections` resolved (see below).
- `options`: everything a Studio UI needs to build its pickers: `themes`, `fonts.display` / `fonts.body` (`[{ key, label }]`), `layouts`, `cardStyles`, `sectionTypes`, `sectionDefaults` and `limits`.
- Saving a design with a `theme` also sets the restaurant's theme (the one onboarding picks), so both stay in sync.

### Schema (version 1)

```json
{
  "version": 1,
  "theme": "classic",
  "fonts": { "display": "abril", "body": "dm-sans" },
  "colors": { "accent": "#111110", "background": "#ffffff" },
  "header": { "showLogo": true, "showSearch": true, "showCover": true },
  "sections": [
    { "type": "featured", "visible": true, "layout": "carousel", "title": "Featured" },
    { "type": "deals", "visible": true, "layout": "carousel", "title": "Pairs & deals" },
    { "type": "category", "categoryId": "<uuid>", "visible": true, "layout": "grid", "title": null }
  ],
  "cards": { "style": "photo-top", "showDescription": true },
  "footer": { "showCta": true, "tagline": "Karibu! Ask us about today’s specials." }
}
```

| Key | Type and allowed values | Default |
| --- | --- | --- |
| `version` | `1` | `1` |
| `theme` | `classic` · `savanna` · `midnight` · `garden`, or `null` for the restaurant's theme | `null` |
| `fonts.display` | Display (headings) font key, see below | `playfair` |
| `fonts.body` | Body font key, see below | `dm-sans` |
| `colors.accent` | Hex colour `#rgb` or `#rrggbb` (stored lower-case 6-digit), or `null` for the theme's | `null` |
| `colors.background` | Hex colour or `null` | `null` |
| `header.showLogo` / `header.showSearch` / `header.showCover` | Boolean | `true` / `true` / `true` |
| `sections` | Up to 40 entries, see below | `[]` (= default order) |
| `sections[].type` | `featured` · `deals` · `category` | required |
| `sections[].categoryId` | Required for `category`: one of the restaurant's category ids | |
| `sections[].visible` | Boolean | `true` |
| `sections[].layout` | `grid` · `list` · `carousel` | `carousel` for featured and deals, `list` for categories |
| `sections[].title` | Up to 40 characters, or `null` for the default title | `null` ("Featured", "Pairs & deals", or the category's name) |
| `cards.style` | `photo-top` · `photo-side` · `text-only` | `photo-top` |
| `cards.showDescription` | Boolean | `true` |
| `footer.showCta` | Boolean (show the "Ready to order" / call-waiter actions in the footer) | `true` |
| `footer.tagline` | Up to 120 characters, or `null` | `null` |

**Font keys** (the frontend maps each key to a self-hosted font file; the server only checks the key):

| Display key | Font | | Body key | Font |
| --- | --- | --- | --- | --- |
| `abril` | Abril Fatface | | `dm-sans` | DM Sans |
| `playfair` | Playfair Display | | `inter` | Inter |
| `fraunces` | Fraunces | | `lora` | Lora |
| `dm-serif` | DM Serif Display | | `work-sans` | Work Sans |
| `bebas` | Bebas Neue | | | |
| `syne` | Syne | | | |

**Validation.** Known keys are checked strictly: a wrong value is a `400` naming the path in `details.field`, for example:

| `details.field` | `error` |
| --- | --- |
| `design` | `Send the design as an object.` / `Send { design: { … } }, or { design: null } to go back to the defaults.` |
| `design.version` | `version must be 1.` |
| `design.theme` | `theme must be one of classic, savanna, midnight, garden.` |
| `design.fonts.display` | `fonts.display must be one of abril, playfair, fraunces, dm-serif, bebas, syne.` |
| `design.colors.accent` | `colors.accent must be a hex colour like #111110.` |
| `design.sections` | `sections must be a list.` / `Use up to 40 sections.` |
| `design.sections[2].layout` | `sections[2].layout must be one of grid, list, carousel.` |
| `design.sections[2].categoryId` | `A category section needs its categoryId.` |
| `design.sections[3]` | `Each category can appear once.` / `The deals section can appear once.` |
| `design.header.showLogo` | `header.showLogo must be true or false.` |
| `design.footer.tagline` | `Footer.tagline must be 120 characters or fewer.` |

**Unknown keys are dropped** silently, at every level (`{ "sparkles": true }` is simply not saved).

### How sections resolve (what guests get)

`resolved.sections` (and the public menu's `design.sections`) is the display order, each entry `{ key, type, categoryId?, title, visible, layout }`:

1. Start from the saved `sections`, in order.
2. **Drop** category sections whose category was deleted. (Saving a design with an unknown `categoryId` is allowed; it is dropped here.)
3. **Featured and deals sections missing** from the saved list are put **first** (featured, then deals), with their defaults.
4. **Categories missing** from the saved list are **appended** at the end, in category order, visible, with the `list` layout. So a new category appears automatically.
5. `title` is filled in: the saved title, or "Featured", "Pairs & deals", or the category's current name.

With no saved design the order is: Featured, Pairs & deals, then every category in category order. `key` is stable (`featured`, `deals`, `category:<id>`) and good for React keys.

Invalid data already stored (for example edited by hand) never breaks the guest menu: the whole design falls back to the defaults.

---

## 16. Speed: caching, compression and timing

What the server does, and what that means for the frontend:

| Where | What | Effect |
| --- | --- | --- |
| Every signed-in call | The token is verified (locally with the project's JWKS when Supabase signs with an asymmetric key; otherwise with one Auth call), and the caller's profile and memberships load **in parallel**. The result is cached in memory for **30 seconds** (never past the token's expiry), keyed by a hash of the token. | A warm call spends ~0 ms on sign-in checks instead of three sequential Supabase round trips. A new token (sign-in, refresh) is a fresh lookup. |
| Suspend, reactivate, role change, rename, invites, new memberships | The server drops that user's cached contexts at once (`invalidateUser` in `lib/cache.js`). | Suspension still takes effect on the next request. Restaurant name or status changes (`PATCH /api/restaurant`, go-live) refresh every member's context. |
| `GET /api/public/menu/:id` | Built once (one parallel round of queries), cached for up to 60 s, already serialised and gzipped. Any owner/manager write that changes what guests see drops it immediately (`invalidateMenu`). The scan is still logged on every request. `ETag` + `If-None-Match` → `304`. | A warm menu costs ~0 ms of database time. Edits are visible on the very next load. |
| Staff names on orders and requests | Cached for 5 minutes; a rename drops it. | `/api/ops/live` full refresh is 2 round trips instead of 3. |
| `/api/ops/live?since=<cursor>` | Unchanged → exactly one small query (`ops_live_cursor`). | Polling every 10 s is cheap. |
| Analytics, onboarding, menu overview | All queries run in parallel (one round trip). | |
| JSON over 1 KB | gzipped when `Accept-Encoding: gzip`. | Smaller menus and order lists on slow mobile data. |

**Measured** (in-process, warm median of 5 after one cold call, from this development machine where one Supabase round trip is ~260 ms):

| Endpoint | Before | After (warm) | After (cold) |
| --- | --- | --- | --- |
| `GET /api/me` | 929 ms | 0 ms | 271 ms |
| `GET /api/ops/live` (full) | 1,681 ms | 539 ms | ~800 ms |
| `GET /api/ops/live?since=` (unchanged) | 1,052 ms | 262 ms | 260 ms |
| `GET /api/ops/analytics?range=7d` | 1,195 ms | 280 ms | 282 ms |
| `GET /api/ops/analytics?range=30d` | 1,079 ms | 277 ms | 291 ms |
| `GET /api/public/menu/:id` | 544 ms | 0 ms | ~550 ms |
| `GET /api/restaurant/onboarding` | 1,065 ms | 272 ms | ~300 ms |

What's left is Supabase round-trip latency (about 260 ms per query from here; much less when the backend runs in the same region as the database).

**Timing log.** Start the backend with `LOG_TIMING=1` to print one line per request: `[timing] GET /api/ops/live 200 262.4ms gzip`.

**Caveat.** The caches live in one process. With more than one backend instance, an invalidation only reaches the instance that handled the write; the others catch up within their TTL (30 s for sign-in contexts, 60 s for menus). Run one instance, or move invalidation to a shared channel, before scaling out.


## 17. Settings: your profile and the restaurant team

### `PATCH /api/me` (any signed-in user)

Body `{ "name": "Wanjiru Kamau" }`. Renames the caller (profile and auth metadata). Returns `{ "name" }`.

### `GET /api/restaurant/team` (owners and managers)

Everyone who has joined the caller's restaurant:

```json
{ "members": [{ "userId": "…", "name": "Amina", "email": "amina@example.com", "role": "waiter",
  "status": "active | invited | suspended", "joinedAt": "…", "lastSignInAt": "…" }],
  "canManage": true, "selfId": "…" }
```

`status` is `invited` until the person first signs in. Invites that have not been sent yet are still listed by
`GET /api/restaurant/onboarding` (`invites`).

### `PATCH /api/restaurant/team/:userId` (owner only)

Body `{ "role": "waiter" | "manager" }`. Changes the member's role and their sign-in role. Returns `{ "members" }`.

### `DELETE /api/restaurant/team/:userId` (owner only)

Removes the member's access to the restaurant and deletes their invite, so they can be invited again. Someone left with
no restaurant also loses their staff role. Returns `{ "members" }`. The owner can't change or remove themselves or
another owner (400).

---

## 18. Contact Cravio and the Cravio admin platform

Owner endpoints live in `routes/support.js`; admin endpoints in `routes/admin-platform.js`. Support requests need **migration 006** (`support_requests`). The admin numbers read the operations tables from migration 003; when a table is missing, its numbers come back as zeros and the response's `available` object says which part is missing, instead of failing.

### The support request object

```json
{
  "id": "uuid", "restaurantId": "uuid",
  "type": "question | problem | billing | feature | complaint | lead",
  "subject": "Printer won’t print", "message": "Since this morning…",
  "urgency": "low | normal | urgent",
  "contactName": "Amina", "contactPhone": "+254712345678", "contactEmail": "amina@example.com",
  "status": "open | in_progress | resolved | closed",
  "adminNote": "Cravio’s reply, or null",
  "createdAt": "…", "updatedAt": "…", "resolvedAt": "… or null"
}
```

Admin responses add `restaurant: { id, name, status, area } | null` and `createdByName`.

### `GET /api/restaurant/support` (managers)

Your restaurant's requests, newest first (up to 100): `{ "available": true, "requests": [SupportRequest] }`. Before migration 006: `{ "available": false, "requests": [] }`; show the call, WhatsApp and email options instead.

### `POST /api/restaurant/support` (managers)

```json
{ "type": "problem", "subject": "optional", "message": "required, up to 4,000 characters", "urgency": "normal",
  "contactName": "optional", "contactPhone": "+254…", "contactEmail": "…" }
```

- `type` is one of `question`, `problem`, `billing`, `feature`, `complaint` (`lead` is reserved for the Cravio team).
- `urgency` defaults to `normal`.
- `subject` is optional (up to 140 characters); without one, the first line of the message is used.
- At least one of `contactPhone` (Kenyan numbers are normalised to `+254…`) or `contactEmail` is required.

Returns `{ "request": SupportRequest, "message": "Message sent. We’ll get back to you soon." }`. Errors:
- `400` with `details.field`.
- `429` after 6 messages in 10 minutes per person or 30 a day per restaurant (in memory), or when the restaurant already has 20 open or in-progress requests.
- `503` before migration 006.

Rows are written with the caller's own client: RLS lets owners and managers insert rows for their own restaurant (status, reply and resolved time always start empty) and read their restaurant's rows. They can't update or delete them.

### Admin endpoints (admins only)

Every admin endpoint checks `requireRole('admin')` and then reads with the service client. Anyone else gets `403`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/admin/overview` | `available { operations, support }`; `restaurants { total, byStatus { live, onboarding, … } }`; `people { owners, waiters, admins }`; `requests { open, complaints }` (open + in progress); `orders { today, last7d, revenueToday, revenue7d, currency }`; `series` (7 Nairobi days: `{ date, orders, revenue }`); `newestRestaurants` (6); `recentRequests` (6 open, newest first). |
| `GET /api/admin/restaurants` | `{ restaurants: [...], counts { all, live, onboarding, … }, currency, available { operations } }`, sorted by name. Each row has `id`, `name`, `status`, `kind`, `area`, `address`, `phone`, `created_at`, `went_live_at`, `owner { id, name, email }`, `tables`, `menuItems`, `staff` (non-owner members), `orders30d`, `revenue30d`, `lastOrderAt`. The Users invite dialog still reads `id`, `name` and `status` from it. |
| `GET /api/admin/performance?range=7d\|30d\|90d` (default `30d`) | `totals { orders, cancelled, scans, guestRequests, activeRestaurants, restaurants, avgServeMinutes, avgAnswerMinutes }`; `series` (`{ date, orders, scans, requests }` per Nairobi day); `restaurants` (per restaurant: `orders`, `cancelled`, `scans`, `guestRequests`, `ordersPerScan`, `avgServeMinutes` (taken → served, under 6 h), `avgAnswerMinutes` (guest request → acknowledged or resolved, under 2 h), `activeDays`, `lastOrderAt`), busiest first. |
| `GET /api/admin/money?range=month\|30d\|90d` (default `month`, from the 1st in Nairobi) | `totals { revenue, paidOrders, avgTicket, previousRevenue (same length just before), openValue, payingRestaurants }`; `series` (`{ date, revenue, paidOrders }`); `methods` (`[{ method: cash\|mpesa\|card\|other, amount, count }]` from succeeded payments); `restaurants` (`revenue`, `paidOrders`, `avgTicket`, `openOrders`, `openValue`, `cancelledValue`). Revenue is paid order totals by `paid_at`. |
| `GET /api/admin/requests?type=&status=&q=` | `{ available, requests, counts { all, open, in_progress, resolved, closed } }`, newest 500. `type` is one type, a comma-separated list, or `leads` (lead, question, problem, billing, feature). "Leads & requests" uses `type=lead,question,problem,billing,feature`; "Complaints" uses `type=complaint`. `q` searches subject, message, contact, restaurant and reply. `counts` are after `type` and `q` but before `status`. |
| `PATCH /api/admin/requests/:id` | Body `{ status?, adminNote? }` (`adminNote` up to 4,000 characters; `null` or empty clears it). `resolved`/`closed` stamp `resolvedAt` (kept if already set); reopening clears it. Returns `{ request, message }`. `404` for an unknown id. |

All admin aggregation happens in the API (paged reads of 1,000 rows, up to 50,000 per table), which is fine for the current platform size. Move it to SQL functions before it isn't.

