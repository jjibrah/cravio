// Contact Cravio (/owner/contact-cravio): call, WhatsApp or email the Cravio team, send a message, and read
// replies. Reads GET /api/restaurant/support and posts to it; before migration 006 the API answers
// { available: false } and the page keeps only the direct contact options.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { EmptyState, ErrorState, OIcon, Panel, Segmented, SkeletonRows } from '../../components/owner/ui';
import { api, useApi } from '../../lib/api';
import '../admin/platform.css';

/**
 * Cravio's support contacts. PLACEHOLDERS: change these to the real support line, WhatsApp number and inbox.
 * `whatsapp` is the number in international format, digits only (used for https://wa.me/<number>).
 */
export const CRAVIO_SUPPORT = {
  phone: '+254 700 000 000',
  whatsapp: '254700000000',
  email: 'support@cravio.app',
  hours: 'Every day, 8am–10pm',
};

const TOPICS = [
  { value: 'question', label: 'Question', icon: 'info', subject: 'I have a question' },
  { value: 'problem', label: 'Something’s broken', icon: 'alert', subject: 'Something isn’t working' },
  { value: 'billing', label: 'Billing', icon: 'bill', subject: 'Billing question' },
  { value: 'feature', label: 'Feature idea', icon: 'sparkle', subject: 'An idea for Cravio' },
  { value: 'complaint', label: 'Complaint', icon: 'heart', subject: 'I’m not happy with something' },
];
const TOPIC_LABEL = Object.fromEntries(TOPICS.map((t) => [t.value, t.label]));
const URGENCIES = [
  { value: 'low', label: 'Whenever' },
  { value: 'normal', label: 'Soon' },
  { value: 'urgent', label: 'Urgent' },
];
const STATUS = { open: 'Received', in_progress: 'Working on it', resolved: 'Resolved', closed: 'Closed' };
const HELP_LINKS = [
  { to: '/owner/products', label: 'Products', hint: 'Add or edit dishes and prices', icon: 'utensils' },
  { to: '/owner/menu', label: 'Menu', hint: 'What guests see and when', icon: 'layers' },
  { to: '/owner/tables', label: 'Tables', hint: 'Your floor and table numbers', icon: 'table' },
  { to: '/onboarding/qr', label: 'QR codes', hint: 'Print table QR codes', icon: 'qr' },
  { to: '/owner/settings', label: 'Settings', hint: 'Restaurant details, hours, staff', icon: 'edit' },
];

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function ContactPage({ section }) {
  const { account } = useOutletContext() || {};
  const { notify } = useNotifications();
  const support = useApi('/api/restaurant/support', { ttl: 30000 });
  const onboarding = useApi('/api/restaurant/onboarding', { ttl: 60000 });
  const available = support.data ? support.data.available !== false : true;
  const requests = support.data?.requests || [];
  const restaurantName = onboarding.data?.restaurant?.name || account?.place?.name || '';
  const whatsappText = encodeURIComponent(`Hi Cravio, this is ${account?.name || 'an owner'}${restaurantName ? ` from ${restaurantName}` : ''}. `);

  return <div className="ct-page">
    <PageHeader title={section?.label || 'Contact Cravio'} description="We’re real people in Kenya. Reach us the way that suits you, and we’ll help." />

    <section className="ct-quick" aria-label="Contact Cravio directly">
      <a className="ct-option" href={`tel:${CRAVIO_SUPPORT.phone.replace(/\s/g, '')}`}>
        <span className="ct-option-icon" aria-hidden="true"><PhoneIcon /></span>
        <span><strong>Call us</strong><small>{CRAVIO_SUPPORT.phone}</small></span>
      </a>
      <a className="ct-option is-whatsapp" href={`https://wa.me/${CRAVIO_SUPPORT.whatsapp}?text=${whatsappText}`} target="_blank" rel="noreferrer">
        <span className="ct-option-icon" aria-hidden="true"><ChatIcon /></span>
        <span><strong>WhatsApp</strong><small>Fastest reply</small></span>
      </a>
      <a className="ct-option" href={`mailto:${CRAVIO_SUPPORT.email}?subject=${encodeURIComponent(restaurantName ? `Help for ${restaurantName}` : 'Help with Cravio')}`}>
        <span className="ct-option-icon" aria-hidden="true"><MailIcon /></span>
        <span><strong>Email</strong><small>{CRAVIO_SUPPORT.email}</small></span>
      </a>
    </section>
    <p className="ct-hours"><OIcon name="info" size={14} />Support hours: {CRAVIO_SUPPORT.hours} (Nairobi time).</p>

    <div className="ct-grid">
      <div className="ct-main">
        {support.error && !support.data ? <div className="o-panel"><ErrorState error={support.error} onRetry={support.refresh} what="your messages" /></div>
          : !available ? <div className="o-panel ct-unavailable">
            <EmptyState icon="info" title="Messaging is almost ready">
              Sending messages from here isn’t switched on yet. Call, WhatsApp or email us above and we’ll help right away.
            </EmptyState>
          </div>
            : <MessageForm account={account} restaurant={onboarding.data?.restaurant} notify={notify}
              onSent={(row) => support.setData((current) => current && { ...current, requests: [row, ...(current.requests || [])] })}
              disabled={!support.data} />}

        {available && <Panel title="Your requests" count={support.data ? requests.length : undefined}
          sub="Everything you’ve sent us, and our replies">
          {!support.data && !support.error ? <SkeletonRows rows={3} thumb={false} label="Loading your requests" />
            : support.error ? <ErrorState compact error={support.error} onRetry={support.refresh} what="your requests" />
              : !requests.length ? <EmptyState icon="check" title="No messages yet">When you send us something it shows up here, with our reply.</EmptyState>
                : <ul className="ct-requests">{requests.map((r) => <RequestItem key={r.id} request={r} />)}</ul>}
        </Panel>}
      </div>

      <aside className="ct-side" aria-labelledby="ct-help-title">
        <section className="o-panel ct-help">
          <h2 id="ct-help-title" className="o-panel-title">Quick fixes</h2>
          <p className="o-panel-sub">Most changes you can make yourself, right now.</p>
          <ul>
            {HELP_LINKS.map((link) => <li key={link.to}>
              <Link to={link.to} className="ct-help-link">
                <span className="ct-help-icon" aria-hidden="true"><OIcon name={link.icon} size={16} /></span>
                <span><strong>{link.label}</strong><small>{link.hint}</small></span>
                <OIcon name="arrowRight" size={15} className="ct-help-arrow" />
              </Link>
            </li>)}
          </ul>
        </section>
      </aside>
    </div>
  </div>;
}

