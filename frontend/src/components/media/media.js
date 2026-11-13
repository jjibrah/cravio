import { supabase } from '../../lib/supabase';
import { MAX_UPLOAD, imageFileError } from '../../lib/onboarding';

/*
 * Dish media helpers: photo and short-video checks, a poster frame grabbed in the browser, and uploads
 * straight to Supabase Storage with progress. Paths follow docs/API.md §10:
 *   photos  <restaurantId>/items/<uuid>.<ext>
 *   videos  <restaurantId>/videos/<uuid>.<mp4|webm|mov>
 *   posters <restaurantId>/posters/<uuid>.jpg
 */

export const BUCKET = 'restaurant-media';
export const MAX_IMAGE_BYTES = MAX_UPLOAD; // 5 MB
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 15;
export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
export const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',');
export const VIDEO_ACCEPT = [...Object.keys(VIDEO_TYPES), '.mp4', '.webm', '.mov'].join(',');
export const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;
export const PHOTO_LIMITS = 'JPG, PNG or WebP up to 5\u00a0MB';
export const VIDEO_LIMITS = 'MP4, WebM or MOV up to 15\u00a0seconds and 25\u00a0MB';
export const MEDIA_LIMITS = 'Photo up to 5 MB, or a video up to 15 seconds (25 MB)';

const EXT_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

/** Some phones hand over videos with an empty type; fall back to the file extension. */
export function videoTypeOf(file) {
  if (!file) return '';
  if (VIDEO_TYPES[file.type]) return file.type;
  const ext = String(file.name || '').split('.').pop()?.toLowerCase();
  return EXT_TYPES[ext] || '';
}

export const isVideoFile = (file) => Boolean(file) && (String(file.type).startsWith('video/') || Boolean(videoTypeOf(file)));

export { imageFileError };

/** Type and size check for a dish video. Returns an error message or ''. */
export function videoFileError(file) {
  if (!file) return 'Choose a video.';
  if (!videoTypeOf(file)) return 'That video type isn’t supported. Use MP4, WebM or MOV.';
  if (file.size > MAX_VIDEO_BYTES) return `That video is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB: trim or compress it.`;
  return '';
}

const secondsText = (seconds) => {
  const rounded = seconds >= MAX_VIDEO_SECONDS + 0.5 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
  return `${rounded} second${rounded === 1 ? '' : 's'}`;
};

/** The duration rule, as the message shown to the owner. '' when it's fine. */
export function durationError(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'We couldn’t read how long that video is. Try an MP4.';
  if (seconds > MAX_VIDEO_SECONDS + 0.05) return `This clip is ${secondsText(seconds)}. Keep it to ${MAX_VIDEO_SECONDS} seconds or less.`;
  return '';
}

/** "0:12" */
export const clipLength = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Reads a local video's metadata in the browser. Resolves { duration, width, height }; rejects if it can't be read. */
export function probeVideo(file, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('That video took too long to open. Try an MP4.')), timeout);
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      // Some files report Infinity until the browser scans them; nudge to the end to get the real length.
      if (video.duration === Infinity) {
        video.ontimeupdate = () => { video.ontimeupdate = null; finish(resolve, { duration: video.duration, width: video.videoWidth, height: video.videoHeight }); };
        video.currentTime = 1e7;
        return;
      }
      finish(resolve, { duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => finish(reject, new Error('That video can’t be read here. Try an MP4.'));
    video.src = url;
  });
}

/**
 * Grabs a poster frame: loads the video, seeks to about `at` seconds, draws it to a canvas and returns a JPEG Blob.
 * Resolves null (never rejects) when the browser can't decode the file, since a poster is optional.
 */
