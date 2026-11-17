import { useState } from 'react';
import { BrandMark } from '../Brand';
import './loader.css';

/*
 * The guest menu's loading screen, in the restaurant's identity: its cover behind, its logo (or initial) with a
 * slow breath, its name, and a thin progress line in its accent. Without a brand yet (a first visit, before the
 * menu arrives) it's a neutral, quiet version of the same screen, and the brand fades in when it's known.
 * `leaving` fades it out over the menu, which is already rendered underneath. "Powered by Cravio" signs off.
 */

function FadeImg({ src, className }) {
  const [loaded, setLoaded] = useState(false);
  return <img className={`${className}${loaded ? ' is-loaded' : ''}`} src={src} alt="" decoding="async" fetchPriority="high"
    onLoad={() => setLoaded(true)} onError={(event) => { event.currentTarget.style.display = 'none'; }} />;
}

export default function BrandedLoader({ brand, leaving = false }) {
  const style = brand ? {
    '--bl-bg': brand.bg, '--bl-surface': brand.surface, '--bl-ink': brand.ink, '--bl-muted': brand.muted, '--bl-accent': brand.accent,
  } : undefined;
  const initial = brand?.name ? [...brand.name.trim()][0]?.toUpperCase() : '';
  return <div className={`bl${brand ? ' is-branded' : ' is-neutral'}${brand?.coverUrl ? ' has-cover' : ''}${leaving ? ' is-leaving' : ''}`} style={style}
    role="status" aria-live="polite" aria-label={brand?.name ? `Loading ${brand.name}’s menu` : 'Loading the menu'}>
    {brand?.coverUrl && <div className="bl-cover" aria-hidden="true"><FadeImg key={brand.coverUrl} className="bl-cover-img" src={brand.coverUrl} /></div>}
    <div className="bl-center" aria-hidden="true">
      {brand && <div className="bl-brand" key="brand">
        <span className={`bl-mark${brand.logoUrl ? ' has-logo' : ''}`}>
          {brand.logoUrl ? <FadeImg key={brand.logoUrl} className="bl-logo" src={brand.logoUrl} /> : <span className="bl-initial">{initial || '·'}</span>}
        </span>
        {brand.name && <p className="bl-name">{brand.name}</p>}
      </div>}
      <span className="bl-progress"><span /></span>
    </div>
    <p className="bl-foot" aria-hidden="true"><span className="bl-powered" /><BrandMark /></p>
  </div>;
}
