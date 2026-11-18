// AI gateway (P2-32/P2-33): metering, limits, switches, cache, privacy guard, admin/owner endpoints, recipe draft through the gateway.
// Everything runs on a throwaway in-memory database with a STUBBED fetch (no network). Prices are set so 1 token = 0.1 KES, which
// keeps every hand calculation exact:  AI_PRICE_TABLE test/model in=out=1000 USD per 1M tokens, AI_USD_TO_KES=100.
// Usage: node backend/tests/inv/ai-gateway.test.js
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rig } from './fixture.js';
import { fakeClock, makeAsserts } from './helpers.js';
import { createUser } from '../support/pg.js';
import { HttpError } from '../../src/lib/http.js';
import * as gateway from '../../src/ai/gateway.js';
import { adminSet, ownerSet, usageHistory, usageThisMonth } from '../../src/ai/limits.js';
import { monthBounds } from '../../src/ai/meter.js';
import { createRoutes } from '../../src/routes/ai.js';
import { inventoryScope } from '../../src/inventory/permissions.js';
import * as recipes from '../../src/inventory/recipes.js';

const { eq, ok, refuses: strictRefuses, count } = makeAsserts();
/** Like makeAsserts().refuses, but a null code means "any code" (status and message still checked). */
const refuses = async (promise, status, code, re, m) => {
  if (code) return strictRefuses(promise, status, code, re, m);
  let caught = null; try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, `${m}: expected a refusal`); eq(caught.status, status, `${m}: status`); if (re) assert.match(caught.message, re, `${m}: message`);
  return caught;
};
const f = await rig();
const { db, ids, users, people, contexts, items } = f;
const { businessId } = ids;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const adminId = await createUser(db, 'admin@example.test', { role: 'admin' });
const admin = { user: { id: adminId }, profile: { role: 'admin' }, memberships: [], grants: [] };
const strangerId = await createUser(db, 'stranger@example.test', { role: 'owner' });
const stranger = { user: { id: strangerId }, profile: { role: 'owner' }, memberships: [], grants: [] };

const env = { OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test/model', AI_PRICE_TABLE: '{"test/model":{"in":1000,"out":1000}}', AI_USD_TO_KES: '100' };
const clock = fakeClock('2026-11-18T09:00:00+03:00');
const now = () => { clock.advance(1); return clock.now(); }; // ticks 1 ms per read so rows have a stable order
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

/** A stubbed provider. script = array of responses used in order (last one repeats): { prompt, completion, content, status, throw, cost, delay }. */
let fetchCalls = 0;
let sentBodies = [];
const provider = (script) => async (_url, init) => {
  const step = script[Math.min(fetchCalls, script.length - 1)];
  fetchCalls++; sentBodies.push(JSON.parse(init.body));
  if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
  if (step.throw) throw Object.assign(new Error('network down'), { name: step.throw });
  if (step.status) return { ok: false, status: step.status, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ id: `gen-${fetchCalls}`, model: 'test/model', choices: [{ message: { content: step.content ?? '{"answer":1}' } }],
    usage: { prompt_tokens: step.prompt, completion_tokens: step.completion, ...(step.cost !== undefined ? { cost: step.cost } : {}) } }) };
};
const reset = () => { fetchCalls = 0; sentBodies = []; gateway.clearCache(); };
let n = 0;
const ask = (script, extra = {}) => gateway.call(db, { businessId, feature: 'recipe_draft', actorId: users.owner, system: 'Be brief.', user: `Question ${++n}`, maxTokens: 50,
  env, now, sleep, fetchImpl: provider(script), ...extra });
const usageRows = () => q('select feature, status, model, prompt_tokens, completion_tokens, cost_kes::float as kes, error_code, user_id from public.ai_usage order by created_at, id');
const month = () => usageThisMonth(db, businessId, { now: now() });

// ===== 1. Off by default: no row = AI off, nothing leaves the building =====
reset();
await refuses(ask([{ prompt: 10, completion: 10 }]), 403, 'ai_off', /AI suggestions are off for this business/, 'no settings and no allowance: off');
eq(fetchCalls, 0, 'no provider call when off');
await refuses(ask([{ prompt: 1, completion: 1 }], { env: {} }), 503, 'ai_not_configured', null, 'no API key -> 503 before anything else');
await db.transaction((t) => adminSet(t, admin, businessId, { enabled: true }));
await refuses(ask([{ prompt: 10, completion: 10 }]), 403, 'ai_off', null, 'switch on but no allowance row: still off');
eq(fetchCalls, 0, 'still no provider call');
eq((await month()).allowance.limitKes, null, 'no limit while no allowance');
await refuses(db.transaction((t) => adminSet(t, admin, businessId, { warnPct: 90 })), 400, 'bad_budget', /Set the monthly allowance first/, 'warn level needs an allowance');
await refuses(db.transaction((t) => adminSet(t, { user: { id: users.owner }, profile: { role: 'owner' } }, businessId, { enabled: true })), 403, 'forbidden', null, 'only the platform admin sets the allowance');
await refuses(db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: -5 })), 400, 'bad_budget', null, 'negative allowance refused');
await refuses(db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 'lots' })), 400, 'bad_budget', null, 'text allowance refused');

