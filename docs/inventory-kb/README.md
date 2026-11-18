# Inventory knowledge base

Working reference for adding the inventory management module to Cravio. Written 18 Nov 2026, while planning. **No code has been changed for this work yet.**

| File | What it holds |
| --- | --- |
| [01-current-system.md](01-current-system.md) | How Cravio is built today: stack, the five interfaces, roles, the order lifecycle, and what inventory already exists on `main` |
| [02-branch-comparison.md](02-branch-comparison.md) | `main` against `v3-dev`: what each branch does with inventory, side by side, and what to keep from each |
| [03-prd-digest.md](03-prd-digest.md) | Short digest of *Restaurant Inventory, Procurement and POS Platform PRD v1.0* (18 Nov 2026), by module, with requirement IDs |
| [04-gap-analysis.md](04-gap-analysis.md) | Each PRD module against the code: built, partial or missing, and where the PRD conflicts with decisions already made |
| [05-navigation-proposal.md](05-navigation-proposal.md) | Draft sidebar with an **Operations** group for the owner, branch manager and admin interfaces |
| [06-open-questions.md](06-open-questions.md) | What needs deciding before the implementation plan is written |
| [07-implementation-plan.md](07-implementation-plan.md) | The 3-phase plan: migrations, services, API, UI per role, cases and tests per phase |
| [08-phase1-workplan.md](08-phase1-workplan.md) | Phase 1 broken into tickets (P1-01…P1-19), milestones, first-week schedule, ways of working |
| [09-phase2-workplan.md](09-phase2-workplan.md) | Phase 2 (purchasing & distribution) broken into tickets (P2-01…), milestones, migrations 014–017, migration of the 009 request/dispatch flow, first week, risks |
| [10-phase3-workplan.md](10-phase3-workplan.md) | Phase 3 (controls, production, batches & reporting) broken into tickets (P3-01…), migrations 018–022, cases, risks |
| [11-design-review.md](11-design-review.md) | Design review of the Phase 1 inventory screens: findings, fixes, what's left |
| [12-ai-insights.md](12-ai-insights.md) | AI insights layer: server-only gateway with per-business metering and limits, deterministic facts, number validator, daily and on-demand insights, privacy, risks, open questions (tickets P2-32…34, P3-40…44) |

Source PRD file: `/Users/it-macmini-5/.t3/userdata/attachments/247035ad-0c89-4fd3-be22-f56e01f97d25-64d170dc-07f1-467b-a3bf-c27a37af2ef2-pdf.pdf`

Related earlier docs: `docs/v2/INVENTORY.md` (migration 009), `docs/v2/RECIPES.md` (migration 012), `docs/v2/DECISIONS.md` (D01–D13 and answers), `docs/INVENTORY-PREVIEW.md` (the older 007 bakery preview).
