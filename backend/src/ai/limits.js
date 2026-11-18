// Per-business AI switches, allowance and usage summaries (migration 014). No provider code here: gateway.js is the only module
// that talks to lib/ai.js. Allowance unit = KES per calendar month (Africa/Nairobi).
//   effective limit = least(admin allowance, owner cap)      no limits row (or business switch off) = AI off
// Writes are audited in inventory_events (entity 'ai_settings'); numbers only, never prompt or answer text (none is stored).
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { diff, record } from '../inventory/audit.js';
import { LIMIT_MESSAGE, monthBounds, round } from './meter.js';

export const FEATURES = Object.freeze(['recipe_draft', 'daily_insight', 'ask']);
export const FEATURE_LABELS = Object.freeze({ recipe_draft: 'AI suggestions', daily_insight: 'AI insights', ask: 'AI insights' });
export const MAX_BUDGET_KES = 1_000_000;

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });
const money = (value) => round(Number(value ?? 0), 4);
const needId = (value) => { if (!isId(value)) throw fail(400, 'Business is invalid.', 'bad_id'); return String(value).toLowerCase(); };

export const effectiveLimit = (limits) => {
  if (!limits) return null;
  const admin = Number(limits.monthly_budget_kes);
  return limits.owner_budget_kes === null || limits.owner_budget_kes === undefined ? admin : Math.min(admin, Number(limits.owner_budget_kes));
};

export async function loadState(db, businessId) {
  const settings = (await db.query('select * from public.ai_business_settings where business_id = $1', [businessId])).rows[0] || null;
  const limits = (await db.query('select * from public.ai_limits where business_id = $1', [businessId])).rows[0] || null;
  return { settings, limits };
}

/** Why this feature is off for the business, or null when it is on. */
export function offReason({ settings, limits }, feature) {
  if (!settings?.enabled) return 'business';
  if (!limits) return 'no_allowance';
  if (settings.features?.[feature] === false) return 'feature';
  if ((settings.features_owner_off || []).includes(feature)) return 'owner';
  return null;
}

/** Settled spend (ok + rejected rows) in [from, to). Reserved and failed rows never count. */
export async function spentBetween(db, businessId, from, to) {
  const { rows } = await db.query(`select coalesce(sum(cost_kes), 0)::text as spent from public.ai_usage
    where business_id = $1 and status in ('ok', 'rejected') and created_at >= $2 and created_at < $3`, [businessId, from, to]);
  return money(rows[0].spent);
}

const allowanceOf = (limits, used, bounds) => {
  const effective = effectiveLimit(limits);
  const pct = effective === null ? null : effective > 0 ? round((used / effective) * 100, 1) : 100;
  return { limitKes: effective, usedKes: money(used), remainingKes: effective === null ? null : money(Math.max(0, effective - used)),
    percent: pct, warnPct: limits?.warn_pct ?? 80, warning: pct !== null && pct >= (limits?.warn_pct ?? 80),
    exhausted: effective !== null && used >= effective, resetText: bounds.resetText, resetDate: bounds.resetDate,
    message: effective !== null && used >= effective ? LIMIT_MESSAGE(bounds.resetText) : null };
};

/** Usage this calendar month: totals, by feature, the limit and the warning flags. Numbers only. */
export async function usageThisMonth(db, businessId, { now = new Date() } = {}) {
  const id = needId(businessId);
  const bounds = monthBounds(now);
  const { settings, limits } = await loadState(db, id);
  const { rows } = await db.query(`select feature,
      count(*) filter (where status in ('ok', 'rejected'))::int as calls, count(*) filter (where status = 'cached')::int as cached,
      count(*) filter (where status = 'error')::int as errors, count(*) filter (where status = 'blocked')::int as blocked,
      coalesce(sum(prompt_tokens) filter (where status in ('ok', 'rejected')), 0)::int as prompt_tokens,
      coalesce(sum(completion_tokens) filter (where status in ('ok', 'rejected')), 0)::int as completion_tokens,
      coalesce(sum(cost_kes) filter (where status in ('ok', 'rejected')), 0)::text as cost_kes
    from public.ai_usage where business_id = $1 and status <> 'reserved' and created_at >= $2 and created_at < $3
    group by feature order by feature`, [id, bounds.start, bounds.next]);
  const byFeature = rows.map((r) => ({ feature: r.feature, calls: r.calls, cached: r.cached, errors: r.errors, blocked: r.blocked,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, costKes: money(r.cost_kes) }));
  const sum = (key) => byFeature.reduce((n, f) => n + f[key], 0);
  const used = money(byFeature.reduce((n, f) => n + f.costKes, 0));
  return {
    month: bounds.month, enabled: settings?.enabled === true, configured: Boolean(limits),
    calls: sum('calls'), cached: sum('cached'), errors: sum('errors'), blocked: sum('blocked'),
    promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'), costKes: used, byFeature,
    allowance: allowanceOf(limits, used, bounds),
  };
}