// ===== 2. Metering is exact (three scripted calls = the hand-calculated total) =====
const set = await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 100, reason: 'pilot allowance' }));
eq([set.allowance.monthlyBudgetKes, set.allowance.effectiveKes, set.enabled], [100, 100, true], 'allowance set (100 KES = 1,000 tokens at the test price)');
const r1 = await ask([{ prompt: 100, completion: 50 }]);         // 150 tokens = 15.0 KES
eq([r1.usage.promptTokens, r1.usage.completionTokens, r1.usage.costKes, r1.cached, r1.model], [100, 50, 15, false, 'test/model'], 'call 1: tokens from the provider usage block, cost 15 KES');
await ask([{ prompt: 200, completion: 100 }]);                    // 30.0
await ask([{ prompt: 60, completion: 40 }]);                      // 10.0
let rows = await usageRows();
eq(rows.map((r) => [r.status, r.prompt_tokens, r.completion_tokens, r.kes]), [['ok', 100, 50, 15], ['ok', 200, 100, 30], ['ok', 60, 40, 10]], 'one ai_usage row per attempt with exact tokens and cost');
eq(rows.every((r) => r.feature === 'recipe_draft' && r.model === 'test/model' && r.user_id === users.owner), true, 'feature, model and user recorded');
let m = await month();
eq([m.calls, m.promptTokens, m.completionTokens, m.costKes, m.allowance.usedKes, m.allowance.percent, m.allowance.warning, m.allowance.remainingKes], [3, 360, 190, 55, 55, 55, false, 45], 'month total = 55 KES = 550 tokens');
eq(JSON.stringify(rows).includes('Question'), false, 'no prompt text in usage rows');
eq(sentBodies[0].usage, { include: true }, 'we ask the provider for its cost');
eq(sentBodies[0].model, 'test/model', 'model from OPENROUTER_MODEL');
const columns = (await q(`select column_name from information_schema.columns where table_name = 'ai_usage'`)).map((c) => c.column_name);
eq(columns.filter((c) => /prompt$|text|content|answer|message/.test(c)), [], 'the table has no column that could hold prompt or answer text (prompt_tokens only)');
// The provider's own cost beats the price table
const rc = await ask([{ prompt: 10, completion: 10, cost: 0.02 }]);          // 0.02 USD x 100 = 2.0 KES
eq(rc.usage.costKes, 2, 'provider-reported cost is used when present');
// No usage block at all: estimated from text length, marked
const noUsage = await gateway.call(db, { businessId, feature: 'recipe_draft', system: 'Be brief.', user: 'Question without usage', maxTokens: 50, env, now, sleep,
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) }) });
ok(noUsage.usage.promptTokens > 0 && noUsage.usage.costKes > 0, 'missing usage block -> estimated tokens (never free)');
eq((await usageRows()).at(-1).error_code, 'usage_estimated', 'and the row says it was estimated');
// Spent so far: 55 + 2 + estimate. Re-base to a clean slate for the limit tests by raising the allowance later; compute the spend.
const spent = (await month()).costKes;

