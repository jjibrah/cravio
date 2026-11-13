import { useId, useMemo, useRef, useState } from 'react';
import { IMAGE_ACCEPT, imageFileError, uploadMedia } from '../media/media';
import { useNotifications } from '../notifications/NotificationProvider';
import Drawer from '../owner/Drawer';
import { EditorSection } from '../owner/ProductEditor';
import { OIcon } from '../owner/ui';
import { DealPhotos } from './DealsView';
import { Thumb } from './EditorSections';
import { SaleSwitch, formatKsh, merchApi, parseMoney } from './shared';

/*
 * Create or edit a deal: name and description, the dishes (search, quantities), the deal price with the
 * live regular price and saving, an optional photo (uploaded under deals/, or composed from the dishes),
 * active and dates. One Save for the whole deal.
 */
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' });
const toDay = (iso, end = false) => (iso ? isoDay.format(new Date(Date.parse(iso) - (end ? 1 : 0))) : '');

export default function DealEditor({ open, deal, items, restaurantId, onClose }) {
  const creating = !deal?.id;
  return <Drawer open={open} onClose={onClose} title={creating ? 'New deal' : 'Edit deal'} wide className="pe-drawer">
    {open && <Body key={deal?.id || 'new'} deal={deal} items={items} restaurantId={restaurantId} onClose={onClose} />}
  </Drawer>;
}