function MessageForm({ account, restaurant, notify, onSent, disabled }) {
  const [topic, setTopic] = useState('question');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(account?.email || '');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState(null);
  const touched = useRef({ phone: false, email: false });
  const ids = { subject: useId(), message: useId(), phone: useId(), email: useId(), topic: useId() };
  const current = TOPICS.find((t) => t.value === topic);

  // Prefill contact details once they load, unless the owner already typed something.
  useEffect(() => { if (restaurant?.phone && !touched.current.phone) setPhone(restaurant.phone); }, [restaurant?.phone]);
  useEffect(() => { if (account?.email && !touched.current.email) setEmail(account.email); }, [account?.email]);

  const fieldError = (name) => (problem?.field === name ? problem.message : null);

  const submit = async (event) => {
    event.preventDefault();
    if (sending) return;
    if (!message.trim()) { setProblem({ field: 'message', message: 'Tell us what’s going on.' }); return; }
    if (!phone.trim() && !email.trim()) { setProblem({ field: 'contactPhone', message: 'Add a phone number or email so we can get back to you.' }); return; }
    setSending(true); setProblem(null);
    try {
      const result = await api('/api/restaurant/support', {
        method: 'POST',
        body: {
          type: topic, subject: subject.trim() || current.subject, message: message.trim(), urgency,
          contactName: account?.name || undefined, contactPhone: phone.trim() || null, contactEmail: email.trim() || null,
        },
      });
      onSent(result.request);
      notify(result.message || 'Message sent');
      setSubject(''); setMessage(''); setUrgency('normal');
    } catch (error) {
      setProblem({ field: error.details?.field || null, message: error.message });
      if (!error.details?.field) notify(error.message, { type: 'error' });
    } finally {
      setSending(false);
    }
  };

  return <form className="o-panel ct-form" onSubmit={submit} noValidate aria-labelledby="ct-form-title">
    <header className="o-panel-head"><div className="o-panel-titles">
      <h2 id="ct-form-title" className="o-panel-title">Send us a message</h2>
      <p className="o-panel-sub">We usually reply within a few hours during support hours.</p>
    </div></header>
    <div className="o-panel-body">
      <fieldset className="o-fieldset">
        <legend id={ids.topic}>What’s it about?</legend>
        <div className="o-chips" role="radiogroup" aria-labelledby={ids.topic}>
          {TOPICS.map((t) => <button key={t.value} type="button" role="radio" aria-checked={topic === t.value} className="o-chip" onClick={() => setTopic(t.value)}>
            <OIcon name={t.icon} size={15} />{t.label}
          </button>)}
        </div>
      </fieldset>

      <div className="o-field">
        <label className="o-label" htmlFor={ids.subject}>Subject <span className="ct-optional">optional</span></label>
        <input id={ids.subject} className="o-input" value={subject} maxLength={140} onChange={(event) => setSubject(event.target.value)}
          placeholder={current.subject} aria-invalid={fieldError('subject') ? 'true' : undefined} />
        {fieldError('subject') && <p className="o-field-error"><OIcon name="alert" size={14} />{fieldError('subject')}</p>}
      </div>

      <div className="o-field">
        <label className="o-label" htmlFor={ids.message}>Message</label>
        <textarea id={ids.message} className="o-input" rows={5} maxLength={4000} value={message} onChange={(event) => setMessage(event.target.value)}
          placeholder={topic === 'problem' ? 'What happened, on which page, and roughly when?' : 'Tell us what you need. The more detail, the faster we can help.'}
          aria-invalid={fieldError('message') ? 'true' : undefined} />
        {fieldError('message') && <p className="o-field-error"><OIcon name="alert" size={14} />{fieldError('message')}</p>}
      </div>

      <div className="o-fieldset">
        <p className="o-label" id="ct-urgency">How urgent is it?</p>
        <Segmented label="How urgent is it?" options={URGENCIES} value={urgency} onChange={setUrgency} className="ct-urgency" />
        {urgency === 'urgent' && <p className="o-field-hint">For anything stopping service right now, calling is fastest: {CRAVIO_SUPPORT.phone}.</p>}
      </div>

      <div className="ct-contact-row">
        <div className="o-field">
          <label className="o-label" htmlFor={ids.phone}>Your phone</label>
          <input id={ids.phone} className="o-input" type="tel" inputMode="tel" autoComplete="tel" value={phone}
            onChange={(event) => { touched.current.phone = true; setPhone(event.target.value); }} placeholder="+254 712 345 678"
            aria-invalid={fieldError('contactPhone') ? 'true' : undefined} />
          {fieldError('contactPhone') && <p className="o-field-error"><OIcon name="alert" size={14} />{fieldError('contactPhone')}</p>}
        </div>
        <div className="o-field">
          <label className="o-label" htmlFor={ids.email}>Your email</label>
          <input id={ids.email} className="o-input" type="email" autoComplete="email" value={email}
            onChange={(event) => { touched.current.email = true; setEmail(event.target.value); }} placeholder="you@restaurant.com"
            aria-invalid={fieldError('contactEmail') ? 'true' : undefined} />
          {fieldError('contactEmail') && <p className="o-field-error"><OIcon name="alert" size={14} />{fieldError('contactEmail')}</p>}
        </div>
      </div>

      {problem && !problem.field && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{problem.message}</span></p>}
      <div className="ct-actions">
        <button type="submit" className="o-btn is-primary is-large" disabled={sending || disabled}>{sending ? 'Sending…' : 'Send message'}</button>
      </div>
    </div>
  </form>;
}

function RequestItem({ request: r }) {
  return <li className="ct-request">
    <div className="ct-request-head">
      <span className={`ct-status is-${r.status}`}><span aria-hidden="true" />{STATUS[r.status] || r.status}</span>
      <span className="ct-request-meta">{TOPIC_LABEL[r.type] || r.type} · {dateTime.format(new Date(r.createdAt))}{r.urgency === 'urgent' ? ' · Urgent' : ''}</span>
    </div>
    <strong className="ct-request-subject">{r.subject}</strong>
    <p className="ct-request-message">{r.message}</p>
    {r.adminNote && <div className="ct-reply">
      <span className="ct-reply-label">Cravio replied{r.updatedAt ? ` · ${dateTime.format(new Date(r.updatedAt))}` : ''}</span>
      <p>{r.adminNote}</p>
    </div>}
  </li>;
}

const svg = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
function PhoneIcon() {
  return <svg {...svg}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></svg>;
}
function ChatIcon() {
  return <svg {...svg}><path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3Z" /><path d="M9 10h.01M12 10h.01M15 10h.01" /></svg>;
}
function MailIcon() {
  return <svg {...svg}><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="m3 6 9 7 9-7" /></svg>;
}
