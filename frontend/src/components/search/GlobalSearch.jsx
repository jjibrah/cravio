import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { kindLabel, scopedItems, searchFor, searchIndex, searchPlaceholder } from '../../config/search';
import { useNotifications } from '../notifications/NotificationProvider';
import Icon from '../Icon';
import './search.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';
const recentKey = (role) => `cravio.search.recent.${role}`;

// Recents hold destinations and scoped queries: { id } or { scope: { path, label, query } }.
function readRecent(role) {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey(role)) || '[]');
    return Array.isArray(value) ? value.filter((entry) => entry && (entry.id || entry.scope)) : [];
  } catch { return []; }
}
function writeRecent(role, entries) {
  try { localStorage.setItem(recentKey(role), JSON.stringify(entries.slice(0, 5))); } catch { /* storage unavailable */ }
}
const recentId = (entry) => entry.id || `scope:${entry.scope.path}:${entry.scope.query}`;

function isTextField(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function Highlight({ text, indices }) {
  if (!indices?.length) return text;
  const marked = new Set(indices);
  const parts = [];
  for (let i = 0; i < text.length; i += 1) {
    const on = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.on === on) last.text += text[i];
    else parts.push({ on, text: text[i] });
  }
  return parts.map((part, i) => part.on ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>);
}

const actionVerb = (item) => item.href ? 'Open in new tab' : item.scope ? 'Search records' : item.action ? (item.destructive ? 'Log out' : 'Run action') : 'Open page';

