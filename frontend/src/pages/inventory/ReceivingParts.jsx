// Small pieces shared by the receiving, approvals and emergency-purchase screens (P2-15 to P2-17).
import { useEffect, useId, useMemo, useState } from 'react';
import { downscaleImage } from '../../lib/images';
import { OIcon } from './parts';
import './receiving.css';

/**
 * Take or choose a photo. On a phone the camera opens straight away (`camera`); the picture is shrunk to at most 1600 px (JPEG) the
 * moment it is chosen, so what you see is what is sent. `onChange(file | null)`.
 */
export function PhotoField({ id, label, hint, file, onChange, accept = 'image/*', camera = true, required = false, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const url = useMemo(() => (file && String(file.type).startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function pick(event) {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setBusy(true); setProblem('');
    try { onChange(await downscaleImage(picked)); } catch (error) { setProblem(error.message); } finally { setBusy(false); }
  }
  return <div className="o-field rcv-photo">
    <span className="o-label">{label}{required ? <> <span className="o-optional">Needed</span></> : <> <span className="o-optional">Optional</span></>}</span>
    {file ? <div className="rcv-photo-got">
      {url ? <img src={url} alt="The photo you added" /> : <span className="rcv-photo-name">{file.name}</span>}
      <button type="button" className="o-btn is-quiet" onClick={() => onChange(null)} disabled={disabled}>Remove</button>
    </div> : <>
      <input id={id} className="visually-hidden" type="file" accept={accept} {...(camera ? { capture: 'environment' } : {})} onChange={pick} disabled={disabled || busy} />
      <label htmlFor={id} className="o-btn rcv-photo-btn"><OIcon name="plus" size={15} />{busy ? 'Getting the photo ready…' : camera ? 'Take a photo' : 'Add a photo or file'}</label>
    </>}
    {hint && <p className="o-field-hint">{hint}</p>}
    {problem && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{problem}</p>}
  </div>;
}

/** A row of pill buttons to pick one (or none) of a few plain choices, such as why goods were rejected. */
export function Chips({ label, options, value, onChange }) {
  const id = useId();
  return <div className="o-field">
    <span className="o-label" id={id}>{label}</span>
    <div className="inv-reasons" role="group" aria-labelledby={id}>
      {options.map((name) => <button key={name} type="button" className="inv-reason" aria-pressed={value === name} onClick={() => onChange(value === name ? '' : name)}>{name}</button>)}
    </div>
  </div>;
}

/** Big radio cards: one choice from a few, each with a short hint. */
export function Choice({ legend, options, value, onChange, disabled = false, className = '' }) {
  const name = useId();
  return <fieldset className={`inv-choice ${className}`} disabled={disabled}>
    <legend className="o-label">{legend}</legend>
    {options.map((option) => <label key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}
    </label>)}
  </fieldset>;
}

/** "Chicken: 40 kg" style fact list used on cards and sheets. */
export function Facts({ items }) {
  return <dl className="rcv-facts">{items.filter((item) => item && item[1] !== null && item[1] !== undefined && item[1] !== '').map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}

/** Photos on a record (signed links from the server): small thumbnails that open the picture. */
export function Evidence({ files = [] }) {
  const pictures = files.filter((f) => f.url);
  if (!files.length) return null;
  return <ul className="rcv-evidence" aria-label="Photos attached">
    {pictures.map((f) => <li key={f.id}><a href={f.url} target="_blank" rel="noopener noreferrer">{String(f.mime).startsWith('image/') ? <img src={f.url} alt={f.name || 'Photo'} loading="lazy" /> : <span>{f.name}</span>}</a></li>)}
    {!pictures.length && <li className="o-field-hint">{files.length} {files.length === 1 ? 'file is' : 'files are'} attached.</li>}
  </ul>;
}
