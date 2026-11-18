# 12 · AI insights layer (design)

Written 18 Nov 2026 from the product owner's answers (`docs/v2/DECISIONS.md` row INV-P2/P3). Status: **design**; nothing built. Tickets are in `09-phase2-workplan.md` (gateway, metering, limits: P2-32…P2-34) and `10-phase3-workplan.md` (insights: P3-40…P3-44).

**One sentence:** Cravio computes every number itself from its own reports; an AI model only *organises and explains* those numbers in plain language ("Westlands made a loss this month because food cost rose to 41%"), through one server-side gateway that meters every call per business and stops at a limit the platform admin sets.

## 1. Principles

1. **The AI never invents numbers.** Every figure in an insight comes from a deterministic Cravio query. The model receives a compact JSON of those figures and may only restate them. A validator rejects (or flags) any number in the answer that is not in the input.
2. **Server only.** The API key (`OPENROUTER_API_KEY`) never leaves the backend; the browser calls Cravio endpoints, never OpenRouter.
3. **One door.** Every AI call, including the existing recipe draft (`recipes.js` `suggest` → `lib/ai.js`), goes through `backend/src/ai/gateway.js`. No other module imports `lib/ai.js` directly (a test greps for it).
4. **Metered and capped per business.** Usage is recorded for every call, success or failure. A hard monthly limit set by the platform admin stops calls with a plain message; the owner can lower it, never raise it.
5. **No personal data in prompts.** No customer or staff names, phone numbers, emails, payment references or addresses. Branch names, dish names, item names, supplier names and KES figures are allowed (business data, not personal data); supplier phone/PIN/bank details never.
6. **Plain money words.** "Gross profit after food cost" (sales minus the cost of ingredients served). The text always says that rent, salaries and other expenses are **not** included unless the owner has entered them (there is no expenses module yet).
7. **Off is fine.** With no key, no allowance or the switch off, Cravio works exactly as before; AI areas show "AI insights are off for this business" (or the recipe form simply has no "Suggest" button).

## 2. The gateway (`backend/src/ai/gateway.js`)

```
call({ db, businessId, userId?, feature, system, user, schema?, maxTokens, cacheKey?, cacheTtl })
  1. switch check    ai_business_settings.enabled and features[feature]  -> 403 ai_off
  2. limit check     month-to-date cost (KES) >= effective limit         -> 429 ai_limit_reached
  3. cache check     same (business, feature, cacheKey) inside ttl       -> return stored result, usage row status 'cached' (0 tokens)
  4. call            lib/ai.js chat (timeout 25 s, one retry on 429/5xx/abort with jittered back-off, max 2 attempts)
  5. meter           ONE ai_usage row per attempt that reached the provider: tokens from the provider's usage block, cost estimate
  6. return          { data, model, usage }
```

- **Model choice:** `OPENROUTER_MODEL` env remains the default; a per-feature override lives in `ai_business_settings` (admin only), so a cheap model can run the daily briefing and a better one the on-demand questions. Current default is `openai/gpt-4o-mini` (to be confirmed, Q-AI-2).
- **Metering source of truth:** the provider's `usage` block (`prompt_tokens`, `completion_tokens`; ask OpenRouter for cost with `usage: { include: true }` and fall back to the price table). Cost estimate stored in USD and converted to KES with a rate held in settings (`ai_usd_to_kes`, default set by admin, shown on the admin screen).
- **Failure rules:** timeouts and provider errors are recorded (`status = 'error'`, tokens null, cost 0) and shown to the user in plain words; a **failed call never counts against the allowance**; a call that returned an unusable answer (bad JSON, validator rejection) **does** count (tokens were spent) and is marked `status = 'rejected'`.
- **Concurrency safety:** the limit check and the usage insert happen under an advisory lock per business so two parallel calls cannot both slip past the last shilling. The gateway reserves a worst-case cost (`maxTokens` × price) before the call and settles to the real cost after.
- **Cache:** results keyed by (business, feature, hash of the input JSON); the daily insight job skips the call when the facts are identical to yesterday's.
- **Testing:** `fetch` is injected (as today); the whole suite runs on a stubbed fetch, never the network.

### 2.1 Tables (migration `014_ai_gateway.sql`, additive, no dependency on 015–018, applied with Release A; Phase 3 adds the insight tables to 023)

| Table | Columns (key) |
| --- | --- |
| `ai_usage` | id, business_id, `feature` (recipe_draft / daily_insight / ask / …), user_id (null for the job), `model`, `prompt_tokens`, `completion_tokens`, `cost_usd` numeric(12,6), `cost_kes` numeric(12,4), `fx_rate`, `status` (ok / cached / error / rejected / blocked), `request_id` (provider id), `latency_ms`, created_at. **Insert-only** (trigger refuses UPDATE/DELETE). Index (business_id, created_at). Never stores prompt or answer text. |
| `ai_limits` | business_id (unique), `monthly_budget_kes` numeric(12,2) **set by the platform admin**, `owner_budget_kes` (optional lower figure set by the owner, must be ≤ admin figure), `warn_pct` (default 80), `updated_by`, `updated_at`. Effective limit = `least(monthly_budget_kes, coalesce(owner_budget_kes, monthly_budget_kes))`. No row = AI off for that business. A token budget (`monthly_token_budget`) may be added if admins prefer tokens over shillings (Q-AI-3). |
| `ai_business_settings` | business_id, `enabled` bool (default false), `features` jsonb (per-feature switches), `model_overrides` jsonb, `daily_insights_time` (default 06:00 Africa/Nairobi), updated_by. |

