import { useEffect, useRef, useState } from 'react';
import { DAYS, KINDS, hoursFor, hoursSummary, phoneError } from '../../../lib/onboarding';
import { Field, InlineError, OptionCard, Toggle, useStep } from '../controls';
import ImageUpload from '../ImageUpload';
import OnbIcon from '../OnbIcon';

export function NameStep({ state, actions, setDraft }) {
  const placeholder = state.progress.data?.namePlaceholder;
  const [name, setName] = useState(placeholder ? '' : state.restaurant.name || '');
  const [error, setError] = useState('');
  useEffect(() => { setDraft({ name }); }, [name, setDraft]);
  useStep({
    canContinue: name.trim().length > 0,
    async onContinue() {
      const clean = name.trim().replace(/\s+/g, ' ');
      if (!clean) { setError('Enter your restaurant’s name.'); return false; }
      if (clean.length > 120) { setError('Keep it under 120 characters.'); return false; }
      await actions.patchRestaurant({ name: clean });
    },
  });
  return <Field label="Restaurant name" error={error} hint="This is how guests see you on the menu.">
    {(props) => <input {...props} className="onb-input-xl" value={name} autoComplete="organization" maxLength={120} autoFocus={!name}
      placeholder="e.g. Mama Oliech’s" onChange={(event) => { setName(event.target.value); setError(''); }} />}
  </Field>;
}

export function KindStep({ state, actions, setDraft }) {
  const [kind, setKind] = useState(state.restaurant.kind || '');
  useEffect(() => { setDraft({ kind: kind || null }); }, [kind, setDraft]);
  useStep({ canContinue: Boolean(kind), onContinue: () => actions.patchRestaurant({ kind }) });
  return <div className="onb-options" role="radiogroup" aria-label="Kind of place">
    {KINDS.map((option) => <OptionCard key={option.key} icon={option.icon} label={option.label} hint={option.hint}
      selected={kind === option.key} onSelect={() => setKind(option.key)} />)}
  </div>;
}

function mapUrl(lat, lng) {
  const d = 0.006;
  const bbox = [lng - d * 1.6, lat - d, lng + d * 1.6, lat + d].map((n) => n.toFixed(5)).join(',');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

async function suggestArea(lat, lng, signal) {
  // Best effort: OpenStreetMap's public geocoder, no key. Silently ignored if it fails.
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lng}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) return '';
  const { address = {} } = await response.json();
  const local = address.suburb || address.neighbourhood || address.quarter || address.village || address.town || '';
  const city = address.city || address.town || address.county || '';
  return [local, city].filter((part, index, all) => part && all.indexOf(part) === index).join(', ');
}

