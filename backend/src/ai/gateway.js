// The ONE door to the AI provider (12-ai-insights.md §2, ticket P2-32). Nothing else may import lib/ai.js's chatCompletion/chatJson;
// a test greps for it. Every call is: privacy guard -> business/feature switch -> month-to-date limit -> cache -> provider call
// (25 s timeout, one retry on timeout/429/5xx) -> one ai_usage row per provider attempt (tokens from the provider's usage block).
//
// Limits: effective limit = least(admin allowance, owner cap), in KES per calendar month (Africa/Nairobi). No allowance row = AI off.
//   * 100 % -> 429 ai_allowance_used with the plain message; no provider call, a 'blocked' row is written.
//   * >= warn % (default 80) -> `allowance.warning` on the result, and a stored notification to the owners once per month.
//   * Concurrency: under a per-business advisory lock a call reserves its worst-case cost ('reserved' row) before it goes out, and the
//     reservation is settled to the real cost afterwards, so parallel calls cannot overshoot the allowance.
//   * A failed provider attempt costs nothing against the allowance; an unusable answer (bad JSON, `parse` threw) does (tokens were spent).
// Cache: in this process, key = business + feature + hash(input + model), TTL default 15 min; a hit is a 'cached' row with 0 tokens/cost.
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { RECIPE_SYSTEM, aiConfigured, chatCompletion, matchItem, normaliseSuggestion, recipePrompt } from '../lib/ai.js';
import { guardPrompt } from './pii.js';
import { FEATURES, FEATURE_LABELS, effectiveLimit, loadState, offReason, spentBetween, usageHistory, usageThisMonth } from './limits.js';
import { LIMIT_MESSAGE, costOf, estimateTokens, monthBounds, round } from './meter.js';

export { FEATURES, usageHistory, usageThisMonth };
// Pure prompt/parse helpers from lib/ai.js, re-exported so callers never import lib/ai.js themselves.
export { RECIPE_SYSTEM, matchItem, normaliseSuggestion, recipePrompt };
export const ATTEMPTS = 2;
export const RESERVATION_TTL_MS = 3 * 60_000;
export const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 200;
const cache = new Map();
/** Tests: forget every cached answer. */
export const clearCache = () => cache.clear();

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs fn(tx) in a transaction on whatever `db` is: a PGlite wrapper (tests), a pg Pool (routes) or a client already in one. */
async function inTx(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn);
  if (typeof db.release === 'function') return fn(db);
  if (typeof db.connect === 'function') {
    const client = await db.connect();
    try { await client.query('begin'); const out = await fn(client); await client.query('commit'); return out; } catch (error) {
      await client.query('rollback').catch(() => {}); throw error;
    } finally { client.release(); }
  }
  return fn(db);
}

const hashOf = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

