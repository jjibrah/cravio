import { useEffect, useRef } from 'react';

const COLORS = ['#d9431e', '#111110', '#f2b33d', '#17734a', '#2f6fd6', '#e8e6e1'];

/** A short burst of canvas confetti. Nothing at all when the user prefers reduced motion. */
export default function Confetti({ pieces = 150, duration = 2600 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = ref.current;
    const context = canvas.getContext('2d');
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { canvas.width = window.innerWidth * ratio; canvas.height = window.innerHeight * ratio; };
    resize();
    window.addEventListener('resize', resize);
    const w = () => canvas.width;
    const h = () => canvas.height;
    const parts = Array.from({ length: pieces }, (_, i) => ({
      x: w() * (0.2 + Math.random() * 0.6), y: h() * (0.25 + Math.random() * 0.1),
      vx: (Math.random() - 0.5) * 14 * ratio, vy: (-8 - Math.random() * 10) * ratio,
      size: (5 + Math.random() * 6) * ratio, rotation: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length], shape: i % 3,
    }));
    const start = performance.now();
    let frame;
    const tick = (now) => {
      const t = now - start;
      context.clearRect(0, 0, w(), h());
      const fade = Math.max(0, 1 - Math.max(0, t - duration * 0.6) / (duration * 0.4));
      for (const p of parts) {
        p.vy += 0.32 * ratio; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rotation += p.spin;
        context.save();
        context.globalAlpha = fade;
        context.translate(p.x, p.y);
        context.rotate(p.rotation);
        context.fillStyle = p.color;
        if (p.shape === 0) context.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        else if (p.shape === 1) { context.beginPath(); context.arc(0, 0, p.size / 3, 0, Math.PI * 2); context.fill(); }
        else context.fillRect(-p.size / 4, -p.size / 2, p.size / 2, p.size);
        context.restore();
      }
      if (t < duration) frame = requestAnimationFrame(tick);
      else context.clearRect(0, 0, w(), h());
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, [pieces, duration]);
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}
