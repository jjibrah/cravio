import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_SUGGESTIONS, TEMPLATE, TEMPLATE_CATEGORIES, formatPrice } from '../../../lib/onboarding';
import { AddOwn, Chip, Field, InlineError, OptionCard, useStep } from '../controls';
import ImageUpload from '../ImageUpload';
import OnbIcon from '../OnbIcon';
import { MEDIA_LIMITS } from '../../media/media';

const VIDEO_NONE = { videoUrl: null, videoPosterUrl: null, videoDurationSeconds: null };
const videoBody = (fields) => (fields ? { videoUrl: fields.videoUrl, videoDurationSeconds: fields.videoDurationSeconds, ...(fields.videoPosterUrl ? { videoPosterUrl: fields.videoPosterUrl } : {}) } : { videoUrl: null });

export function MenuMethodStep({ state, actions }) {
  const [method, setMethod] = useState(state.progress.data?.menuMethod || '');
  useStep({ canContinue: Boolean(method), onContinue: () => actions.saveProgressData({ menuMethod: method }) });
  return <div className="onb-options is-large" role="radiogroup" aria-label="How to add your menu">
    <OptionCard icon="list" label="Add items one by one" hint="Type in your dishes and prices. Best if your menu is unique."
      selected={method === 'manual'} onSelect={() => setMethod('manual')} />
    <OptionCard icon="sparkles" label="Start from a template" hint="Tap common Kenyan dishes and drinks, then set your own prices."
      selected={method === 'template'} onSelect={() => setMethod('template')} />
  </div>;
}

export function CategoriesStep({ state, actions, setDraft }) {
  const template = state.progress.data?.menuMethod === 'template';
  const existing = state.categories.map((category) => category.name);
  const [names, setNames] = useState(() => existing.length ? existing : template ? TEMPLATE_CATEGORIES : ['Mains', 'Drinks']);
  const options = [...new Set([...CATEGORY_SUGGESTIONS, ...names])];
  useEffect(() => { setDraft({ categories: names }); }, [names, setDraft]);
  const removed = state.categories.filter((category) => !names.some((name) => name.toLowerCase() === category.name.toLowerCase()));
  const losing = removed.map((category) => ({ category, count: state.items.filter((item) => item.categoryId === category.id).length })).filter((entry) => entry.count);
  useStep({
    canContinue: names.length > 0,
    onContinue: () => (names.join('|') === existing.join('|') ? undefined : actions.setCategories(names)),
  });
  const toggle = (name) => setNames((current) => current.includes(name) ? current.filter((n) => n !== name) : [...current, name]);
  return <div className="onb-stack">
    <div className="onb-chips" role="group" aria-label="Categories">
      {options.map((name) => <Chip key={name} selected={names.includes(name)} onToggle={() => toggle(name)}
        count={state.items.filter((item) => state.categories.find((c) => c.id === item.categoryId)?.name === name).length}>{name}</Chip>)}
    </div>
    <AddOwn placeholder="Add your own, e.g. Grill" label="Add a category" onAdd={(name) => {
      if (names.some((n) => n.toLowerCase() === name.toLowerCase()) || names.length >= 20) return;
      setNames((current) => [...current, name]);
    }} />
    {losing.length > 0 && <p className="onb-warning" role="status"><OnbIcon name="alert" size={14} />
      Removing {losing.map(({ category, count }) => `${category.name} also removes its ${count} item${count === 1 ? '' : 's'}`).join('; ')}.</p>}
    {!losing.length && <p className="onb-note">You can rename and reorder categories later from Products.</p>}
  </div>;
}

function priceValue(input) {
  const number = Number(String(input).replace(/[,\s]/g, ''));
  return input !== '' && Number.isFinite(number) && number >= 0 ? number : null;
}

