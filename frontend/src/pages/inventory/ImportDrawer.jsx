// CSV import of items: download the template, choose a file (or paste), check it (a dry run that writes nothing) and read the
// report row by row, then import. "Import N items" stays off while any row has an error: nothing is imported until the file is clean.
import { useId, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { explain, newCommandId, owner } from '../../lib/inventory';
import { FormError, OIcon, downloadText } from './parts';

const ACTION = { create: ['New', 'is-ok'], update: ['Update', 'is-low'], skip: ['No change', 'is-off'], error: ['Fix this', 'is-out'] };

function Summary({ summary }) {
  const chips = [['create', summary.create], ['update', summary.update], ['skip', summary.skip], ['error', summary.errors]].filter(([, n]) => n > 0);
  return <div className="inv-summary" aria-label="Summary">
    {chips.map(([key, n]) => <span key={key} className={`inv-badge ${ACTION[key][1]}`}>{n} {ACTION[key][0].toLowerCase()}</span>)}
    {summary.openings > 0 && <span className="inv-badge is-off">{summary.openings} with opening stock</span>}
    {summary.warnings > 0 && <span className="inv-badge is-low">{summary.warnings} {summary.warnings === 1 ? 'warning' : 'warnings'}</span>}
  </div>;
}

function Report({ report }) {
  return <>
    <Summary summary={report.summary} />
    {report.fileWarnings?.length > 0 && <ul className="inv-results">{report.fileWarnings.map((w) => <li key={w} className="is-skipped">{w}</li>)}</ul>}
    <div className="inv-report" role="region" aria-label="Import report" tabIndex={0}>
      <table className="inv-table">
        <thead><tr><th scope="col">Row</th><th scope="col">Item</th><th scope="col">What happens</th><th scope="col">Notes</th></tr></thead>
        <tbody>{report.rows.map((row) => <tr key={row.line}>
          <td>{row.line}</td>
          <th scope="row">{row.name}</th>
          <td><span className={`inv-badge ${ACTION[row.action]?.[1] || 'is-off'}`}>{ACTION[row.action]?.[0] || row.action}</span></td>
          <td>{[...(row.messages || []), ...(row.warnings || []), ...(row.action === 'error' ? [] : row.changes || [])].length
            ? <ul>{[...(row.messages || []), ...(row.warnings || []), ...(row.action === 'error' ? [] : row.changes || [])].map((m) => <li key={m} className={row.action === 'error' && (row.messages || []).includes(m) ? 'is-minus' : undefined}>{m}</li>)}</ul> : null}
            {row.opening && <small>Opening stock: {row.opening.display || `${row.opening.quantity} ${row.opening.unit}`} at {row.opening.locationName}</small>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

export default function ImportDrawer({ ctx, onClose }) {
  const ids = useId();
  const { notify } = useNotifications();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [commandId, setCommandId] = useState(newCommandId);
  const businessId = ctx.business.id;

  const guard = async (work) => {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(explain(failure)); } finally { setBusy(false); }
  };
  const change = (text, name = '') => { setCsv(text); setFileName(name); setReport(null); setResult(null); setError(null); };

  const template = () => guard(async () => {
    const file = await owner.importTemplate(businessId);
    downloadText(file.filename || 'cravio-items-import-template.csv', file.csv);
  });
  const check = () => guard(async () => { setReport(await owner.importDryRun(businessId, csv)); });
  const commit = () => guard(async () => {
    try {
      const done = await owner.importCommit(businessId, csv, { commandId });
      setResult(done); setReport(null); setCommandId(newCommandId());
      ctx.refresh();
      notify(`Imported ${done.summary.create + done.summary.update} items.`);
    } catch (failure) {
      if (failure.code === 'import_has_errors' && failure.details?.report) setReport(failure.details.report);
      throw failure;
    }
  });

  const count = report ? report.summary.create + report.summary.update : 0;
  const canImport = Boolean(report?.ok) && count > 0 && !busy;
  return <div className="inv-form">
    <section aria-label="Step 1">
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>1. Get the template</h3>
      <p className="o-field-hint">A spreadsheet with one row per item. Fill it in with Excel or Google Sheets and save it as CSV.</p>
      <button type="button" className="o-btn is-small" onClick={template} disabled={busy}><OIcon name="download" size={15} />Download template</button>
    </section>
    <section className="inv-section" aria-label="Step 2">
      <h3>2. Choose your file</h3>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-file`}>CSV file</label>
        <input id={`${ids}-file`} className="o-input" type="file" accept=".csv,text/csv,text/plain" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) change(await file.text(), file.name);
        }} />
        {fileName && <p className="o-field-hint">{fileName}</p>}
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-paste`}>Or paste it here <span className="o-optional">Optional</span></label>
        <textarea id={`${ids}-paste`} className="o-input inv-paste" rows={4} value={csv} placeholder="name,code,category,measured_by,…" onChange={(event) => change(event.target.value)} />
      </div>
      <button type="button" className="o-btn is-primary is-small" onClick={check} disabled={busy || !csv.trim()}>{busy && !report ? 'Checking…' : 'Check the file'}</button>
      <p className="o-field-hint">Checking changes nothing. You’ll see what would happen to every row first.</p>
    </section>

    {report && <section className="inv-section" aria-label="Check results">
      <h3>3. Check the results</h3>
      <Report report={report} />
      {!report.ok && <p className="inv-warn">Fix the rows marked “Fix this” in your file, then check it again. Nothing is imported until every row is fine.</p>}
    </section>}

    {result && <section className="inv-section" aria-label="Import finished">
      <h3>Import finished</h3>
      <p>{result.summary.create} added, {result.summary.update} updated, {result.summary.skip} unchanged{result.summary.openings ? `, ${result.summary.openings} opening amounts recorded` : ''}.</p>
    </section>}

    <FormError error={error} />
    <div className="biz-form-actions">
      {result ? <button type="button" className="o-btn is-primary" onClick={onClose}>Done</button>
        : <button type="button" className="o-btn is-primary" onClick={commit} disabled={!canImport}>{busy && report ? 'Importing…' : `Import ${count} ${count === 1 ? 'item' : 'items'}`}</button>}
      {!result && <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>}
    </div>
  </div>;
}
