import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api';
import Glyph from './Glyph';
import {
  IMAGE_ACCEPT, PHOTO_LIMITS, VIDEO_ACCEPT, VIDEO_LIMITS, clipLength, imageFileError, uploadDishPhoto, uploadDishVideo, videoFileError,
} from './media';
import './media.css';

export * from './media';

/**
 * A dish's photo and short video, side by side: add, replace or remove each. Uploads straight to storage,
 * PATCHes /api/restaurant/items/:id itself, then calls onSaved(updatedItem).
 *
 * Props: { restaurantId, item: { id, name, photoUrl, videoUrl, videoPosterUrl, videoDurationSeconds }, onSaved, compact? }
 */
export default function DishMediaEditor({ restaurantId, item, onSaved, compact = false }) {
  const [saved, setSaved] = useState(item);
  useEffect(() => { setSaved(item); }, [item]);
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return undefined; const timer = setTimeout(() => setStatus(''), 3000); return () => clearTimeout(timer); }, [status]);

  async function patch(fields, message) {
    const { item: updated } = await api(`/api/restaurant/items/${item.id}`, { method: 'PATCH', body: fields });
    setSaved(updated);
    setStatus(message);
    onSaved?.(updated);
    return updated;
  }

  return <div className={`dme${compact ? ' is-compact' : ''}`} role="group" aria-label={`Photo and video for ${item.name}`}>
    <div className="dme-slots">
      <PhotoSlot restaurantId={restaurantId} item={saved} compact={compact} patch={patch} />
      <VideoSlot restaurantId={restaurantId} item={saved} compact={compact} patch={patch} />
    </div>
    <p className="dme-status" role="status" aria-live="polite">{status && <><Glyph name="check" size={14} />{status}</>}</p>
  </div>;
}

function Progress({ text, progress }) {
  return <div className="dme-progress" role="status" aria-live="polite">
    <span className="dme-progress-text">{text}</span>
    <span className={`dme-bar${progress == null ? ' is-indeterminate' : ''}`} role="progressbar" aria-label={text}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress == null ? undefined : Math.round(progress * 100)}>
      <span style={progress == null ? undefined : { width: `${Math.max(4, progress * 100)}%` }} />
    </span>
  </div>;
}

function SlotError({ id, children }) {
  if (!children) return null;
  return <p className="dme-error" id={id} role="alert"><Glyph name="alert" size={14} />{children}</p>;
}

function PhotoSlot({ restaurantId, item, compact, patch }) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState('');

  async function choose(file) {
    if (!file) return;
    setError('');
    const problem = imageFileError(file);
    if (problem) { setError(problem); return; }
    const preview = URL.createObjectURL(file);
    setLocal(preview);
    setBusy({ text: 'Uploading photo…', progress: 0 });
    try {
      const photoUrl = await uploadDishPhoto(restaurantId, file, { onProgress: (p) => setBusy({ text: p == null ? 'Uploading photo…' : `Uploading photo… ${Math.round(p * 100)}%`, progress: p }) });
      setBusy({ text: 'Saving…', progress: null });
      await patch({ photoUrl }, 'Photo saved');
    } catch (uploadError) { setError(uploadError.message || 'Couldn’t save that photo. Try again.'); }
    finally { setBusy(null); setLocal(''); URL.revokeObjectURL(preview); if (inputRef.current) inputRef.current.value = ''; }
  }

  async function remove() {
    setError('');
    setBusy({ text: 'Removing…', progress: null });
    try { await patch({ photoUrl: null }, 'Photo removed'); }
    catch (removeError) { setError(removeError.message); }
    finally { setBusy(null); }
  }

  const shown = local || item.photoUrl;
  return <div className="dme-slot">
    <span className="dme-label">Photo</span>
    <input ref={inputRef} id={inputId} className="visually-hidden" type="file" accept={IMAGE_ACCEPT} disabled={Boolean(busy)}
      aria-describedby={error ? errorId : undefined} onChange={(event) => choose(event.target.files?.[0])} />
    <label htmlFor={inputId} className={`dme-tile${shown ? ' has-media' : ''}${busy ? ' is-busy' : ''}`}>
      {shown ? <img src={shown} alt="" /> : <span className="dme-empty"><Glyph name="camera" size={22} /><strong>Add photo</strong>{!compact && <span>{PHOTO_LIMITS}</span>}</span>}
      <span className="visually-hidden">{shown ? `Replace the photo of ${item.name}` : `Add a photo of ${item.name}`}</span>
    </label>
    {busy && <Progress {...busy} />}
    {shown && !busy && <div className="dme-actions">
      <button type="button" className="dme-link" onClick={() => inputRef.current?.click()}>Replace</button>
      <button type="button" className="dme-link" onClick={remove} aria-label={`Remove the photo of ${item.name}`}>Remove</button>
    </div>}
    {compact && !shown && !busy && <span className="dme-hint">Up to 5 MB</span>}
    <SlotError id={errorId}>{error}</SlotError>
  </div>;
}

