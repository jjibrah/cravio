# Cravio v2 — continue on another device

Prepared 16 November 2026. Branch: **v2-dev**. Base code: `e0de46635182613b9536b122d5aa42e3c9228dcc` from dev. This handoff adds planning documents only; the five-interface redesign has not been implemented.

## Implementation status (updated 16 Nov 2026)

| Package | State | Evidence |
| --- | --- | --- |
| V2-01 decisions/baseline | Read-only account audit done; D02–D08 still open (see DECISIONS.md, incl. R1–R7 recommendations now in code) | `npm run audit:accounts` |
| V2-02 membership & scoping | **Implemented.** Every branch API resolves the branch from `X-Cravio-Branch` against the caller's memberships (403 for another restaurant, 409 when several branches and none named). Business grants model + proposed migration 008 (**not applied**) | `npm run test:v2` (access rules, 008 rehearsal incl. rollback, owner data layer, mapping) |
| V2-03 branch-manager routing | **Implemented.** Former owner screens at `/branch/:branchId/*`; legacy `/owner/<page>` links redirect; branch switcher; per-branch API cache; waiter branch choice | `npm run test:v2-ui` (read-only against the shared DB) |
| V2-04 owner/operations interface | **Implemented, needs 008 to show data.** `/owner` overview, Locations (+ add branch), Branch detail (+ add staff), People & access (grant/edit/revoke operations). Before 008 it shows “needs database update 008” | Owner UI spec with mocked API; owner data layer tests on PGlite |
| V2-05…V2-07 stock, order effects, requests | **Not started — blocked on D03–D07.** No stock behaviour has been guessed | — |
| V2-08 regression | Read-only browser checks for owner→branch, waiter, guest QR. Inherited Playwright suites mutate the shared DB and were **not** run | — |

Migration 008 review pack: [MIGRATION-008.md](MIGRATION-008.md).

## Start here

1. [Implementation plan](IMPLEMENTATION-PLAN.md): five interfaces, page contents, migration, stock design, work packages and acceptance.
2. [PRD context](PRD-CONTEXT.md): all 25 supplied functional requirements and their original evidence status.
3. [Decision register](DECISIONS.md): confirmed instructions and unresolved operating rules.

These documents supersede the root inventory plan and `docs/MULTI-BRANCH-PLAN.md` for v2 scope. `question.md` is an older Fayaz questionnaire for the separate bakery opportunity, not Cravio's current requirements. The original PRD's source meeting files and client proposal/questionnaire were not supplied in this checkout.

## Get the branch

For a new clone:

```bash
git clone --branch v2-dev https://github.com/jjibrah/cravio.git cravio-v2
cd cravio-v2
git status --short --branch
npm ci
```

For an existing clean clone:

```bash
git fetch origin
git switch --track origin/v2-dev
npm ci
```

If `v2-dev` already exists locally, use `git switch v2-dev` and `git pull --ff-only` instead. Preserve any uncommitted work before switching; do not reset or force-push to make a checkout match.

Use Node.js compatible with the current project (README specifies 22.12+). Inspect package scripts before running database commands. No database setup, seed or migration is needed merely to read this plan.

## Local application setup

The frontend and backend development `.env` files are now included on `v2-dev` at the user's explicit request for the other-device handoff. The user plans to rotate the keys. Do not overwrite these files with empty templates. If a future checkout does not contain them, create config files from templates:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Only do that if these files do not already exist. This branch transfers the included development environment files, but not database contents or local worktrees. If the keys have been rotated, obtain the replacement values through the team's secure channel. Server service/database credentials belong only in backend config. The frontend needs its public Supabase URL/key and an empty `VITE_API_URL` for the local proxy. Use the same Supabase target in frontend and backend.

For the v2 checkout set `PORT=3004` and `FRONTEND_URL=http://localhost:5174` in `backend/.env`, then run in separate terminals from the repository root:

```bash
npm run dev:backend
```

