# Migration 008 — businesses, branches and access (for review, NOT applied)

Status: **proposed**. Files live in `backend/db/proposed/` so `npm run db:migrate` cannot apply them. Nothing in this document has been run against the shared database. Rehearsed only on disposable in-process Postgres (PGlite) via `npm run test:v2`.

## What it changes

| Change | Why | Compatibility with main (same database) |
| --- | --- | --- |
| `public.businesses` | Groups branches | Main ignores it |
| `restaurants.business_id` (not null) + trigger that creates a business for any restaurant inserted without one | Every restaurant is a branch of exactly one business | Main never sets it; the trigger fills it |
| Backfill: **one business per existing restaurant**, named after it | No grouping by name/owner/email is ever inferred | Restaurant/menu/table/order IDs, `owner_id` and guest QR links unchanged |
| `restaurants.owner_primary` (default true) and partial unique index `(owner_id) where owner_primary` replacing `restaurants_one_per_owner` | A business owner can add further branches (`owner_primary = false`) | Main-created restaurants default to true, so main's "one restaurant per owner" 23505 conflict still happens |
| `public.business_members` (`owner` \| `operations`) and `public.business_member_branches` | Business-level grants, separate from branch roles | Main ignores them |
| `public.access_events` (append-only) | Audit of grants, branch creation, mapping runs | — |
| Helpers `private.business_role`, `private.oversees_branch`; RLS: read own grants, owners read their business's grants; **no browser writes** | Same pattern as 002 | Existing 002–007 policies unchanged |

**The migration grants nobody anything.** After it, every existing account behaves exactly as before in v2: legacy owners and managers land in their branch workspace (`/branch/:id`), waiters in `/waiter`, admins in `/admin`. Owner/operations access exists only after the reviewed mapping below.

## Current accounts (read-only audit, 16 Nov 2026)

`npm run audit:accounts` (READ ONLY transaction; emails masked unless `--show-emails`). Output must not be committed.

| Restaurant | Status | Members |
| --- | --- | --- |
| Abdis Test Restaurant (`106fe2fb…`) | live, 14 tables, 19 items, 1,002 orders | `owner@gmail.com` (owner), `waiter@gmail.com` (waiter), a second waiter account |
| Mama Oliech’s (`0f743f69…`) | onboarding, empty | `onboarding@gmail.com` (owner) |

One platform admin account; no preview-inventory data; nobody belongs to several restaurants. `manager@gmail.com` and `admin@gmail.com` do **not** exist in this database.

## Proposed account mapping (needs your confirmation — D02)

| Account | Today | After 008 alone | Proposed reviewed grant |
| --- | --- | --- | --- |
| `owner@gmail.com` | owner of Abdis Test Restaurant | Branch manager of Abdis (lands in `/branch/106fe2fb…`) | **Business owner** of “Abdis Test Restaurant” business? *(confirm, or leave as branch manager only)* |
| `onboarding@gmail.com` | owner of Mama Oliech’s (onboarding) | Branch manager of Mama Oliech’s, continues onboarding | None proposed (test account) |
| `waiter@gmail.com`, second waiter | waiter at Abdis | unchanged | None |
| platform admin | admin | unchanged | None — platform admin is not a business owner |

Grouping: none proposed. Abdis and Mama Oliech’s stay separate businesses.

Mapping file (keep outside Git), applied after 008 with a dry run first:

```json
{ "businesses": [ { "restaurantIds": ["106fe2fb-94bb-4f5d-bd0d-bd694004424c"], "owners": ["owner@gmail.com"] } ] }
```

```bash
node backend/scripts/apply-access-mapping.js /path/outside/repo/mapping.json          # dry run, prints the plan
node backend/scripts/apply-access-mapping.js /path/outside/repo/mapping.json --apply  # commit
```

The tool aborts the whole run on an unknown email or restaurant, a branch outside its entry, or a restaurant listed twice; never changes `restaurant_members`; and records `mapping_applied` events.

## Apply procedure (after approval)

1. Take a backup/snapshot of the shared database (Supabase dashboard → Database → Backups, or `pg_dump` of `public` and `private`).
2. `npm run audit:accounts > /tmp/before.txt` (outside the repo).
3. Move `backend/db/proposed/008_business_branches.sql` to `backend/db/migrations/` unchanged; `npm run db:migrate -- --dry-run` must list only 008; then `npm run db:migrate`.
4. Compatibility checks: `npm run audit:accounts` (v2 schema present: true, same accounts and memberships); main on :5173 still signs in as owner/waiter, shows Abdis' orders, guest QR `/guest-menu?r=106fe2fb…&t=1` opens; v2 `/api/owner/overview` returns `{ businesses: [] }` for everyone until the mapping is applied.
5. Dry-run then apply the reviewed mapping.

## Recovery

- **Before any grant exists:** run `backend/db/proposed/008_business_branches.down.sql`. It refuses if grants/access events exist or if an owner has several restaurants, and never touches restaurants, menus, tables, orders or memberships. Then delete the `008_business_branches.sql` row from `private.schema_migrations`.
- **After grants exist:** export `business_members`, `business_member_branches`, `access_events` (CSV), remove grants deliberately, remove any extra branches created in v2 (or re-own them), then run the down file.
- **v2 app can be switched off without data loss:** the v2 backend works without 008 (owner interface reports “needs database update 008”), and main never reads the new tables.
