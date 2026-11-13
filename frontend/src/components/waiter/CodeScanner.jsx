import { useEffect, useRef, useState } from 'react';
import Sheet from '../Sheet';
import Glyph from '../media/Glyph';

export const CODE_PATTERN = /([ACDEFHJKMNPRTUVWXY34679]{6})\b/;
/** Uppercases, drops spaces and dashes, keeps 6 characters. */
export const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export const canScanInApp = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Scans the guest's QR with the camera (BarcodeDetector), where the browser supports it. Elsewhere it explains the
 * two other ways: the phone's own camera app (the QR opens /waiter/cart/<code>), or typing the code.
 * `onType` (optional) switches to typing the code; without it, "Type the code instead" just closes.
 */
export default function CodeScanner({ open, onClose, onCode, onType }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('starting');
  const supported = canScanInApp();

  useEffect(() => {
    if (!open || !supported) return undefined;
    let stream = null;
    let timer = null;
    let stopped = false;
    setStatus('starting');
    (async () => {
      try {
        const formats = window.BarcodeDetector.getSupportedFormats ? await window.BarcodeDetector.getSupportedFormats().catch(() => []) : [];
        if (formats.length && !formats.includes('qr_code')) { setStatus('unsupported'); return; }
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setStatus('scanning');
        const tick = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(video);
            for (const code of found) {
              const match = String(code.rawValue || '').toUpperCase().match(CODE_PATTERN);
              if (match) { stopped = true; navigator.vibrate?.(40); onCode(match[1]); return; }
            }
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch (error) {
        setStatus(error?.name === 'NotAllowedError' ? 'denied' : 'failed');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((track) => track.stop()); };
  }, [open, supported, onCode]);

  const fallback = <div className="w-scan-help">
    <p><strong>Use your phone’s camera app.</strong> Point it at the guest’s QR code and tap the link. It opens their order here.</p>
    <p>Or type the 6-character code under the guest’s QR.</p>
  </div>;

  return <Sheet open={open} onClose={onClose} title="Scan the guest’s code" className="w-sheet w-scan-sheet">
    {!supported || status === 'unsupported' ? fallback : <>
      <div className="w-scan-view">
        <video ref={videoRef} muted playsInline aria-label="Camera view" />
        <span className="w-scan-frame" aria-hidden="true" />
      </div>
      <p className="w-scan-status" role="status">
        {status === 'starting' && 'Starting the camera…'}
        {status === 'scanning' && <><Glyph name="scan" size={16} />Hold the QR inside the square.</>}
        {status === 'denied' && 'Camera access is blocked. Allow it in your browser settings, or type the code instead.'}
        {status === 'failed' && 'The camera didn’t start. Type the code instead.'}
      </p>
      {(status === 'denied' || status === 'failed') && fallback}
    </>}
    <button type="button" className="w-btn w-btn-secondary w-btn-big" onClick={onType || onClose}><Glyph name="keyboard" size={18} />Type the code instead</button>
  </Sheet>;
}
