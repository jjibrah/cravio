import { useEffect, useId, useRef } from 'react';
import Sheet from '../Sheet';
import { useMediaQuery } from '../../lib/ops';
import { OIcon } from './ui';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Right-side drawer on desktop and tablet (a native modal dialog with a focus trap, modelled on Sheet.jsx),
 * and the shared bottom Sheet on phones. Escape and the backdrop close it; focus returns to the opener.
 * `title` must be a string (it labels the dialog); `header` adds content beside it (e.g. a status chip).
 */
export default function Drawer({ open, onClose, title, header, children, footer, className = '', wide = false }) {
  const phone = useMediaQuery('(max-width: 767px)');
  if (phone) {
    return <Sheet open={open} onClose={onClose} title={title} className={`o-sheet ${className}`}>
      {header && <div className="o-sheet-header-extra">{header}</div>}
      {children}
      {footer && <div className="o-sheet-footer">{footer}</div>}
    </Sheet>;
  }
  return <RightDrawer open={open} onClose={onClose} title={title} header={header} footer={footer} className={className} wide={wide}>{children}</RightDrawer>;
}

function RightDrawer({ open, onClose, title, header, children, footer, className, wide }) {
  const ref = useRef(null);
  const titleId = useId();
  const returnFocus = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement;
      dialog.showModal();
      requestAnimationFrame(() => (dialog.querySelector('[data-autofocus]') || dialog.querySelector('.o-drawer-close'))?.focus({ preventScroll: true }));
    }
    if (!open && dialog.open) dialog.close();
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (dialog.open) dialog.close();
      const back = returnFocus.current;
      if (back && document.contains(back)) requestAnimationFrame(() => back.focus({ preventScroll: true }));
    };
  }, [open]);

  return <dialog ref={ref} className={`o-drawer${wide ? ' is-wide' : ''} ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    {open && <div className="o-drawer-panel">
      <header className="o-drawer-header">
        <div className="o-drawer-titles"><h2 id={titleId} className="o-drawer-title">{title}</h2>{header}</div>
        <button type="button" className="o-icon-btn o-drawer-close" onClick={onClose} aria-label="Close"><OIcon name="close" size={18} /></button>
      </header>
      <div className="o-drawer-body">{children}</div>
      {footer && <footer className="o-drawer-footer">{footer}</footer>}
    </div>}
  </dialog>;
}

/** A small centred modal dialog (bottom sheet on phones) with Escape, backdrop close and focus return. */
export function Modal({ open, onClose, title, children }) {
  const ref = useRef(null);
  const titleId = useId();
  const returnFocus = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement;
      dialog.showModal();
      requestAnimationFrame(() => (dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE))?.focus({ preventScroll: true }));
    }
    if (!open && dialog.open) dialog.close();
    if (!open) return undefined;
    return () => {
      if (dialog.open) dialog.close();
      const back = returnFocus.current;
      if (back && document.contains(back)) requestAnimationFrame(() => back.focus({ preventScroll: true }));
    };
  }, [open]);
  return <dialog ref={ref} className="o-modal" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {open && <>
      <header className="o-modal-header"><h2 id={titleId}>{title}</h2>
        <button type="button" className="o-icon-btn" onClick={onClose} aria-label="Close"><OIcon name="close" size={18} /></button></header>
      <div className="o-modal-body">{children}</div>
    </>}
  </dialog>;
}
