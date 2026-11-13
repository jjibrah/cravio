import { useEffect, useId, useRef } from 'react';
import Glyph from '../media/Glyph';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapTab(event, root) {
  if (event.key !== 'Tab') return;
  const elements = [...root.querySelectorAll(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
  if (!elements.length) { event.preventDefault(); return; }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/**
 * A sheet in the restaurant's look: a bottom sheet on phones, a centred card on wider screens.
 * - On the guest page it's a native modal <dialog> (top layer, inert page, Escape, focus returns to the opener).
 * - `contained` (the Studio and owner previews) renders inside the preview frame instead, as an absolutely
 *   positioned dialog with its own focus trap, so nothing escapes the device mock-up.
 * `title` draws the standard header; without it, label the sheet with `labelledBy` and draw your own.
 * `footer` sticks to the bottom (the "Add to order" bar).
 */
export default function GuestSheet({ open, onClose, title, labelledBy, contained = false, className = '', footer, children, closeLabel }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const panelRef = useRef(null);
  const opener = useRef(null);
  const labelId = title ? titleId : labelledBy;
  const close = closeLabel || `Close${title ? ` ${title.toLowerCase()}` : ''}`;

  // Native dialog on the page.
  useEffect(() => {
    if (contained) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      dialog.querySelector('.gs-panel')?.scrollTo?.(0, 0);
    }
    if (!open && dialog.open) dialog.close();
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open, contained]);

  // Contained dialog: focus in on open, back to the opener on close.
  useEffect(() => {
    if (!contained || !open) return undefined;
    opener.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector('[data-autofocus]') || panel?.querySelector(FOCUSABLE);
    (first || panel)?.focus({ preventScroll: true });
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, [contained, open]);

  const head = title && <header className="gs-head">
    <h2 id={titleId}>{title}</h2>
    <button type="button" className="gs-close" onClick={onClose} aria-label={close}><Glyph name="close" size={20} /></button>
  </header>;
  const panel = <div ref={panelRef} className="gs-panel" tabIndex={-1}>
    {head}
    <div className="gs-body">{children}</div>
    {footer && <div className="gs-foot">{footer}</div>}
  </div>;

  if (contained) {
    if (!open) return null;
    return <div className={`gs-layer ${className}`}>
      <div className="gs-backdrop" aria-hidden="true" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={labelId} className="gs gs-contained"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
          else trapTab(event, event.currentTarget);
        }}>{panel}</div>
    </div>;
  }

  return <dialog ref={dialogRef} className={`gs ${className}`} aria-labelledby={labelId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={() => { if (open) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => trapTab(event, event.currentTarget)}>
    {open ? panel : null}
  </dialog>;
}
