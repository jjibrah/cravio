import { formatStockMoney } from '../../lib/inventory';
// One dish's recipe in the side sheet (P1-16): ingredient lines with the unit people think in, a live "what this means" preview with
// food cost, "keep selling when out", an optional note, Save (always a new version), Stop tracking, a ✨ AI draft (never saved
// by itself), the version history (with a read-only look at an old one) and the dish's extras, each with its own small recipe.
// Read-only (no inputs) when the person may look but not change (operations manager). Writes carry command ids and retry with the same one.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import '../../components/owner/products.css';
import { SaleSwitch } from '../../components/products/shared';
import { api } from '../../lib/api';
import { explain, formatNumber, recipePaths, useInventoryWrite } from '../../lib/inventory';
import LineEditor, { emptyLine, isComplete, lineFromView, lineText, problem, toBody } from './LineEditor';
import { ErrorState, FormError, OIcon, SkeletonRows } from './parts';
import './recipes.css';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const andList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const percent = (value) => `${formatNumber(value)}%`;

/** Errors in plain words. The server's own messages are plain already; these two get better wording here. */
export function plainError(error) {
  if (!error) return '';
  const e = typeof error === 'string' ? { message: error } : error;
  if (e.code === 'duplicate_item') {
    const name = /^(.*?) is in the recipe twice/.exec(e.message || '')?.[1];
    return `${name || 'That item'} is already in this recipe — change its amount instead.`;
  }
  if (e.code === 'ai_not_configured') return 'AI drafting isn’t set up yet. You can add the ingredients yourself.';
  return e.message || 'Something went wrong. Please try again.';
}

function LockIcon() {
  return <svg className="rc-lock" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
}

/** Food cost in words: "Ksh 186 · 31% of the Ksh 600 price", or why it is unknown. */
export function FoodCost({ cost, price, currency }) {
  if (!cost) return null;
  if (cost.cost === null || cost.cost === undefined) {
    return <div className="rc-cost is-unknown"><span>Food cost</span><strong>Unknown</strong>
      <small>{cost.unknown?.length ? `No price yet for ${andList(cost.unknown)}. Cravio learns a price from the cost you enter with its stock.` : 'Add an ingredient to see the cost.'}</small></div>;
  }
  return <div className="rc-cost"><span>Food cost per dish</span><strong>{formatStockMoney(cost.cost, currency)}</strong>
    <small>{cost.costPct !== null && cost.costPct !== undefined ? `${percent(cost.costPct)} of the ${formatStockMoney(price, currency)} price` : `The price is ${formatStockMoney(price, currency)}`}</small></div>;
}

function Sentences({ items }) {
  if (!items?.length) return null;
  return <ul className="rc-sentences" aria-label="What this recipe means">{items.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}</ul>;
}

/** Saved ingredient lines as plain text (read-only views). */
function ReadLines({ lines }) {
  if (!lines?.length) return <p className="o-field-hint">No ingredients.</p>;
  return <ul className="rc-readlines">{lines.map((line) => <li key={line.itemId}><span>{line.name}{line.archived ? ' (archived)' : ''}</span><strong>{lineText(lineFromView(line))}</strong></li>)}</ul>;
}

/* ------------------------------------------------------------------ extras */