function VideoSlot({ restaurantId, item, compact, patch }) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [item.videoUrl]);

  async function choose(file) {
    if (!file) return;
    setError('');
    const problem = videoFileError(file);
    if (problem) { setError(problem); if (inputRef.current) inputRef.current.value = ''; return; }
    setPlaying(false);
    setBusy({ text: 'Checking the video…', progress: null });
    try {
      const fields = await uploadDishVideo(restaurantId, file, { onStage: ({ text, progress }) => setBusy({ text, progress }) });
      setBusy({ text: 'Saving…', progress: null });
      const body = { videoUrl: fields.videoUrl, videoDurationSeconds: fields.videoDurationSeconds };
      if (fields.videoPosterUrl) body.videoPosterUrl = fields.videoPosterUrl;
      await patch(body, 'Video saved');
    } catch (uploadError) { setError(uploadError.message || 'Couldn’t save that video. Try again.'); }
    finally { setBusy(null); if (inputRef.current) inputRef.current.value = ''; }
  }

  async function remove() {
    setError('');
    setBusy({ text: 'Removing…', progress: null });
    try { await patch({ videoUrl: null }, 'Video removed'); }
    catch (removeError) { setError(removeError.message); }
    finally { setBusy(null); }
  }

  const has = Boolean(item.videoUrl);
  const poster = item.videoPosterUrl || item.photoUrl || undefined;
  return <div className="dme-slot">
    <span className="dme-label">Video <span className="dme-label-meta">optional</span></span>
    <input ref={inputRef} id={inputId} className="visually-hidden" type="file" accept={VIDEO_ACCEPT} disabled={Boolean(busy)}
      aria-describedby={error ? errorId : undefined} onChange={(event) => choose(event.target.files?.[0])} />
    {has && playing
      ? <div className="dme-tile has-media is-video"><video src={item.videoUrl} poster={poster} controls autoPlay playsInline muted loop aria-label={`Video of ${item.name}`} /></div>
      : has
        ? <button type="button" className={`dme-tile has-media is-video${busy ? ' is-busy' : ''}`} onClick={() => setPlaying(true)} aria-label={`Play the video of ${item.name}`} disabled={Boolean(busy)}>
          {poster ? <img src={poster} alt="" /> : <span className="dme-video-blank" />}
          <span className="dme-play" aria-hidden="true"><Glyph name="play" size={16} /></span>
          {item.videoDurationSeconds ? <span className="dme-duration">{clipLength(item.videoDurationSeconds)}</span> : null}
        </button>
        : <label htmlFor={inputId} className={`dme-tile${busy ? ' is-busy' : ''}`}>
          <span className="dme-empty"><Glyph name="video" size={22} /><strong>Add video</strong>{!compact && <span>{VIDEO_LIMITS}</span>}</span>
          <span className="visually-hidden">{`Add a video of ${item.name} (up to 15 seconds)`}</span>
        </label>}
    {busy && <Progress {...busy} />}
    {has && !busy && <div className="dme-actions">
      <button type="button" className="dme-link" onClick={() => inputRef.current?.click()}>Replace</button>
      <button type="button" className="dme-link" onClick={remove} aria-label={`Remove the video of ${item.name}`}>Remove</button>
    </div>}
    {compact && !has && !busy && <span className="dme-hint">Up to 15 s</span>}
    <SlotError id={errorId}>{error}</SlotError>
  </div>;
}
