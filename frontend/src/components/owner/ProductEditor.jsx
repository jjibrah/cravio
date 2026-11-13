import { useEffect, useId, useRef, useState } from 'react';
import ImageUpload from '../onboarding/ImageUpload';
import { useNotifications } from '../notifications/NotificationProvider';
import { ExtrasSection, FeaturedSection, PairingsSection } from '../products/EditorSections';
import { SaleSwitch, formatKsh, merchApi, parseMoney } from '../products/shared';
import Drawer from './Drawer';
import { OIcon } from './ui';
import './products.css';

// The dish photo/video editor is built separately; use it when it exists, otherwise fall back to a photo upload.
const mediaModules = import.meta.glob('../media/DishMediaEditor.jsx', { eager: true });
const DishMediaEditor = Object.values(mediaModules)[0]?.default || null;

const SECTIONS = [
  { id: 'details', label: 'Details' },
  { id: 'media', label: 'Photo & video' },
  { id: 'extras', label: 'Extras' },
  { id: 'pairings', label: 'Goes well with' },
  { id: 'featured', label: 'Featured' },
];

/**
 * Add or edit a dish in a right drawer (a bottom sheet on phones), in sections that each save on their own:
 * details, photo and video, extras, "goes well with" and featured. A new dish is created first; the other
 * sections open once it exists. `item` is the live copy from the menu cache (null while adding).
 */
export default function ProductEditor({ open, item, menu, categories, defaultCategoryId, restaurantId, focus, onClose, onCreated, onDeleted }) {
  const creating = !item?.id;
  return <Drawer open={open} onClose={onClose} title={creating ? 'Add product' : 'Edit product'} wide className="pe-drawer">
    {open && <EditorBody key={item?.id || 'new'} item={item} menu={menu} categories={categories} defaultCategoryId={defaultCategoryId}
      restaurantId={restaurantId} focus={focus} onCreated={onCreated} onDeleted={onDeleted} onClose={onClose} />}
  </Drawer>;
}