// ===== 3. 80 % warning once, 100 % hard stop =====
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 200 }));          // 200 KES = 2,000 tokens
const top = async (target) => { // spends so the month total is exactly `target` KES using one call
  const need = Math.round((target - (await month()).costKes) * 10);
  return ask([{ prompt: need, completion: 0 }]);
};
let w = await top(150);
eq([w.allowance.percent, w.allowance.warning], [75, false], '75% used: no warning yet');
eq((await q(`select 1 from public.notifications where kind = 'ai_allowance_warning'`)).length, 0, 'no notification below the warn level');
w = await top(160);
eq([w.allowance.percent, w.allowance.warning, w.allowance.warnPct], [80, true, 80], 'exactly 80%: warning flag on');
const notes = await q(`select recipient_id, title, dedupe_key from public.notifications where kind = 'ai_allowance_warning'`);
eq([notes.length, notes.map((x) => x.recipient_id).sort(), notes[0].title, notes[0].dedupe_key], [2, [users.owner, people.owner2].sort(), 'You have used 80% of this month’s AI allowance', 'ai_warn:2026-11:80'], 'each owner is notified once, with the plain sentence');
w = await top(170);
eq(w.allowance.warning, true, 'still warning at 85%');
eq((await q(`select 1 from public.notifications where kind = 'ai_allowance_warning'`)).length, 2, 'warned once per month, not per call');
const beforeStop = fetchCalls;
w = await top(200);
eq([w.allowance.percent, w.allowance.limitKes], [100, 200], 'reached 100%');
await refuses(ask([{ prompt: 1, completion: 1 }]), 429, 'ai_allowance_used', /^Your AI allowance for this month is used up\. It resets on 1 December\.$/, 'at 100%: the exact plain message');
eq(fetchCalls, beforeStop + 1, 'the refused call never reached the provider (only the call that hit 100%)');
const blocked = (await usageRows()).at(-1);
eq([blocked.status, blocked.error_code, blocked.kes], ['blocked', 'ai_allowance_used', 0], 'refusal recorded as blocked, costs nothing');
eq((await month()).blocked, 1, 'usage summary counts the blocked call');
// A cached answer is not served past the limit either
await refuses(ask([{ prompt: 1, completion: 1 }], { user: 'Question 1' }), 429, 'ai_allowance_used', null, 'over the limit even for a repeated question');
// Admin raises: immediate effect
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 400 }));
ok((await ask([{ prompt: 10, completion: 10 }])).usage.costKes === 2, 'raising the allowance takes effect immediately');

// ===== 5. Owner cap: lower only; admin lowering pulls it down =====
const ownerScope = await inventoryScope(db, contexts.owner, businessId);
await refuses(db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: 401 })), 400, 'cap_above_allowance', /not raise it above KES 400/, 'owner can’t exceed the admin allowance');
await refuses(db.transaction((t) => ownerSet(t, ownerScope, businessId, { monthlyBudgetKes: 900 })), 403, 'forbidden', /Only Cravio/, 'owner can’t set the allowance');
await refuses(db.transaction((t) => ownerSet(t, ownerScope, businessId, { enabled: false })), 403, 'forbidden', null, 'nor the business switch');
await refuses(db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: -1 })), 400, 'bad_budget', null, 'nor a negative cap');
let ov = await db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: 300 }));
eq([ov.allowance.monthlyBudgetKes, ov.allowance.ownerBudgetKes, ov.limitKes], [400, 300, 300], 'owner lowered to 300: effective limit 300');
let dbErr = null; try { await db.query('update public.ai_limits set owner_budget_kes = 999 where business_id = $1', [businessId]); } catch (e) { dbErr = e; }
ok(dbErr && /check/i.test(dbErr.message), 'the database itself refuses an owner cap above the allowance');
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 250 }));
eq((await month()).allowance.limitKes, 250, 'admin lowered below the owner cap: effective limit follows');
eq((await one('select owner_budget_kes::float as c from public.ai_limits where business_id = $1', [businessId])).c, 250, 'and the owner cap was pulled down with it');
ov = await db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: null }));
eq([ov.allowance.ownerBudgetKes, ov.limitKes], [null, 250], 'owner clears the cap: back to the admin figure');
await db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: 4 }));
{ // a cap below usage blocks at once
  await refuses(ask([{ prompt: 1, completion: 1 }]), 429, 'ai_allowance_used', null, 'owner cap already passed -> refused');
}
await db.transaction((t) => ownerSet(t, ownerScope, businessId, { ownerBudgetKes: null }));
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 1000 }));
const audit = await q(`select action, actor_role, before, after from public.inventory_events where entity = 'ai_settings' order by id`);
ok(audit.length >= 6 && audit.some((a) => a.action === 'ai_owner_changed' && a.actor_role === 'owner') && audit.some((a) => a.action === 'ai_settings_changed' && a.actor_role === 'admin'), 'allowance changes are audited (admin and owner)');
eq(JSON.stringify(audit).includes('Question'), false, 'audit holds numbers only');