async function insertRow(db, { businessId, feature, actorId, model = null, status, costUsd = 0, costKes = 0, fxRate = null, promptTokens = null, completionTokens = null, errorCode = null, requestId = null, latencyMs = null, at }) {
  return (await db.query(`insert into public.ai_usage (business_id, feature, user_id, model, prompt_tokens, completion_tokens, cost_usd, cost_kes, fx_rate, status, error_code, request_id, latency_ms, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
  [businessId, feature, actorId || null, model, promptTokens, completionTokens, costUsd, costKes, fxRate, status, errorCode, requestId, latencyMs, at])).rows[0].id;
}

const limitError = (resetText) => fail(429, LIMIT_MESSAGE(resetText), 'ai_allowance_used', { resetText });

/** Writes a 'blocked' row (best effort) and returns the 429 to throw. */
async function blocked(db, ctx, bounds) {
  try { await insertRow(db, { ...ctx, status: 'blocked', errorCode: 'ai_allowance_used' }); } catch (e) { console.error('[ai] could not record a blocked call:', e.message); }
  return limitError(bounds.resetText);
}

/** Under the business's advisory lock: refuse when settled + reserved + this call's worst case would pass the limit; else insert the reservation. */
async function reserve(db, ctx, { limitKes, bounds, worstKes, worstUsd, model, now }) {
  return inTx(db, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 17))', [`ai:${ctx.businessId}`]);
    const settled = await spentBetween(tx, ctx.businessId, bounds.start, bounds.next);
    const held = Number((await tx.query(`select coalesce(sum(cost_kes), 0)::text as held from public.ai_usage
      where business_id = $1 and status = 'reserved' and created_at >= $2`, [ctx.businessId, new Date(now.getTime() - RESERVATION_TTL_MS)])).rows[0].held);
    if (settled + held >= limitKes || settled + held + worstKes > limitKes) return null;
    return insertRow(tx, { ...ctx, model, status: 'reserved', costUsd: worstUsd, costKes: worstKes, at: now });
  });
}

const settle = (db, id, row) => db.query(`update public.ai_usage set status = $2, model = $3, prompt_tokens = $4, completion_tokens = $5, cost_usd = $6, cost_kes = $7,
  fx_rate = $8, error_code = $9, request_id = $10, latency_ms = $11 where id = $1 and status = 'reserved'`,
[id, row.status, row.model ?? null, row.promptTokens ?? null, row.completionTokens ?? null, row.costUsd ?? 0, row.costKes ?? 0, row.fxRate ?? null, row.errorCode ?? null, row.requestId ?? null, row.latencyMs ?? null]);

/** Stored notification to the owners, once per month and level (dedupe key). Best effort. */
async function warnOwners(db, businessId, percent, warnPct, month) {
  try {
    const owners = (await db.query(`select user_id from public.business_members where business_id = $1 and role = 'owner'`, [businessId])).rows;
    for (const { user_id: userId } of owners) {
      await db.query(`insert into public.notifications (business_id, recipient_id, kind, title, body, dedupe_key) values ($1, $2, 'ai_allowance_warning', $3, $4, $5)
        on conflict do nothing`, [businessId, userId, `You have used ${Math.floor(percent)}% of this month’s AI allowance`,
        'AI suggestions stop when the allowance is used up and start again next month. Ask Cravio if you need more.', `ai_warn:${month}:${warnPct}`]);
    }
  } catch (error) { console.error('[ai] could not store the allowance warning:', error.message); }
}

const allowanceNow = async (db, businessId, limits, bounds) => {
  const used = await spentBetween(db, businessId, bounds.start, bounds.next);
  const limit = effectiveLimit(limits);
  const percent = limit > 0 ? round((used / limit) * 100, 1) : 100;
  return { usedKes: used, limitKes: limit, percent, warnPct: limits.warn_pct, warning: percent >= limits.warn_pct, resetText: bounds.resetText };
};

/**
 * One metered AI call that must answer with JSON.
 *   db          a pool/client/wrapper (the gateway opens its own short transactions; never hold one open across this call)
 *   businessId, feature ('recipe_draft' | ...), actorId (user, null for jobs)
 *   system, user | payload   prompt text (payload is serialised after the privacy guard)
 *   parse(data)              optional validator/normaliser; if it throws an HttpError the answer counts as 'rejected' (tokens spent) and no retry happens
 *   maxTokens, cache (default true), cacheKey, cacheTtlMs
 *   env, fetchImpl, now() -> Date, sleep(ms), timeoutMs     for tests
 * Returns { data, model, cached, usage: { promptTokens, completionTokens, costKes }, allowance }.
 * Throws 400 ai_pii_blocked | 503 ai_not_configured | 403 ai_off | 429 ai_allowance_used | 502 ai_unavailable / ai_bad_answer.
 */
export async function call(db, { businessId, feature, actorId = null, system, user, payload, maxTokens = 800, parse = null, cache: useCache = true, cacheKey = null,
  cacheTtlMs = Number(process.env.AI_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS, env = process.env, fetchImpl, now = () => new Date(), sleep = sleepFor, timeoutMs } = {}) {
  if (!businessId || typeof feature !== 'string' || !/^[a-z][a-z_]{0,39}$/.test(feature)) throw new TypeError('gateway.call needs a businessId and a feature name.');
  if (typeof system !== 'string' || (typeof user !== 'string' && payload === undefined)) throw new TypeError('gateway.call needs system text and user text or a payload.');
  const biz = String(businessId).toLowerCase();
  guardPrompt({ system, user, payload, cacheKey });
  const userText = typeof user === 'string' ? user : JSON.stringify(payload);
  if (!aiConfigured(env)) throw fail(503, 'AI suggestions aren’t set up. Add OPENROUTER_API_KEY to the backend settings to switch them on. You can still enter the recipe yourself.', 'ai_not_configured');

  let state;
  try { state = await loadState(db, biz); } catch (error) {
    if (['42P01', '42703'].includes(error?.code)) throw fail(503, 'AI needs database update 014, which hasn’t been applied yet.', 'ai_schema_missing');
    throw error;
  }
  const label = FEATURE_LABELS[feature] || 'AI insights';
  const off = offReason(state, feature);
  if (off) throw fail(403, off === 'owner' ? `${label} are switched off for this business.` : `${label} are off for this business.`, 'ai_off', { reason: off });
  const { settings, limits } = state;
  const limitKes = effectiveLimit(limits);
  const startedAt = now();
  const bounds = monthBounds(startedAt);
  const ctx = { businessId: biz, feature, actorId };

  // Limit first (a business over its allowance gets the message even for an answer we could serve from memory).
  if ((await spentBetween(db, biz, bounds.start, bounds.next)) >= limitKes) throw await blocked(db, { ...ctx, at: startedAt }, bounds);

  const model = (settings.model_overrides?.[feature] || '').trim() || (env.OPENROUTER_MODEL || '').trim() || undefined;
  const key = `${biz}|${feature}|${hashOf(cacheKey ?? '', system, userText, model || '')}`;
  if (useCache) {
    const hit = cache.get(key);
    if (hit && hit.expires > startedAt.getTime()) {
      await insertRow(db, { ...ctx, model: hit.model, status: 'cached', at: startedAt });
      return { data: structuredClone(hit.data), model: hit.model, cached: true, usage: { promptTokens: 0, completionTokens: 0, costKes: 0 }, allowance: await allowanceNow(db, biz, limits, bounds) };
    }
    if (hit) cache.delete(key);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const at = now();
    const priceModel = model || (env.OPENROUTER_MODEL || '').trim() || 'openai/gpt-4o-mini';
    const worst = costOf({ model: priceModel, promptTokens: estimateTokens(system, userText), completionTokens: maxTokens }, env);
    const reservationId = await reserve(db, ctx, { limitKes, bounds, worstKes: worst.costKes, worstUsd: worst.costUsd, model: priceModel, now: at });
    if (!reservationId) throw await blocked(db, { ...ctx, at }, bounds);

    let outcome;
    try {
      let result;
      try {
        result = await chatCompletion({ system, user: userText, env, model, maxTokens, ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
      } catch (error) {
        if (error instanceof HttpError && error.details?.code === 'ai_bad_answer') {
          const u = error.details.usage;
          const cost = costOf({ model: error.details.model || priceModel, promptTokens: u?.promptTokens ?? estimateTokens(system, userText), completionTokens: u?.completionTokens ?? 0, providerCostUsd: u?.costUsd ?? null }, env);
          await settle(db, reservationId, { status: 'rejected', model: error.details.model || priceModel, promptTokens: u?.promptTokens ?? null, completionTokens: u?.completionTokens ?? null, ...cost, errorCode: 'ai_bad_answer', requestId: error.details.requestId });
          outcome = 'settled';
        }
        throw error;
      }
      const u = result.usage;
      const estimated = !u || u.promptTokens === null || u.completionTokens === null;
      const promptTokens = estimated ? estimateTokens(system, userText) : u.promptTokens;
      const completionTokens = estimated ? estimateTokens(JSON.stringify(result.data)) : u.completionTokens;
      const cost = costOf({ model: result.model, promptTokens, completionTokens, providerCostUsd: estimated ? null : u.costUsd }, env);
      const row = { model: result.model, promptTokens, completionTokens, ...cost, requestId: result.requestId, latencyMs: result.latencyMs, errorCode: estimated ? 'usage_estimated' : null };
      let data = result.data;
      if (parse) {
        try { data = parse(result.data); } catch (error) {
          await settle(db, reservationId, { ...row, status: 'rejected', errorCode: error?.details?.code || 'ai_bad_answer' });
          outcome = 'settled';
          throw error;
        }
      }
      await settle(db, reservationId, { ...row, status: 'ok' });
      outcome = 'settled';
      if (useCache) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { data: structuredClone(data), model: result.model, expires: now().getTime() + cacheTtlMs });
      }
      const allowance = await allowanceNow(db, biz, limits, bounds);
      if (allowance.warning) await warnOwners(db, biz, allowance.percent, limits.warn_pct, bounds.month);
      return { data, model: result.model, cached: false, usage: { promptTokens, completionTokens, costKes: cost.costKes }, allowance };
    } catch (error) {
      lastError = error;
      if (outcome !== 'settled') {
        // The provider never gave a usable answer: record the failure at no cost.
        await settle(db, reservationId, { status: 'error', model: priceModel, errorCode: error?.details?.code || 'ai_error', costUsd: 0, costKes: 0 }).catch((e) => console.error('[ai] could not record a failed call:', e.message));
        if (error?.details?.retryable && attempt < ATTEMPTS) { await sleep(300 + Math.floor(Math.random() * 300)); continue; }
      }
      throw error;
    }
  }
  throw lastError;
}
