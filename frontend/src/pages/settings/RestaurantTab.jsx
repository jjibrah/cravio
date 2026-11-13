import { useMemo, useState } from 'react';
import ImageUpload from '../../components/onboarding/ImageUpload';
import { KINDS, phoneError } from '../../lib/onboarding';
import { Field, SaveActions, SettingsCard, useSaver } from './parts';

const formatKenyan = (value) => {
  const match = String(value || '').match(/^\+254(\d{3})(\d{3})(\d{3})$/);
  return match ? `+254 ${match[1]} ${match[2]} ${match[3]}` : value || '';
};

const fromRestaurant = (r) => ({
  name: r.name || '', kind: r.kind || '', phone: formatKenyan(r.phone), area: r.area || '', address: r.address || '',
});

/** Name, kind, contact and location, then logo and cover photo (which save as soon as they upload). */
export default function RestaurantTab({ restaurant, patchRestaurant }) {
  const initial = useMemo(() => fromRestaurant(restaurant), [restaurant]);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [saving, run] = useSaver();
  const [imageSaving, runImage] = useSaver();
  const dirty = Object.keys(initial).some((key) => form[key].trim() !== initial[key].trim());

  const set = (key) => (event) => { setForm({ ...form, [key]: event.target.value }); setErrors({ ...errors, [key]: '' }); };

  async function save() {
    const next = {};
    if (!form.name.trim()) next.name = 'Enter your restaurant’s name.';
    if (!form.area.trim()) next.area = 'Enter your area, like Westlands, Nairobi.';
    const phone = form.phone.trim();
    if (phone && phone.replace(/\s/g, '') !== '+254' && phoneError(phone)) next.phone = phoneError(phone);
    setErrors(next);
    if (Object.keys(next).length) return;
    const body = {};
    if (form.name.trim() !== initial.name) body.name = form.name.trim().replace(/\s+/g, ' ');
    if (form.kind !== initial.kind && form.kind) body.kind = form.kind;
    if (form.area.trim() !== initial.area) body.area = form.area.trim();
    if (form.address.trim() !== initial.address) body.address = form.address.trim() || null;
    if (phone !== initial.phone.trim()) body.phone = phone && phone.replace(/\s/g, '') !== '+254' ? phone : null;
    if (!Object.keys(body).length) { setForm(initial); return; }
    await run(() => patchRestaurant(body), 'Restaurant details saved');
  }

  const saveImage = (key, label) => (url) => runImage(() => patchRestaurant({ [key]: url }), url ? `${label} updated` : `${label} removed`);

  return <>
    <SettingsCard id="details" title="Restaurant details" description="How guests and your team see your restaurant."
      footer={<SaveActions dirty={dirty} saving={saving} onSave={save} onReset={() => { setForm(initial); setErrors({}); }} />}>
      <form className="st-grid" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Field label="Restaurant name" error={errors.name} hint="Shown at the top of your guest menu.">
          {(props) => <input {...props} className="o-input" value={form.name} onChange={set('name')} maxLength={120} autoComplete="organization" />}
        </Field>
        <Field label="Kind of place">
          {(props) => <select {...props} className="o-select" value={form.kind} onChange={set('kind')}>
            {!form.kind && <option value="">Choose one</option>}
            {KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
          </select>}
        </Field>
        <Field label="Phone number" optional error={errors.phone} hint="Guests can call you from the menu.">
          {(props) => <input {...props} className="o-input" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} placeholder="+254 712 345 678" maxLength={20} />}
        </Field>
        <Field label="Area" error={errors.area} hint="The neighbourhood and town guests know you by.">
          {(props) => <input {...props} className="o-input" value={form.area} onChange={set('area')} maxLength={120} placeholder="e.g. Westlands, Nairobi" />}
        </Field>
        <Field label="Street or building" optional className="is-wide">
          {(props) => <input {...props} className="o-input" value={form.address} onChange={set('address')} maxLength={240} placeholder="e.g. Sarit Centre, Karuna Road" />}
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </SettingsCard>

    <SettingsCard id="photos" title="Logo and cover photo" description="These save as soon as they finish uploading. JPG, PNG or WebP, up to 5 MB.">
      <div className="st-images" aria-busy={imageSaving || undefined}>
        <div className="st-image-slot">
          <p className="st-label">Logo</p>
          <ImageUpload restaurantId={restaurant.id} kind="logo" variant="logo" value={restaurant.logoUrl || null}
            onChange={saveImage('logoUrl', 'Logo')} label="Upload your logo" hint="Square works best" disabled={imageSaving} />
        </div>
        <div className="st-image-slot is-cover">
          <p className="st-label">Cover photo</p>
          <ImageUpload restaurantId={restaurant.id} kind="cover" variant="cover" value={restaurant.coverUrl || null}
            onChange={saveImage('coverUrl', 'Cover photo')} label="Upload a cover photo" hint="The first thing guests see when they scan" disabled={imageSaving} />
        </div>
      </div>
    </SettingsCard>
  </>;
}