export function LocationStep({ state, actions, setDraft }) {
  const r = state.restaurant;
  const [area, setArea] = useState(r.area || '');
  const [address, setAddress] = useState(r.address || '');
  const [coords, setCoords] = useState(r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null);
  const [locating, setLocating] = useState(false);
  const [geoNote, setGeoNote] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  useEffect(() => { setDraft({ area, address }); }, [area, address, setDraft]);
  useEffect(() => () => abortRef.current?.abort(), []);

  useStep({
    canContinue: area.trim().length > 0,
    async onContinue() {
      if (!area.trim()) { setError('Enter your area, like Westlands, Nairobi.'); return false; }
      await actions.patchRestaurant({ area: area.trim(), address: address.trim() || null, lat: coords?.lat ?? null, lng: coords?.lng ?? null });
    },
  });

  function locate() {
    if (!('geolocation' in navigator)) { setGeoNote('Your browser can’t share its location. Type your area instead.'); return; }
    setLocating(true);
    setGeoNote('');
    navigator.geolocation.getCurrentPosition(async (position) => {
      const next = { lat: Number(position.coords.latitude.toFixed(6)), lng: Number(position.coords.longitude.toFixed(6)) };
      setCoords(next);
      setLocating(false);
      setGeoNote('Pinned to where you are now. Guests see this on the map.');
      if (!area.trim()) {
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        try { const suggestion = await suggestArea(next.lat, next.lng, abortRef.current.signal); if (suggestion) { setArea((current) => current.trim() ? current : suggestion); setError(''); } }
        catch { /* the pin is enough */ }
      }
    }, (geoError) => {
      setLocating(false);
      setGeoNote(geoError.code === 1 ? 'Location is blocked for this site. Type your area instead; you can allow it later in your browser settings.'
        : 'We couldn’t find your location. Type your area instead.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  return <div className="onb-stack">
    <Field label="Area" error={error} hint="The neighbourhood and town guests know you by.">
      {(props) => <input {...props} className="onb-input-lg" value={area} maxLength={120} autoComplete="address-level2" placeholder="e.g. Westlands, Nairobi"
        onChange={(event) => { setArea(event.target.value); setError(''); }} />}
    </Field>
    <Field label="Street or building" optional>
      {(props) => <input {...props} value={address} maxLength={240} autoComplete="street-address" placeholder="e.g. Sarit Centre, Karuna Road"
        onChange={(event) => setAddress(event.target.value)} />}
    </Field>
    <div className="onb-map">
      {coords ? <iframe title="Map showing your restaurant’s pin" src={mapUrl(coords.lat, coords.lng)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        : <div className="onb-map-static" aria-hidden="true"><span className="onb-map-grid" /><span className="onb-map-pin"><OnbIcon name="pin" size={26} /></span>
          <span className="onb-map-label">{area.trim() || 'Your restaurant'}</span></div>}
      <div className="onb-map-bar">
        <button type="button" className="onb-secondary" onClick={locate} disabled={locating}><OnbIcon name="locate" size={16} />{locating ? 'Finding you…' : coords ? 'Update my location' : 'Use my location'}</button>
        {coords && <button type="button" className="onb-text-button" onClick={() => { setCoords(null); setGeoNote(''); }}>Remove pin</button>}
      </div>
    </div>
    {geoNote && <p className="onb-note" role="status">{geoNote}</p>}
  </div>;
}

const PRESETS = [
  { key: 'everyday', label: 'Every day', hint: 'Same hours all week', icon: 'calendar' },
  { key: 'weekdays', label: 'Weekdays only', hint: 'Monday to Friday', icon: 'clock' },
  { key: 'custom', label: 'Custom', hint: 'Set each day', icon: 'sliders' },
];

export function HoursStep({ state, actions, setDraft }) {
  const saved = state.restaurant.openingHours;
  const [hours, setHours] = useState(() => saved?.days ? saved : hoursFor('everyday'));
  const [error, setError] = useState('');
  const firstOpen = DAYS.find(([day]) => hours.days[day]?.open)?.[0] || 'mon';
  const { from, to } = hours.days[firstOpen];
  useEffect(() => { setDraft({ openingHours: hours }); }, [hours, setDraft]);

  const openCount = DAYS.filter(([day]) => hours.days[day].open).length;
  useStep({
    canContinue: openCount > 0,
    async onContinue() {
      if (!openCount) { setError('Turn on at least one day.'); return false; }
      if (DAYS.some(([day]) => hours.days[day].open && hours.days[day].from === hours.days[day].to)) { setError('Opening and closing times can’t be the same.'); return false; }
      await actions.patchRestaurant({ openingHours: hours });
    },
  });

  const setRange = (key, value) => setHours((current) => ({ ...current, days: Object.fromEntries(DAYS.map(([day]) => [day, { ...current.days[day], [key]: value }])) }));
  const setDay = (day, patch) => { setError(''); setHours((current) => ({ ...current, days: { ...current.days, [day]: { ...current.days[day], ...patch } } })); };

  return <div className="onb-stack">
    <div className="onb-options is-compact" role="radiogroup" aria-label="Opening pattern">
      {PRESETS.map((preset) => <OptionCard key={preset.key} icon={preset.icon} label={preset.label} hint={preset.hint} selected={hours.preset === preset.key}
        onSelect={() => { setError(''); setHours(preset.key === 'custom' ? { ...hours, preset: 'custom' } : hoursFor(preset.key, from, to)); }} />)}
    </div>
    {hours.preset === 'custom' ? <div className="onb-days" role="group" aria-label="Hours for each day">
      {DAYS.map(([day, label]) => { const entry = hours.days[day]; return <div className={`onb-day${entry.open ? '' : ' is-closed'}`} key={day}>
        <Toggle checked={entry.open} onChange={(open) => setDay(day, { open })} label={`Open on ${label}`} />
        <span className="onb-day-name">{label.slice(0, 3)}</span>
        {entry.open ? <span className="onb-day-times">
          <input type="time" value={entry.from} aria-label={`${label} opens`} onChange={(event) => setDay(day, { from: event.target.value })} />
          <span aria-hidden="true">–</span>
          <input type="time" value={entry.to} aria-label={`${label} closes`} onChange={(event) => setDay(day, { to: event.target.value })} />
        </span> : <span className="onb-day-closed">Closed</span>}
      </div>; })}
    </div> : <div className="onb-time-range">
      <label><span>Opens</span><input type="time" value={from} onChange={(event) => { setError(''); setRange('from', event.target.value); }} /></label>
      <span className="onb-time-dash" aria-hidden="true">–</span>
      <label><span>Closes</span><input type="time" value={to} onChange={(event) => { setError(''); setRange('to', event.target.value); }} /></label>
    </div>}
    <InlineError>{error}</InlineError>
    {!error && openCount > 0 && <p className="onb-note"><OnbIcon name="clock" size={14} />{hoursSummary(hours)}{DAYS.some(([day]) => hours.days[day].open && hours.days[day].to < hours.days[day].from) ? ' · closes after midnight' : ''}</p>}
  </div>;
}

export function LogoStep({ state, actions, setDraft }) {
  const [logoUrl, setLogoUrl] = useState(state.restaurant.logoUrl || null);
  useEffect(() => { setDraft({ logoUrl }); }, [logoUrl, setDraft]);
  useStep({
    canContinue: Boolean(logoUrl) || Boolean(state.restaurant.logoUrl),
    onContinue: () => (logoUrl === (state.restaurant.logoUrl || null) ? undefined : actions.patchRestaurant({ logoUrl })),
  });
  return <div className="onb-stack">
    <ImageUpload restaurantId={state.restaurant.id} kind="logo" variant="logo" value={logoUrl} onChange={setLogoUrl}
      label="Upload your logo" hint="Square works best. JPG, PNG or WebP, up to 5 MB." />
    <p className="onb-note">No logo yet? Skip this and guests see <strong>{state.restaurant.name}</strong> in your colours instead.</p>
  </div>;
}

export function PhoneStep({ state, actions, setDraft }) {
  const [phone, setPhone] = useState(state.restaurant.phone ? formatKenyan(state.restaurant.phone) : '+254 ');
  const [error, setError] = useState('');
  useEffect(() => { setDraft({ phone }); }, [phone, setDraft]);
  const empty = phone.replace(/\s/g, '') === '+254' || !phone.trim();
  useStep({
    canContinue: !empty,
    async onContinue() {
      const problem = phoneError(phone);
      if (problem) { setError(problem); return false; }
      await actions.patchRestaurant({ phone: phone.trim() });
    },
  });
  return <Field label="Phone number" error={error} hint="Guests can call you from the menu. We’ll never share it with anyone else.">
    {(props) => <input {...props} className="onb-input-xl" type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={20}
      onChange={(event) => { setPhone(event.target.value); setError(''); }} />}
  </Field>;
}

function formatKenyan(value) {
  const match = value.match(/^\+254(\d{3})(\d{3})(\d{3})$/);
  return match ? `+254 ${match[1]} ${match[2]} ${match[3]}` : value;
}
