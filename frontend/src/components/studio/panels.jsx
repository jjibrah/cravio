import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import ImageUpload from '../onboarding/ImageUpload';
import { menuApi } from '../../lib/ops';
import { guestMenuUrl } from '../../lib/onboarding';
import {
  BODY_FONTS, DISPLAY_FONTS, LIMITS, THEMES, contrast, designColors, isHex, loadAllFonts, normalizeHex, resolveSections, sectionsToSave,
} from '../../lib/menu-design';
import SectionList from './SectionList';
import { StudioIcon } from './StudioIcon';

/* The Studio's editing panels. Each gets the draft design and `update(fn, tag)`; `tag` groups typing into one undo step. */

export function PanelHead({ title, children }) {
  return <header className="st-panel-head"><h2>{title}</h2>{children && <p>{children}</p>}</header>;
}

function Switch({ label, hint, checked, onChange }) {
  const id = useId();
  return <div className="st-switch-row">
    <span className="st-switch-text"><label htmlFor={id}>{label}</label>{hint && <span id={`${id}-h`}>{hint}</span>}</span>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={hint ? `${id}-h` : undefined} className="st-switch" onClick={() => onChange(!checked)}><span /></button>
  </div>;
}

/* ---------- Layout ---------- */
export function LayoutPanel({ studio, onPick, selected }) {
  const { draft, update, menu } = studio;
  const sections = resolveSections(draft.sections, menu.categories);
  const counts = {};
  for (const section of sections) {
    counts[section.key] = section.type === 'featured' ? menu.featuredItemIds.length
      : section.type === 'deals' ? menu.deals.length
        : menu.items.filter((item) => item.categoryId === section.categoryId).length;
  }
  return <>
    <PanelHead title="Layout">Order the sections, pick how each one is laid out, and hide what you don’t need.</PanelHead>
    <SectionList sections={sections} counts={counts} selected={selected} onPick={onPick}
      onChange={(list, tag) => update((current) => ({ ...current, sections: sectionsToSave(list) }), tag)} />
  </>;
}

/* ---------- Type ---------- */
export function TypePanel({ studio }) {
  const { draft, update, restaurant } = studio;
  const [ready, setReady] = useState(false);
  useEffect(() => { let live = true; loadAllFonts().then(() => { if (live) setReady(true); }); return () => { live = false; }; }, []);
  const name = restaurant?.name || 'Your menu';
  return <>
    <PanelHead title="Type">A display font for headings and a body font for dishes. Fonts are served with the menu, nothing to install.</PanelHead>
    <fieldset className="st-group">
      <legend>Headings</legend>
      <div className="st-fonts" role="radiogroup" aria-label="Heading font">
        {DISPLAY_FONTS.map((font) => <button key={font.key} type="button" role="radio" aria-checked={draft.fonts.display === font.key}
          className={`st-font${draft.fonts.display === font.key ? ' is-on' : ''}`} onClick={() => update((d) => ({ ...d, fonts: { ...d.fonts, display: font.key } }))}>
          <span className="st-font-specimen is-display" style={{ fontFamily: font.family, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : 'normal', fontSynthesis: font.italic === 'synthetic' ? 'style' : 'none' }}>Starters</span>
          <span className="st-font-name">{font.label}{draft.fonts.display === font.key && <StudioIcon name="check" size={14} strokeWidth={2.6} />}</span>
        </button>)}
      </div>
    </fieldset>
    <fieldset className="st-group">
      <legend>Body</legend>
      <div className="st-fonts is-body" role="radiogroup" aria-label="Body font">
        {BODY_FONTS.map((font) => <button key={font.key} type="button" role="radio" aria-checked={draft.fonts.body === font.key}
          className={`st-font${draft.fonts.body === font.key ? ' is-on' : ''}`} onClick={() => update((d) => ({ ...d, fonts: { ...d.fonts, body: font.key } }))}>
          <span className="st-font-specimen is-body" style={{ fontFamily: font.family }}><strong>GRILLED CHICKEN</strong> Ksh 1,350<br /><span>Flame-grilled, lemon and herbs, with chips.</span></span>
          <span className="st-font-name">{font.label}{draft.fonts.body === font.key && <StudioIcon name="check" size={14} strokeWidth={2.6} />}</span>
        </button>)}
      </div>
    </fieldset>
    {!ready && <p className="st-note" role="status">Loading font specimens…</p>}
    <p className="st-note">Shown on {name}’s menu exactly as in the preview.</p>
  </>;
}

