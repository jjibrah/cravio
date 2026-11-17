/*
 * A tiny pool of detached, muted, inline <video> elements, keyed by URL, so a dish video can start before its
 * sheet is on screen:
 * - warmVideo(url): a guest pressed a video card; start buffering (preload="auto").
 * - primeVideo(url): the guest tapped to open the dish; call play() inside that tap, which iOS honours even in
 *   Low Power Mode, so the element is already playing (or blessed to play) when the sheet adopts it.
 * - takeVideo(url) / returnVideo(url, video): the dish sheet adopts the warm element (keeping whatever it has
 *   buffered) and hands it back on close, so reopening the same dish is instant.
 * It also tells card videos when a sheet video is playing, so a phone decodes one video at a time.
 * No React, no imports: safe for the guest bundle.
 */

const MAX = 3;
const pool = new Map();
const primeTimers = new WeakMap();
const listeners = new Set();
let sheetVideos = 0;

const hasDom = () => typeof document !== 'undefined';

function make(url) {
  const video = document.createElement('video');
  // Property and attribute both: iOS reads the attributes for inline, muted playback.
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute('muted', '');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.setAttribute('disableremoteplayback', '');
  video.loop = true;
  video.preload = 'auto';
  video.src = url;
  return video;
}

function release(video) {
  clearTimeout(primeTimers.get(video));
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* already gone */ }
}

function trim() {
  while (pool.size > MAX) {
    const [url, video] = pool.entries().next().value;
    pool.delete(url);
    if (!video.isConnected) release(video);
  }
}

/** Starts buffering a dish video (idempotent). Returns the pooled element. */
export function warmVideo(url) {
  if (!url || !hasDom()) return null;
  let video = pool.get(url);
  if (video) { pool.delete(url); pool.set(url, video); return video; }
  video = make(url);
  pool.set(url, video);
  try { video.load(); } catch { /* the src assignment already started it */ }
  trim();
  return video;
}

/** A press turned into a scroll: stop a warm-up that nothing has used yet. */
export function coolVideo(url) {
  const video = pool.get(url);
  if (!video || video.isConnected || !video.paused || video.readyState >= 2) return;
  pool.delete(url);
  release(video);
}

/** Inside the tap that opens the dish: start playback, so the sheet shows a moving picture at once. */
export function primeVideo(url, { play = true } = {}) {
  const video = warmVideo(url);
  if (!video || !play) return;
  if (video.paused) video.play()?.catch?.(() => {});
  clearTimeout(primeTimers.get(video));
  // If no sheet adopts it, don't keep decoding in the background.
  primeTimers.set(video, setTimeout(() => { if (!video.isConnected) video.pause(); }, 2000));
}

/** The dish sheet takes the warm element (or a fresh one) for its own. */
export function takeVideo(url) {
  const video = pool.get(url);
  if (video) {
    pool.delete(url);
    clearTimeout(primeTimers.get(video));
    return video;
  }
  return make(url);
}

/** The sheet closed: keep the buffered element for a reopen, unless it failed. */
export function returnVideo(url, video, { failed = false } = {}) {
  if (!video) return;
  video.pause();
  if (failed || pool.has(url)) { release(video); return; }
  pool.set(url, video);
  trim();
}

/* ---------- One video at a time ---------- */

export const sheetVideoActive = () => sheetVideos > 0;
export function onSheetVideo(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function setSheetVideo(active) {
  const before = sheetVideos > 0;
  sheetVideos = Math.max(0, sheetVideos + (active ? 1 : -1));
  if (before !== sheetVideos > 0) listeners.forEach((listener) => listener(sheetVideos > 0));
}