// ===== 6. Switches: business, feature (admin), feature (owner) =====
reset();
const before6 = (await usageRows()).length;
await db.transaction((t) => adminSet(t, admin, businessId, { features: { recipe_draft: false } }));
await refuses(ask([{ prompt: 1, completion: 1 }]), 403, 'ai_off', null, 'feature switched off by the admin');
await db.transaction((t) => adminSet(t, admin, businessId, { features: { recipe_draft: true } }));
await db.transaction((t) => ownerSet(t, ownerScope, businessId, { featuresOff: ['recipe_draft'] }));
await refuses(ask([{ prompt: 1, completion: 1 }]), 403, 'ai_off', /switched off/, 'feature switched off by the owner');
eq((await db.transaction((t) => adminSet(t, admin, businessId, { features: { recipe_draft: true } }))).featuresOwnerOff, ['recipe_draft'], 'the admin can’t be overridden by flipping their own switch');
await db.transaction((t) => ownerSet(t, ownerScope, businessId, { featuresOff: [] }));
await db.transaction((t) => adminSet(t, admin, businessId, { enabled: false }));
await refuses(ask([{ prompt: 1, completion: 1 }]), 403, 'ai_off', null, 'business switched off');
await db.transaction((t) => adminSet(t, admin, businessId, { enabled: true }));
eq([fetchCalls, (await usageRows()).length], [0, before6], 'switch refusals: no provider call and no usage row');
await refuses(db.transaction((t) => adminSet(t, admin, businessId, { features: { mystery: false } })), 400, 'bad_features', null, 'unknown feature refused');
await db.transaction((t) => adminSet(t, admin, businessId, { modelOverrides: { recipe_draft: 'vendor/cheap-model' } }));
await ask([{ prompt: 10, completion: 10 }]);
eq(sentBodies[0].model, 'vendor/cheap-model', 'per-feature model override is used');
eq((await usageRows()).at(-1).model, 'test/model', 'and the row records the model the provider reports');
await refuses(db.transaction((t) => adminSet(t, admin, businessId, { modelOverrides: { recipe_draft: 'not a model' } })), 400, 'bad_model', null, 'malformed model id refused');
await db.transaction((t) => adminSet(t, admin, businessId, { modelOverrides: { recipe_draft: null } }));

// ===== 7. Failures: recorded, free, one retry =====
reset();
const base7 = await month();
const retried = await ask([{ status: 503 }, { prompt: 20, completion: 20 }]);
eq([fetchCalls, retried.usage.costKes, sleeps.length >= 1], [2, 4, true], '503 then success: one retry with a back-off');
let tail = (await usageRows()).slice(-2);
eq(tail.map((r) => [r.status, r.kes, r.prompt_tokens]), [['error', 0, null], ['ok', 4, 20]], 'one row per attempt: the failure at no cost, then the success');
await refuses(ask([{ status: 500 }]), 502, 'ai_unavailable', null, 'two failures -> 502');
eq(fetchCalls, 4, 'at most two attempts per call');
tail = (await usageRows()).slice(-2);
eq(tail.map((r) => [r.status, r.error_code]), [['error', 'ai_unavailable'], ['error', 'ai_unavailable']], 'both failed attempts recorded');
const after7 = await month();
eq([after7.costKes - base7.costKes, after7.errors - base7.errors], [4, 3], 'failed calls cost nothing against the allowance (only the 4 KES success counted)');
await refuses(ask([{ throw: 'AbortError' }, { throw: 'AbortError' }]), 502, 'ai_unavailable', /took too long/, 'timeouts are retried then reported plainly');
await refuses(ask([{ status: 401 }]), 502, 'ai_unavailable', null, 'a 401 is not retried');
eq(fetchCalls, 4 + 2 + 1, 'a non-retryable failure makes one attempt only');
// Unusable answers DO count
const costBefore = (await month()).costKes;
await refuses(ask([{ prompt: 30, completion: 20, content: 'not json at all' }]), 502, 'ai_bad_answer', null, 'unusable answer -> 502');
tail = (await usageRows()).at(-1);
eq([tail.status, tail.kes, tail.prompt_tokens, tail.completion_tokens], ['rejected', 5, 30, 20], 'bad JSON is recorded as rejected and the tokens count');
eq((await month()).costKes - costBefore, 5, 'rejected answers count against the allowance');
const costBefore2 = (await month()).costKes;
await refuses(ask([{ prompt: 10, completion: 10 }], { parse: () => { throw new HttpError(502, 'nope', { code: 'ai_bad_answer' }); } }), 502, 'ai_bad_answer', null, 'parse() rejection');
eq([(await usageRows()).at(-1).status, (await month()).costKes - costBefore2], ['rejected', 2], 'a validator rejection is metered too, and not retried');
eq(fetchCalls, 4 + 2 + 1 + 1 + 1, 'no retry after an unusable answer');
eq((await q(`select count(*)::int as n from public.ai_usage where status = 'reserved'`))[0].n, 0, 'no reservation is left unsettled after failures');