```bash
npm run dev --workspace frontend -- --port 5174 --strictPort
```

Open http://localhost:5174. Legacy owner accounts land in `/branch/<id>`, waiters in `/waiter`; `/owner` needs migration 008 plus a reviewed grant.

Checks (read-only; never seeds or writes): `npm run test:v2` (disposable PGlite, no shared DB) and, with both servers running, `V2_BASE_URL=http://localhost:5174 V2_TEST_PASSWORD=… npm run test:v2-ui`. Do **not** run the inherited `npm test` Playwright suites against the shared database: several create orders, change settings or go through onboarding.

If 5173/5174 are taken by another project on this machine, run v2 on spare ports, e.g. `PORT=3014 FRONTEND_URL=http://localhost:5184 npm run start:backend` and `PORT=3014 npm run dev --workspace frontend -- --port 5184 --strictPort` (the Vite proxy reads `PORT`). Restart frontend if its backend-port configuration changes. Auth invitation/recovery redirects must include the chosen local URL before those flows are evaluated.

## Optional main comparison

The current `npm run compare` launcher explicitly requires the working branch to be named `dev`. **It will reject `v2-dev`.** The launcher is unchanged because this task is planning only. Use independent app processes, or update that launcher as a separately authorized future implementation task.

To prepare a separate baseline checkout on the new device, with a non-existing destination directory:

```bash
git worktree add --detach ../cravio-main-baseline origin/main
```

In that baseline directory, install dependencies and configure its own environment files (main does not include the v2 development environment files). Set backend `PORT=3003`, `FRONTEND_URL=http://localhost:5173`, matching Supabase settings and empty frontend `VITE_API_URL`. Then run the baseline backend and frontend in their own terminals:

```bash
npm run dev:backend
```

```bash
npm run dev --workspace frontend -- --port 5173 --strictPort
```

This produces main at 5173/backend 3003 and v2 at 5174/backend 3004. Check port owners before starting; do not kill unrelated processes. Stop each process with Ctrl+C when finished. The existing running comparison on the original device was not restarted or reconfigured by this planning delivery.

The user previously chose a **shared existing database** for comparison. Different devices, branches and ports do not isolate writes. Do not silently switch database targets, rerun setup/seeds, or apply future role/schema migrations just to make a screen load. Review compatibility and a restore plan before future migrations; use disposable test fixtures for mutation tests. Existing migration 007 was applied in an earlier session, not by this handoff.

## State and limitations inherited from dev

- React/Vite frontend, Node backend, Supabase Auth/Postgres/media; existing menu, waiter, guest, admin and restaurant-owner code.
- Existing owner inventory preview has account-owned locations/products, manual stock events/transfers and a read-only browser example.
- It is not integrated with restaurant orders or shared staff memberships, and is not the target v2 architecture.
- The new owner/operations dashboard, branch-manager area, role migration and order-linked stock behavior remain unimplemented.
- OpenRouter is a placeholder. No provider key, live model integration or usage budget is needed for this handoff.
- No live database changes, application tests, feature implementation or main merge were performed for this planning task. Validation concerns documentation integrity and Git scope only.

## Suggested continuation brief

> Read docs/v2/IMPLEMENTATION-PLAN.md, PRD-CONTEXT.md and DECISIONS.md on v2-dev. This is Cravio's general restaurant platform with five interfaces: owner/operations manager, branch manager, waiter, guest and platform admin. Existing owner service screens become branch-manager screens; new owner access is scoped across assigned branches. Inventory is product quantities by branch, linked to an agreed Cravio order lifecycle. Fayaz bakery workflows and mandatory external POS integration are excluded. Review current repo state and the unresolved decisions first; do not assume the planning handoff itself authorizes implementation. Once the user authorizes work, implement the agreed packages on v2-dev, preserve the visual design, verify authorization and stock correctness, and keep main untouched until explicit merge approval.

When continuing work, publish commits to `v2-dev`; do not change main/dev history or force-push. A future merge into main needs review and explicit user approval.