/** The last `months` calendar months (this one first): calls, tokens, KES. */
export async function usageHistory(db, businessId, months = 6, { now = new Date() } = {}) {
  const id = needId(businessId);
  const count = Math.max(1, Math.min(24, Math.trunc(Number(months)) || 6));
  const out = [];
  for (let i = 0; i < count; i++) {
    const b = monthBounds(now, -i);
    const r = (await db.query(`select count(*) filter (where status in ('ok', 'rejected'))::int as calls, count(*) filter (where status = 'cached')::int as cached,
        count(*) filter (where status = 'error')::int as errors,
        coalesce(sum(prompt_tokens) filter (where status in ('ok', 'rejected')), 0)::int as pt, coalesce(sum(completion_tokens) filter (where status in ('ok', 'rejected')), 0)::int as ct,
        coalesce(sum(cost_kes) filter (where status in ('ok', 'rejected')), 0)::text as cost
      from public.ai_usage where business_id = $1 and status <> 'reserved' and created_at >= $2 and created_at < $3`, [id, b.start, b.next])).rows[0];
    out.push({ month: b.month, calls: r.calls, cached: r.cached, errors: r.errors, promptTokens: r.pt, completionTokens: r.ct, costKes: money(r.cost) });
  }
  return out;
}

const featureFlags = (settings) => Object.fromEntries(FEATURES.map((f) => [f, settings?.features?.[f] !== false]));

/** What the platform admin sees for a business: switches, allowance, usage this month and the last 6 months. */
export async function adminView(db, businessId, { now = new Date() } = {}) {
  const id = needId(businessId);
  const biz = (await db.query('select id, name from public.businesses where id = $1', [id])).rows[0];
  if (!biz) throw fail(404, 'That business doesn’t exist.', 'not_found');
  const { settings, limits } = await loadState(db, id);
  return {
    businessId: id, businessName: biz.name, enabled: settings?.enabled === true,
    features: featureFlags(settings), featuresOwnerOff: settings?.features_owner_off || [], modelOverrides: settings?.model_overrides || {},
    allowance: limits ? { monthlyBudgetKes: money(limits.monthly_budget_kes), ownerBudgetKes: limits.owner_budget_kes === null ? null : money(limits.owner_budget_kes),
      effectiveKes: effectiveLimit(limits), warnPct: limits.warn_pct } : null,
    usage: await usageThisMonth(db, id, { now }), history: await usageHistory(db, id, 6, { now }),
  };
}

const isAdmin = (admin) => admin?.profile?.role === 'admin' && admin?.user?.id;

function parseBudget(value, label) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_BUDGET_KES) throw fail(400, `${label} must be a number between 0 and ${MAX_BUDGET_KES.toLocaleString('en-US')} (KES).`, 'bad_budget');
  return round(n, 2);
}

/**
 * Admin sets the switches and the monthly allowance. Fields are optional; only those sent change.
 *   { enabled, monthlyBudgetKes, warnPct, features: { recipe_draft: false }, modelOverrides: { recipe_draft: 'vendor/model' }, reason }
 * Lowering the allowance below the owner's cap pulls the cap down with it. Call inside a transaction.
 */