// ===== 8. Cache: the second identical question costs nothing =====
reset();
const first = await ask([{ prompt: 40, completion: 10 }], { user: 'Same question' });
const second = await ask([{ prompt: 400, completion: 100 }], { user: 'Same question' });
eq([fetchCalls, second.cached, second.usage.costKes, second.data], [1, true, 0, first.data], 'identical input answered from the cache: one provider call');
tail = (await usageRows()).at(-1);
eq([tail.status, tail.prompt_tokens, tail.kes], ['cached', null, 0], 'cache hit is a cached row with no tokens and no cost');
second.data.answer = 99;
eq((await ask([{ prompt: 1, completion: 1 }], { user: 'Same question' })).data.answer, 1, 'cached data can’t be mutated by callers');
await ask([{ prompt: 10, completion: 10 }], { user: 'Same question', cache: false });
eq(fetchCalls, 2, 'cache: false always calls the provider');
await ask([{ prompt: 10, completion: 10 }], { user: 'Same question', cacheKey: 'other' });
eq(fetchCalls, 3, 'a different cacheKey is a different entry');
clock.advance(16 * 60_000);
await ask([{ prompt: 10, completion: 10 }], { user: 'Same question' });
eq(fetchCalls, 4, 'after the 15 minute TTL the provider is called again');
const cachedElsewhere = await gateway.call(db, { businessId, feature: 'daily_insight', system: 'Be brief.', user: 'Same question', maxTokens: 50, env, now, sleep, fetchImpl: provider([{ prompt: 10, completion: 10 }]) });
eq(cachedElsewhere.cached, false, 'cache is per feature');

// ===== 9. Privacy guard =====
reset();
const rowsBefore = (await usageRows()).length;
for (const [label, extra] of [
  ['an email in the prompt', { user: 'Dish for jane.doe@example.com' }],
  ['a Kenyan mobile number', { user: 'Call 0712 345 678 about the dish' }],
  ['a +254 number', { user: 'Supplier +254 722 000 111' }],
  ['a long digit string (card / reference)', { user: 'Ref 4111111111111111' }],
  ['an email in the system text', { system: 'Contact boss@cravio.test' }],
  ['a denied payload field (phone)', { user: undefined, payload: { branch: 'Westlands', phone: '0700000000' } }],
  ['a denied payload field (customer_name)', { user: undefined, payload: { branch: 'Westlands', rows: [{ customer_name: 'Wanjiru' }] } }],
  ['a denied payload field (notes)', { user: undefined, payload: { notes: 'free text' } }],
  ['a phone number nested in a payload value', { user: undefined, payload: { branch: { label: 'Call 254712345678' } } }],
]) {
  await refuses(ask([{ prompt: 1, completion: 1 }], extra), 400, 'ai_pii_blocked', /personal details/, label);
}
eq([fetchCalls, (await usageRows()).length], [0, rowsBefore], 'blocked before anything is sent or recorded');
const okPayload = await ask([{ prompt: 10, completion: 10 }], { user: undefined, payload: { branch: 'Westlands', salesKes: 820000, dishes: ['Chicken burger', 'Fries'] } });
eq(okPayload.data.answer, 1, 'business data (branch, dish names, KES) is allowed');
eq(JSON.parse(sentBodies[0].messages[1].content).branch, 'Westlands', 'a payload is serialised as the user message');
const err = await ask([{ prompt: 1, completion: 1 }], { user: 'x@y.zz' }).catch((e) => e);
eq(JSON.stringify(err.details).includes('x@y.zz'), false, 'the refusal never echoes the value');

// ===== 10. Concurrency: parallel calls cannot slip past the limit =====
reset();
const start10 = (await month()).costKes;
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: start10 + 10 }));
const settled = await Promise.allSettled(Array.from({ length: 6 }, () => ask([{ prompt: 3, completion: 20, delay: 15 }], { maxTokens: 20 })));  // each really costs 2.3 KES (6 would be 13.8, over the 10 limit); each reserves ~2.7 up front
const wins = settled.filter((s) => s.status === 'fulfilled').length;
const stops = settled.filter((s) => s.status === 'rejected' && s.reason?.details?.code === 'ai_allowance_used').length;
eq(wins + stops, 6, 'every parallel call either succeeded or was stopped by the allowance');
ok(wins >= 1 && wins <= 3 && stops >= 3, `at most three of six parallel calls fit in 10 KES (${wins} did)`);
ok((await month()).costKes - start10 <= 10, 'total spend never passes the limit');
eq((await q(`select count(*)::int as n from public.ai_usage where status = 'reserved'`))[0].n, 0, 'all reservations settled');
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 1000 }));

