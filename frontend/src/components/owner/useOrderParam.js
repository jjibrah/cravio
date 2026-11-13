import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The open order lives in `?order=<id>`, so the detail drawer is deep-linkable. Returns [id, open(order), close, preview]. */
export default function useOrderParam() {
  const [params, setParams] = useSearchParams();
  const preview = useRef(null);
  const id = params.get('order');
  const open = useCallback((order) => {
    preview.current = order || null;
    setParams((current) => { const next = new URLSearchParams(current); next.set('order', order.id); return next; });
  }, [setParams]);
  const close = useCallback(() => {
    setParams((current) => { const next = new URLSearchParams(current); next.delete('order'); return next; }, { replace: true });
  }, [setParams]);
  return [id, open, close, preview.current?.id === id ? preview.current : null];
}