Month = calendar month, Africa/Nairobi. Usage rows are summed, not counters, so there is nothing to drift (a monthly roll-up view is only added if it is slow).

### 2.2 Limits in words

- **80 %** of the allowance: owner and admin notified once ("You have used 80% of this month's AI allowance"); the Overview meter turns amber.
- **100 %**: hard stop. Every AI action returns `429 ai_limit_reached` with the message **"Your AI allowance for this month is used up. It resets on 1 December."** (the date is computed from the calendar; the recipe form stays usable by hand; stored insights stay visible, marked with their date).
- Admin raises the budget → effect is immediate. Owner lowers theirs → immediate. Both audited.
- The daily job never runs a business past its limit and never starts a call it cannot afford (uses the reserved worst-case cost).

## 3. Insights: facts first, words second

### 3.1 Facts (deterministic, no AI) — `backend/src/ai/facts.js`

Each fact builder is a plain SQL/JS function over existing reports and returns small, typed numbers for a period and a scope (business or one branch). All of them reuse Phase 3 services so the AI text matches the Reports screen to the shilling.

| Fact set | Source | Fields |
| --- | --- | --- |
| Branch profitability | sales from `orders` (served, net of cancellations) minus **food cost = served consumption at average cost** (`order_stock_lines` × cost, P3-23/24) | per branch: sales, food cost, **gross profit after food cost**, food cost %, rank; period vs previous period. Always carries `excludes: ["rent","salaries","utilities"]` unless expenses exist |
| Loss-making branch | same | branch where gross profit after food cost is negative or food cost % is above `food_cost_target_pct`, this week / this month |
| Dish food-cost spikes | recipes at current avg cost vs 4 weeks ago (P3-25) | dish, price, cost then/now, % then/now, the ingredient that moved most |
| Wastage | wastage records (P3-04) | value by branch, top items, ratio vs 4-week average (unusual flag) |
| Purchases and emergency spend | GRNs, emergency purchases (Phase 2) | spend central vs emergency, share %, items bought in an emergency ≥ N times, suppliers with the biggest price moves |
| Variance hotspots | variance report (P3-24) | items/branches outside tolerance, value, "needs a count" |
| Reorder suggestions | `reorderSuggestions` (P2-07) | items below reorder, suggested qty and supplier (no new maths) |

Every fact object also carries `period`, `generated_at`, `data_quality` notes (e.g. "12 movements have no cost; food cost is understated") that the text must mention when present.

### 3.2 Words (the model)

- **Input:** one JSON document (`facts`), at most ~3,000 tokens, branch/dish/item/supplier names and numbers only. System prompt: restate and explain these figures in short plain sentences; **cite each figure exactly as given**; do not compute new figures, percentages, totals, rankings or forecasts; do not guess causes beyond the supplied `drivers`; say "not enough data" when a field is null; British/Kenyan English, KES with thousands separators, no jargon.
- **Output (JSON):** `{ findings: [ { id, severity: info|watch|act, title, text, figures: [ "KES 412,300", "31.4%" ], branch?, link } ], summary }`, ≤ 6 findings, `text` ≤ 280 chars.
- **Number validator** (`backend/src/ai/validate.js`): extracts every number token from `title`/`text`/`summary` (handles `1,234`, `KES 1.2m`, `31%`, dates are exempt when they match the period), normalises, and requires each to match a value in `facts` (exact, or rounded to the display precision used in `facts`). **Any unmatched number → the finding is dropped; if more than half are dropped, or a required figure is missing, the whole answer is rejected** and the insight is shown as the plain deterministic summary (a template: "Westlands: sales KES 820,000, food cost KES 340,000 (41%)") with no AI wording. `figures[]` must also all be in `facts`. The validator is unit-tested with adversarial answers.
- **Fallback:** the deterministic template is always generated first and stored; the AI text is an *upgrade* over it. If the AI is off, over its limit or rejected, the owner still sees the template version.
- **Links:** each finding links to the exact report with filters (e.g. Reports → Variance, branch and dates), so every claim can be checked in two clicks.

### 3.3 Runs

