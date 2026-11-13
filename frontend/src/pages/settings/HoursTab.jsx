import { useMemo, useState } from 'react';
import { Segmented } from '../../components/owner/ui';
import { DAYS, hoursFor, hoursSummary } from '../../lib/onboarding';
import { SaveActions, SettingsCard, Switch, useSaver } from './parts';

const PATTERNS = [{ value: 'everyday', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'custom', label: 'Custom' }];

/** Opening hours: pick a pattern, set the times, save. Custom shows one row per day. */
export default function HoursTab({ restaurant, patchRestaurant }) {
  const initial = useMemo(() => (restaurant.openingHours?.days ? restaurant.openingHours : hoursFor('everyday')), [restaurant.openingHours]);
  const [hours, setHours] = useState(initial);
  const [error, setError] = useState('');
  const [saving, run] = useSaver();
  const dirty = JSON.stringify(hours) !== JSON.stringify(initial);
  const firstOpen = DAYS.find(([day]) => hours.days[day]?.open)?.[0] || 'mon';
  const { from, to } = hours.days[firstOpen];
  const openCount = DAYS.filter(([day]) => hours.days[day].open).length;

  const setPattern = (preset) => { setError(''); setHours(preset === 'custom' ? { ...hours, preset: 'custom' } : hoursFor(preset, from, to)); };
  const setRange = (key, value) => { setError(''); setHours((current) => ({ ...current, days: Object.fromEntries(DAYS.map(([day]) => [day, current.days[day].open ? { ...current.days[day], [key]: value } : current.days[day]])) })); };
  const setDay = (day, patch) => { setError(''); setHours((current) => ({ ...current, days: { ...current.days, [day]: { ...current.days[day], ...patch } } })); };

  async function save() {
    if (!openCount) { setError('Turn on at least one day.'); return; }
    if (DAYS.some(([day]) => hours.days[day].open && hours.days[day].from === hours.days[day].to)) { setError('Opening and closing times can’t be the same.'); return; }
    await run(() => patchRestaurant({ openingHours: hours }), 'Opening hours saved');
  }

  return <SettingsCard id="hours" title="Opening hours" description="Guests see these on your menu. Ordering still works whenever staff are on shift."
    footer={<SaveActions dirty={dirty} saving={saving} onSave={save} onReset={() => { setHours(initial); setError(''); }} />}>
    <div className="st-stack">
      <Segmented label="Opening pattern" options={PATTERNS} value={hours.preset || 'custom'} onChange={setPattern} />
      {hours.preset === 'custom' ? <ul className="st-days" aria-label="Hours for each day">
        {DAYS.map(([day, label]) => {
          const entry = hours.days[day];
          return <li key={day} className={`st-day${entry.open ? '' : ' is-closed'}`}>
            <Switch checked={entry.open} onChange={(open) => setDay(day, { open })} label={label} />
            {entry.open ? <span className="st-times">
              <input className="o-input" type="time" value={entry.from} aria-label={`${label} opens`} onChange={(event) => setDay(day, { from: event.target.value })} />
              <span aria-hidden="true">to</span>
              <input className="o-input" type="time" value={entry.to} aria-label={`${label} closes`} onChange={(event) => setDay(day, { to: event.target.value })} />
            </span> : <span className="st-closed">Closed</span>}
          </li>;
        })}
      </ul> : <div className="st-times is-range">
        <label><span className="st-label">Opens</span><input className="o-input" type="time" value={from} onChange={(event) => setRange('from', event.target.value)} /></label>
        <span aria-hidden="true" className="st-times-dash">to</span>
        <label><span className="st-label">Closes</span><input className="o-input" type="time" value={to} onChange={(event) => setRange('to', event.target.value)} /></label>
      </div>}
      {error ? <p className="st-error" role="alert">{error}</p>
        : openCount > 0 && <p className="st-summary">{hoursSummary(hours)}{DAYS.some(([day]) => hours.days[day].open && hours.days[day].to < hours.days[day].from) ? ' · closes after midnight' : ''}</p>}
    </div>
  </SettingsCard>;
}