function ExtraRecipe({ extra, paths, items, loadingItems, canEdit, canSeeCost, onSaved }) {
  const { notify } = useNotifications();
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [warn, setWarn] = useState('');
  const idBase = useId();
  const start = () => { clearError(); setWarn(''); setLines(extra.lines.length ? extra.lines.map(lineFromView) : [emptyLine()]); setEditing(true); };
  const body = toBody(lines);
  const stopping = extra.tracked && !body.length;

  async function save(event) {
    event.preventDefault();
    const fix = problem(lines);
    if (fix) { setWarn(fix); return; }
    setWarn('');
    const result = await run('PUT', paths.extra(extra.id), { lines: body }, { step: `extra:${extra.id}:${JSON.stringify(body)}` });
    if (result) { onSaved(extra.id, result); setEditing(false); notify(stopping ? `${extra.name} no longer changes stock.` : `${extra.name} saved.`); }
  }

  return <li className="rc-extra">
    <div className="rc-extra-head">
      <div>
        <strong>{extra.name}</strong> <small>+{formatStockMoney(extra.price)}</small>
        {!extra.tracked && <p className="o-field-hint">Adding it doesn’t change stock.</p>}
        <Sentences items={extra.preview} />
        {canSeeCost && extra.tracked && extra.foodCost && <p className="o-field-hint">{extra.foodCost.cost === null
          ? `Cost unknown — no price for ${andList(extra.foodCost.unknown)}`
          : `Cost ${formatStockMoney(extra.foodCost.cost)}${extra.foodCost.costPct !== null ? ` · ${percent(extra.foodCost.costPct)} of the price` : ''}`}</p>}
      </div>
      {canEdit && !editing && <button type="button" className="o-btn is-small" onClick={start} aria-label={`${extra.tracked ? 'Edit' : 'Add'} ingredients for ${extra.name}`}>{extra.tracked ? 'Edit' : 'Add ingredients'}</button>}
    </div>
    {editing && <form className="rc-extra-form" onSubmit={save} noValidate aria-label={`Ingredients for ${extra.name}`}>
      <LineEditor lines={lines} onChange={setLines} items={items} loadingItems={loadingItems} idBase={idBase} />
      <FormError error={warn || plainError(error)} />
      <div className="biz-form-actions">
        <button type="submit" className="o-btn is-primary is-small" disabled={busy}>{busy ? 'Saving…' : stopping ? 'Stop tracking this extra' : 'Save extra'}</button>
        <button type="button" className="o-btn is-quiet is-small" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
      </div>
    </form>}
  </li>;
}

/* ------------------------------------------------------------------ the sheet */

export default function RecipeSheet({ dish, businessId, items, loadingItems, canSeeCost, onSaved, onClose }) {
  const paths = useMemo(() => recipePaths(businessId), [businessId]);
  const { notify } = useNotifications();
  const [state, setState] = useState({ view: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ view: null, error: null });
    api(paths.recipe(dish.id)).then((view) => live && setState({ view, error: null }), (error) => live && setState({ view: null, error }));
    return () => { live = false; };
  }, [paths, dish.id, attempt]);
  if (state.error) return <ErrorState error={state.error} onRetry={() => setAttempt((n) => n + 1)} what="this recipe" />;
  if (!state.view) return <SkeletonRows rows={5} thumb={false} label="Loading recipe" />;
  return <Editor view={state.view} paths={paths} items={items} loadingItems={loadingItems} canSeeCost={canSeeCost && state.view.canSeeCost !== false}
    onSaved={onSaved} onClose={onClose} notify={notify} />;
}

const signature = (lines, allow) => JSON.stringify([toBody(lines), allow]);