/** Template dishes for one category: tap to include, confirm each price, then add. */
function Suggestions({ category, state, actions }) {
  const taken = new Set(state.items.map((item) => item.name.toLowerCase()));
  const dishes = TEMPLATE.filter((dish) => dish.category.toLowerCase() === category.name.toLowerCase() && !taken.has(dish.name.toLowerCase()));
  const [picked, setPicked] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!dishes.length) return null;
  const chosen = dishes.filter((dish) => picked[dish.name] !== undefined);
  async function addChosen() {
    const bad = chosen.find((dish) => priceValue(picked[dish.name]) === null);
    if (bad) { setError(`Enter a price for ${bad.name}.`); return; }
    setBusy(true); setError('');
    try {
      await actions.addItems(chosen.map((dish) => ({ categoryId: category.id, name: dish.name, price: priceValue(picked[dish.name]), source: 'template' })));
      setPicked({});
    } catch (addError) { setError(addError.message); } finally { setBusy(false); }
  }
  return <section className="onb-suggestions" aria-label={`Suggested ${category.name.toLowerCase()}`}>
    <header><h2>Suggestions</h2><p>Tap to include. Prices are suggestions: set your own before adding.</p></header>
    <ul>
      {dishes.map((dish) => { const on = picked[dish.name] !== undefined; return <li key={dish.name} className={`onb-suggestion${on ? ' is-selected' : ''}`}>
        <button type="button" role="checkbox" aria-checked={on} className="onb-suggestion-toggle" onClick={() => setPicked((current) => {
          const next = { ...current };
          if (on) delete next[dish.name]; else next[dish.name] = String(dish.price);
          return next;
        })}>
          <span className="onb-suggestion-check" aria-hidden="true"><OnbIcon name="check" size={13} /></span>
          <span className="onb-suggestion-name">{dish.name}</span>
          {!on && <span className="onb-suggestion-price">~{formatPrice(dish.price)}</span>}
        </button>
        {on && <label className="onb-price-input"><span className="visually-hidden">Your price for {dish.name}</span><span aria-hidden="true">Ksh</span>
          <input inputMode="decimal" value={picked[dish.name]} onChange={(event) => { setPicked({ ...picked, [dish.name]: event.target.value }); setError(''); }} /></label>}
      </li>; })}
    </ul>
    <InlineError>{error}</InlineError>
    {chosen.length > 0 && <button type="button" className="onb-secondary" onClick={addChosen} disabled={busy}><OnbIcon name="plus" size={16} />
      {busy ? 'Adding…' : `Add ${chosen.length} dish${chosen.length === 1 ? '' : 'es'} at these prices`}</button>}
  </section>;
}

