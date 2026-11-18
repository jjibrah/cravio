// Recipes (P1-16): every dish of one branch with what it can still make and what it costs, and the recipe sheet to change it.
// One list for both sides: the owner at /owner/inventory/recipes (a branch picker at the top, remembered) and a branch manager
// at /branch/:id/recipes (their own branch). The data: GET recipes (list) and the recipe sheet's own calls; see RecipeSheet.jsx.
import { useEffect, useId, useMemo, useState } from 'react';
import { useApi } from '../../lib/api';
import { formatPrice } from '../../lib/format';
import { branchPaths, recipePaths } from '../../lib/inventory';
import { pickItemsFromBranch, pickItemsFromOwner } from './LineEditor';
import RecipeSheet from './RecipeSheet';
import { EmptyState, ErrorState, OIcon, Panel, SkeletonRows, TaskDrawer } from './parts';
import './recipes.css';

const andList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

const STATUS = {
  recipe: { label: 'Tracked', tone: 'is-ok' },
  link: { label: 'Uses old link', tone: 'is-low' },
  none: { label: 'Not tracked', tone: 'is-off' },
};

/** "12 left — Chicken runs out first", "None left — Chicken has run out", or nothing for a dish that isn’t tracked. */
export function portionsText(dish) {
  if (!dish.tracked || dish.portions === null || dish.portions === undefined) return '';
  const name = dish.limitingItem?.name;
  if (dish.portions <= 0) return `None left${name ? ` — ${name} has run out` : ''}${dish.allowWhenOut && !dish.soldOut ? '. Still selling' : ''}`;
  return `${dish.portions} left${name ? ` — ${name} runs out first` : ''}`;
}

/** "Ksh 186 · 31% of the price", "Cost unknown — no price for Cheese", or '' when the person can’t see costs. */
export function costText(dish) {
  const cost = dish.foodCost;
  if (!dish.tracked || !cost) return '';
  if (cost.cost === null || cost.cost === undefined) return cost.unknown?.length ? `Cost unknown — no price for ${andList(cost.unknown)}` : 'Cost unknown';
  return `${formatPrice(cost.cost)}${cost.costPct !== null && cost.costPct !== undefined ? ` · ${Number(cost.costPct)}% of the price` : ''}`;
}

function DishRow({ dish, canEdit, canSeeCost, onOpen }) {
  const status = STATUS[dish.source] || STATUS.none;
  const portions = portionsText(dish);
  const cost = canSeeCost ? costText(dish) : '';
  return <li className="biz-person rc-row">
    <span className="biz-person-main">
      <strong>
        <button type="button" className="inv-link" onClick={() => onOpen(dish)}>{dish.name}</button>
        <span className={`inv-badge ${status.tone}`}>{status.label}</span>
        {dish.soldOut && <span className="inv-badge is-out">Sold out</span>}
      </strong>
      <span>{formatPrice(dish.price)}{dish.version ? ` · Version ${dish.version}` : ''}{dish.allowWhenOut && dish.tracked ? ' · Keeps selling when out' : ''}</span>
      {portions && <span className="rc-portions">{portions}</span>}
      {cost && <span className={dish.foodCost?.cost === null ? 'rc-warn' : undefined}>{cost}</span>}
      {!dish.tracked && <span>Selling it doesn’t change stock.</span>}
    </span>
    <span className="biz-person-actions">
      <button type="button" className="o-btn is-small" onClick={() => onOpen(dish)} aria-label={`${canEdit ? (dish.tracked ? 'Edit recipe for' : 'Add recipe for') : 'View recipe for'} ${dish.name}`}>
        {canEdit ? (dish.tracked ? 'Edit recipe' : 'Add recipe') : 'View recipe'}</button>
    </span>
  </li>;
}