/* ---------- Colour ---------- */
function ColourField({ label, value, fallback, onChange, onReset }) {
  const id = useId();
  const [text, setText] = useState(value || '');
  useEffect(() => setText(value || ''), [value]);
  const invalid = text !== '' && !isHex(text);
  return <div className="st-colour">
    <label htmlFor={id}>{label}</label>
    <div className="st-colour-row">
      <input type="color" aria-label={`${label}: pick a colour`} value={normalizeHex(value) || fallback} onChange={(event) => onChange(event.target.value, true)} />
      <input id={id} className="st-hex" value={text} placeholder={fallback} spellCheck={false} autoComplete="off" maxLength={7} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-e` : undefined}
        onChange={(event) => { const next = event.target.value.trim(); setText(next); if (isHex(next)) onChange(normalizeHex(next), true); }}
        onBlur={() => { if (!isHex(text)) setText(value || ''); }} />
      <button type="button" className="o-btn is-small is-quiet" onClick={onReset} disabled={!value}>Use theme’s</button>
    </div>
    {invalid && <p id={`${id}-e`} className="st-error">Use a hex colour like #111110.</p>}
  </div>;
}

export function ColourPanel({ studio }) {
  const { draft, update, restaurant } = studio;
  const themeKey = draft.theme || restaurant?.theme || 'classic';
  const colors = designColors({ ...draft, theme: themeKey });
  const actionContrast = contrast(colors.action, colors.bg);
  const labelContrast = contrast(colors.onAction, colors.action);
  const textContrast = contrast(colors.ink, colors.bg);
  const setColor = (key, value) => update((d) => ({ ...d, colors: { ...d.colors, [key]: value } }), `color:${key}`);
  return <>
    <PanelHead title="Colour">Start from a theme, then make it yours with your own accent and background.</PanelHead>
    <fieldset className="st-group">
      <legend>Theme</legend>
      <div className="st-themes" role="radiogroup" aria-label="Theme">
        {THEMES.map((theme) => <button key={theme.key} type="button" role="radio" aria-checked={themeKey === theme.key}
          className={`st-theme${themeKey === theme.key ? ' is-on' : ''}`} onClick={() => update((d) => ({ ...d, theme: theme.key }))}>
          <span className="st-theme-swatch" aria-hidden="true" style={{ background: theme.bg }}>
            <i style={{ background: theme.surface }} /><b style={{ background: theme.action }} /><em style={{ color: theme.ink }}>Aa</em>
          </span>
          <span className="st-theme-name">{theme.label}</span>
          <span className="st-theme-hint">{theme.hint}</span>
        </button>)}
      </div>
    </fieldset>
    <fieldset className="st-group">
      <legend>Your colours</legend>
      <ColourField label="Accent (buttons and highlights)" value={draft.colors.accent} fallback={designColors({ theme: themeKey }).action} onChange={(v) => setColor('accent', v)} onReset={() => setColor('accent', null)} />
      <ColourField label="Background" value={draft.colors.background} fallback={designColors({ theme: themeKey }).bg} onChange={(v) => setColor('background', v)} onReset={() => setColor('background', null)} />
      <div className="st-contrast" aria-live="polite">
        {actionContrast < 3 && <p className="st-warn"><StudioIcon name="alert" size={15} />Buttons are hard to see on this background ({actionContrast.toFixed(1)}:1). Aim for 3:1 or more.</p>}
        {labelContrast < 4.5 && <p className="st-warn"><StudioIcon name="alert" size={15} />Button labels are hard to read on this accent ({labelContrast.toFixed(1)}:1).</p>}
        {textContrast < 4.5 && <p className="st-warn"><StudioIcon name="alert" size={15} />Text is hard to read on this background ({textContrast.toFixed(1)}:1).</p>}
        {actionContrast >= 3 && labelContrast >= 4.5 && textContrast >= 4.5 && <p className="st-ok"><StudioIcon name="check" size={15} />Readable: text {textContrast.toFixed(1)}:1, buttons {actionContrast.toFixed(1)}:1.</p>}
      </div>
    </fieldset>
  </>;
}

/* ---------- Header and cards ---------- */
const CARD_STYLES = [
  { key: 'photo-top', label: 'Photo on top' },
  { key: 'photo-side', label: 'Photo beside' },
  { key: 'text-only', label: 'Text only' },
];
function CardThumb({ style }) {
  const f = { fill: 'currentColor', opacity: 0.22 };
  return <svg viewBox="0 0 48 32" width="48" height="32" aria-hidden="true">
    {style === 'photo-top' && <><rect x="6" y="2" width="16" height="16" rx="2.5" {...f} /><rect x="6" y="21" width="12" height="3" rx="1.5" {...f} /><rect x="6" y="26" width="8" height="3" rx="1.5" {...f} /><rect x="26" y="2" width="16" height="16" rx="2.5" {...f} /><rect x="26" y="21" width="12" height="3" rx="1.5" {...f} /><rect x="26" y="26" width="8" height="3" rx="1.5" {...f} /></>}
    {style === 'photo-side' && <>{[0, 1].map((r) => <g key={r}><rect x="4" y={4 + r * 14} width="22" height="3" rx="1.5" {...f} /><rect x="4" y={9 + r * 14} width="14" height="3" rx="1.5" {...f} /><rect x="32" y={2 + r * 14} width="12" height="12" rx="2.5" {...f} /></g>)}</>}
    {style === 'text-only' && <>{[0, 1, 2].map((r) => <g key={r}><rect x="4" y={4 + r * 9} width="26" height="3" rx="1.5" {...f} /><rect x="36" y={4 + r * 9} width="8" height="3" rx="1.5" {...f} /></g>)}</>}
  </svg>;
}

export function StylePanel({ studio }) {
  const { draft, update, restaurant } = studio;
  const header = (patch) => update((d) => ({ ...d, header: { ...d.header, ...patch } }));
  return <>
    <PanelHead title="Header and cards">What sits at the top, and how each dish is shown.</PanelHead>
    <fieldset className="st-group">
      <legend>Header</legend>
      <Switch label="Logo" hint={restaurant?.logoUrl ? 'Off shows your name as a wordmark.' : 'No logo yet: add one in Brand.'} checked={draft.header.showLogo} onChange={(v) => header({ showLogo: v })} />
      <Switch label="Search and filters" checked={draft.header.showSearch} onChange={(v) => header({ showSearch: v })} />
      <Switch label="Cover photo" hint={restaurant?.coverUrl ? 'Your name and opening hours sit on it.' : 'No cover yet: add one in Brand.'} checked={draft.header.showCover} onChange={(v) => header({ showCover: v })} />
    </fieldset>
    <fieldset className="st-group">
      <legend>Dish cards</legend>
      <div className="st-layouts" role="radiogroup" aria-label="Card style">
        {CARD_STYLES.map((style) => <button key={style.key} type="button" role="radio" aria-checked={draft.cards.style === style.key}
          className={`st-layout${draft.cards.style === style.key ? ' is-on' : ''}`} onClick={() => update((d) => ({ ...d, cards: { ...d.cards, style: style.key } }))}>
          <CardThumb style={style.key} /><span>{style.label}</span>
        </button>)}
      </div>
      <Switch label="Descriptions" hint="Two lines under each dish." checked={draft.cards.showDescription} onChange={(v) => update((d) => ({ ...d, cards: { ...d.cards, showDescription: v } }))} />
    </fieldset>
  </>;
}

/* ---------- Footer ---------- */
export function FooterPanel({ studio }) {
  const { draft, update } = studio;
  const id = useId();
  const tagline = draft.footer.tagline || '';
  return <>
    <PanelHead title="Footer">The band at the end of the menu, with “Order now” and “Find us”.</PanelHead>
    <fieldset className="st-group">
      <legend>Call to action</legend>
      <Switch label="Show the band" hint="Off shows your hours, address and phone instead." checked={draft.footer.showCta} onChange={(v) => update((d) => ({ ...d, footer: { ...d.footer, showCta: v } }))} />
      <div className="st-field">
        <label htmlFor={id}>Tagline</label>
        <textarea id={id} rows={2} maxLength={LIMITS.tagline} value={tagline} placeholder="Karibu! Ask us about today’s specials." aria-describedby={`${id}-n`}
          onChange={(event) => update((d) => ({ ...d, footer: { ...d.footer, tagline: event.target.value || null } }), 'tagline')} />
        <span id={`${id}-n`} className="st-count">{tagline.length}/{LIMITS.tagline}</span>
      </div>
    </fieldset>
  </>;
}

/* ---------- Brand ---------- */
export function BrandPanel({ studio }) {
  const { restaurant, setRestaurant } = studio;
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  async function save(field, url) {
    const previous = restaurant[field];
    setError(''); setSaved('');
    setRestaurant({ [field]: url });
    try { await menuApi.updateRestaurant({ [field]: url }); setSaved(field === 'logoUrl' ? 'Logo saved.' : 'Cover saved.'); }
    catch (problem) { setRestaurant({ [field]: previous }); setError(problem.message); }
  }
  return <>
    <PanelHead title="Brand">Your logo and cover photo. These save straight away and show on the live menu at once.</PanelHead>
    <div className="st-group st-brand">
      <ImageUpload restaurantId={restaurant.id} kind="logo" variant="logo" label="Logo" hint="Square or wide, on a plain background." value={restaurant.logoUrl} onChange={(url) => save('logoUrl', url)} />
      <ImageUpload restaurantId={restaurant.id} kind="cover" variant="cover" label="Cover photo" hint="A wide photo of your place or food. Up to 5 MB." value={restaurant.coverUrl} onChange={(url) => save('coverUrl', url)} />
      {error && <p className="st-error" role="alert">{error}</p>}
      <p className="st-note" role="status">{saved}</p>
    </div>
    <fieldset className="st-group">
      <legend>Details guests see</legend>
      <ul className="st-details">
        {[['Name', restaurant.name, 'name'], ['Area', restaurant.area, 'location'], ['Phone', restaurant.phone, 'phone']].map(([label, value, step]) => <li key={label}>
          <span>{label}</span><strong className={value ? undefined : 'is-empty'}>{value || 'Not added yet'}</strong>
          <Link className="o-btn is-small" to={`/onboarding/${step}`} aria-label={`Edit ${label.toLowerCase()}`}>Edit</Link>
        </li>)}
      </ul>
    </fieldset>
  </>;
}

/* ---------- Publish ---------- */
export function PublishPanel({ studio }) {
  const { restaurant, menu, dirty, publishedAt } = studio;
  const link = guestMenuUrl(restaurant.id);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState('');
  const live = restaurant.status === 'live';
  useEffect(() => {
    let alive = true;
    import('qrcode').then(({ default: QRCode }) => QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111110', light: '#ffffff' } }))
      .then((svg) => { if (alive) setQr(svg); }).catch(() => {});
    return () => { alive = false; };
  }, [link]);
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return <>
    <PanelHead title="Publish">Guests see your menu at this link and on your table QR codes.</PanelHead>
    <div className="st-group">
      <p className={`st-live${live ? ' is-live' : ''}`}><span aria-hidden="true" />{live ? <><strong>Live</strong> · {menu.items.length} dish{menu.items.length === 1 ? '' : 'es'} showing</> : <><strong>Not live yet</strong> · finish setup to open it to guests</>}</p>
      <p className="st-note">{dirty ? 'You have unpublished changes. Guests still see the last published design.' : publishedAt ? 'Published. Guests see it on their next visit.' : 'Guests see exactly what’s in the preview.'}</p>
    </div>
    <div className="st-group">
      <div className="st-link"><span title={link}>{link.replace(/^https?:\/\//, '')}</span>
        <button type="button" className="o-btn is-small" onClick={copy}><StudioIcon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy'}</button></div>
      <span className="visually-hidden" role="status">{copied ? 'Link copied' : ''}</span>
      <div className="st-qr" role="img" aria-label="QR code for your guest menu" dangerouslySetInnerHTML={{ __html: qr }} />
      <div className="st-actions">
        <a className="o-btn" href={link} target="_blank" rel="noopener noreferrer"><StudioIcon name="external" size={15} />Open guest menu</a>
        <Link className="o-btn" to="/onboarding/qr"><StudioIcon name="printer" size={15} />Print table QR codes</Link>
      </div>
    </div>
  </>;
}
