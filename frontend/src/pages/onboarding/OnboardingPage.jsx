import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { homeFor, useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { LEGACY_STEPS, SECTIONS, STEPS, STEP_KEYS, cheer, currentStepKey, possessive, sectionEnds, stepByKey, stepIndex } from '../../lib/onboarding';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import { Loading } from '../AuthPages';
import AccountPage from '../AccountPage';
import Brand from '../../components/Brand';
import Sheet from '../../components/Sheet';
import { StepContext } from '../../components/onboarding/controls';
import OnbIcon from '../../components/onboarding/OnbIcon';
import PhonePreview from '../../components/onboarding/PhonePreview';
import Finish from '../../components/onboarding/Finish';
import QrPack from '../../components/onboarding/QrPack';
import { HoursStep, KindStep, LocationStep, LogoStep, NameStep, PhoneStep } from '../../components/onboarding/steps/BasicsSteps';
import { SectionsStep, StaffStep, TablesStep } from '../../components/onboarding/steps/FloorStaffSteps';
import { CategoriesStep, ItemsStep, MenuMethodStep } from '../../components/onboarding/steps/MenuSteps';
import { PhotosStep } from '../../components/onboarding/steps/PhotosStep';
import { PreviewStep, ThemeStep } from '../../components/onboarding/steps/LookSteps';
import '../../components/onboarding/onboarding.css';

const STEP_COMPONENTS = {
  name: NameStep, kind: KindStep, location: LocationStep, hours: HoursStep, logo: LogoStep, phone: PhoneStep,
  tables: TablesStep, sections: SectionsStep, staff: StaffStep,
  'menu-method': MenuMethodStep, categories: CategoriesStep, items: ItemsStep, photos: PhotosStep,
  theme: ThemeStep, preview: PreviewStep,
};

function copyFor(key, rawName) {
  const name = rawName?.trim() || 'your restaurant';
  return {
    name: ['What’s your restaurant called?', 'You can change it any time.'],
    kind: [`What kind of place is ${name}?`, 'This helps us set things up the right way.'],
    location: ['Where are you?', 'Guests use this to find you.'],
    hours: ['When are you open?', 'Pick a pattern, then adjust the times.'],
    logo: ['Add your logo', 'It sits at the top of your menu.'],
    phone: ['What number can guests call?', 'Kenyan numbers start with +254.'],
    tables: ['How many tables do you have?', 'Count every table, inside and out.'],
    sections: ['Do you have sections?', 'Pick all that apply.'],
    staff: ['Who takes orders?', 'Add your waiters and managers. We’ll invite them when you go live.'],
    'menu-method': ['How do you want to add your menu?', 'You can mix both later.'],
    categories: [`How is ${possessive(name)} menu organised?`, 'Pick your categories, or add your own.'],
    items: ['Add your dishes', 'A name and a price are enough. Photos come next.'],
    photos: ['Make it look delicious', 'Guests choose with their eyes. Add a cover and a photo for each dish, or do it later.'],
    theme: ['Pick a look', 'Your menu changes as you tap.'],
    preview: ['This is what guests see.', 'Scan any table’s QR code and this opens.'],
  }[key];
}

/** Where to pick up: the saved screen (old keys like 'cover' map to their new home), else the first unanswered one. */
function resumeStep(state) {
  const { currentStep, completedSteps = [], skippedSteps = [] } = state.progress;
  const saved = currentStepKey(currentStep);
  if (STEP_KEYS.includes(saved)) return saved;
  return STEP_KEYS.find((key) => !completedSteps.includes(key) && !skippedSteps.includes(key)) || 'preview';
}

export default function OnboardingPage() {
  const { session, initializing, account, accountLoading, accountError } = useAuth();
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (!account && (accountLoading || !accountError)) return <Loading />;
  if (!account && accountError) return <AccountPage />;
  if (account.role !== 'owner') return <Navigate to={homeFor(account)} replace />;
  return <OnboardingFlow />;
}

function OnboardingFlow() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { retry, account } = useAuth();
  const { notify } = useNotifications();
  const stepKey = pathname.replace(/^\/onboarding\/?/, '').split('/')[0] || '';
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setState(await api('/api/restaurant/onboarding')); }
    catch (error) { setLoadError(error.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const merge = useCallback((patch) => setState((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) })), []);
  const actions = useMemo(() => ({
    async patchRestaurant(fields) { const { restaurant } = await api('/api/restaurant', { method: 'PATCH', body: fields }); merge({ restaurant }); return restaurant; },
    async setTables(count) { const { tables } = await api('/api/restaurant/tables', { method: 'PUT', body: { count } }); merge({ tables }); },
    async setSections(names) { const { sections } = await api('/api/restaurant/sections', { method: 'PUT', body: { names } }); merge({ sections }); },
    async setCategories(names) { const result = await api('/api/restaurant/categories', { method: 'PUT', body: { names } }); merge(result); },
    async addItem(fields) { const { item } = await api('/api/restaurant/items', { method: 'POST', body: fields }); merge((s) => ({ items: [...s.items, item] })); return item; },
    async addItems(list) { const { items } = await api('/api/restaurant/items/bulk', { method: 'POST', body: { items: list } }); merge((s) => ({ items: [...s.items, ...items] })); },
    async updateItem(id, fields) { const { item } = await api(`/api/restaurant/items/${id}`, { method: 'PATCH', body: fields }); merge((s) => ({ items: s.items.map((i) => i.id === id ? item : i) })); },
    async deleteItem(id) { await api(`/api/restaurant/items/${id}`, { method: 'DELETE' }); merge((s) => ({ items: s.items.filter((i) => i.id !== id) })); },
    async addInvite(fields) { const { invite } = await api('/api/restaurant/invites', { method: 'POST', body: fields }); merge((s) => ({ invites: [...s.invites, invite] })); },
    async removeInvite(id) { await api(`/api/restaurant/invites/${id}`, { method: 'DELETE' }); merge((s) => ({ invites: s.invites.filter((i) => i.id !== id) })); },
    async sendInvites() {
      const { invites } = await api('/api/restaurant/invites/send', { method: 'POST' });
      merge((s) => ({ invites: s.invites.map((i) => invites.find((sent) => sent.id === i.id) || i) }));
      return invites;
    },
    async saveProgressData(data) { const { progress } = await api('/api/restaurant/onboarding/progress', { method: 'PUT', body: { data } }); merge({ progress }); },
    goTo(step) { navigate(`/onboarding/${step}`); },
  }), [merge, navigate]);

  if (loadError) return <div className="onb-fallback"><Brand to="/onboarding" label="Cravio" /><h1>We couldn’t open your setup</h1><p>{loadError}</p>
    <button type="button" className="onb-primary" onClick={load}>Try again</button></div>;
  if (!state) return <Loading />;

  const live = state.restaurant.status === 'live';
  if (stepKey === 'done' || stepKey === 'qr') {
    if (!live) return <Navigate to={`/onboarding/${resumeStep(state)}`} replace />;
    const preview = { restaurant: state.restaurant, tables: state.tables, sections: state.sections, categories: state.categories, items: state.items };
    return stepKey === 'qr' ? <QrPack state={state} /> : <Finish state={state} preview={preview} actions={actions} />;
  }
  if (!stepKey) return <Navigate to={live ? '/owner' : `/onboarding/${resumeStep(state)}`} replace />;
  if (LEGACY_STEPS[stepKey]) return <Navigate to={`/onboarding/${LEGACY_STEPS[stepKey]}`} replace />;
  if (!STEP_COMPONENTS[stepKey]) return <Navigate to="/onboarding" replace />;
  return <StepScreen key="flow" stepKey={stepKey} state={state} setState={setState} actions={actions} live={live}
    onLive={() => { retry(); navigate('/onboarding/done'); }} notify={notify} onboardingRequired={account?.onboardingRequired} />;
}

