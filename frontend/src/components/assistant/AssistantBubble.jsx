// "Ask Cravio": a chat bubble in the corner of every owner page. It opens a small, non-blocking panel that answers
// questions about today from /api/owner/briefing (recorded orders, guest requests and stock). No AI model is
// connected yet; the panel says so and answers only what those records cover.
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../lib/api';
import { OIcon } from '../owner/ui';
import './assistant.css';

const SUGGESTIONS = [
  { key: 'sales', label: 'How are sales today?' },
  { key: 'best', label: 'What’s selling best?' },
  { key: 'attention', label: 'What needs me?' },
  { key: 'stock', label: 'What’s running low?' },
  { key: 'requests', label: 'Any stock requests?' },
];
const INTENTS = [
  ['best', /best|top|popular|selling|dish|item/],
  ['stock', /stock|low|out|inventory|servings|run(ning)? out/],
  ['requests', /request|dispatch|deliver|transfer|approve/],
  ['attention', /attention|need|urgent|problem|issue|wrong|waiting|guest/],
  ['sales', /sale|revenue|money|paid|order|how.*(doing|going)|today|compare|week/],
];
const intentOf = (text) => INTENTS.find(([, pattern]) => pattern.test(text.toLowerCase()))?.[0] || null;
const FALLBACK = 'I can answer about today’s sales, best sellers, what needs you, stock levels and stock requests. Wider questions will work once the AI connection is switched on.';

export default function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const panelId = useId();
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  // Loaded only once the bubble is opened; refreshed each time it opens again.
  const { data: brief, error, loading, refresh } = useApi('/api/owner/briefing', { ttl: 60000, enabled: open });

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = (question, key = intentOf(question)) => {
    const answer = !brief ? (error ? `I couldn’t load today’s records: ${error.message}` : 'One moment, I’m still reading today’s records.')
      : brief.empty ? brief.headline : key ? brief.answers[key] : FALLBACK;
    setMessages((list) => [...list, { from: 'you', text: question }, { from: 'cravio', text: answer }]);
  };

  return <div className="ast">
    {open && <section className="ast-panel" id={panelId} role="dialog" aria-modal="false" aria-labelledby={`${panelId}-title`}>
      <header className="ast-head">
        <span className="ast-avatar" aria-hidden="true"><OIcon name="sparkle" size={16} /></span>
        <div className="ast-titles">
          <h2 id={`${panelId}-title`}>Ask Cravio</h2>
          <p>Answers come from your records. No AI model is connected yet.</p>
        </div>
        <button type="button" className="ast-close" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} aria-label="Close Ask Cravio"><OIcon name="close" size={18} /></button>
      </header>
      <div className="ast-messages" role="log" aria-live="polite" aria-label="Conversation">
        <p className="ast-bubble is-cravio">{loading && !brief ? 'Reading today’s records…'
          : brief && !brief.empty ? `${brief.headline} Ask me about sales, best sellers, stock or what needs you.` : 'Hi! Ask me about today.'}</p>
        {messages.map((message, index) => <p key={index} className={`ast-bubble is-${message.from}`}>
          <span className="visually-hidden">{message.from === 'you' ? 'You: ' : 'Cravio: '}</span>{message.text}</p>)}
        {error && !brief && <p className="ast-bubble is-cravio">I couldn’t load today’s records. <button type="button" className="ast-link" onClick={() => refresh()}>Try again</button></p>}
        <span ref={endRef} />
      </div>
      <div className="ast-suggestions" role="group" aria-label="Suggested questions">
        {SUGGESTIONS.map((s) => <button key={s.key} type="button" className="ast-chip" onClick={() => ask(s.label, s.key)}>{s.label}</button>)}
      </div>
      <form className="ast-input" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { ask(draft.trim()); setDraft(''); } }}>
        <label className="visually-hidden" htmlFor={`${panelId}-q`}>Ask a question</label>
        <input id={`${panelId}-q`} ref={inputRef} value={draft} maxLength={200} placeholder="Ask about today" autoComplete="off" onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" disabled={!draft.trim()} aria-label="Send"><OIcon name="arrowUp" size={16} /></button>
      </form>
    </section>}
    <button ref={triggerRef} type="button" className={`ast-fab${open ? ' is-open' : ''}`} aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => { if (!open) refresh(); setOpen(!open); }} aria-label={open ? 'Close Ask Cravio' : 'Ask Cravio'}>
      <OIcon name={open ? 'close' : 'sparkle'} size={22} />
    </button>
  </div>;
}
