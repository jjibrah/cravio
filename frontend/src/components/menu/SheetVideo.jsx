import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './MenuCards';
import { returnVideo, setSheetVideo, takeVideo } from './video-warm';
import './sheet-video.css';

/*
 * The dish sheet's video. Opening a dish is the guest's intent, so it starts by itself (muted, inline, looped),
 * Save-Data or not: play() on open and again once data arrives, then one clear play button if the browser still
 * says no. The poster (or photo) shows at once with a soft shimmer; the video crossfades in on its first real
 * frame, so there's no black flash and no jump. A tap pauses or resumes, with a small indicator. Reduced motion:
 * the poster and a play button, nothing moves until the guest asks.
 *
 * The <video> element itself comes from video-warm.js (the one the card press started buffering, often already
 * playing from the opening tap) and is handed back on close.
 */

const playIcon = (size) => <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" /></svg>;
const pauseIcon = (size) => <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></svg>;

export default function SheetVideo({ item, poster, onPlay, children }) {
  const slotRef = useRef(null);
  const videoRef = useRef(null);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  const [reduced] = useState(prefersReducedMotion);
  // loading: trying to start · playing · paused: by the guest · blocked: the browser refused, or reduced motion · error
  const [phase, setPhase] = useState(reduced ? 'blocked' : 'loading');
  const [shown, setShown] = useState(false);
  const [flash, setFlash] = useState(null);
  const userPaused = useRef(false);

  useEffect(() => {
    const slot = slotRef.current;
    const url = item.videoUrl;
    const video = takeVideo(url);
    videoRef.current = video;
    video.className = 'dv-video';
    video.setAttribute('aria-hidden', 'true');
    video.tabIndex = -1;
    if (reduced && video.paused) { video.preload = 'metadata'; }
    slot.appendChild(video);
    setSheetVideo(true);

    let alive = true;
    let refusals = 0;
    let failed = false;
    let fired = false;
    let retryTimer = 0;

    const reveal = () => { if (alive) setShown(true); };
    const onPlaying = () => {
      if (!alive) return;
      setPhase('playing');
      if (!fired) { fired = true; onPlayRef.current?.(item); }
      // Fade in on the first painted frame, not on "playing" (which can come before a frame on slow phones).
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(reveal);
      else requestAnimationFrame(() => requestAnimationFrame(reveal));
    };
    const attempt = () => {
      if (!alive || userPaused.current || !video.paused) return;
      const promise = video.play();
      promise?.catch?.((error) => {
        if (!alive || userPaused.current || !video.paused) return;
        if (error?.name === 'AbortError') return; // interrupted by a reload, not refused
        refusals += 1;
        if (refusals >= 2) { setPhase('blocked'); return; }
        // Retry once: right away when there's data, otherwise when it arrives (onReady).
        if (video.readyState >= 2) retryTimer = setTimeout(attempt, 250);
      });
    };
    const onReady = () => { if (refusals < 2) attempt(); };
    // Paused by the guest, or by the phone (a background tab, Low Power Mode): then offer the play button.
    const onPause = () => { if (alive) setPhase(userPaused.current ? 'paused' : 'blocked'); };
    const onError = () => { failed = true; if (alive) setPhase('error'); };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onError);
    if (!reduced) {
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
    }

    if (video.error) onError();
    else if (!video.paused) onPlaying(); // the opening tap already started it
    else if (!reduced) attempt();

    return () => {
      alive = false;
      clearTimeout(retryTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.pause();
      video.remove();
      setSheetVideo(false);
      returnVideo(url, video, { failed });
    };
    // One element per dish: DishSheet is keyed by the dish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(timer);
  }, [flash]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video || phase === 'error') return;
    if (video.paused) {
      userPaused.current = false;
      setPhase(shown ? 'playing' : 'loading');
      setFlash({ icon: 'play', at: Date.now() });
      // Inside the tap, so this is allowed even where autoplay was refused.
      video.play()?.catch?.((error) => { if (error?.name !== 'AbortError' && video.paused) setPhase('blocked'); });
    } else {
      userPaused.current = true;
      video.pause();
      setPhase('paused');
      setFlash({ icon: 'pause', at: Date.now() });
    }
  };

  const playing = phase === 'playing' || phase === 'loading';
  return <div className={`gx-dish-media is-video dv is-${phase}${shown ? ' is-shown' : ''}${poster ? '' : ' no-poster'}`}>
    {poster && <img className="dv-poster" src={poster} alt="" decoding="async" loading="eager" fetchPriority="high" />}
    <span ref={slotRef} className="dv-slot" />
    {phase === 'loading' && !shown && <span className="dv-loading" aria-hidden="true"><span className="dv-spinner" /></span>}
    {phase !== 'error' && <button type="button" className="dv-toggle" onClick={toggle} aria-label={`${playing ? 'Pause' : 'Play'} video of ${item.name}`}>
      {phase === 'blocked' && <span className="dv-big-play">{playIcon(26)}</span>}
      {phase === 'paused' && <span className="dv-badge">{playIcon(13)}</span>}
      {flash && <span key={flash.at} className="dv-flash">{flash.icon === 'play' ? playIcon(22) : pauseIcon(22)}</span>}
    </button>}
    {children}
  </div>;
}