function StepScreen({ stepKey, state, setState, actions, live, onLive, notify, onboardingRequired }) {
  const navigate = useNavigate();
  const index = stepIndex(stepKey);
  const step = stepByKey(stepKey);
  const section = SECTIONS.find((s) => s.key === step.section);
  const sectionSteps = STEPS.filter((s) => s.section === step.section);
  const [title, subtitle] = copyFor(stepKey, state.progress.data?.namePlaceholder ? '' : state.restaurant.name);
  const headingRef = useRef(null);
  const stepRef = useRef(null);
  const previousIndex = useRef(index);
  const [direction, setDirection] = useState('forward');
  const [ui, setUi] = useState({ canContinue: true });
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [stepError, setStepError] = useState('');
  const [missing, setMissing] = useState(null);
  const [cheerNote, setCheerNote] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [draft, setDraftState] = useState({ step: stepKey, values: {} });
  const stepKeyRef = useRef(stepKey);
  stepKeyRef.current = stepKey;

  const setDraft = useCallback((patch) => setDraftState((current) => ({
    step: stepKeyRef.current, values: { ...(current.step === stepKeyRef.current ? current.values : {}), ...patch },
  })), []);
  const context = useMemo(() => ({
    bind(ref) { stepRef.current = ref; return () => { if (stepRef.current === ref) stepRef.current = null; }; },
    setUi,
  }), []);

  // New step: direction, focus on the question, clear transient messages, remember where we are.
  useLayoutEffect(() => {
    setDirection(index >= previousIndex.current ? 'forward' : 'back');
    previousIndex.current = index;
    setStepError(''); setSaveError(null); setMissing(null); setUi({ canContinue: true });
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [index]);
  useEffect(() => {
    if (live || state.progress.currentStep === stepKey) return;
    api('/api/restaurant/onboarding/progress', { method: 'PUT', body: { currentStep: stepKey } })
      .then(({ progress }) => setState((current) => ({ ...current, progress })))
      .catch(() => { /* the next Continue saves it again */ });
  }, [stepKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!cheerNote) return; const timer = setTimeout(() => setCheerNote(null), 3600); return () => clearTimeout(timer); }, [cheerNote]);
  useEffect(() => { if (saveStatus !== 'saved') return; const timer = setTimeout(() => setSaveStatus(''), 2200); return () => clearTimeout(timer); }, [saveStatus]);

  const preview = useMemo(() => {
    const values = draft.step === stepKey ? draft.values : {};
    const restaurant = { ...state.restaurant };
    for (const key of ['name', 'kind', 'area', 'address', 'openingHours', 'logoUrl', 'coverUrl', 'theme']) if (values[key] !== undefined) restaurant[key] = values[key];
    if (state.progress.data?.namePlaceholder && values.name === undefined) restaurant.name = '';
    const tables = values.tableCount !== undefined ? Array.from({ length: Math.min(values.tableCount, 200) }, (_, i) => ({ number: i + 1 })) : state.tables;
    const sections = values.sections ? values.sections.map((name) => ({ id: name, name })) : state.sections;
    const categories = values.categories
      ? values.categories.map((name) => state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase()) || { id: `draft-${name}`, name })
      : state.categories;
    return { restaurant, tables, sections, categories, items: state.items };
  }, [draft, stepKey, state]);

  async function advance(kind) {
    if (saving) return;
    setSaveError(null); setStepError(''); setMissing(null);
    setSaving(true); setSaveStatus('saving');
    try {
      if (kind === 'continue') {
        const result = await stepRef.current?.current?.onContinue?.();
        if (result === false) { setSaveStatus(''); return; }
      }
      if (live) {
        if (kind === 'skip' || STEP_KEYS.includes(stepKey)) {
          await api('/api/restaurant/onboarding/progress', { method: 'PUT', body: kind === 'skip' ? { skip: stepKey } : { complete: stepKey } });
        }
        notify('Saved');
        navigate('/owner');
        return;
      }
      if (stepKey === 'preview') {
        try {
          const result = await api('/api/restaurant/go-live', { method: 'POST' });
          setState(result);
          onLive();
        } catch (error) {
          if (error.status === 400 && error.details?.missing) { setMissing(error.details.missing); setSaveStatus(''); return; }
          throw error;
        }
        return;
      }
      const next = STEP_KEYS[index + 1];
      const { progress } = await api('/api/restaurant/onboarding/progress', {
        method: 'PUT', body: { [kind === 'skip' ? 'skip' : 'complete']: stepKey, currentStep: next },
      });
      setState((current) => ({ ...current, progress }));
      setSaveStatus('saved');
      if (sectionEnds.has(stepKey)) setCheerNote({ step: next, text: cheer(step.section, preview.restaurant.name) });
      navigate(`/onboarding/${next}`);
    } catch (error) {
      setSaveStatus('');
      if (error.status === 400 || error.status === 409 || error.status === 403) setStepError(error.message);
      else setSaveError({ kind, message: error.message || 'Couldn’t save.' });
    } finally { setSaving(false); }
  }

  function goBack() {
    if (live) { navigate('/owner'); return; }
    if (index > 0) navigate(`/onboarding/${STEP_KEYS[index - 1]}`);
  }

  const Step = STEP_COMPONENTS[stepKey];
  const percent = Math.round(((index + 1) / (STEPS.length + 1)) * 100);
  const showSkip = step.skippable && !ui.hideSkip;
  const wide = stepKey === 'preview';

  return <StepContext.Provider value={context}>
    <div className={`onb${wide ? ' is-wide' : ''}`}>
      <a className="skip-link onb-skip-link" href="#onb-question">Skip to question</a>
      <header className="onb-top">
        <div className="onb-top-row">
          <button type="button" className="onb-back" onClick={goBack} disabled={!live && index === 0} aria-label={live ? 'Back to dashboard' : 'Previous question'}>
            <OnbIcon name="back" size={20} /></button>
          <Brand to={live ? '/owner' : `/onboarding/${stepKey}`} label={live ? 'Cravio dashboard' : 'Cravio'} className="onb-brand" />
          <span className={`onb-saved${saveStatus ? ' is-visible' : ''}`} role="status" aria-live="polite">
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? <><OnbIcon name="check" size={14} />Saved</> : ''}</span>
          {live || !onboardingRequired
            ? <Link className="onb-exit" to="/owner">Save &amp; exit</Link>
            : <button type="button" className="onb-exit" onClick={() => setExitOpen(true)}>Save &amp; exit</button>}
        </div>
        <div className="onb-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={STEPS.length}
          aria-valuenow={index + 1} aria-valuetext={`Question ${index + 1} of ${STEPS.length}: ${section.label}`}>
          <span className="onb-progress-fill" style={{ width: `${live ? 100 : percent}%` }} />
        </div>
      </header>

      <div className="onb-body">
        <main className="onb-main" id="onb-question">
          <form className="onb-form" noValidate onSubmit={(event) => { event.preventDefault(); if (ui.canContinue && !ui.hideContinue) advance('continue'); }}>
            <div key={stepKey} className={`onb-question is-${direction}`}>
              {cheerNote?.step === stepKey && <p className="onb-cheer" role="status">{cheerNote.text}</p>}
              <p className="onb-eyebrow">{live ? 'Editing' : section.label} · {sectionSteps.indexOf(step) + 1} of {sectionSteps.length}</p>
              <h1 ref={headingRef} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Enter' && ui.canContinue && !ui.hideContinue) { event.preventDefault(); advance('continue'); } }}>{title}</h1>
              {subtitle && <p className="onb-subtitle">{subtitle}</p>}
              <div className="onb-content">
                <Step state={state} actions={actions} setDraft={setDraft} preview={preview} missing={missing} live={live} />
              </div>
            </div>
            <footer className="onb-footer">
              {stepError && <p className="onb-field-error onb-footer-error" role="alert"><OnbIcon name="alert" size={14} />{stepError}</p>}
              {saveError && <div className="onb-retry" role="alert">
                <span><OnbIcon name="alert" size={16} />Couldn’t save. Your answers are still here.</span>
                <button type="button" className="onb-text-button" onClick={() => advance(saveError.kind)}>Retry</button>
              </div>}
              <div className="onb-footer-row">
                {!wide && <button type="button" className="onb-preview-pill" onClick={() => setPreviewOpen(true)} aria-haspopup="dialog">
                  <OnbIcon name="smartphone" size={16} />Preview</button>}
                {showSkip && <button type="button" className={`onb-skip${ui.hideContinue ? ' is-prominent' : ''}`} onClick={() => advance('skip')} disabled={saving}>
                  {ui.skipLabel || 'Skip for now'}</button>}
                {!ui.hideContinue && <button type="submit" className="onb-primary onb-continue" disabled={saving || !ui.canContinue}>
                  {saving ? (stepKey === 'preview' && !live ? 'Going live…' : 'Saving…') : ui.continueLabel || (live ? 'Save' : 'Continue')}
                  {!saving && <OnbIcon name="arrow" size={18} />}</button>}
              </div>
            </footer>
          </form>
        </main>
        {!wide && <aside className="onb-aside" aria-label="Preview">
          <PhonePreview {...preview} focus={stepKey} />
          <p className="onb-aside-note">Live preview · what guests see when they scan</p>
        </aside>}
      </div>

      <Sheet open={previewOpen} onClose={() => setPreviewOpen(false)} title="Preview" className="onb-preview-sheet">
        <PhonePreview {...preview} focus={stepKey} />
      </Sheet>
      <Sheet open={exitOpen} onClose={() => setExitOpen(false)} title="Your progress is saved">
        <p className="onb-sheet-text">Everything you’ve answered is saved. Next time you sign in, you’ll come back to “{title}”</p>
        <div className="onb-sheet-actions">
          <button type="button" className="onb-primary" onClick={() => setExitOpen(false)}>Keep going</button>
          <button type="button" className="onb-secondary" onClick={async () => { await supabase.auth.signOut(); navigate('/login', { replace: true }); }}>Sign out</button>
        </div>
      </Sheet>
    </div>
  </StepContext.Provider>;
}