// ===== 11. Usage rows are insert-only =====
const target = await one(`select id from public.ai_usage where status = 'ok' limit 1`);
await assert.rejects(db.query(`update public.ai_usage set cost_kes = 0 where id = $1`, [target.id]), /can’t be changed|can't be changed/, 'update refused'); count();
await assert.rejects(db.query(`update public.ai_usage set status = 'ok' where id = $1`, [target.id]), /can't be changed/, 'status change refused'); count();
await assert.rejects(db.query(`delete from public.ai_usage where id = $1`, [target.id]), /can't be deleted/, 'delete refused'); count();
await assert.rejects(db.query(`delete from public.ai_usage`), /can't be deleted/, 'bulk delete refused'); count();
await assert.rejects(db.query(`insert into public.ai_usage (business_id, feature, status) values ($1, 'x', 'bogus')`, [businessId]), /check/i, 'unknown status refused'); count();
const rid = (await one(`insert into public.ai_usage (business_id, feature, status) values ($1, 'x', 'reserved') returning id`, [businessId])).id;
await db.query(`update public.ai_usage set status = 'ok', prompt_tokens = 1, completion_tokens = 1 where id = $1`, [rid]);
await assert.rejects(db.query(`update public.ai_usage set status = 'error' where id = $1`, [rid]), /can't be changed/, 'a settled row can’t change again'); count();
await assert.rejects(db.query(`update public.ai_usage set business_id = $2 where id = $1`, [(await one(`insert into public.ai_usage (business_id, feature, status) values ($1, 'x', 'reserved') returning id`, [businessId])).id, strangerId]), /can't be changed/, 'identity columns frozen'); count();

// ===== 12. The recipe draft goes through the gateway (P2-33) =====
reset();
const scope = await inventoryScope(db, contexts.owner, businessId, { ensureLocations: true });
const draftBody = [{ prompt: 80, completion: 20, content: JSON.stringify({ lines: [{ name: 'Flour', quantity: 100, unit: 'g' }], note: 'A simple bun' }) }];
const rowsBefore12 = (await usageRows()).length;
const draft = await recipes.suggest(db, scope, ids.burgerId, { env, fetchImpl: provider(draftBody), now, sleep });
eq([draft.draft, draft.menuItemId, draft.model, draft.lines[0].itemId, draft.lines[0].quantity, draft.note], [true, ids.burgerId, 'test/model', items.flour, 100, 'A simple bun'], 'same response shape as before');
const dr = (await usageRows()).slice(rowsBefore12);
eq(dr.map((r) => [r.feature, r.status, r.model, r.prompt_tokens, r.completion_tokens, r.kes]), [['recipe_draft', 'ok', 'test/model', 80, 20, 10]], 'the draft is metered: feature, model, tokens and KES');
eq(dr[0].user_id, users.owner, 'with the person who asked');
ok(!JSON.stringify(sentBodies).includes('salesKes'), 'only menu text and item names are sent');
const stopAt = (await month()).costKes;
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: stopAt }));
reset();
await refuses(recipes.suggest(db, scope, ids.burgerId, { env, fetchImpl: provider(draftBody), now, sleep }), 429, 'ai_allowance_used', /^Your AI allowance for this month is used up\. It resets on 1 December\.$/, 'draft at the limit: the plain message');
eq(fetchCalls, 0, 'and no provider call');
await db.transaction((t) => adminSet(t, admin, businessId, { enabled: false }));
await refuses(recipes.suggest(db, scope, ids.burgerId, { env, fetchImpl: provider(draftBody), now, sleep }), 403, 'ai_off', /AI suggestions are off for this business/, 'AI off: the form says so');
const saved = await db.transaction((t) => recipes.saveRecipe(t, scope, ids.burgerId, { lines: [{ itemId: items.flour, quantity: 100, unit: 'g' }] }));
ok(saved, 'with AI off the recipe can still be saved by hand');
await refuses(recipes.suggest(db, scope, ids.burgerId, { env: {}, fetchImpl: provider(draftBody), now, sleep }), 503, 'ai_not_configured', null, 'no key stays a 503');
await db.transaction((t) => adminSet(t, admin, businessId, { enabled: true, monthlyBudgetKes: 1000 }));
reset();
await refuses(recipes.suggest(db, scope, ids.burgerId, { env, fetchImpl: provider([{ prompt: 5, completion: 5, content: JSON.stringify({ lines: [{ name: 'Flour', quantity: -3, unit: 'g' }] }) }]), now, sleep }), 502, 'ai_bad_answer', null, 'draft with nothing usable');
eq((await usageRows()).at(-1).status, 'rejected', 'an unusable draft is metered as rejected (tokens were spent)');

// ===== 4. Month boundary (Nairobi calendar month) and the reset date text (runs late: it writes December rows, and rows are read back newest-last) =====
const edge = monthBounds(new Date('2026-12-31T22:00:00Z'));      // 01:00 on 1 Jan in Nairobi
eq([edge.month, edge.resetText, edge.resetDate], ['2027-01', '1 February', '2027-02-01'], '22:00 UTC on 31 Dec is already January in Nairobi');
eq([monthBounds(new Date('2026-12-31T20:00:00Z')).month, monthBounds(new Date('2026-12-31T20:00:00Z')).resetText], ['2026-12', '1 January'], '20:00 UTC on 31 Dec is still December: resets on 1 January');
eq(monthBounds(new Date('2026-11-18T09:00:00+03:00')).resetText, '1 December', 'November resets on 1 December');
const used = (await month()).costKes;
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: used }));        // exactly used up
clock.set('2026-11-30T23:59:30+03:00');
await refuses(ask([{ prompt: 1, completion: 1 }]), 429, 'ai_allowance_used', /resets on 1 December\./, '23:59:30 on 30 Nov: still used up');
clock.set('2026-12-01T00:00:10+03:00');
eq((await month()).costKes, 0, 'a second after midnight on 1 Dec: new month, nothing used');
const fresh = await ask([{ prompt: 10, completion: 10 }]);
eq([fresh.usage.costKes, fresh.allowance.usedKes], [2, 2], 'the allowance reset: calls work again');
clock.set('2026-12-31T10:00:00+03:00');
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 2 }));
await refuses(ask([{ prompt: 1, completion: 1 }]), 429, 'ai_allowance_used', /^Your AI allowance for this month is used up\. It resets on 1 January\.$/, 'on 31 Dec the message says 1 January');
const hist = await usageHistory(db, businessId, 6, { now: now() });
eq([hist.length, hist[0].month, hist[1].month, hist[1].costKes > 0, hist[5].month], [6, '2026-12', '2026-11', true, '2026-07'], 'six months of history, newest first, no gaps');
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 1000 }));
clock.set('2026-11-18T09:00:00+03:00');