/** The list for one branch. `ownerCtx` (from OwnerFrame) on the owner side; absent on the branch side. */
export function RecipesPanel({ ownerCtx = null, branchId = null, title = 'Dishes' }) {
  const ids = useId();
  const businessId = ownerCtx?.business.id || null;
  const paths = useMemo(() => recipePaths(businessId), [businessId]);
  const list = useApi(ownerCtx && !branchId ? null : paths.list(branchId), { ttl: 15000 });
  const [search, setSearch] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => { setSearch(''); setUntracked(false); setOpen(null); }, [branchId]);

  // The items an ingredient can be picked from. The branch side loads them only when a recipe is opened.
  const snapshot = useApi(!ownerCtx && open ? branchPaths.snapshot({ all: true }) : null, { ttl: 15000 });
  const items = useMemo(() => (ownerCtx ? pickItemsFromOwner(ownerCtx.data.items, ownerCtx.data.units) : pickItemsFromBranch(snapshot.data?.items)), [ownerCtx, snapshot.data]);

  const data = list.data;
  const term = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = [];
    for (const dish of data?.dishes || []) {
      if (untracked && dish.tracked) continue;
      if (term && !dish.name.toLowerCase().includes(term)) continue;
      const name = dish.category || 'Other';
      let group = out.find((g) => g.name === name);
      if (!group) { group = { name, dishes: [] }; out.push(group); }
      group.dishes.push(dish);
    }
    return out;
  }, [data, untracked, term]);

  if (list.error && !data) return <ErrorState error={list.error} onRetry={list.refresh} what="recipes" />;
  if (!data) return <Panel title={title}><SkeletonRows rows={6} thumb={false} label="Loading recipes" /></Panel>;
  const { summary, canEdit, canSeeCost } = data;
  const shown = groups.reduce((sum, g) => sum + g.dishes.length, 0);

  return <>
    <Panel title={title} count={summary.dishes}
      sub={summary.dishes ? `${summary.tracked} of ${summary.dishes} dishes have a recipe. Dishes without one don’t change stock.` : undefined}>
      {!summary.dishes ? <EmptyState icon="utensils" tone="neutral" title="No dishes on this menu yet">
        Add dishes under Products first. Then come back and say what goes into each one.</EmptyState> : <>
        <div className="inv-toolbar">
          <label className="visually-hidden" htmlFor={`${ids}-q`}>Search dishes</label>
          <input id={`${ids}-q`} className="o-input inv-search" type="search" placeholder="Search dishes" value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="inv-check"><input type="checkbox" checked={untracked} onChange={(event) => setUntracked(event.target.checked)} />Not tracked yet{summary.untracked ? ` (${summary.untracked})` : ''}</label>
          {summary.soldOut > 0 && <span className="inv-badge is-out">{summary.soldOut} sold out</span>}
        </div>
        {!shown ? <EmptyState icon="search" tone="neutral" title={untracked && !term ? 'Every dish has a recipe' : 'No dishes match'}
          action={<button type="button" className="o-btn is-secondary" onClick={() => { setSearch(''); setUntracked(false); }}>Clear filters</button>}>
          {untracked && !term ? 'Nice. Nothing is left to set up.' : 'Try a different name.'}</EmptyState>
          : groups.map((group) => <section key={group.name} className="rc-group" aria-labelledby={`${ids}-${group.name}`}>
            <h3 id={`${ids}-${group.name}`} className="rc-group-title">{group.name}</h3>
            <ul className="biz-people">{group.dishes.map((dish) => <DishRow key={dish.id} dish={dish} canEdit={canEdit} canSeeCost={canSeeCost} onOpen={setOpen} />)}</ul>
          </section>)}
      </>}
    </Panel>
    <TaskDrawer open={Boolean(open)} title={open ? `${open.name}: ${canEdit ? 'recipe' : 'recipe (view only)'}` : 'Recipe'} onClose={() => setOpen(null)} wide>
      {open && <RecipeSheet key={open.id} dish={open} businessId={businessId} items={items} loadingItems={!ownerCtx && snapshot.loading && !snapshot.data}
        canSeeCost={canSeeCost} onSaved={list.refresh} onClose={() => setOpen(null)} />}
    </TaskDrawer>
  </>;
}

const BRANCH_KEY = 'cravio-recipes-branch:';
const remembered = (businessId) => { try { return sessionStorage.getItem(BRANCH_KEY + businessId); } catch { return null; } };
const remember = (businessId, id) => { try { sessionStorage.setItem(BRANCH_KEY + businessId, id); } catch { /* storage blocked */ } };

/** The branches an owner can pick from, and which one is shown: the remembered one if it still exists, else the first. */
export const ownerBranches = (ctx) => ctx.data.locations.filter((place) => place.restaurantId).map((place) => ({ id: place.restaurantId, name: place.name }));
export const effectiveBranch = (ctx, chosen) => {
  const branches = ownerBranches(ctx);
  return (branches.find((b) => b.id === chosen) || branches.find((b) => b.id === remembered(ctx.business.id)) || branches[0])?.id || null;
};

/** The branch picker for the page header (only when there is more than one branch). */
export function BranchPicker({ ctx, value, onChange }) {
  const id = useId();
  const branches = ownerBranches(ctx);
  if (branches.length < 2) return null;
  return <>
    <label className="visually-hidden" htmlFor={id}>Branch</label>
    <select id={id} className="o-select" value={value || ''} onChange={(event) => { remember(ctx.business.id, event.target.value); onChange(event.target.value); }}>
      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  </>;
}

export function NoBranches() {
  return <EmptyState icon="store" tone="neutral" title="No branches yet">Add a branch under Locations. Then you can set up its recipes.</EmptyState>;
}
