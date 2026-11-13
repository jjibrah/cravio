import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import Brand from '../Brand';
import Confetti from './Confetti';
import OnbIcon from './OnbIcon';
import PhonePreview from './PhonePreview';

/** "You're live!": the end of the lesson. Shows the menu, the QR pack, and honest invite results. */
export default function Finish({ state, preview, actions }) {
  const { account, accountLoading, retry } = useAuth();
  const navigate = useNavigate();
  const headingRef = useRef(null);
  const [waitingFor, setWaitingFor] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const { restaurant, tables, invites } = state;
  const failed = invites.filter((invite) => invite.status === 'failed');

  useEffect(() => { headingRef.current?.focus(); }, []);
  // The dashboard only opens once /api/me knows the restaurant is live.
  useEffect(() => { if (account?.onboardingRequired) retry(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (waitingFor && account && !account.onboardingRequired && !accountLoading) navigate(waitingFor);
  }, [waitingFor, account, accountLoading, navigate]);

  const open = (path) => {
    if (account && !account.onboardingRequired) navigate(path);
    else { setWaitingFor(path); retry(); }
  };

  return <div className="finish">
    <Confetti />
    <header className="finish-top"><Brand to="/owner" label="Cravio dashboard" /></header>
    <main className="finish-body">
      <section className="finish-intro">
        <p className="finish-eyebrow"><span className="finish-live-dot" aria-hidden="true" />Live now</p>
        <h1 ref={headingRef} tabIndex={-1}>You’re live! 🎉</h1>
        <p className="finish-lede"><strong>{restaurant.name}</strong> is ready for guests. Print your QR codes, put them on the tables, and the menu is one scan away.</p>

        <div className="finish-card">
          <span className="finish-card-icon"><OnbIcon name="qr" size={22} /></span>
          <div className="finish-card-text"><h2>Download your QR codes</h2><p>{tables.length} printable card{tables.length === 1 ? '' : 's'}, one per table, with your name and the table number.</p></div>
          <Link className="onb-primary" to="/onboarding/qr"><OnbIcon name="printer" size={18} />Open QR pack</Link>
        </div>

        <div className="finish-card is-list">
          <div className="finish-card-head"><span className="finish-card-icon"><OnbIcon name="mail" size={20} /></span>
            <div className="finish-card-text"><h2>Staff invites</h2>
              <p>{invites.length ? `${invites.length - failed.length} of ${invites.length} sent. They’ll get an email to set a password.` : 'No one invited yet. Add your team any time from Overview.'}</p></div></div>
          {invites.length > 0 && <ul className="finish-invites">
            {invites.map((invite) => <li key={invite.id}>
              <span className={`finish-status is-${invite.status}`} aria-hidden="true"><OnbIcon name={invite.status === 'sent' ? 'check' : invite.status === 'failed' ? 'alert' : 'clock'} size={14} /></span>
              <span className="finish-invite-text"><strong>{invite.name}</strong><span>{invite.email}</span>
                {invite.status === 'failed' && <span className="finish-invite-error">{invite.error}</span>}</span>
              <span className={`onb-pill is-${invite.status}`}>{invite.status === 'sent' ? 'Sent' : invite.status === 'failed' ? 'Not sent' : 'Waiting'}</span>
            </li>)}
          </ul>}
          {failed.length > 0 && <div className="finish-retry">
            <button type="button" className="onb-secondary" disabled={retrying} onClick={async () => {
              setRetrying(true); setRetryError('');
              try { await actions.sendInvites(); } catch (error) { setRetryError(error.message); } finally { setRetrying(false); }
            }}>{retrying ? 'Trying again…' : 'Try again'}</button>
            <Link className="onb-text-button" to="/onboarding/staff">Edit staff</Link>
            {retryError && <p className="onb-field-error" role="alert">{retryError}</p>}
          </div>}
        </div>

        <div className="finish-actions">
          <button type="button" className="onb-primary is-large" onClick={() => open('/owner?tour=1')} disabled={Boolean(waitingFor)}>
            {waitingFor ? 'Opening your dashboard…' : 'Take a quick tour'}<OnbIcon name="arrow" size={18} /></button>
          <button type="button" className="onb-secondary is-large" onClick={() => open('/owner')} disabled={Boolean(waitingFor)}>Skip to dashboard</button>
        </div>
      </section>
      <aside className="finish-phone" aria-label="Your live menu"><PhonePreview {...preview} size="large" focus="done" label="Your live guest menu" /></aside>
    </main>
  </div>;
}