// ===== 13. Endpoints: admin and owner =====
const tokens = { admin, owner: contexts.owner, owner2: contexts.owner2, manager: contexts.manager, ops: contexts.ops, waiter: contexts.waiter, stranger };
const authenticate = async (request) => { const who = request.headers.authorization?.replace(/^Bearer /, ''); if (!tokens[who]) throw new HttpError(401, 'Please sign in to continue.'); return tokens[who]; };
const routes = createRoutes({ authenticateAdmin: async (request) => { const c = await authenticate(request); if (c.profile.role !== 'admin') throw new HttpError(403, 'You do not have access to this.'); return c; },
  authenticate, pool: () => db, transact: (fn) => db.transaction(fn), now });
const api = async (as, method, pathname, body) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.path.exec(pathname);
    if (m) return route.handler({ request: { headers: { authorization: `Bearer ${as}` } }, params: { ...m.groups }, body: method === 'GET' ? undefined : body, url: new URL(`http://x${pathname}`) });
  }
  throw new Error(`no route ${method} ${pathname}`);
};
const A = `/api/admin/businesses/${businessId}/ai`;
const O = `/api/owner/inventory/${businessId}`;
await db.transaction((t) => adminSet(t, admin, businessId, { monthlyBudgetKes: 400, enabled: true }));
await refuses(api('owner', 'GET', A), 403, null, null, 'owner can’t open the admin endpoint');
await refuses(api('owner', 'PUT', A, { monthlyBudgetKes: 9999 }), 403, null, null, 'owner can’t raise the allowance through the admin endpoint');
await refuses(api('manager', 'PUT', A, { enabled: false }), 403, null, null, 'branch manager can’t either');
const av = await api('admin', 'GET', A);
eq([av.businessId, av.enabled, av.allowance.monthlyBudgetKes, av.history.length, av.features.recipe_draft], [businessId, true, 400, 6, true], 'admin sees switches, allowance and six months');
ok(av.usage.calls > 0 && av.usage.byFeature.length > 0 && typeof av.usage.costKes === 'number', 'admin sees counts and KES');
eq(Object.keys(av.usage).filter((k) => /text|prompt$|answer|content|message/.test(k)), [], 'admin sees numbers only: no prompt or answer fields');
const put = await api('admin', 'PUT', A, { monthlyBudgetKes: 500, warnPct: 90, features: { daily_insight: false }, reason: 'upgraded' });
eq([put.allowance.monthlyBudgetKes, put.allowance.warnPct, put.features.daily_insight, put.changed.sort()], [500, 90, false, ['features', 'monthlyBudgetKes', 'warnPct']], 'admin PUT changes allowance, warn level and a feature');
await refuses(api('admin', 'PUT', A, { warnPct: 120 }), 400, 'bad_warn', null, 'warn level 1..100');
await refuses(api('admin', 'GET', `/api/admin/businesses/00000000-0000-4000-8000-000000000000/ai`), 404, 'not_found', null, 'unknown business');
await api('admin', 'PUT', A, { warnPct: 80, features: { daily_insight: true } });

