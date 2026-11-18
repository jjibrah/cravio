// Money and calendar helpers for the AI gateway. Pure functions, no database, no network.
// Allowance unit: KES per calendar month (Africa/Nairobi, UTC+3, no daylight saving). Costs are estimated from the token counts the
// provider reports and a price table (USD per 1 million tokens), then converted to KES with a fixed rate.
//   AI_PRICE_TABLE   optional JSON, e.g. {"openai/gpt-4o-mini":{"in":0.15,"out":0.6}}; merged over the defaults below
//   AI_USD_TO_KES    optional number (default 130)
// The provider's own `usage.cost` (USD) wins over the table when it sends one (we ask for it).

export const NAIROBI_OFFSET_MS = 3 * 3_600_000;
export const DEFAULT_USD_TO_KES = 130;
export const DEFAULT_PRICES = Object.freeze({
  'openai/gpt-4o-mini': { in: 0.15, out: 0.6 },
  'openai/gpt-4o': { in: 2.5, out: 10 },
  'anthropic/claude-3.5-haiku': { in: 0.8, out: 4 },
});
/** Used for a model that isn't in the table: deliberately high so an unknown model never looks cheaper than it is. */
export const FALLBACK_PRICE = Object.freeze({ in: 3, out: 15 });
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const round = (value, places) => { const f = 10 ** places; return Math.round((Number(value) + Number.EPSILON) * f) / f; };

export function priceTable(env = process.env) {
  const table = { ...DEFAULT_PRICES };
  if (env.AI_PRICE_TABLE) {
    try {
      for (const [model, p] of Object.entries(JSON.parse(env.AI_PRICE_TABLE))) {
        if (p && Number.isFinite(p.in) && Number.isFinite(p.out) && p.in >= 0 && p.out >= 0) table[model] = { in: p.in, out: p.out };
      }
    } catch { console.error('[ai] AI_PRICE_TABLE is not valid JSON; using the defaults.'); }
  }
  return table;
}

export function usdToKes(env = process.env) {
  const rate = Number(env.AI_USD_TO_KES);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_KES;
}

/** { costUsd, costKes, fxRate } for token counts. `providerCostUsd` (when a number) replaces the table estimate. */
export function costOf({ model, promptTokens = 0, completionTokens = 0, providerCostUsd = null }, env = process.env) {
  const price = priceTable(env)[model] || FALLBACK_PRICE;
  const estimate = ((promptTokens || 0) * price.in + (completionTokens || 0) * price.out) / 1_000_000;
  const costUsd = round(typeof providerCostUsd === 'number' ? providerCostUsd : estimate, 6);
  const fxRate = usdToKes(env);
  return { costUsd, costKes: round(costUsd * fxRate, 4), fxRate };
}

/** Rough prompt size for the worst-case reservation (about 3 characters per token is deliberately pessimistic). */
export const estimateTokens = (...texts) => Math.ceil(texts.reduce((n, t) => n + String(t ?? '').length, 0) / 3);

/** The start of the calendar month (Africa/Nairobi) containing `now`, as a Date (UTC instant), plus the start of the next month. */
export function monthBounds(now = new Date(), offsetMonths = 0) {
  const local = new Date(now.getTime() + NAIROBI_OFFSET_MS);
  const y = local.getUTCFullYear(); const m = local.getUTCMonth() + offsetMonths;
  const start = new Date(Date.UTC(y, m, 1) - NAIROBI_OFFSET_MS);
  const next = new Date(Date.UTC(y, m + 1, 1) - NAIROBI_OFFSET_MS);
  const label = new Date(Date.UTC(y, m, 1));
  const nextLabel = new Date(Date.UTC(y, m + 1, 1));
  return { start, next, month: `${label.getUTCFullYear()}-${String(label.getUTCMonth() + 1).padStart(2, '0')}`,
    resetText: `1 ${MONTHS[nextLabel.getUTCMonth()]}`, resetDate: nextLabel.toISOString().slice(0, 10) };
}

export const LIMIT_MESSAGE = (resetText) => `Your AI allowance for this month is used up. It resets on ${resetText}.`;
