# Inventory demo (local, click-through)

A throwaway copy of the product you can click through in a real browser window. The new inventory screens run against the REAL route
handlers and the REAL services, on an in-memory database that is built when you start and thrown away when you stop.

## Run it

```
npm run demo:inventory
```

Wait about 30 to 60 seconds (it builds the database and starts the web server). Two Chromium windows open:

| Window | Address | Signed in as |
|---|---|---|
| Owner | http://127.0.0.1:5190/owner/inventory | Wanjiru Kamau, business owner |
| Branch | http://127.0.0.1:5190/branch/<Westlands id>/inventory | Brian Otieno, Westlands branch manager |

Stop with **Ctrl+C** in the terminal (or close the windows). Both servers are stopped with it. Ports used: **5190** (web) and **5189** (demo API).
Port 5173 is never used. If 5189 or 5190 is busy the command says so and exits.

## Nothing touches real data

- The database is PGlite in memory, with every committed migration plus the proposed inventory migrations (012 to 020).
- It never reads `backend/.env` or `frontend/.env`. The browser is given a fake Supabase address that the demo API answers, and the demo
  browser refuses every request to a host other than localhost (so no Supabase, fonts or analytics).
- Sign-in is a bearer token per demo person, mapped to rows in the in-memory database. Reload and you are still signed in; restart and all data resets.

## What is in the data ("Golden Eats")

The golden dataset (a full week of orders, receipts, transfers, wastage and counts for **Westlands**, **Karen** and the **Warehouse**; 10 items, 8 dishes
with recipes) plus extras made through the real handlers, so every screen has something to show:

- **Approvals (owner):** an emergency purchase from Karen (chicken, Ksh 3,440) and a purchase order from the co-owner (Nairobi Prime Butchery, Ksh 38,338).
- **Purchase orders:** one waiting for approval, one **sent** (Farm Fresh, due at Westlands: shows as an expected delivery on the branch Stock page and on Receive goods), one draft.
- **Requests and transfers:** a Westlands request waiting for review (urgent), a Karen request approved and dispatched (on the way, with a receive code), and a delivery to Westlands received short (burger buns, a discrepancy).
- **Wastage:** 200 g of tomatoes written off at Westlands.
- **AI:** an allowance is set (Ksh 500 a month). "Suggest a recipe" works but returns a canned answer; no AI provider is called (it is still metered through the real gateway).

## Other logins

Each person is a bearer token. The two windows start with the owner and the Westlands manager. The tokens work against the demo API (port 5189) too:

| Token | Person |
|---|---|
| `demo-owner` | Wanjiru Kamau, owner (all branches, can approve) |
| `demo-owner-2` | Amina Hassan, co-owner (made the waiting purchase order, so the owner can approve it: the maker cannot approve their own) |
| `demo-manager-westlands` | Brian Otieno, Westlands manager |
| `demo-manager-karen` | Grace Njeri, Karen manager |

## What does not work in demo mode

Only the inventory screens are served. Any other API path answers `404 Not available in demo mode`, so these show an error or an empty panel:
the owner **Overview**, the branch **Overview, Orders, Tables, Products, Insights, Settings** and the setup checklist (they belong to the restaurant app,
not to inventory). Evidence photos for attachments that upload straight to Supabase Storage cannot complete (there is no storage); emergency purchase and wastage
photos that go through the API are kept in memory. Scheduled jobs (daily AI insights) do not run.

## For developers

- `scripts/demo/inventory-demo-server.js` builds the database and serves the routes (`node scripts/demo/inventory-demo-server.js` runs the API alone on 5189; `/demo/info` lists the ids and tokens).
- `scripts/demo/vite.demo.config.js` is the Vite config for port 5190 (the normal `frontend/vite.config.js` is untouched).
- `scripts/demo/inventory-demo-browser.js` starts both, opens the windows and cleans up. `DEMO_HEADLESS=1` hides the windows; `DEMO_AFTER=/path/to/module.js` runs a module with the open pages, then stops (used for screenshots).