const ou = await api('owner', 'GET', `${O}/ai-usage`);
eq([ou.businessId, ou.allowance.monthlyBudgetKes, ou.allowance.canRaise, typeof ou.usage.costKes, ou.history.length, ou.limitKes], [businessId, 500, false, 'number', 6, 500], 'owner sees usage, the effective limit and history');
ok(ou.message === null && ou.percent !== undefined && ou.resetText === '1 December', 'with the reset date text');
await refuses(api('manager', 'GET', `${O}/ai-usage`), 403, 'forbidden', null, 'branch manager has no access');
await refuses(api('ops', 'GET', `${O}/ai-usage`), 403, 'forbidden', null, 'operations manager has no access');
await refuses(api('waiter', 'GET', `${O}/ai-usage`), 403, 'forbidden', null, 'waiter has no access');
await refuses(api('stranger', 'GET', `${O}/ai-usage`), 403, 'forbidden', null, 'someone from another business has no access');
await refuses(api('admin', 'GET', `${O}/ai-usage`), 403, 'forbidden', null, 'the admin uses the admin endpoint, not the owner one');
await refuses(api('manager', 'PUT', `${O}/ai-limit`, { ownerBudgetKes: 10 }), 403, 'forbidden', null, 'branch manager can’t set a cap');
eq((await q(`select 1 from public.inventory_events where action = 'denied' and actor_id = $1 and entity = 'ai_settings'`, [users.manager])).length >= 2, true, 'denied attempts are audited');
await refuses(api('owner', 'PUT', `${O}/ai-limit`, { ownerBudgetKes: 501 }), 400, 'cap_above_allowance', null, 'owner can’t raise above the admin allowance (endpoint)');
await refuses(api('owner', 'PUT', `${O}/ai-limit`, { monthlyBudgetKes: 5000 }), 403, 'forbidden', null, 'owner can’t send the admin field');
const lowered = await api('owner', 'PUT', `${O}/ai-limit`, { ownerBudgetKes: 120.5, commandId: '11111111-1111-4111-8111-111111111111' });
eq([lowered.allowance.ownerBudgetKes, lowered.limitKes, lowered.changed], [120.5, 120.5, ['ownerBudgetKes']], 'owner lowers their cap');
const replay = await api('owner', 'PUT', `${O}/ai-limit`, { ownerBudgetKes: 120.5, commandId: '11111111-1111-4111-8111-111111111111' });
eq(replay.limitKes, 120.5, 'the same commandId replays the first answer');
eq((await api('admin', 'GET', A)).allowance.effectiveKes, 120.5, 'the admin screen shows the effective limit');
await api('owner', 'PUT', `${O}/ai-limit`, { ownerBudgetKes: null });
await db.query('update public.businesses set inventory_enabled = false where id = $1', [businessId]);
await refuses(api('owner', 'GET', `${O}/ai-usage`), 403, 'inventory_disabled', null, 'owner screens follow the inventory switch');
await db.query('update public.businesses set inventory_enabled = true where id = $1', [businessId]);

// ===== 14. One door: only the gateway imports lib/ai.js =====
const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = `${dir}${name}`; return statSync(p).isDirectory() ? walk(`${p}/`) : p.endsWith('.js') ? [p] : []; });
// './ai.js' only means lib/ai.js for files inside lib/ (routes/index.js imports './ai.js' = routes/ai.js, the AI usage API).
const importsLibAi = (p) => { const src = readFileSync(p, 'utf8'); return /from\s+['"][^'"]*lib\/ai\.js['"]/.test(src) || (p.slice(srcDir.length).startsWith('lib/') && /from\s+['"]\.\/ai\.js['"]/.test(src)); };
const importers = walk(srcDir).filter(importsLibAi).map((p) => p.slice(srcDir.length)).sort();
// stock/recipes.js is the frozen 009 module; its route no longer calls it (routes/stock.js goes through ai/legacy-recipe.js) and it goes with the old pages (P2-28).
eq(importers, ['ai/gateway.js', 'stock/recipes.js'], 'only the gateway (and the frozen, now unused 009 recipes module) import lib/ai.js');
const callers = walk(srcDir).filter((p) => /\b(chatCompletion|chatJson)\b/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(srcDir.length)).sort();
eq(callers, ['ai/gateway.js', 'lib/ai.js'], 'nothing else calls the provider functions');
ok(!/suggest\b/.test(readFileSync(`${srcDir}routes/stock.js`, 'utf8').replace(/suggestionInput|suggestLegacy|\/suggest|AI draft/g, '')), 'the 009 route no longer uses the unmetered suggest');

console.log(`ai-gateway: ${count()} checks passed`);