export function capturePoster(file, { at = 0.5, maxWidth = 960, quality = 0.82, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.onloadeddata = () => {
      const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(at, video.duration / 2) : at;
      video.onseeked = () => {
        try {
          const width = video.videoWidth || 640;
          const height = video.videoHeight || 360;
          const scale = Math.min(1, maxWidth / width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => finish(blob), 'image/jpeg', quality);
        } catch { finish(null); }
      };
      video.currentTime = target;
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function storageError(error, what) {
  const message = String(error?.message || error || '');
  if (/exceeded|too large|size|413/i.test(message)) return new Error(`That ${what} is too large for storage. Choose a smaller one.`);
  if (/mime|type|415/i.test(message)) return new Error(`That ${what} type isn’t allowed.`);
  if (/bucket not found/i.test(message)) return new Error('Media storage isn’t set up yet. Try again later.');
  if (/row-level security|unauthori[sz]ed|403|401|jwt/i.test(message)) return new Error('You don’t have permission to upload here. Sign in again and retry.');
  return new Error('The upload didn’t finish. Check your connection and try again.');
}

const publicUrl = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

/**
 * Uploads a file or Blob to `<restaurantId>/<kind>/<uuid>.<ext>` and resolves its public URL.
 * Uses XHR against the Storage REST API so `onProgress(fraction)` gets real progress; if that path isn't
 * available it falls back to the Supabase client (no progress events, so `onProgress(null)` = indeterminate).
 */
export async function uploadMedia(restaurantId, kind, file, { contentType, ext, onProgress, signal } = {}) {
  if (!supabase) throw new Error('Uploads aren’t set up in this app.');
  const type = contentType || file.type || 'application/octet-stream';
  const extension = ext || IMAGE_TYPES[type] || VIDEO_TYPES[type] || 'bin';
  const path = `${restaurantId}/${kind}/${crypto.randomUUID()}.${extension}`;
  const what = type.startsWith('video/') ? 'video' : 'image';
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const { data: { session } } = await supabase.auth.getSession();

  if (baseUrl && apiKey && session && typeof XMLHttpRequest !== 'undefined') {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${baseUrl.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`);
      xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
      xhr.setRequestHeader('apikey', apiKey);
      xhr.setRequestHeader('Content-Type', type);
      xhr.setRequestHeader('Cache-Control', 'max-age=31536000');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(); return; }
        let message = `${xhr.status}`;
        try { const body = JSON.parse(xhr.responseText); message = `${xhr.status} ${body.message || body.error || ''}`; } catch { /* keep the status */ }
        reject(storageError(message, what));
      };
      xhr.onerror = () => reject(storageError('network', what));
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' }));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      onProgress?.(0);
      xhr.send(file);
    });
    return publicUrl(path);
  }

  onProgress?.(null);
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: type, cacheControl: '31536000', upsert: false });
  if (error) throw storageError(error, what);
  return publicUrl(path);
}

/** Checks and uploads a dish photo. Resolves the public URL. */
export async function uploadDishPhoto(restaurantId, file, { onProgress, signal } = {}) {
  const problem = imageFileError(file);
  if (problem) throw new Error(problem);
  return uploadMedia(restaurantId, 'items', file, { contentType: file.type, ext: IMAGE_TYPES[file.type], onProgress, signal });
}

/**
 * The whole video flow: type and size check, duration check (before any upload), poster frame, uploads.
 * `onStage({ stage, progress, text })` reports what's happening: checking → poster → uploading → done.
 * Resolves { videoUrl, videoPosterUrl, videoDurationSeconds }, ready to PATCH onto the item.
 */
export async function uploadDishVideo(restaurantId, file, { onStage, signal } = {}) {
  const stage = (name, text, progress = null) => onStage?.({ stage: name, text, progress });
  const typeProblem = videoFileError(file);
  if (typeProblem) throw new Error(typeProblem);
  stage('checking', 'Checking the video…');
  const { duration } = await probeVideo(file);
  const problem = durationError(duration);
  if (problem) throw new Error(problem);

  stage('poster', 'Making a preview picture…');
  const poster = await capturePoster(file);

  const type = videoTypeOf(file);
  stage('uploading', 'Uploading video…', 0);
  const videoUrl = await uploadMedia(restaurantId, 'videos', file, {
    contentType: type, ext: VIDEO_TYPES[type], signal,
    onProgress: (fraction) => stage('uploading', fraction === null ? 'Uploading video…' : `Uploading video… ${Math.round(fraction * 100)}%`, fraction),
  });
  let videoPosterUrl = null;
  if (poster) {
    stage('uploading', 'Uploading the preview picture…', null);
    try { videoPosterUrl = await uploadMedia(restaurantId, 'posters', poster, { contentType: 'image/jpeg', ext: 'jpg', signal }); }
    catch { videoPosterUrl = null; } // The video still works without a poster.
  }
  return { videoUrl, videoPosterUrl, videoDurationSeconds: Math.min(MAX_VIDEO_SECONDS, Math.max(0.1, Math.round(duration * 10) / 10)) };
}