function Editor({ view, paths, items, loadingItems, canSeeCost, onSaved, onClose, notify }) {
  const ids = useId();
  const dish = view.dish;
  const canEdit = view.canEdit;
  const startLines = () => (view.lines.length ? view.lines.map(lineFromView) : [emptyLine()]);
  const [lines, setLines] = useState(startLines);
  const [allow, setAllow] = useState(view.allowWhenOut);
  const [note, setNote] = useState('');
  const initial = useRef(signature(lines, allow));
  const dirty = signature(lines, allow) !== initial.current;
  const [run, { busy, error, clearError }] = useInventoryWrite();
  const [warn, setWarn] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [extras, setExtras] = useState(view.extras);

  /* live preview of what is typed (not saved) */
  const [live, setLive] = useState({ preview: null, foodCost: null, error: null, waiting: false });
  const body = toBody(lines);
  const bodyKey = JSON.stringify(body);
  const serial = useRef(0);
  useEffect(() => {
    if (!dirty) { setLive({ preview: null, foodCost: null, error: null, waiting: false }); return undefined; }
    if (!body.length) { setLive({ preview: [], foodCost: null, error: null, waiting: false }); return undefined; }
    const mine = (serial.current += 1);
    setLive((current) => ({ ...current, waiting: true }));
    const timer = setTimeout(() => {
      api(paths.preview(dish.id), { method: 'POST', body: { lines: body } }).then(
        (result) => mine === serial.current && setLive({ preview: result.preview, foodCost: result.foodCost || null, error: null, waiting: false }),
        (failure) => mine === serial.current && setLive({ preview: null, foodCost: null, error: explain(failure), waiting: false }));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey, dirty, dish.id, paths]);

  const sentences = dirty ? live.preview : view.preview;
  const cost = canSeeCost ? (dirty ? (body.length ? live.foodCost : null) : view.foodCost) : null;

  /* AI draft: fills the lines for review, never saves */
  const [ai, setAi] = useState({ busy: false, error: '', notes: [], drafted: false });
  const [confirmAi, setConfirmAi] = useState(false);
  async function draft() {
    setConfirmAi(false);
    setAi({ busy: true, error: '', notes: [], drafted: false });
    try {
      const result = await api(paths.suggest(dish.id), { method: 'POST', body: {} });
      const known = new Map(items.map((item) => [item.id, item]));
      const notes = [];
      const drafted = [];
      for (const line of result.lines || []) {
        if (!line.itemId) { notes.push(`${line.name} (${formatNumber(line.quantity)} ${line.unit}) isn’t one of your items yet. Add it under Items, then add it here.`); continue; }
        const item = known.get(line.itemId);
        const choices = item?.choices || [{ value: line.unit, label: line.unit }];
        const unit = choices.some((c) => c.value === line.unit) ? line.unit : item?.baseUnit || choices[0].value;
        drafted.push({ ...emptyLine(), itemId: line.itemId, name: item?.name || line.name, quantity: String(line.quantity), unit, choices });
        if (line.warning) notes.push(line.warning);
      }
      if (drafted.length) setLines(drafted);
      setAi({ busy: false, error: drafted.length ? '' : 'The AI didn’t suggest anything you can use. Add the ingredients yourself.', notes, drafted: drafted.length > 0 });
    } catch (failure) {
      setAi({ busy: false, error: plainError(explain(failure)), notes: [], drafted: false });
    }
  }

  const needsSave = dirty || view.source !== 'recipe';
  const stoppable = view.tracked;

  async function save(event) {
    event.preventDefault();
    const fix = problem(lines);
    if (fix) { setWarn(fix); return; }
    if (!body.length) { setWarn('Add at least one ingredient, or use “Stop tracking this dish”.'); return; }
    setWarn('');
    const payload = { lines: body, allowWhenOut: allow, note: note.trim() || undefined };
    const result = await run('PUT', paths.recipe(dish.id), payload, { step: `save:${JSON.stringify(payload)}` });
    if (result) { notify(`Saved as version ${result.version?.version ?? ''}`.trim() + '.'); onSaved(); onClose(); }
  }
  async function stop() {
    const result = await run('PUT', paths.recipe(dish.id), { lines: [] }, { step: 'stop' });
    if (result) { notify(`${dish.name} no longer changes stock.`); onSaved(); onClose(); }
  }

  /* history */
  const [old, setOld] = useState({ loading: false, view: null, error: null });
  async function lookAt(version) {
    setOld({ loading: true, view: null, error: null, id: version.id });
    try { setOld({ loading: false, view: await api(paths.version(dish.id, version.id)), error: null, id: version.id }); }
    catch (failure) { setOld({ loading: false, view: null, error: explain(failure), id: version.id }); }
  }
  function useOld() {
    setLines(old.view.lines.map(lineFromView));
    setOld({ loading: false, view: null, error: null });
    setWarn('');
    notify(`Version ${old.view.version.version}’s ingredients are in the form. Check them, then save.`);
  }

  const readOnlyWhy = 'You can look at this recipe, but only the owner or this branch’s manager can change it.';
  const sourceNote = view.source === 'link' && view.link ? `This dish is tied to stock the older way: ${formatNumber(view.link.servings)} of ${view.link.name || 'an item'} per dish. Saving a recipe replaces that.` : '';

  return <div className="inv-form rc-sheet">
    <div className="rc-head">
      <span>{dish.category || 'Dish'} · {formatStockMoney(dish.price, dish.currency)}</span>
      {view.version ? <span className="inv-badge is-ok">Version {view.version.version}</span> : view.source === 'link' ? <span className="inv-badge is-low">Uses old link</span> : <span className="inv-badge is-off">Not tracked</span>}
    </div>
    {!canEdit && <p className="inv-explain rc-readonly" role="note"><OIcon name="info" size={14} /> {readOnlyWhy}</p>}
    {sourceNote && <p className="inv-explain">{sourceNote}</p>}

    {canEdit ? <form onSubmit={save} noValidate>
      <div className="rc-ai">
        <button type="button" className="o-btn is-small" onClick={() => (dirty && body.length ? setConfirmAi(true) : draft())} disabled={ai.busy}>
          <OIcon name="sparkle" size={14} />{ai.busy ? 'Drafting…' : 'Draft with AI'}</button>
        <span className="o-field-hint">Suggests ingredients for you to check. Nothing is saved until you press Save.</span>
      </div>
      {confirmAi && <div className="inv-confirm" role="alertdialog" aria-label="Replace what you typed?">
        <span>Replace the ingredients you’ve entered with an AI draft?</span>
        <div className="biz-form-actions"><button type="button" className="o-btn is-small" onClick={draft}>Replace with draft</button>
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setConfirmAi(false)}>Keep mine</button></div>
      </div>}
      {ai.error && <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{ai.error}</p>}
      {ai.drafted && <p className="inv-explain rc-drafted" role="status"><OIcon name="sparkle" size={13} /> AI draft: check every amount before you save. Nothing is saved yet.</p>}
      {ai.notes.map((text) => <p className="inv-warn" key={text}>{text}</p>)}

      <h3 className="rc-title" id={`${ids}-ingredients`}>Ingredients for one dish</h3>
      <LineEditor lines={lines} onChange={(next) => { setLines(next); setWarn(''); clearError(); }} items={items} loadingItems={loadingItems} idBase={`${ids}-main`} />
      <p className="o-field-hint">Only what’s worth tracking. Salt, spices and garnish can stay out.</p>

      {(sentences?.length > 0 || live.error) && <div className="rc-preview" aria-live="polite">
        <h3 className="rc-title">What this means</h3>
        {live.error ? <p className="o-field-error" role="alert"><OIcon name="alert" size={14} />{plainError(live.error)}</p> : <Sentences items={sentences} />}
      </div>}
      {cost && body.length > 0 && <FoodCost cost={cost} price={dish.price} currency={dish.currency} />}

      <div className="rc-keep">
        <SaleSwitch on={allow} onToggle={() => setAllow(!allow)} label="Keep selling when out" onText="On" offText="Off" />
        <div>
          <strong>Keep selling when out</strong>
          <p className="o-field-hint">{allow ? 'Orders still go through when stock shows zero. You and the owner are told, and the shortfall is logged so someone can count it.'
            : 'When an ingredient hits zero this dish shows as sold out and can’t be ordered.'}</p>
        </div>
      </div>

      <div className="o-field">
        <label className="o-label" htmlFor={`${ids}-note`}>What changed <span className="o-optional">Optional</span></label>
        <input id={`${ids}-note`} className="o-input" maxLength={280} value={note} placeholder="e.g. Bigger portion of chicken" onChange={(event) => setNote(event.target.value)} />
        <p className="o-field-hint">Saving makes a new version. Orders already taken keep the version they were taken with.</p>
      </div>

      <FormError error={warn || plainError(error)} />
      <div className="biz-form-actions">
        <button type="submit" className="o-btn is-primary" disabled={busy || !needsSave}>{busy ? 'Saving…' : 'Save recipe'}</button>
        <button type="button" className="o-btn is-quiet" onClick={onClose} disabled={busy}>Cancel</button>
        {stoppable && <button type="button" className="o-btn is-quiet rc-stop" onClick={() => setConfirmStop(true)} disabled={busy}>Stop tracking this dish</button>}
      </div>
      {!needsSave && <p className="o-field-hint">No changes to save yet.</p>}
      {confirmStop && <div className="inv-confirm" role="alertdialog" aria-label="Stop tracking this dish?">
        <span>Stop tracking {dish.name}? Selling it will no longer change stock, and it can’t show as sold out. Earlier versions are kept.</span>
        <div className="biz-form-actions"><button type="button" className="o-btn is-primary is-small" onClick={stop} disabled={busy}>Yes, stop tracking</button>
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setConfirmStop(false)}>Keep tracking</button></div>
      </div>}
    </form> : <>
      <h3 className="rc-title">Ingredients for one dish</h3>
      <ReadLines lines={view.lines} />
      <Sentences items={view.preview} />
      {canSeeCost && view.lines.length > 0 && <FoodCost cost={view.foodCost} price={dish.price} currency={dish.currency} />}
      <p className="o-field-hint">{view.allowWhenOut ? 'Keeps selling when an ingredient runs out.' : 'Shows as sold out when an ingredient runs out.'}</p>
    </>}

    {extras.length > 0 && <section className="inv-section" aria-labelledby={`${ids}-extras`}>
      <h3 id={`${ids}-extras`}>Extras</h3>
      <p className="o-field-hint">Add-ons like extra cheese take their own ingredients off stock when someone orders them.</p>
      <ul className="rc-extras">{extras.map((extra) => <ExtraRecipe key={extra.id} extra={extra} paths={paths} items={items} loadingItems={loadingItems}
        canEdit={canEdit} canSeeCost={canSeeCost} onSaved={(id, result) => { setExtras((list) => list.map((e) => (e.id === id ? { ...e, tracked: result.tracked, lines: result.lines, preview: result.preview, foodCost: result.foodCost } : e))); onSaved(); }} />)}</ul>
    </section>}

    {view.versions.length > 0 && <section className="inv-section" aria-labelledby={`${ids}-versions`}>
      <h3 id={`${ids}-versions`}>Version history</h3>
      <ul className="rc-versions">{view.versions.map((v) => <li key={v.id}>
        <span className="rc-version-main"><strong>Version {v.version}</strong>{v.current && <span className="inv-badge is-ok">Current</span>}
          {v.used && <span className="rc-used"><LockIcon />Used by orders</span>}
          <small>{day(v.createdAt)}{v.createdBy?.name ? ` · ${v.createdBy.name}` : ''} · {v.lineCount} ingredient{v.lineCount === 1 ? '' : 's'}{v.note ? ` · “${v.note}”` : ''}</small></span>
        <button type="button" className="o-btn is-quiet is-small" onClick={() => lookAt(v)} aria-label={`View version ${v.version}`}>View</button>
      </li>)}</ul>
      {old.loading && <SkeletonRows rows={2} thumb={false} label="Loading version" />}
      {old.error && <FormError error={plainError(old.error)} />}
      {old.view && <div className="rc-old" role="region" aria-label={`Version ${old.view.version.version}`}>
        <h4>Version {old.view.version.version}{old.view.version.current ? ' (current)' : ''}</h4>
        <ReadLines lines={old.view.lines} />
        <Sentences items={old.view.preview} />
        {canSeeCost && old.view.foodCost && <FoodCost cost={old.view.foodCost} price={dish.price} currency={dish.currency} />}
        {old.view.version.used && <p className="o-field-hint"><LockIcon /> Orders were taken with this version, so it can’t change. Saving makes a new one.</p>}
        <div className="biz-form-actions">
          {canEdit && !old.view.version.current && <button type="button" className="o-btn is-small" onClick={useOld}>Start from this version</button>}
          <button type="button" className="o-btn is-quiet is-small" onClick={() => setOld({ loading: false, view: null, error: null })}>Close</button>
        </div>
      </div>}
    </section>}
  </div>;
}
