import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import UserIcon from './UserIcon';

/**
 * Row actions menu (WAI-ARIA menu button).
 * items: { label, icon?, onSelect, disabled?, reason?, danger?, checked? (radio) } | { separator: true } | { group: 'Label' }
 * Arrow keys / Home / End move, Enter or Space selects, Escape or Tab closes.
 * Disabled items stay focusable so their reason is discoverable.
 */
export default function ActionsMenu({ label, items, className = '' }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const close = useCallback((focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = 260;
    const height = menu?.offsetHeight || 280;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below;
    setPosition({ top, left, width });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  const placed = Boolean(position);
  useEffect(() => {
    // Focus once the menu is positioned (it is visibility:hidden until then).
    if (open && placed) menuRef.current?.querySelector('[role^="menuitem"]')?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) { setPosition(null); return undefined; }
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open, close]);

  function onMenuKeyDown(event) {
    const entries = [...menuRef.current.querySelectorAll('[role^="menuitem"]')];
    const index = entries.indexOf(document.activeElement);
    const move = (next) => { event.preventDefault(); entries[(next + entries.length) % entries.length]?.focus(); };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(entries.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const start = index + 1;
      const order = [...entries.slice(start), ...entries.slice(0, start)];
      const match = order.find((entry) => entry.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) { event.preventDefault(); match.focus(); }
    }
  }

  function select(item) {
    if (item.disabled) return;
    close(!item.keepFocusAway);
    item.onSelect?.();
  }

  return <>
    <button ref={buttonRef} type="button" className={`u-icon-button u-more ${className}`} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setOpen(true); }
      }}>
      <UserIcon name="more" size={18} />
    </button>
    {open && createPortal(<div ref={menuRef} id={menuId} role="menu" aria-label={label} className="u-menu"
      style={position ? { top: position.top, left: position.left, width: position.width } : { visibility: 'hidden' }}
      onKeyDown={onMenuKeyDown} onClick={(event) => event.stopPropagation()}>
      {items.map((item, index) => {
        if (item.separator) return <div key={`s${index}`} role="separator" className="u-menu-separator" />;
        if (item.group) return <div key={`g${index}`} role="presentation" className="u-menu-group">{item.group}</div>;
        const radio = item.checked !== undefined;
        const reasonId = item.reason ? `${menuId}-r${index}` : undefined;
        return <button key={item.label} type="button" tabIndex={-1}
          role={radio ? 'menuitemradio' : 'menuitem'} aria-checked={radio ? item.checked : undefined}
          aria-disabled={item.disabled || undefined} aria-describedby={reasonId}
          className={`u-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`}
          onClick={() => select(item)}>
          <span className="u-menu-icon">{radio ? (item.checked ? <UserIcon name="check" size={15} /> : null) : item.icon && <UserIcon name={item.icon} size={15} />}</span>
          <span className="u-menu-text">
            <span>{item.label}</span>
            {item.reason && <span id={reasonId} className="u-menu-reason">{item.reason}</span>}
          </span>
        </button>;
      })}
    </div>, document.body)}
  </>;
}