export function ItemsStep({ state, actions }) {
  const template = state.progress.data?.menuMethod === 'template';
  const savedActive = state.progress.data?.activeCategoryId;
  const [activeId, setActiveId] = useState(() => state.categories.some((c) => c.id === savedActive) ? savedActive : state.categories[0]?.id);
  const active = state.categories.find((category) => category.id === activeId) || state.categories[0];
  const [form, setForm] = useState({ name: '', price: '', photoUrl: null, ...VIDEO_NONE });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [rowError, setRowError] = useState('');
  const nameRef = useRef(null);
  const items = useMemo(() => state.items.filter((item) => item.categoryId === active?.id), [state.items, active]);
  const filled = Boolean(form.name.trim() || form.price.trim());

  async function save() {
    const next = {};
    if (!form.name.trim()) next.name = 'Enter the dish name.';
    if (priceValue(form.price) === null) next.price = form.price.trim() ? 'Enter a number, like 450.' : 'Enter a price.';
    setErrors(next);
    if (Object.keys(next).length) return false;
    setBusy(true);
    try {
      const item = await actions.addItem({ categoryId: active.id, name: form.name.trim(), price: priceValue(form.price), photoUrl: form.photoUrl, ...(form.videoUrl ? videoBody(form) : {}) });
      setForm({ name: '', price: '', photoUrl: null, ...VIDEO_NONE });
      setFlash(`${item.name} added`);
      nameRef.current?.focus();
      return true;
    } catch (error) {
      if (error.status === 400) { setErrors({ name: error.message }); return false; }
      throw error;
    } finally { setBusy(false); }
  }

  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(''), 2400); return () => clearTimeout(timer); }, [flash]);

  useStep({
    canContinue: state.items.length > 0 || filled,
    async onContinue() {
      if (filled && (await save()) === false) return false;
      if (active && active.id !== savedActive) await actions.saveProgressData({ activeCategoryId: active.id });
    },
  });

  if (!active) return <p className="onb-note">Add a category first. <button type="button" className="onb-text-button" onClick={() => actions.goTo('categories')}>Choose categories</button></p>;
  const set = (key) => (event) => { setForm({ ...form, [key]: event.target.value }); setErrors({ ...errors, [key]: '' }); };

  return <div className="onb-stack">
    <div className="onb-tabs" role="tablist" aria-label="Categories">
      {state.categories.map((category) => { const count = state.items.filter((item) => item.categoryId === category.id).length; return <button type="button" role="tab" key={category.id}
        aria-selected={category.id === active.id} className={`onb-tab${category.id === active.id ? ' is-active' : ''}`} onClick={() => { setActiveId(category.id); setErrors({}); }}>
        {category.name}{count > 0 && <span className="onb-tab-count">{count}</span>}
      </button>; })}
    </div>

    {template && <Suggestions key={active.id} category={active} state={state} actions={actions} />}

    <div className="onb-card onb-item-card" role="group" aria-label={`Add an item to ${active.name}`}
      onKeyDown={(event) => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); event.stopPropagation(); save().catch((error) => setErrors({ name: error.message })); } }}>
      <div className="onb-item-card-head"><h2>{items.length ? `Add another to ${active.name}` : `Add your first ${active.name.toLowerCase()} item`}</h2>
        {flash && <span className="onb-flash" role="status"><OnbIcon name="check" size={14} />{flash}</span>}</div>
      <div className="onb-item-row">
        <ImageUpload restaurantId={state.restaurant.id} kind="items" variant="thumb" value={form.photoUrl} label="a photo or video" onChange={(photoUrl) => setForm((current) => ({ ...current, photoUrl }))}
          video={form} onVideoChange={(fields) => setForm((current) => ({ ...current, ...(fields || VIDEO_NONE) }))} />
        <Field label="Dish name" error={errors.name} className="is-grow">{(props) => <input {...props} ref={nameRef} value={form.name} onChange={set('name')} maxLength={80} autoComplete="off" placeholder="e.g. Beef stew" />}</Field>
        <Field label="Price" error={errors.price} className="is-price">{(props) => <span className="onb-money"><span aria-hidden="true">Ksh</span>
          <input {...props} inputMode="decimal" value={form.price} onChange={set('price')} autoComplete="off" placeholder="450" /></span>}</Field>
      </div>
      <p className="onb-media-hint">{MEDIA_LIMITS}. Tap the camera to add one.</p>
      <button type="button" className="onb-secondary onb-add-button" onClick={() => save().catch((error) => setErrors({ name: error.message }))} disabled={busy}>
        <OnbIcon name="plus" size={16} />{busy ? 'Saving…' : items.length ? 'Add another' : 'Add item'}</button>
    </div>

    {items.length > 0 && <ul className="onb-menu-list" aria-label={`${active.name} items`}>
      {items.map((item) => <li key={item.id}>
        <ImageUpload restaurantId={state.restaurant.id} kind="items" variant="thumb" value={item.photoUrl} label={`a photo or video of ${item.name}`}
          onChange={(photoUrl) => actions.updateItem(item.id, { photoUrl }).catch((error) => setRowError(error.message))}
          video={item} onVideoChange={(fields) => actions.updateItem(item.id, videoBody(fields)).catch((error) => setRowError(error.message))} />
        <span className="onb-menu-name"><strong>{item.name}</strong>{item.source === 'template' && <span className="onb-tag">From template</span>}</span>
        <span className="onb-menu-price">{formatPrice(item.price, item.currency)}</span>
        <button type="button" className="icon-button onb-remove" aria-label={`Remove ${item.name}`} onClick={() => actions.deleteItem(item.id).catch((error) => setRowError(error.message))}><OnbIcon name="trash" size={16} /></button>
      </li>)}
    </ul>}
    <InlineError>{rowError}</InlineError>
    {state.items.length === 0 && <p className="onb-note">Add at least one item to continue. You can add the rest later.</p>}
  </div>;
}
