// The 009-era recipe draft (POST /api/stock/recipes/suggest, src/stock/recipes.js suggestionInput) on the metered gateway (P2-33).
// src/stock/* is frozen, so the route builds its input there and calls this instead of stock/recipes.js `suggest`. Retired with the old pages (P2-28).
import { RECIPE_SYSTEM, call, normaliseSuggestion, recipePrompt } from './gateway.js';

/** input = { dish, stockItems } from suggestionInput. Returns the same shape as the old suggest: { menuItemId, draft, model, lines, note }. */
export async function suggestLegacy(db, { businessId, actorId = null }, input, options = {}) {
  const result = await call(db, {
    businessId, feature: 'recipe_draft', actorId, system: RECIPE_SYSTEM, user: recipePrompt(input.dish, input.stockItems),
    parse: (data) => normaliseSuggestion(data, input.stockItems), maxTokens: 800, ...options,
  });
  return { menuItemId: input.dish.id, draft: true, model: result.model, ...result.data };
}
