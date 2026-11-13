import { useId, useRef, useState } from 'react';
import { IMAGE_ACCEPT, imageFileError, uploadImage } from '../../lib/onboarding';
import { MEDIA_ACCEPT, isVideoFile, uploadDishVideo, videoFileError } from '../media/media';
import OnbIcon from './OnbIcon';

function PlayBadge() {
  return <span className="upload-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" /></svg></span>;
}

/**
 * Picks an image, checks it (type, 5 MB), uploads it straight to Supabase Storage and reports the public URL.
 * Variants: 'logo' (round), 'cover' (wide), 'thumb' (compact button for dish photos),
 * 'dish' (the guest menu's rounded-square photo, with a remove button once filled).
 * With `onError`, errors are reported to the parent (to show under a whole row) instead of inline.
 * With `onVideoChange` ('thumb' and 'dish' only), the slot takes a photo OR a short video (≤15 s, ≤25 MB): a video is
 * checked for length before upload, gets a poster frame, and is reported as { videoUrl, videoPosterUrl, videoDurationSeconds }
 * (null to remove). `video` is the current { videoUrl, videoPosterUrl, ... }.
 */
export default function ImageUpload({ restaurantId, kind, value, onChange, variant = 'cover', label, hint, disabled = false, onError, video, onVideoChange }) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localPreview, setLocalPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState('');
  const takesVideo = Boolean(onVideoChange) && (variant === 'thumb' || variant === 'dish');
  const hasVideo = takesVideo && Boolean(video?.videoUrl);

  const report = (message) => { setError(message); onError?.(message); };

  async function handleVideo(file) {
    const problem = videoFileError(file);
    if (problem) { report(problem); return; }
    setBusy(true);
    setStage('Checking the video…');
    try {
      const fields = await uploadDishVideo(restaurantId, file, { onStage: ({ text }) => setStage(text) });
      setStage('Saving…');
      await onVideoChange(fields);
    } catch (uploadError) {
      report(uploadError.message);
    } finally {
      setBusy(false);
      setStage('');
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handle(file) {
    report('');
    if (!file) return;
    if (takesVideo && isVideoFile(file)) { await handleVideo(file); return; }
    const problem = imageFileError(file);
    if (problem) { report(problem); return; }
    const preview = URL.createObjectURL(file);
    setLocalPreview(preview);
    setBusy(true);
    try {
      const url = await uploadImage(restaurantId, kind, file);
      onChange(url);
    } catch (uploadError) {
      report(uploadError.message);
    } finally {
      setBusy(false);
      setLocalPreview('');
      URL.revokeObjectURL(preview);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const shown = localPreview || (hasVideo ? video.videoPosterUrl || value : value);
  const busyText = stage || `Uploading ${takesVideo ? 'media' : 'photo'}…`;
  const removeMedia = () => { report(''); if (hasVideo) onVideoChange(null); else onChange(null); };
  const input = <input ref={inputRef} id={inputId} className="visually-hidden" type="file" accept={takesVideo ? MEDIA_ACCEPT : IMAGE_ACCEPT} disabled={disabled || busy}
    aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined}
    onChange={(event) => handle(event.target.files?.[0])} />;
  const errorNote = error && !onError && <p className="onb-field-error" id={errorId} role="alert"><OnbIcon name="alert" size={14} />{error}</p>;

  if (variant === 'thumb') return <div className="upload-thumb">
    {input}
    <label htmlFor={inputId} className={`upload-thumb-button${shown || hasVideo ? ' has-image' : ''}${busy ? ' is-busy' : ''}`}>
      {shown ? <img src={shown} alt="" /> : hasVideo ? <span className="upload-video-blank" /> : <OnbIcon name="camera" size={18} />}
      {hasVideo && !busy && <PlayBadge />}
      <span className="visually-hidden">{busy ? busyText : shown || hasVideo ? `Replace ${label}` : `Add ${label}`}</span>
      {busy && <span className="upload-spinner" aria-hidden="true" />}
    </label>
    {busy && takesVideo && <span className="upload-stage" role="status">{busyText}</span>}
    {takesVideo && (shown || hasVideo) && !busy && <button type="button" className="upload-thumb-remove" onClick={removeMedia}>Remove<span className="visually-hidden"> {hasVideo ? 'video' : 'photo'}</span></button>}
    {errorNote}
  </div>;

  if (variant === 'dish') return <div className={`upload-dish${shown || hasVideo ? ' has-image' : ''}`}>
    {input}
    <label htmlFor={inputId} className={`upload-dish-button${shown || hasVideo ? ' has-image' : ''}${busy ? ' is-busy' : ''}`}>
      {shown ? <img src={shown} alt="" /> : hasVideo ? <span className="upload-video-blank" />
        : <span className="upload-dish-empty" aria-hidden="true"><OnbIcon name="camera" size={20} /><span>{takesVideo ? 'Photo or video' : 'Add photo'}</span></span>}
      {hasVideo && !busy && <PlayBadge />}
      <span className="visually-hidden">{busy ? busyText : shown || hasVideo ? `Replace ${label}` : `Add ${label}`}</span>
      {busy && <span className="upload-spinner" aria-hidden="true" />}
    </label>
    {(shown || hasVideo) && !busy && <button type="button" className="upload-dish-remove" aria-label={`Remove ${hasVideo ? `the video of ${label.replace(/^an? (photo|photo or video) of /, '')}` : label}`} disabled={disabled}
      onClick={removeMedia}><OnbIcon name="close" size={14} /></button>}
    {busy && takesVideo && <span className="upload-stage" role="status">{busyText}</span>}
    {errorNote}
  </div>;

  return <div className={`upload upload-${variant}`}>
    {input}
    <label htmlFor={inputId} className={`upload-drop${shown ? ' has-image' : ''}${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); handle(event.dataTransfer.files?.[0]); }}>
      {shown ? <img className="upload-image" src={shown} alt={`${label} preview`} /> : <span className="upload-empty">
        <span className="upload-empty-icon"><OnbIcon name="upload" size={22} /></span>
        <strong>{label}</strong>
        <span>{hint || 'JPG, PNG or WebP, up to 5 MB'}</span>
      </span>}
      {busy && <span className="upload-busy" role="status"><span className="upload-spinner" aria-hidden="true" />Uploading…</span>}
    </label>
    {shown && !busy && <div className="upload-actions">
      <button type="button" className="onb-text-button" onClick={() => inputRef.current?.click()}>Replace</button>
      <button type="button" className="onb-text-button" onClick={() => { onChange(null); report(''); }}>Remove</button>
    </div>}
    {errorNote}
  </div>;
}