export async function adminSet(db, admin, businessId, body = {}) {
  if (!isAdmin(admin)) throw fail(403, 'You do not have access to this.', 'forbidden');
  const id = needId(businessId);
  if (!(await db.query('select 1 from public.businesses where id = $1 for update', [id])).rows[0]) throw fail(404, 'That business doesn’t exist.', 'not_found');
  const before = await loadState(db, id);
  const settings = before.settings || { enabled: false, features: {}, features_owner_off: [], model_overrides: {} };

  const enabled = body.enabled === undefined ? settings.enabled : body.enabled;
  if (typeof enabled !== 'boolean') throw fail(400, 'Say whether AI should be on or off for this business.', 'bad_enabled');
  const features = { ...settings.features };
  if (body.features !== undefined) {
    if (!body.features || typeof body.features !== 'object' || Array.isArray(body.features)) throw fail(400, 'features must list each feature as on or off.', 'bad_features');
    for (const [key, value] of Object.entries(body.features)) {
      if (!FEATURES.includes(key) || typeof value !== 'boolean') throw fail(400, `Unknown feature “${String(key).slice(0, 30)}”.`, 'bad_features');
      if (value) delete features[key]; else features[key] = false;
    }
  }
  const overrides = { ...settings.model_overrides };
  if (body.modelOverrides !== undefined) {
    if (!body.modelOverrides || typeof body.modelOverrides !== 'object' || Array.isArray(body.modelOverrides)) throw fail(400, 'modelOverrides must map a feature to a model id.', 'bad_model');
    for (const [key, value] of Object.entries(body.modelOverrides)) {
      if (!FEATURES.includes(key)) throw fail(400, `Unknown feature “${String(key).slice(0, 30)}”.`, 'bad_model');
      if (value === null || value === '') delete overrides[key];
      else if (typeof value === 'string' && /^[\w.:-]+\/[\w.:-]+$/.test(value) && value.length <= 120) overrides[key] = value;
      else throw fail(400, 'A model id looks like vendor/model-name.', 'bad_model');
    }
  }
  const note = typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ') : '';
  if (note.length > 280) throw fail(400, 'Keep the reason under 280 characters.', 'bad_reason');

  let limit = before.limits;
  const nextBudget = body.monthlyBudgetKes === undefined ? null : parseBudget(body.monthlyBudgetKes, 'The monthly allowance');
  const nextWarn = body.warnPct === undefined ? null : body.warnPct;
  if (nextWarn !== null && (!Number.isInteger(nextWarn) || nextWarn < 1 || nextWarn > 100)) throw fail(400, 'The warning level must be a whole number from 1 to 100.', 'bad_warn');
  if (nextBudget !== null || nextWarn !== null) {
    if (!limit && nextBudget === null) throw fail(400, 'Set the monthly allowance first.', 'bad_budget');
    const budget = nextBudget ?? Number(limit.monthly_budget_kes);
    const cap = limit?.owner_budget_kes === null || limit?.owner_budget_kes === undefined ? null : Math.min(Number(limit.owner_budget_kes), budget);
    await db.query(`insert into public.ai_limits (business_id, monthly_budget_kes, owner_budget_kes, warn_pct, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
      on conflict (business_id) do update set monthly_budget_kes = excluded.monthly_budget_kes, owner_budget_kes = excluded.owner_budget_kes,
        warn_pct = excluded.warn_pct, updated_by = excluded.updated_by, updated_at = now()`, [id, budget, cap, nextWarn ?? limit?.warn_pct ?? 80, admin.user.id]);
    limit = (await db.query('select * from public.ai_limits where business_id = $1', [id])).rows[0];
  }
  await db.query(`insert into public.ai_business_settings (business_id, enabled, features, model_overrides, features_owner_off, updated_by, updated_at) values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, now())
    on conflict (business_id) do update set enabled = excluded.enabled, features = excluded.features, model_overrides = excluded.model_overrides, updated_by = excluded.updated_by, updated_at = now()`,
    [id, enabled, JSON.stringify(features), JSON.stringify(overrides), JSON.stringify(settings.features_owner_off || []), admin.user.id]);

  const shape = (s, l) => ({ enabled: s?.enabled === true, features: s?.features || {}, modelOverrides: s?.model_overrides || {},
    monthlyBudgetKes: l ? money(l.monthly_budget_kes) : null, ownerBudgetKes: l?.owner_budget_kes == null ? null : money(l.owner_budget_kes), warnPct: l?.warn_pct ?? null });
  const afterState = await loadState(db, id);
  const change = diff(shape(before.settings, before.limits), shape(afterState.settings, afterState.limits));
  if (change.changed.length) {
    await record(db, { businessId: id, actorId: admin.user.id, actorRole: 'admin', entity: 'ai_settings', action: 'ai_settings_changed',
      before: change.before, after: { ...change.after, ...(note ? { note } : {}) } });
  }
  return { changed: change.changed, ...(await adminView(db, id)) };
}

