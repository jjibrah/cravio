import { useEffect, useId, useRef } from 'react';
import Icon from '../../components/Icon';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Native modal dialog with a focus trap, modelled on components/Sheet.jsx.
 * variant "drawer": right-side panel on desktop, bottom sheet below 768px.
 * variant "modal": centred panel, bottom sheet on phones.
 * The title is rendered by the caller via `header` (gets titleId) or `title`.
 */
export default function Dialog({ open, onClose, variant = 'modal', title, header, footer, children, label, initialFocus, className = '' }) {
  const ref = useRef(null);
  const titleId = useId();
  const returnFocus = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement;
      dialog.showModal();
      const target = initialFocus?.current || dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE);
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
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
  }, [open, initialFocus]);

  return <dialog ref={ref} className={`u-dialog is-${variant} ${className}`} aria-labelledby={label ? undefined : titleId} aria-label={label}
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
    {open && <div className="u-dialog-panel">
      <div className="u-dialog-handle" aria-hidden="true" />
      <header className="u-dialog-header">
        {header ? header(titleId) : <h2 id={titleId} className="u-dialog-title">{title}</h2>}
        <button type="button" className="u-icon-button u-dialog-close" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
      </header>
      <div className="u-dialog-body">{children}</div>
      {footer && <footer className="u-dialog-footer">{footer}</footer>}
    </div>}
  </dialog>;
}