function Body({ deal, items, restaurantId, onClose }) {
  const { notify } = useNotifications();
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const [form, setForm] = useState(() => ({
    name: deal?.name || '', description: deal?.description || '', price: deal ? String(deal.price) : '',
    active: deal ? deal.active : true, startsAt: toDay(deal?.startsAt), endsAt: toDay(deal?.endsAt, true), photoUrl: deal?.photoUrl || null,
    lines: (deal?.items || []).map((line) => ({ itemId: line.itemId, quantity: line.quantity, name: line.name })),
  }));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [upload, setUpload] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef(null);
  const ids = { name: useId(), description: useId(), price: useId(), search: useId(), start: useId(), end: useId() };

  const set = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '', form: '' })); };
  const lines = form.lines.map((line) => ({ ...line, item: byId.get(line.itemId) }));
  const regular = lines.reduce((sum, line) => sum + (line.item ? Number(line.item.price) * line.quantity : 0), 0);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const price = parseMoney(form.price);
  const saving = Number.isFinite(price) ? regular - price : null;
  const q = query.trim().toLowerCase();
  const candidates = q ? items.filter((item) => !form.lines.some((line) => line.itemId === item.id) && item.name.toLowerCase().includes(q)).slice(0, 8) : [];
  const preview = { items: lines.map((line) => ({ itemId: line.itemId, name: line.item?.name || line.name, photoUrl: line.item?.photoUrl, available: line.item?.available })), photoUrl: form.photoUrl };

  const setLines = (update) => { setForm((current) => ({ ...current, lines: update(current.lines) })); setErrors((current) => ({ ...current, items: '', form: '' })); };
  const addLine = (item) => { setLines((current) => [...current, { itemId: item.id, quantity: 1, name: item.name }]); setQuery(''); };
  const setQuantity = (itemId, quantity) => setLines((current) => current.map((line) => (line.itemId === itemId ? { ...line, quantity: Math.max(1, Math.min(20, quantity)) } : line)));

  async function choosePhoto(file) {
    if (!file) return;
    const problem = imageFileError(file);
    if (problem) { setErrors((current) => ({ ...current, photo: problem })); return; }
    setUpload(0); setErrors((current) => ({ ...current, photo: '' }));
    try {
      const url = await uploadMedia(restaurantId, 'deals', file, { onProgress: (fraction) => setUpload(fraction) });
      set('photoUrl', url);
    } catch (problem) { setErrors((current) => ({ ...current, photo: problem.message || 'Couldn’t upload that photo. Try again.' })); }
    finally { setUpload(null); if (fileRef.current) fileRef.current.value = ''; }
  }

  function validate() {
    const next = {};
    if (!form.name.trim()) next.name = 'Give the deal a name, like Burger meal.';
    if (!form.lines.length) next.items = 'Add the dishes in this deal.';
    else if (units < 2) next.items = 'A deal needs at least 2 dishes (or one dish with quantity 2).';
    if (!Number.isFinite(price) || price < 0) next.price = 'Enter the deal price in Ksh.';
    if (form.startsAt && form.endsAt && form.endsAt < form.startsAt) next.endsAt = 'The deal must end after it starts.';
    setErrors(next);
    return !Object.keys(next).length;
  }

  async function save(event) {
    event.preventDefault();
    if (!validate()) return;
    setBusy(true);
    const body = {
      name: form.name.trim(), description: form.description.trim(), price, active: form.active,
      items: form.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
      startsAt: form.startsAt || null, endsAt: form.endsAt || null, photoUrl: form.photoUrl || null,
    };
    try {
      if (deal?.id) await merchApi.updateDeal(deal.id, body); else await merchApi.addDeal(body);
      notify(deal?.id ? `${body.name} saved.` : `${body.name} added.`);
      onClose();
    } catch (problem) {
      const field = problem.details?.field;
      setErrors(field && ['name', 'price', 'items', 'endsAt', 'startsAt', 'description', 'photoUrl'].includes(field) ? { [field === 'photoUrl' ? 'photo' : field]: problem.message } : { form: problem.message });
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try { await merchApi.removeDeal(deal.id); notify(`${deal.name} deleted.`); onClose(); }
    catch (problem) { setErrors({ form: problem.message }); setBusy(false); }
  }

  return <form className="o-editor pe de" onSubmit={save} noValidate>
    {errors.form && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{errors.form}</span></p>}
    {deal?.issues?.length > 0 && <p className="o-note is-warning"><OIcon name="alert" size={16} /><span>Hidden from guests: {deal.issues.map((issue) => issue.message).join(' ')}</span></p>}

    <EditorSection id="deal-details" title="Details">
      <div className="o-field">
        <label className="o-label" htmlFor={ids.name}>Name</label>
        <input id={ids.name} className="o-input" value={form.name} maxLength={60} onChange={(event) => set('name', event.target.value)} placeholder="For example: Burger meal" data-autofocus
          aria-invalid={errors.name ? 'true' : undefined} />
        {errors.name && <p className="o-field-error">{errors.name}</p>}
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={ids.description}>Description <span className="o-optional">optional</span></label>
        <textarea id={ids.description} className="o-input" rows={2} maxLength={200} value={form.description} onChange={(event) => set('description', event.target.value)} placeholder="Classic beef burger, chips and a Stoney." />
      </div>
    </EditorSection>

    <EditorSection id="deal-items" title="Dishes in this deal" hint="Search your menu and set how many of each.">
      {lines.length > 0 && <ul className="pp-list de-lines">
        {lines.map((line) => <li key={line.itemId} className="pp-row">
          <Thumb item={line.item || { name: line.name }} />
          <span className="pp-name">{line.item?.name || line.name}<small>{line.item ? `${formatKsh(line.item.price)} each${line.item.available ? '' : ' · Sold out'}` : 'No longer on your menu'}</small></span>
          <span className="de-qty" role="group" aria-label={`Quantity of ${line.item?.name || line.name}`}>
            <button type="button" className="o-icon-btn" onClick={() => setQuantity(line.itemId, line.quantity - 1)} disabled={line.quantity <= 1} aria-label="One fewer"><OIcon name="minus" size={14} /></button>
            <span aria-live="polite">{line.quantity}</span>
            <button type="button" className="o-icon-btn" onClick={() => setQuantity(line.itemId, line.quantity + 1)} disabled={line.quantity >= 20} aria-label="One more"><OIcon name="plus" size={14} /></button>
          </span>
          <button type="button" className="o-icon-btn" onClick={() => setLines((current) => current.filter((entry) => entry.itemId !== line.itemId))} aria-label={`Remove ${line.item?.name || line.name}`}><OIcon name="close" size={15} /></button>
        </li>)}
      </ul>}
      {form.lines.length < 10 && <div className="pp-picker">
        <div className="o-search pp-search">
          <OIcon name="search" size={16} />
          <label className="visually-hidden" htmlFor={ids.search}>Add a dish to the deal</label>
          <input id={ids.search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add a dish: search your menu" autoComplete="off" />
        </div>
        {q && <ul className="pp-options" aria-label="Matching dishes">
          {candidates.map((item) => <li key={item.id}><button type="button" className="pp-option" onClick={() => addLine(item)} aria-label={`Add ${item.name}`}>
            <Thumb item={item} /><span className="pp-name">{item.name}<small>{formatKsh(item.price)}</small></span><OIcon name="plus" size={15} />
          </button></li>)}
          {!candidates.length && <li className="pp-none">No dishes match “{query}”.</li>}
        </ul>}
      </div>}
      {errors.items && <p className="o-field-error" role="alert">{errors.items}</p>}
    </EditorSection>

    <EditorSection id="deal-price" title="Price">
      <div className="de-price">
        <div className="o-field">
          <label className="o-label" htmlFor={ids.price}>Deal price</label>
          <div className="o-price-input"><span aria-hidden="true">Ksh</span>
            <input id={ids.price} className="o-input" inputMode="decimal" value={form.price} onChange={(event) => set('price', event.target.value)} placeholder="1150" aria-invalid={errors.price ? 'true' : undefined} /></div>
          {errors.price && <p className="o-field-error">{errors.price}</p>}
        </div>
        <dl className="de-sum" aria-live="polite">
          <div><dt>Bought separately</dt><dd>{formatKsh(regular)}</dd></div>
          <div className={saving !== null && saving <= 0 && lines.length ? 'is-warn' : saving > 0 ? 'is-good' : ''}><dt>Guests save</dt>
            <dd>{saving === null || !lines.length ? '—' : saving > 0 ? `${formatKsh(saving)} (${Math.round((saving / regular) * 100)}%)` : formatKsh(0)}</dd></div>
        </dl>
      </div>
      {saving !== null && saving <= 0 && lines.length > 0 && <p className="o-note is-warning"><OIcon name="alert" size={16} />
        <span>{saving < 0 ? `This deal costs ${formatKsh(-saving)} more than buying the dishes separately.` : 'This deal costs the same as buying the dishes separately.'} Guests are more likely to choose a deal that saves them something.</span></p>}
    </EditorSection>

    <EditorSection id="deal-photo" title="Photo" hint="Optional. Without one, guests see the dishes’ photos together.">
      <div className="de-photo">
        <DealPhotos deal={preview} />
        <div className="de-photo-actions">
          <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="visually-hidden" id="deal-photo-input" onChange={(event) => choosePhoto(event.target.files?.[0])} />
          <label htmlFor="deal-photo-input" className="o-btn is-secondary is-small">{form.photoUrl ? 'Replace photo' : 'Upload a photo'}</label>
          {form.photoUrl && <button type="button" className="o-btn is-quiet is-small" onClick={() => set('photoUrl', null)}>Use the dishes’ photos</button>}
          {upload !== null && <span className="o-field-hint" role="status">Uploading… {Math.round((upload || 0) * 100)}%</span>}
          <span className="o-field-hint">JPG, PNG or WebP up to 5 MB.</span>
          {errors.photo && <p className="o-field-error" role="alert">{errors.photo}</p>}
        </div>
      </div>
    </EditorSection>

    <EditorSection id="deal-when" title="When guests see it">
      <div className="pe-available">
        <SaleSwitch on={form.active} label="Active" onText="Active" offText="Off" onToggle={() => set('active', !form.active)} />
        <span className="o-field-hint">{form.active ? 'Shown on your menu (within the dates below).' : 'Hidden from guests.'}</span>
      </div>
      <div className="o-editor-row">
        <div className="o-field">
          <label className="o-label" htmlFor={ids.start}>Starts <span className="o-optional">optional</span></label>
          <input id={ids.start} type="date" className="o-input" value={form.startsAt} onChange={(event) => set('startsAt', event.target.value)} />
        </div>
        <div className="o-field">
          <label className="o-label" htmlFor={ids.end}>Ends <span className="o-optional">optional, through that day</span></label>
          <input id={ids.end} type="date" className="o-input" value={form.endsAt} min={form.startsAt || undefined} onChange={(event) => set('endsAt', event.target.value)} aria-invalid={errors.endsAt ? 'true' : undefined} />
          {errors.endsAt && <p className="o-field-error">{errors.endsAt}</p>}
        </div>
      </div>
    </EditorSection>

    <div className="o-editor-actions de-actions">
      <button type="submit" className="o-btn is-primary is-large" disabled={busy || upload !== null}>{busy ? 'Saving…' : deal?.id ? 'Save deal' : 'Add deal'}</button>
      <button type="button" className="o-btn is-quiet" onClick={onClose}>Cancel</button>
    </div>

    {deal?.id && <section className="o-editor-danger">
      {!confirmDelete ? <button type="button" className="o-btn is-quiet is-danger" onClick={() => setConfirmDelete(true)}><OIcon name="trash" size={16} />Delete deal</button>
        : <div className="o-inline-form is-danger" role="group" aria-label={`Delete ${deal.name}?`}>
          <p className="o-inline-title">Delete {deal.name}?</p>
          <p className="o-inline-help">Guests won’t see it any more. Past orders keep their record. To pause it, switch it off instead.</p>
          <div className="o-order-actions">
            <button type="button" className="o-btn is-danger-solid" onClick={remove} disabled={busy}>Delete</button>
            <button type="button" className="o-btn is-quiet" onClick={() => setConfirmDelete(false)}>Keep it</button>
          </div>
        </div>}
    </section>}
  </form>;
}
