import { useEffect, useId, useState } from 'react';
import { useNotifications } from '../notifications/NotificationProvider';
import Drawer from '../owner/Drawer';
import { OIcon } from '../owner/ui';
import { merchApi, pluralize } from './shared';

/** Manage categories in a drawer: rename, reorder (whole list via PUT /categories/order) and delete. */
export default function ManageCategories({ open, onClose, categories, items, onChange, onAdd }) {
  return <Drawer open={open} onClose={onClose} title="Manage categories">
    {open && <Body categories={categories} items={items} onChange={onChange} onAdd={onAdd} />}
  </Drawer>;
}

function Body({ categories, items, onChange, onAdd }) {
  const { notify } = useNotifications();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function move(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= categories.length) return;
    const next = [...categories];
    [next[index], next[target]] = [next[target], next[index]];
    const before = categories;
    onChange((current) => ({ ...current, categories: next.map((category, position) => ({ ...category, position })) }));
    setError('');
    setBusy(true);
    try {
      await merchApi.orderCategories(next.map((category) => category.id));
      requestAnimationFrame(() => document.querySelector(`[data-cat-move="${categories[index].id}:${direction}"]`)?.focus());
    } catch (problem) {
      onChange((current) => ({ ...current, categories: before }));
      setError(problem.message);
    } finally { setBusy(false); }
  }

  return <div className="mc">
    <p className="mc-intro">Guests see categories in this order. Renaming keeps the dishes; deleting a category deletes its dishes.</p>
    {error && <p className="o-note is-error" role="alert"><OIcon name="alert" size={16} /><span>{error}</span></p>}
    <ol className="mc-list">
      {categories.map((category, index) => <CategoryRow key={category.id} category={category} index={index} last={index === categories.length - 1} busy={busy}
        count={items.filter((item) => item.categoryId === category.id).length}
        onMove={(direction) => move(index, direction)}
        onRenamed={(updated) => onChange((current) => ({ ...current, categories: current.categories.map((entry) => (entry.id === updated.id ? { ...entry, name: updated.name } : entry)) }))}
        onDeleted={() => { onChange((current) => ({ ...current, categories: current.categories.filter((entry) => entry.id !== category.id), items: current.items.filter((item) => item.categoryId !== category.id) })); notify(`${category.name} deleted.`); }} />)}
    </ol>
    <button type="button" className="o-btn is-secondary" onClick={onAdd}><OIcon name="plus" size={16} />Add a category</button>
  </div>;
}

function CategoryRow({ category, index, last, busy, count, onMove, onRenamed, onDeleted }) {
  const [name, setName] = useState(category.name);
  const [state, setState] = useState(''); // '' | saving | saved | confirm | deleting
  const [error, setError] = useState('');
  const inputId = useId();
  useEffect(() => { setName(category.name); }, [category.name]);
  useEffect(() => { if (state !== 'saved') return undefined; const timer = setTimeout(() => setState(''), 2000); return () => clearTimeout(timer); }, [state]);
  const dirty = name.trim() !== category.name;

  async function rename(event) {
    event?.preventDefault();
    if (!dirty) return;
    if (!name.trim()) { setError('Give the category a name.'); return; }
    setState('saving'); setError('');
    try {
      const { category: updated } = await merchApi.updateCategory(category.id, { name: name.trim() });
      onRenamed(updated);
      setState('saved');
    } catch (problem) { setError(problem.message); setState(''); }
  }
  async function remove() {
    setState('deleting'); setError('');
    try { await merchApi.removeCategory(category.id); onDeleted(); } catch (problem) { setError(problem.message); setState('confirm'); }
  }

  return <li className="mc-row">
    <form className="mc-main" onSubmit={rename} noValidate>
      <span className="mc-pos" aria-hidden="true">{index + 1}</span>
      <label className="visually-hidden" htmlFor={inputId}>Name of category {index + 1}</label>
      <input id={inputId} className="o-input" value={name} maxLength={40} onChange={(event) => { setName(event.target.value); setError(''); }}
        onKeyDown={(event) => { if (event.key === 'Escape' && dirty) { event.stopPropagation(); setName(category.name); } }} />
      {dirty ? <button type="submit" className="o-btn is-primary is-small" disabled={state === 'saving'}>{state === 'saving' ? 'Saving…' : 'Save'}</button>
        : <span className="mc-count">{pluralize(count, 'dish', 'dishes')}</span>}
      <span className="mc-tools">
        <button type="button" className="o-icon-btn" onClick={() => onMove(-1)} disabled={index === 0 || busy} data-cat-move={`${category.id}:-1`} aria-label={`Move ${category.name} up`}><OIcon name="arrowUp" size={16} /></button>
        <button type="button" className="o-icon-btn" onClick={() => onMove(1)} disabled={last || busy} data-cat-move={`${category.id}:1`} aria-label={`Move ${category.name} down`}><OIcon name="arrowDown" size={16} /></button>
        <button type="button" className="o-icon-btn mc-delete" onClick={() => setState('confirm')} aria-label={`Delete ${category.name}`}><OIcon name="trash" size={16} /></button>
      </span>
    </form>
    {state === 'saved' && <span className="o-saved mc-saved" role="status"><OIcon name="check" size={14} strokeWidth={2.4} />Saved</span>}
    {error && <p className="o-field-error" role="alert">{error}</p>}
    {(state === 'confirm' || state === 'deleting') && <div className="o-inline-form is-danger mc-confirm" role="group" aria-label={`Delete ${category.name}?`}>
      <p className="o-inline-title">Delete {category.name}?</p>
      <p className="o-inline-help">{count ? `Its ${pluralize(count, 'dish', 'dishes')} will be deleted too. Past orders keep their record. This can’t be undone.` : 'It has no dishes. This can’t be undone.'}</p>
      <div className="o-order-actions">
        <button type="button" className="o-btn is-danger-solid is-small" onClick={remove} disabled={state === 'deleting'}>{state === 'deleting' ? 'Deleting…' : count ? `Delete with ${pluralize(count, 'dish', 'dishes')}` : 'Delete category'}</button>
        <button type="button" className="o-btn is-quiet is-small" onClick={() => setState('')}>Keep it</button>
      </div>
    </div>}
  </li>;
}