- **Daily scheduled run** per business with AI enabled and inside its limit: the existing in-process scheduler (P3-31 hosts the single timer) at the business's time (default 06:00 Nairobi); builds facts for yesterday/week-to-date/month-to-date, skips the call when facts equal the last run (cache), stores one `ai_insights` row per scope (business-wide for the owner; one per branch for branch managers). Business-wide and per-branch facts are separate calls, so a branch manager's insight never contains another branch's numbers.
- **On-demand "Ask about my numbers":** a **limited** question set, not free chat: a picker of ~10 questions ("Which branch made the most gross profit last month?", "Which dishes got more expensive to make?", "Where did we lose stock this week?", "What do I need to order?") with an optional period and branch; each maps to a fact builder. A free-text box is **out of scope for v1** (hardest to validate and the main cost/abuse risk); revisit after the pilot (Q-AI-5). Per-user rate limit (e.g. 20 questions/day) on top of the allowance.
- **Storage** (tables added in migration 023): `ai_insights` (business, scope branch_id null = business, kind daily/ask, period, `facts jsonb`, `ai_text jsonb` null, `template_text`, status ok/rejected/off/limit, `usage_id`, created_at; retained 90 days) and `ai_questions` (question key, params, insight id, asked_by).

### 3.4 Where it shows

- **Owner Overview:** the existing briefing gains an "Insights" block (top 3 findings of today's run, with the date; "AI summary" label and "Numbers computed by Cravio" footnote; link "See all"). Without AI it shows the template findings.
- **Owner Reports → Insights:** all findings, history by date, filters by branch/severity, the **Ask about my numbers** panel, and the **AI usage this month** meter ("KES 410 of KES 1,000 used · resets 1 December").
- **Branch manager:** Overview and Reports → Insights show their **own branch only** (server-scoped: facts are built for that branch and no other branch's name appears in the payload).
- **Admin:** Businesses → business detail gets an **AI** section next to the inventory switch: on/off, monthly allowance (KES), warn %, model overrides, **usage this month and last 6 months** (calls, tokens, KES, by feature), reset-date text. Admin sees usage counts and costs only, never insight content (no stock/order data for admins, existing rule).
- **Owner:** usage this month on Reports → Insights and in Settings → Inventory; can lower the allowance, switch individual features off.

## 4. Privacy and Kenya Data Protection Act (DPA 2019)

- Prompts contain business aggregates only (see §1.5). A unit test builds each fact payload from the golden dataset **seeded with people's names, phones and emails in every free-text field** and asserts none reaches the payload (name/phone/email regexes plus an allow-list of keys).
- Free-text fields (notes, reasons, customer names, table labels) are **never** sent. Dish and item names are, because they are menu text already sent by the recipe draft.
- Provider: OpenRouter routes to third-party models (possibly outside Kenya). Choose a route/model with no training on inputs where OpenRouter allows it (data-policy setting), state the processing in the privacy policy, and add the provider to the processor list. Because no personal data is sent, a cross-border transfer assessment is expected to be light, but **confirm with counsel before launch** (open item, Q-AI-6).
- `ai_usage` stores no prompt or answer text. `ai_insights.facts` is business data, owned by the business, deleted with it.
- No decisions are automated: insights are advice with links to the numbers; nothing changes stock, price or approvals.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| **Cost overrun** | Hard limit per business, reserved worst-case cost, cheap default model, cache, daily job skips unchanged facts, no free-text chat in v1, per-user question limit; admin screen shows spend; alert at 80 % |
| **Hallucinated numbers or causes** | Facts-only input, number validator (drop/reject), deterministic template fallback, "drivers" supplied by Cravio (the model may not invent causes), links to the source report, adversarial validator tests |
| **Misleading "profit"** | Wording fixed to "gross profit after food cost"; `excludes` always in the facts and in the text; a branch is never called "loss-making" without that qualifier |
| **Privacy / DPA** | No personal data in prompts (tested), provider data-policy choice, processor listed, counsel check |
| **Provider outage / price change** | Gateway isolates the provider; template fallback; model env-configurable; usage row stores model so history stays explainable |
| **Usage rows disagree with the provider's bill** | Reconcile monthly against OpenRouter's activity page; the estimate is labelled "estimate" in the admin screen |
| **Branch manager sees other branches** | Facts built per scope server-side; test with two branches and a name-leak assertion |
| **Stale or low-quality data** (no costs, no counts) | `data_quality` notes forced into the text; findings suppressed when cost coverage is below a floor (default 80 % of served lines costed) |

## 6. Open questions

- **Q-AI-1 Who pays?** Cravio absorbs it as part of the subscription (admin sets a modest allowance per plan) or passes it on (paid add-on, owner buys more)? Drives the default and the "raise" flow.
- **Q-AI-2 Which model?** Default `openai/gpt-4o-mini` is cheap and adequate for restating figures; a stronger model for "Ask" if quality demands it. Needs a short bake-off on the golden dataset.
- **Q-AI-3 Default monthly allowance** and its unit (KES budget, as designed, or tokens)? Starting suggestion to size from the pilot: measure the real monthly cost of one business with daily insights and 20 questions, then set the default at roughly 2× that.
- **Q-AI-4** Daily insight time (06:00 Nairobi?) and whether owners can turn the daily run off but keep "Ask".
- **Q-AI-5** Free-text questions later? (default: no in v1).
- **Q-AI-6** Counsel sign-off on the OpenRouter/DPA position before the first paying business uses it.
