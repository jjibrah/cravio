# Cravio v2 — continue on another device

Prepared 16 November 2026. Branch: **v2-dev**. Base code: `e0de46635182613b9536b122d5aa42e3c9228dcc` from dev. This handoff adds planning documents only; the five-interface redesign has not been implemented.

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

For a fresh clone, create ignored config files from templates:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Only do that if these files do not already exist. Populate credentials through the team's secure channel; Git does not transfer `.env` files, database contents or local worktrees. Server service/database credentials belong only in backend config. The frontend needs its public Supabase URL/key and an empty `VITE_API_URL` for the local proxy. Use the same Supabase target in frontend and backend.

For the v2 checkout set `PORT=3004` and `FRONTEND_URL=http://localhost:5174` in `backend/.env`, then run in separate terminals from the repository root:

```bash
npm run dev:backend
```

```bash
npm run dev --workspace frontend -- --port 5174 --strictPort
```

Open http://localhost:5174. This runs the inherited preview, not the planned five interfaces. Restart frontend if its backend-port configuration changes. Auth invitation/recovery redirects must include the chosen local URL before those flows are evaluated.

## Optional main comparison

The current `npm run compare` launcher explicitly requires the working branch to be named `dev`. **It will reject `v2-dev`.** The launcher is unchanged because this task is planning only. Use independent app processes, or update that launcher as a separately authorized future implementation task.

To prepare a separate baseline checkout on the new device, with a non-existing destination directory:

```bash
git worktree add --detach ../cravio-main-baseline origin/main
```

In that baseline directory, install dependencies and configure its own ignored environment files. Set backend `PORT=3003`, `FRONTEND_URL=http://localhost:5173`, matching Supabase settings and empty frontend `VITE_API_URL`. Then run the baseline backend and frontend in their own terminals:

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