/** What the owner sees: usage, effective limit, warning, and the figures they may change. Numbers only. */
export async function ownerView(db, businessId, { now = new Date() } = {}) {
  const id = needId(businessId);
  const { settings, limits } = await loadState(db, id);
  const usage = await usageThisMonth(db, id, { now });
  return {
    businessId: id, enabled: settings?.enabled === true, configured: Boolean(limits),
    features: Object.fromEntries(FEATURES.map((f) => [f, offReason({ settings, limits }, f) === null])), featuresOwnerOff: settings?.features_owner_off || [],
    allowance: limits ? { monthlyBudgetKes: money(limits.monthly_budget_kes), ownerBudgetKes: limits.owner_budget_kes === null ? null : money(limits.owner_budget_kes), canRaise: false } : null,
    usage: { month: usage.month, calls: usage.calls, cached: usage.cached, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costKes: usage.costKes, byFeature: usage.byFeature },
    ...usage.allowance, history: await usageHistory(db, id, 6, { now }),
  };
}

/**
 * The owner lowers their own cap (never above the admin allowance) or clears it (null), and may switch features off/on for their business.
 *   { ownerBudgetKes: number | null, featuresOff: ['recipe_draft'] }
 * Anything else (the allowance itself, the business switch, warn %) is refused: only Cravio changes those.
 */
export async function ownerSet(db, scope, businessId, body = {}) {
  const id = needId(businessId);
  for (const key of Object.keys(body)) {
    if (key === 'commandId') continue;
    if (!['ownerBudgetKes', 'featuresOff'].includes(key)) throw fail(403, 'Only Cravio can change the monthly AI allowance or switch AI on or off. You can lower your own limit.', 'forbidden');
  }
  const before = await loadState(db, id);
  if (!before.limits) throw fail(409, 'AI isn’t set up for this business yet. Ask Cravio to give it an allowance.', 'ai_off');
  let cap = before.limits.owner_budget_kes;
  if (body.ownerBudgetKes !== undefined) {
    if (body.ownerBudgetKes === null) cap = null;
    else {
      cap = parseBudget(body.ownerBudgetKes, 'Your limit');
      if (cap > Number(before.limits.monthly_budget_kes)) {
        throw fail(400, `You can lower your AI limit but not raise it above KES ${money(before.limits.monthly_budget_kes).toLocaleString('en-US')}. Ask Cravio if you need more.`, 'cap_above_allowance');
      }
    }
  }
  let off = before.settings?.features_owner_off || [];
  if (body.featuresOff !== undefined) {
    if (!Array.isArray(body.featuresOff) || body.featuresOff.some((f) => !FEATURES.includes(f))) throw fail(400, 'featuresOff must list known features.', 'bad_features');
    off = [...new Set(body.featuresOff)];
  }
  await db.query('update public.ai_limits set owner_budget_kes = $2, updated_by = $3, updated_at = now() where business_id = $1', [id, cap, scope.userId]);
  await db.query(`insert into public.ai_business_settings (business_id, enabled, features_owner_off, updated_by, updated_at) values ($1, false, $2::jsonb, $3, now())
    on conflict (business_id) do update set features_owner_off = excluded.features_owner_off, updated_by = excluded.updated_by, updated_at = now()`, [id, JSON.stringify(off), scope.userId]);
  const change = diff({ ownerBudgetKes: before.limits.owner_budget_kes === null ? null : money(before.limits.owner_budget_kes), featuresOff: before.settings?.features_owner_off || [] },
    { ownerBudgetKes: cap === null ? null : money(cap), featuresOff: off });
  if (change.changed.length) {
    await record(db, { businessId: id, actorId: scope.userId, actorRole: scope.role, entity: 'ai_settings', action: 'ai_owner_changed', before: change.before, after: change.after });
  }
  return { changed: change.changed, ...(await ownerView(db, id)) };
}
