import { useCallback } from 'react';
import usePolling from '../../lib/usePolling';
import { publicApi } from './guestApi';

/**
 * After "Ready to order", follows the guest's cart until a waiter confirms it (docs/ORDER-FLOW.md):
 * GET /api/public/carts/:code/status every ~5 s while `enabled` (paused while the page is hidden).
 * `data` is { code, status: 'ready' | 'confirmed' | 'expired', confirmedBy?, confirmedAt?, orderShortId? };
 * compare `data.code` with the current code, since a poll for an earlier code can still land.
 */
export default function useCartStatus(restaurantId, code, { enabled = true, interval = 5000 } = {}) {
  const load = useCallback(async (signal) => {
    const data = await publicApi(`/api/public/carts/${encodeURIComponent(code)}/status?restaurantId=${encodeURIComponent(restaurantId)}`, { signal });
    return { ...data, code };
  }, [restaurantId, code]);
  return usePolling(load, { interval, enabled: Boolean(enabled && code && restaurantId) });
}
