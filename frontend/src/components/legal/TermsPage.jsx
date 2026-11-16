// /terms: the current terms and conditions, public (no sign-in). Reads GET /api/public/legal/terms.
import { useEffect, useState } from 'react';
import Brand from '../Brand';
import LegalText, { formatLegalDate } from './LegalText';
import './legal.css';

export default function TermsPage() {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/public/legal/terms`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!live) return;
        if (response.ok) setState({ status: 'ready', doc: data });
        else setState({ status: response.status === 404 || response.status === 503 ? 'none' : 'error', message: data.error });
      })
      .catch(() => live && setState({ status: 'error', message: 'Could not reach Cravio. Check your connection and try again.' }));
    return () => { live = false; };
  }, []);
  useEffect(() => { document.title = state.doc ? `${state.doc.title} · Cravio` : 'Terms and conditions · Cravio'; }, [state.doc]);
  return <div className="page legal-page">
    <header className="legal-top"><Brand to="/login" label="Cravio" /></header>
    <main className="legal-doc">
      {state.status === 'loading' && <p className="legal-meta">Loading the terms…</p>}
      {state.status === 'ready' && <>
        <h1>{state.doc.title}</h1>
        <p className="legal-meta">Version {state.doc.version} · published {formatLegalDate(state.doc.publishedAt)}</p>
        <LegalText body={state.doc.body} />
      </>}
      {state.status === 'none' && <><h1>Terms and conditions</h1><p className="legal-meta">Cravio hasn’t published terms yet.</p></>}
      {state.status === 'error' && <><h1>Terms and conditions</h1><p className="legal-meta">{state.message || 'Could not load the terms.'}</p></>}
    </main>
  </div>;
}
