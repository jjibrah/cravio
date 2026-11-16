// Admin Terms & conditions (/admin/terms): write the terms (plain text with # headings and - bullets), preview them as
// people will see them, save a draft, and publish a new version. Published versions can't be edited; each shows how
// many people accepted it. New accounts must accept the current version; publishing can also ask existing people to.
import { useEffect, useId, useState } from 'react';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { Modal } from '../../components/owner/Drawer';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows } from '../../components/owner/ui';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import LegalText, { formatLegalDate } from '../../components/legal/LegalText';
import { api, useApi } from '../../lib/api';
import { formatWhole } from './platform-ui';
import './business.css';
import './terms.css';

const PATH = '/api/admin/legal/terms';

export default function AdminTermsPage({ section }) {
  const ids = useId();
  const { notify } = useNotifications();
  const { data, error, loading, refresh } = useApi(PATH, { ttl: 10000 });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [requireExisting, setRequireExisting] = useState(true);

  useEffect(() => {
    if (data && !loaded) { setTitle(data.draft.title); setBody(data.draft.body); setLoaded(true); }
  }, [data, loaded]);

  const saved = data && title === data.draft.title && body === data.draft.body;
  const sameAsCurrent = data?.current && title.trim() === data.current.title && body === data.current.body;

  const save = async () => {
    setBusy(true); setProblem('');
    try { await api(`${PATH}/draft`, { method: 'PUT', body: { title, body } }); notify('Draft saved.'); return true; }
    catch (failure) { setProblem(failure.message); return false; }
    finally { setBusy(false); }
  };
  const publish = async () => {
    setBusy(true); setProblem('');
    try {
      if (!saved) await api(`${PATH}/draft`, { method: 'PUT', body: { title, body } });
      const doc = await api(`${PATH}/publish`, { method: 'POST', body: { requireExisting } });
      notify(`Version ${doc.version} is live. ${requireExisting ? 'Everyone will be asked to accept it.' : 'New accounts must accept it.'}`);
      setPublishing(false);
    } catch (failure) { setProblem(failure.message); }
    finally { setBusy(false); }
  };

  if (error && !data) {
    return <div className="in-page pl-page ab-page"><PageHeader title={section.label} description={section.description} />
      {error.details?.code === 'legal_schema_missing'
        ? <EmptyState icon="info" tone="neutral" title="Terms aren’t switched on yet">They need database update 010 (terms and conditions), which is waiting for review.</EmptyState>
        : <ErrorState error={error} onRetry={refresh} what="the terms" />}</div>;
  }
  if (loading && !data) return <div className="in-page pl-page ab-page"><PageHeader title={section.label} /><Panel title="Terms"><SkeletonRows rows={6} thumb={false} label="Loading the terms" /></Panel></div>;

  const current = data.current;
  return <div className="in-page pl-page ab-page">
    <PageHeader title={section.label} description={current
      ? `Version ${current.version} is live since ${formatLegalDate(current.publishedAt)}. People accept it when they create their account.`
      : 'Nothing published yet. Until you publish, new accounts aren’t asked to accept any terms.'}>
      <a className="o-btn" href="/terms" target="_blank" rel="noreferrer"><OIcon name="external" size={15} />View public page</a>
      <button type="button" className="o-btn" onClick={save} disabled={busy || saved}>{saved ? 'Draft saved' : 'Save draft'}</button>
      <button type="button" className="o-btn is-primary" onClick={() => { setProblem(''); setPublishing(true); }} disabled={busy || !body.trim() || sameAsCurrent}>
        {current ? `Publish version ${current.version + 1}` : 'Publish'}</button>
    </PageHeader>
    {problem && !publishing && <p className="o-note is-error"><OIcon name="alert" size={16} /><span>{problem}</span></p>}

    <div className="tc-editor">
      <section className="o-panel tc-pane" aria-labelledby={`${ids}-write`}>
        <header className="tc-pane-head"><h2 id={`${ids}-write`}>Write</h2><span>{saved ? 'Saved' : 'Unsaved changes'} · {formatWhole(body.length)} characters</span></header>
        <div className="tc-fields">
          <label className="o-label" htmlFor={`${ids}-title`}>Title</label>
          <input id={`${ids}-title`} className="o-input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          <label className="o-label" htmlFor={`${ids}-body`}>Text</label>
          <textarea id={`${ids}-body`} className="o-input tc-text" value={body} onChange={(event) => setBody(event.target.value)} spellCheck
            placeholder={'# Using Cravio\nWrite each paragraph on its own lines, with a blank line between paragraphs.\n\n## Your account\n- Start a bullet with a dash'} />
          <p className="tc-help"><code># Heading</code> · <code>## Subheading</code> · <code>- Bullet</code> · a blank line starts a new paragraph.</p>
        </div>
      </section>
      <section className="o-panel tc-pane" aria-labelledby={`${ids}-preview`}>
        <header className="tc-pane-head"><h2 id={`${ids}-preview`}>Preview</h2><span>As people will see it</span></header>
        <div className="tc-preview">
          <h1 className="tc-preview-title">{title || 'Terms and conditions'}</h1>
          {body.trim() ? <LegalText body={body} /> : <p className="tc-empty">Start writing on the left.</p>}
        </div>
      </section>
    </div>

    <Panel title="Published versions" count={data.versions.length || undefined} sub={`${formatWhole(data.accountHolders)} account holders (admins excluded). Versions can’t be edited after publishing.`}>
      {data.versions.length ? <div className="pl-table-scroll ab-body-table"><table className="pl-table">
        <thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">By</th><th scope="col">Who must accept</th><th scope="col" className="is-num">Accepted</th></tr></thead>
        <tbody>{data.versions.map((v, index) => <tr key={v.id}>
          <th scope="row"><strong>Version {v.version}</strong>{index === 0 && <span className="o-tag tc-live">Live</span>}</th>
          <td>{formatLegalDate(v.publishedAt)}</td>
          <td>{v.publishedBy || '—'}</td>
          <td>{v.requireExisting ? 'Everyone' : 'New accounts'}</td>
          <td className="is-num">{formatWhole(v.accepted)}</td>
        </tr>)}</tbody>
      </table></div> : <div className="ab-body"><EmptyState icon="info" tone="neutral" title="No versions yet">Publish to make the terms part of account creation.</EmptyState></div>}
    </Panel>

    <Modal open={publishing} onClose={() => !busy && setPublishing(false)} title={current ? `Publish version ${current.version + 1}?` : 'Publish the terms?'}>
      <div className="ab-form">
        <p className="ab-form-intro">From now on, everyone who creates a Cravio account must tick “I agree” to this version. Published versions can’t be edited; to change them, publish a new version.</p>
        <label className="tc-check"><input type="checkbox" checked={requireExisting} onChange={(event) => setRequireExisting(event.target.checked)} />
          <span><strong>Ask existing people to accept it too</strong><small>They see the terms at their next sign-in and can’t continue until they agree. Admins are never asked.</small></span></label>
        {problem && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{problem}</p>}
        <div className="ab-form-actions">
          <button type="button" className="o-btn" onClick={() => setPublishing(false)} disabled={busy} data-autofocus>Cancel</button>
          <button type="button" className="o-btn is-primary" onClick={publish} disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</button>
        </div>
      </div>
    </Modal>
  </div>;
}
