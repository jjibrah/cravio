import { useEffect, useId, useRef } from 'react';
import Icon from './Icon';
import './sheet.css';

export default function Sheet({ open, onClose, title, children, className = '', id }) {
  const ref = useRef(null);
  const titleId = useId();
  // Closes we trigger ourselves (cleanup, or following a prop change) must not echo back as onClose.
  const selfClosing = useRef(false);
  // The dialog's close event fires asynchronously, so the flag is cleared when that event arrives.
  const closeQuietly = (dialog) => { selfClosing.current = true; dialog.close(); };

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) closeQuietly(dialog);
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (dialog.open) closeQuietly(dialog);
    };
  }, [open]);

  return <dialog ref={ref} id={id} className={`sheet ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={() => {
      // Ignore closes we caused, and stale close events that arrive after the sheet reopened.
      if (selfClosing.current || ref.current?.open) { selfClosing.current = false; return; }
      onClose();
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]')]
        .filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="sheet-panel">
      <div className="sheet-handle" aria-hidden="true" />
      <header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><Icon name="close" /></button></header>
      <div className="sheet-content">{children}</div>
    </div>
  </dialog>;
}