function EditorBody({ item, menu, categories, defaultCategoryId, restaurantId, focus, onCreated, onDeleted, onClose }) {
  const { notify } = useNotifications();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const body = useRef(null);

  useEffect(() => {
    if (!focus || !item?.id) return;
    requestAnimationFrame(() => body.current?.querySelector(`#pe-${focus}`)?.scrollIntoView({ block: 'start' }));
  }, [focus, item?.id]);

  async function remove() {
    setDeleting(true);
    try {
      await merchApi.removeItem(item.id);
      notify(`${item.name} deleted.`);
      onDeleted(item);
      onClose();
    } catch (problem) { setDeleteError(problem.message); setDeleting(false); }
  }

  const scrollTo = (id) => body.current?.querySelector(`#pe-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return <div className="o-editor pe" ref={body}>
    {item?.id && <nav className="pe-nav" aria-label="Sections">
      {SECTIONS.map((section) => <button key={section.id} type="button" className="pe-nav-link" onClick={() => scrollTo(section.id)}>{section.label}</button>)}
    </nav>}

    <DetailsSection item={item} categories={categories} defaultCategoryId={defaultCategoryId} onCreated={onCreated} />

    <EditorSection id="media" title="Photo & video" hint="A square photo sells best. Add a short video (up to 15 seconds) to bring it to life.">
      {!item?.id ? <p className="o-editor-media-note"><OIcon name="info" size={16} />Add the product first, then its photo or a short video.</p>
        : DishMediaEditor ? <DishMediaEditor restaurantId={restaurantId} item={item} onSaved={() => undefined} />
          : <PhotoFallback restaurantId={restaurantId} item={item} />}
    </EditorSection>

    {item?.id && <>
      <EditorSection id="extras" title="Extras" hint="Paid add-ons guests can choose, like “Cheese Ksh 150”. Use Ksh 0 for free swaps.">
        <ExtrasSection item={item} limit={menu?.limits?.extrasPerDish || 12} />
      </EditorSection>
      <EditorSection id="pairings" title="Goes well with" hint="Suggested on this dish’s page, in this order. Pick up to 6.">
        <PairingsSection item={item} items={menu?.items || []} limit={menu?.limits?.pairingsPerDish || 6} />
      </EditorSection>
      <EditorSection id="featured" title="Featured" hint="Featured dishes show first on your menu.">
        <FeaturedSection item={item} featuredIds={menu?.featuredItemIds || []} items={menu?.items || []} limit={menu?.limits?.featured || 10} />
      </EditorSection>

      <section className="o-editor-danger">
        {!confirmDelete ? <button type="button" className="o-btn is-quiet is-danger" onClick={() => setConfirmDelete(true)}><OIcon name="trash" size={16} />Delete product</button>
          : <div className="o-inline-form is-danger" role="group" aria-labelledby="delete-item-title">
            <p className="o-inline-title" id="delete-item-title">Delete {item.name}?</p>
            <p className="o-inline-help">It disappears from your menu, its pairings and its deals. Past orders keep their record. To hide it for today only, switch off “On sale” instead.</p>
            {deleteError && <p className="o-field-error" role="alert">{deleteError}</p>}
            <div className="o-order-actions">
              <button type="button" className="o-btn is-danger-solid" onClick={remove} disabled={deleting} autoFocus>{deleting ? 'Deleting…' : 'Delete'}</button>
              <button type="button" className="o-btn is-quiet" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </div>
          </div>}
      </section>
    </>}
  </div>;
}

export function EditorSection({ id, title, hint, children, action }) {
  return <section className="pe-section" id={`pe-${id}`} aria-labelledby={`pe-${id}-title`}>
    <header className="pe-section-head">
      <div><h3 id={`pe-${id}-title`}>{title}</h3>{hint && <p>{hint}</p>}</div>
      {action}
    </header>
    {children}
  </section>;
}

function DetailsSection({ item, categories, defaultCategoryId, onCreated }) {
  const { notify } = useNotifications();
  const initial = () => ({
    name: item?.name || '', description: item?.description || '',
    price: item?.price !== undefined && item?.price !== null ? String(item.price) : '',
    categoryId: item?.categoryId || defaultCategoryId || categories[0]?.id || '',
    available: item ? item.available : true,
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const ids = { name: useId(), description: useId(), price: useId(), category: useId() };
  useEffect(() => { if (!saved) return undefined; const timer = setTimeout(() => setSaved(false), 2500); return () => clearTimeout(timer); }, [saved]);
  // Someone toggled "On sale" from the card while the editor is open: follow it.
  useEffect(() => { if (item) setForm((current) => ({ ...current, available: item.available })); }, [item?.available]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = initial();
  const dirty = !item?.id || ['name', 'description', 'price', 'categoryId', 'available'].some((key) => String(form[key]) !== String(base[key]));
  const set = (key) => (event) => { setForm((current) => ({ ...current, [key]: event.target.value })); setErrors((current) => ({ ...current, [key]: '', form: '' })); setSaved(false); };

  function validate() {
    const next = {};
    if (!form.name.trim()) next.name = 'Give the dish a name.';
    const price = parseMoney(form.price);
    if (!Number.isFinite(price) || price < 0) next.price = 'Enter a price in Ksh, like 750.';
    if (!form.categoryId) next.categoryId = 'Choose a category.';
    setErrors(next);
    return Object.keys(next).length ? null : { name: form.name.trim(), description: form.description.trim(), price, categoryId: form.categoryId, available: form.available };
  }

  async function save(event) {
    event.preventDefault();
    const values = validate();
    if (!values) return;
    setBusy(true);
    try {
      const result = item?.id ? await merchApi.updateItem(item.id, values) : await merchApi.addItem(values);
      setSaved(true);
      if (!item?.id) { onCreated(result.item); notify(`${result.item.name} added. Now add a photo.`); }
    } catch (problem) {
      const field = problem.details?.field;
      setErrors(field && ['name', 'price', 'categoryId', 'description'].includes(field) ? { [field]: problem.message } : { form: problem.message });
    } finally { setBusy(false); }
  }

  const price = parseMoney(form.price);
  return <EditorSection id="details" title="Details">
    <form className="o-editor-form" onSubmit={save} noValidate>
      {errors.form && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{errors.form}</span></p>}
      <div className="o-field">
        <label className="o-label" htmlFor={ids.name}>Name</label>
        <input id={ids.name} className="o-input" value={form.name} onChange={set('name')} maxLength={80} placeholder="For example: Chicken wings" data-autofocus
          aria-invalid={errors.name ? 'true' : undefined} aria-describedby={errors.name ? `${ids.name}-e` : undefined} />
        {errors.name && <p className="o-field-error" id={`${ids.name}-e`}>{errors.name}</p>}
      </div>
      <div className="o-field">
        <label className="o-label" htmlFor={ids.description}>Description <span className="o-optional">optional</span></label>
        <textarea id={ids.description} className="o-input" value={form.description} onChange={set('description')} maxLength={240} rows={3} placeholder="What’s in it, in a few words" />
      </div>
      <div className="o-editor-row">
        <div className="o-field">
          <label className="o-label" htmlFor={ids.price}>Price</label>
          <div className="o-price-input"><span aria-hidden="true">Ksh</span>
            <input id={ids.price} className="o-input" inputMode="decimal" value={form.price} onChange={set('price')} placeholder="750"
              aria-invalid={errors.price ? 'true' : undefined} aria-describedby={errors.price ? `${ids.price}-e` : `${ids.price}-h`} /></div>
          {errors.price ? <p className="o-field-error" id={`${ids.price}-e`}>{errors.price}</p>
            : <p className="o-field-hint" id={`${ids.price}-h`}>{Number.isFinite(price) ? `Guests see ${formatKsh(price)}` : 'In Kenyan shillings'}</p>}
        </div>
        <div className="o-field">
          <label className="o-label" htmlFor={ids.category}>Category</label>
          <select id={ids.category} className="o-select" value={form.categoryId} onChange={set('categoryId')} aria-invalid={errors.categoryId ? 'true' : undefined}>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          {errors.categoryId && <p className="o-field-error">{errors.categoryId}</p>}
        </div>
      </div>
      <div className="pe-available">
        <SaleSwitch on={form.available} label="On sale" onToggle={() => { setForm((current) => ({ ...current, available: !current.available })); setSaved(false); }} />
        <span className="o-field-hint">{form.available ? 'Guests can order it.' : 'Hidden from guests until you switch it back on.'}</span>
      </div>
      <div className="o-editor-actions">
        <button type="submit" className="o-btn is-primary" disabled={busy || !dirty}>{busy ? 'Saving…' : item?.id ? 'Save details' : 'Add product'}</button>
        {saved && <span className="o-saved" role="status"><OIcon name="check" size={15} strokeWidth={2.4} />Saved</span>}
      </div>
    </form>
  </EditorSection>;
}

function PhotoFallback({ restaurantId, item }) {
  const [error, setError] = useState('');
  const { notify } = useNotifications();
  async function change(url) {
    setError('');
    try { await merchApi.updateItem(item.id, { photoUrl: url }); notify(url ? 'Photo saved.' : 'Photo removed.'); } catch (problem) { setError(problem.message); }
  }
  return <div className="o-photo-fallback">
    <ImageUpload restaurantId={restaurantId} kind="items" value={item.photoUrl} onChange={change} variant="dish" label={`photo of ${item.name}`} />
    {error && <p className="o-field-error" role="alert">{error}</p>}
  </div>;
}