export default function GlobalSearch({ role, placeId }) {
  const navigate = useNavigate();
  const { retry } = useAuth();
  const { notify } = useNotifications();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirming, setConfirming] = useState(null);
  const [recent, setRecent] = useState(() => readRecent(role));
  const index = useMemo(() => searchIndex(role), [role]);
  const trimmed = query.trim();

  // Groups are built once per query, each label appears once, and every row has a unique key.
  const groups = useMemo(() => {
    if (!trimmed) {
      const recentItems = recent.map((entry) => {
        if (entry.scope) return { id: recentId(entry), group: 'Recent', label: `${entry.scope.label}: ${entry.scope.query}`, hint: 'Recent search', icon: 'search', scope: entry.scope, to: `/${role}/${entry.scope.path}?q=${encodeURIComponent(entry.scope.query)}` };
        const item = index.find((candidate) => candidate.id === entry.id);
        return item && { ...item, group: 'Recent' };
      }).filter(Boolean);
      const taken = new Set(recentItems.map((item) => item.id));
      return [
        recentItems.length && { label: 'Recent', items: recentItems.map((item) => ({ item })) },
        { label: 'Pages', items: index.filter((item) => item.group === 'Pages' && !taken.has(item.id)).map((item) => ({ item })) },
        { label: 'Actions', items: index.filter((item) => item.group === 'Actions' && !taken.has(item.id)).map((item) => ({ item })) },
      ].filter((group) => group && group.items.length);
    }
    return [...searchFor(role, trimmed), { label: 'Search records', items: scopedItems(role, trimmed).map((item) => ({ item })) }];
  }, [trimmed, recent, index, role]);
  const flat = useMemo(() => groups.flatMap((group) => group.items.map((hit) => ({ ...hit, groupLabel: group.label }))), [groups]);
  const groupStarts = useMemo(() => groups.reduce((starts, group, i) => [...starts, i ? starts[i - 1] + groups[i - 1].items.length : 0], []), [groups]);
  const pageMatches = trimmed ? flat.filter((hit) => hit.groupLabel !== 'Search records').length : flat.length;

  useEffect(() => { setActiveIndex(0); setConfirming(null); }, [groups]);
  useEffect(() => { setConfirming(null); }, [activeIndex]);

  const show = useCallback(() => { setQuery(''); setActiveIndex(0); setOpen(true); }, []);
  const hide = useCallback(() => { setOpen(false); setConfirming(null); }, []);

  useEffect(() => {
    const onKey = (event) => {
      const inPalette = dialogRef.current?.contains(event.target);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (!inPalette && isTextField(event.target)) return;
        event.preventDefault();
        if (open) hide(); else show();
      } else if (event.key === '/' && !open && !isTextField(event.target)) { event.preventDefault(); show(); }
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('cravio:open-search', show);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('cravio:open-search', show); };
  }, [open, show, hide]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); inputRef.current?.focus(); }
    if (!open && dialog.open) { dialog.close(); triggerRef.current?.focus(); }
  }, [open]);

  useEffect(() => {
    document.getElementById(`${baseId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, baseId]);

  function remember(item) {
    const entry = item.scope ? { scope: item.scope } : { id: item.id };
    const next = [entry, ...recent.filter((value) => recentId(value) !== recentId(entry))].slice(0, 5);
    setRecent(next);
    writeRecent(role, next);
  }

  async function run(item) {
    if (item.destructive && confirming !== item.id) { setConfirming(item.id); return; }
    if (!item.destructive) remember(item);
    hide();
    if (item.to) navigate(item.to);
    else if (item.href) {
      // The guest menu opens this restaurant's real menu when we know which restaurant it is.
      const href = item.href === '/guest-menu' && placeId ? `/guest-menu?r=${placeId}` : item.href;
      window.open(href, '_blank', 'noopener,noreferrer');
    }
    else if (item.action === 'refresh') retry();
    else if (item.action === 'sign-out') {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      notify(error ? 'Could not sign out. Please try again.' : 'Signed out successfully', error ? { type: 'error', duration: 7000 } : undefined);
    }
  }

  function move(next) {
    if (!flat.length) return;
    setActiveIndex((next + flat.length) % flat.length);
  }

  function onInputKey(event) {
    const groupOf = groupStarts.findLastIndex((start) => start <= activeIndex);
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(activeIndex + 1); break;
      case 'ArrowUp': event.preventDefault(); move(activeIndex - 1); break;
      case 'Home': if (flat.length) { event.preventDefault(); setActiveIndex(0); } break;
      case 'End': if (flat.length) { event.preventDefault(); setActiveIndex(flat.length - 1); } break;
      case 'Tab': case 'PageDown': case 'PageUp': {
        if (groups.length < 2) { if (event.key === 'Tab') event.preventDefault(); break; }
        event.preventDefault();
        const forward = event.key === 'PageDown' || (event.key === 'Tab' && !event.shiftKey);
        setActiveIndex(groupStarts[(groupOf + (forward ? 1 : -1) + groups.length) % groups.length]);
        break;
      }
      case 'Enter': if (flat[activeIndex]) { event.preventDefault(); run(flat[activeIndex].item); } break;
      default:
    }
  }

  const active = flat[activeIndex]?.item;
  const recordCount = trimmed ? groups.at(-1).items.length : 0;
  const status = trimmed
    ? `${pageMatches ? `${pageMatches} ${pageMatches === 1 ? 'match' : 'matches'}` : `No pages or actions match “${trimmed}”`}, ${recordCount} record searches`
    : `${flat.length} suggestions`;
  let position = -1;

  return <>
    <button ref={triggerRef} type="button" className="search-trigger" onClick={show}
      aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K /" aria-label="Search">
      <Icon name="search" size={15} />
      <span className="search-trigger-text">{searchPlaceholder[role]}</span>
      <kbd className="search-kbd">{shortcutLabel}</kbd>
    </button>

    <dialog ref={dialogRef} className="search-palette" aria-label="Search"
      onCancel={(event) => { event.preventDefault(); if (query) setQuery(''); else hide(); }}
      onClick={(event) => { if (event.target === event.currentTarget) hide(); }}>
      <div className="search-panel">
        <div className="search-input-row">
          <Icon name="search" size={18} />
          <input ref={inputRef} type="text" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onInputKey}
            placeholder={searchPlaceholder[role]} aria-label="Search Cravio" autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded={flat.length > 0} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={flat.length ? `${baseId}-opt-${activeIndex}` : undefined} />
          {query && <button type="button" tabIndex={-1} className="search-clear" onClick={() => { setQuery(''); inputRef.current?.focus(); }} aria-label="Clear search"><Icon name="close" size={14} /></button>}
          <button type="button" tabIndex={-1} className="search-cancel" onClick={hide}>Cancel</button>
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">{status}</p>
        {trimmed && !pageMatches && <p className="search-empty">No pages or actions match “{trimmed}”. You can still search records below.</p>}

        <div className="search-results" id={listId} role="listbox" aria-label="Search results" tabIndex={-1}>
          {groups.map((group) => {
            const headingId = `${baseId}-group-${group.label.replace(/\W+/g, '-')}`;
            return <div role="group" aria-labelledby={headingId} className="search-group" key={group.label}>
              <p className="search-group-label" id={headingId}>{group.label}</p>
              {group.items.map(({ item, indices, keyword }) => {
                position += 1;
                const current = position;
                const isActive = current === activeIndex;
                const isConfirming = confirming === item.id;
                const hint = isConfirming ? 'Press ↵ again to log out' : keyword ? `Matches “${keyword}”` : item.hint;
                const hintId = `${baseId}-hint-${current}`;
                return <div key={`${group.label}:${item.id}`} id={`${baseId}-opt-${current}`} role="option" aria-selected={isActive} aria-describedby={hint ? hintId : undefined}
                  className={`search-option${isActive ? ' is-active' : ''}${isConfirming ? ' is-confirming' : ''}`}
                  onMouseMove={() => { if (!isActive) setActiveIndex(current); }}
                  onClick={() => run(item)}>
                  <span className="search-option-icon"><Icon name={item.icon} size={15} /></span>
                  <span className="search-option-label"><Highlight text={item.label} indices={indices} /></span>
                  {hint && <span className={`search-option-hint${isActive || keyword || isConfirming ? ' is-visible' : ''}`} id={hintId}>{hint}</span>}
                  <span className="search-option-kind">{item.href ? <Icon name="external" size={13} /> : kindLabel[group.label] ?? ''}</span>
                </div>;
              })}
            </div>;
          })}
        </div>

        <footer className="search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>tab</kbd> Next group</span>
          <span><kbd>esc</kbd> {query ? 'Clear' : 'Close'}</span>
          {active && <span className="search-footer-end">{confirming === active.id ? 'Confirm' : actionVerb(active)} <kbd>↵</kbd></span>}
        </footer>
      </div>
    </dialog>
  </>;
}
