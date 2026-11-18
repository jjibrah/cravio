// Optional AI help through OpenRouter (https://openrouter.ai). Used only to DRAFT a recipe for a dish; nothing is
// saved from here. Configure in backend/.env:
//   OPENROUTER_API_KEY  – required to switch AI suggestions on (without it the API answers 503 "not set up")
//   OPENROUTER_MODEL    – optional, any OpenRouter model id (default below)
// Privacy: callers send only menu text (dish name, description, category) and stock item names/units, never people,
// orders, prices or contact details. `fetch` is read at call time so tests can stub it.
import { HttpError } from './http.js';
import { UNITS, compatibleUnits, normaliseUnit } from './units.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const TIMEOUT_MS = 25000;

export const aiConfigured = (env = process.env) => Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_API_KEY.trim());

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** The token counts (and the provider's own cost in USD, when it sends one) from a provider response. Null when there is no usage block. */
export function extractUsage(body) {
  const u = body?.usage;
  if (!u || typeof u !== 'object') return null;
  return { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), costUsd: num(u.cost) };
}

const unavailable = (status, message, extra = {}) => new HttpError(status, message, { code: 'ai_unavailable', ...extra });

/**
 * One chat completion that must answer with a JSON object. ONLY ai/gateway.js may call this (it meters and limits every call).
 * Returns { data, model, usage: { promptTokens, completionTokens, costUsd } | null, requestId, latencyMs }.
 * Errors are HttpErrors whose details carry `retryable` (timeouts, 429, 5xx) and, when the provider answered, `usage` (so an
 * unusable answer can still be metered).
 */
export async function chatCompletion({ system, user, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, model: modelOverride = null, maxTokens = 800 }) {
  if (!aiConfigured(env)) {
    throw new HttpError(503, 'AI suggestions aren’t set up. Add OPENROUTER_API_KEY to the backend settings to switch them on. You can still enter the recipe yourself.', { code: 'ai_not_configured' });
  }
  const model = (modelOverride || '').trim() || (env.OPENROUTER_MODEL || '').trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY.trim()}`, 'Content-Type': 'application/json', 'X-Title': 'Cravio' },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: maxTokens, usage: { include: true },
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } catch (error) {
    throw unavailable(502, error?.name === 'AbortError' ? 'The AI service took too long. Try again, or enter the recipe yourself.' : 'Couldn’t reach the AI service. Try again, or enter the recipe yourself.', { retryable: true });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    console.error('[ai] OpenRouter answered', response.status);
    throw unavailable(502, 'The AI service didn’t answer. Try again, or enter the recipe yourself.', { retryable: response.status === 429 || response.status >= 500, status: response.status });
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  const usage = extractUsage(body);
  const requestId = typeof body?.id === 'string' ? body.id.slice(0, 120) : null;
  const parsed = parseJson(body?.choices?.[0]?.message?.content);
  if (!parsed) throw new HttpError(502, 'The AI answer couldn’t be used. Try again, or enter the recipe yourself.', { code: 'ai_bad_answer', usage, requestId, model });
  return { data: parsed, model: typeof body?.model === 'string' && body.model ? body.model : model, usage, requestId, latencyMs: Date.now() - started };
}

/** Back-compat wrapper: one completion, returns { data, model }. Prefer the gateway. */
export async function chatJson(options) {
  const { data, model } = await chatCompletion(options);
  return { data, model };
}

/** The JSON object in a model answer (tolerates ```json fences and text around it). Null when there is none. */
export function parseJson(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object') return value; } catch { /* next */ }
  }
  return null;
}

export const RECIPE_SYSTEM = `You help restaurant managers write recipes for stock control: how much of each ingredient ONE serving of a dish uses.
Answer with JSON only: {"lines":[{"name":"<ingredient>","quantity":<number>,"unit":"<unit>"}],"note":"<one short sentence>"}
Rules: unit is one of ${UNITS.join(', ')}. quantity is a positive number per ONE dish. Prefer the restaurant's existing stock item names
(given with their units) and a unit compatible with that item (g or kg for weight, ml or l for volume, piece, serving).
Include only ingredients worth tracking (main proteins, starches, drinks, bread, packaging); skip salt, spices and water. At most 8 lines.`;

/** Builds the prompt from menu text and stock item names only. */
export function recipePrompt(dish, stockItems) {
  const items = stockItems.slice(0, 150).map((item) => `- ${item.name} (${item.unit})`).join('\n') || '- (none yet)';
  return [`Dish: ${dish.name}`, dish.category ? `Category: ${dish.category}` : '', dish.description ? `Description: ${dish.description}` : '',
    '', 'Existing stock items:', items].filter((line) => line !== '').join('\n');
}

const key = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (text) => key(text).split(' ').filter((w) => w.length > 2).map((w) => w.replace(/(es|s)$/, ''));

/** The existing stock item an AI ingredient name refers to, or null. */
export function matchItem(name, stockItems) {
  const wanted = key(name);
  if (!wanted) return null;
  const exact = stockItems.find((item) => key(item.name) === wanted);
  if (exact) return exact;
  const contains = stockItems.filter((item) => key(item.name).includes(wanted) || wanted.includes(key(item.name)));
  if (contains.length === 1) return contains[0];
  const mine = new Set(words(name));
  let best = null; let score = 0;
  for (const item of contains.length ? contains : stockItems) {
    const theirs = words(item.name);
    const overlap = theirs.filter((w) => mine.has(w)).length / Math.max(theirs.length, mine.size, 1);
    if (overlap > score) { score = overlap; best = item; }
  }
  return score >= 0.5 ? best : null;
}

/**
 * Validates and normalises a model answer into a draft: allowed units only, positive quantities, lines matched to
 * existing stock items by name (otherwise flagged newItem). Throws 502 when nothing usable is left.
 */
export function normaliseSuggestion(raw, stockItems) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.lines) ? raw.lines : Array.isArray(raw?.ingredients) ? raw.ingredients : null;
  if (!list) throw new HttpError(502, 'The AI answer couldn’t be used. Try again, or enter the recipe yourself.', { code: 'ai_bad_answer' });
  const lines = [];
  const seen = new Set();
  for (const entry of list.slice(0, 20)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    const quantity = typeof entry.quantity === 'string' ? Number(entry.quantity.trim()) : entry.quantity;
    const unit = normaliseUnit(entry.unit);
    if (!name || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000 || !unit) continue;
    const item = matchItem(name, stockItems);
    const dedupe = item ? item.id : key(name);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const line = { itemId: item?.id || null, name: item?.name || name, quantity: Math.round(quantity * 1000) / 1000, unit, newItem: !item };
    if (item && !compatibleUnits(item.unit).includes(unit)) {
      line.warning = `Suggested in ${unit}, but ${item.name} is counted in ${item.unit}. Check the amount.`;
      line.unit = item.unit;
    }
    if (!item) line.warning = 'Not a stock item yet. Add it first, or choose an existing item.';
    lines.push(line);
    if (lines.length >= 12) break;
  }
  if (!lines.length) throw new HttpError(502, 'The AI answer had no usable ingredients. Try again, or enter the recipe yourself.', { code: 'ai_bad_answer' });
  const note = typeof raw?.note === 'string' ? raw.note.trim().slice(0, 200) : '';
  return { lines, note };
}

/** Drafts a recipe for one dish. Never saves anything. */
export async function suggestRecipe({ dish, stockItems }, options = {}) {
  const { data, model } = await chatJson({ system: RECIPE_SYSTEM, user: recipePrompt(dish, stockItems), ...options });
  return { draft: true, model, ...normaliseSuggestion(data, stockItems) };
}
