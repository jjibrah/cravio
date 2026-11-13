/* Search and filters for the guest menu: dishes and deals, matched on names, descriptions, extras and deal contents. */

export const NO_FILTERS = Object.freeze({ featured: false, offer: false, video: false, min: '', max: '', category: '' });

const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const activeFilterCount = (filters) => ['featured', 'offer', 'video'].filter((key) => filters[key]).length
  + (filters.min !== '' || filters.max !== '' ? 1 : 0) + (filters.category ? 1 : 0);

export const isSearching = (query, filters) => Boolean(query.trim()) || activeFilterCount(filters) > 0;

/** Every word of the query must appear somewhere in the text. */
function matches(words, ...texts) {
  if (!words.length) return true;
  const haystack = fold(texts.flat().join(' '));
  return words.every((word) => haystack.includes(word));
}

/**
 * @returns { items, deals } that match `query` and `filters`, in menu order.
 * "On offer" means a dish that's part of a live deal, and every deal.
 */
export function searchMenu({ items = [], deals = [], featuredIds = [] }, query, filters) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const featured = new Set(featuredIds);
  const inDeals = new Set(deals.flatMap((deal) => (deal.items || []).map((part) => part.itemId)));
  const min = filters.min === '' ? -Infinity : Number(filters.min);
  const max = filters.max === '' ? Infinity : Number(filters.max);
  const inRange = (price) => Number(price) >= min && Number(price) <= max;
  const byId = new Map(items.map((item) => [item.id, item]));

  const foundItems = items.filter((item) => (!filters.featured || featured.has(item.id) || item.featured)
    && (!filters.offer || inDeals.has(item.id))
    && (!filters.video || Boolean(item.videoUrl))
    && (!filters.category || item.categoryId === filters.category)
    && inRange(item.price)
    && matches(words, item.name, item.description, (item.extras || []).map((extra) => extra.name)));

  const foundDeals = filters.featured || filters.video ? [] : deals.filter((deal) => inRange(deal.price)
    && (!filters.category || (deal.items || []).some((part) => byId.get(part.itemId)?.categoryId === filters.category))
    && matches(words, deal.name, deal.description, (deal.items || []).map((part) => part.name)));

  return { items: foundItems, deals: foundDeals };
}

/** Lowest and highest price on the menu, for the price filter's hints. */
export function priceBounds(items = [], deals = []) {
  const prices = [...items.map((item) => Number(item.price)), ...deals.map((deal) => Number(deal.price))].filter(Number.isFinite);
  return prices.length ? { low: Math.min(...prices), high: Math.max(...prices) } : { low: 0, high: 0 };
}
