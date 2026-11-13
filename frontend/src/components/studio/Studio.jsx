import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../dashboard/PageFrame';
import MenuExperience from '../menu/MenuExperience';
import { ErrorState, SkeletonRows } from '../owner/ui';
import { BrandPanel, ColourPanel, FooterPanel, LayoutPanel, PublishPanel, StylePanel, TypePanel } from './panels';
import { StudioIcon } from './StudioIcon';
import useStudio from './useStudio';
import './studio.css';

const TABS = [
  { key: 'layout', label: 'Layout', icon: 'layout', Panel: LayoutPanel },
  { key: 'type', label: 'Type', icon: 'type', Panel: TypePanel },
  { key: 'colour', label: 'Colour', icon: 'palette', Panel: ColourPanel },
  { key: 'style', label: 'Header & cards', short: 'Cards', icon: 'cards', Panel: StylePanel },
  { key: 'footer', label: 'Footer', icon: 'footer', Panel: FooterPanel },
  { key: 'brand', label: 'Brand', icon: 'brand', Panel: BrandPanel },
  { key: 'publish', label: 'Publish', icon: 'publish', Panel: PublishPanel },
];
const DEVICES = { phone: { width: 390, height: 844, label: 'Phone' }, tablet: { width: 820, height: 1100, label: 'Tablet' } };
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const typing = (element) => element?.isContentEditable || (element?.tagName === 'TEXTAREA') || (element?.tagName === 'INPUT' && !['checkbox', 'radio', 'color', 'range', 'button'].includes(element.type));

/** The device mock-up: the real guest menu at real size, scaled to fit the canvas. */
function PreviewCanvas({ studio, device, focus }) {
  const stageRef = useRef(null);
  const [scale, setScale] = useState(1);
  const size = DEVICES[device];
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const fit = () => {
      const pad = 40;
      const s = Math.min(1, (stage.clientWidth - pad) / (size.width + 24), (stage.clientHeight - pad) / (size.height + 24));
      setScale(Math.max(0.3, s));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [size.width, size.height]);
  return <div ref={stageRef} className="st-stage">
    <div className="st-device-box" style={{ width: (size.width + 24) * scale, height: (size.height + 24) * scale }}>
      <figure className={`st-device is-${device}`} style={{ width: size.width + 24, height: size.height + 24, transform: `scale(${scale})` }} aria-label={`${size.label} preview of your guest menu`}>
        <div className="st-screen phone-screen" data-theme={studio.resolved.theme}>
          <MenuExperience variant="preview" data={studio.preview} restaurantId={studio.restaurant.id} tableNumber={1} focusSection={focus} />
        </div>
      </figure>
    </div>
  </div>;
}

function LeaveDialog({ open, onStay, onLeave }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="st-confirm" aria-labelledby="st-leave-t" aria-describedby="st-leave-d" onCancel={(event) => { event.preventDefault(); onStay(); }}>
    <h2 id="st-leave-t">Leave without publishing?</h2>
    <p id="st-leave-d">Guests won’t see your changes until you publish. Your draft stays on this device, so you can pick it up later.</p>
    <div className="st-confirm-actions">
      <button type="button" className="o-btn" onClick={onLeave}>Leave</button>
      <button type="button" className="o-btn is-primary" onClick={onStay} autoFocus>Keep editing</button>
    </div>
  </dialog>;
}

export default function Studio({ section }) {
  const studio = useStudio();
  const navigate = useNavigate();
  const [tab, setTab] = useState('layout');
  const [device, setDevice] = useState('phone');
  const [mode, setMode] = useState('edit'); // small screens: edit or preview
  const [focus, setFocus] = useState(null);
  const [selected, setSelected] = useState(null);
  const [leaveTo, setLeaveTo] = useState(null);
  const [flash, setFlash] = useState('');
  const { dirty, undo, redo, canUndo, canRedo } = studio;

  // ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo (text fields keep their own undo).
  useEffect(() => {
    const onKey = (event) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod || typing(document.activeElement)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Warn before leaving with unpublished changes: closing the tab, and links inside the app.
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (event) => { event.preventDefault(); event.returnValue = ''; };
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.origin !== window.location.origin || anchor.closest('.st-screen')) return;
      if (anchor.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(`${anchor.pathname}${anchor.search}${anchor.hash}`);
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => { window.removeEventListener('beforeunload', onUnload); document.removeEventListener('click', onClick, true); };
  }, [dirty]);

  const pick = useCallback((key) => { setSelected(key); setFocus({ key, n: Date.now() }); }, []);
  async function publish() {
    if (await studio.publish()) { setFlash('Published. Guests see the new design on their next visit.'); setTimeout(() => setFlash(''), 4000); }
  }
  function reset() {
    studio.reset();
    setFlash('Back to the default design. Undo to get yours back.');
    setTimeout(() => setFlash(''), 4000);
  }

  const status = studio.publishing ? { tone: 'busy', text: 'Publishing…' } : dirty ? { tone: 'dirty', text: 'Unsaved changes' } : { tone: 'clean', text: 'Published' };
  const toolbar = studio.load.status === 'ready' && <div className="st-toolbar" role="toolbar" aria-label="Studio">
    <span className={`st-status is-${status.tone}`} role="status"><span aria-hidden="true" />{status.text}</span>
    <div className="st-tool-group">
      <button type="button" className="o-icon-btn" onClick={undo} disabled={!canUndo} aria-label="Undo" title={`Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`}><StudioIcon name="undo" /></button>
      <button type="button" className="o-icon-btn" onClick={redo} disabled={!canRedo} aria-label="Redo" title={`Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`}><StudioIcon name="redo" /></button>
    </div>
    <button type="button" className="o-btn is-quiet st-reset" onClick={reset}><StudioIcon name="reset" size={16} />Reset to default</button>
    <button type="button" className="o-btn is-primary st-publish" onClick={publish} disabled={!dirty || studio.publishing}><StudioIcon name="publish" size={16} />Publish changes</button>
  </div>;

  const active = TABS.find((entry) => entry.key === tab);
  return <div className={`st is-${mode}`}>
    <PageHeader title={section.label} description="Design your guest menu. Changes show in the preview at once; guests see them when you publish.">{toolbar}</PageHeader>
    {studio.load.status === 'error' && <div className="o-panel"><ErrorState error={studio.load.error} onRetry={studio.retry} what="your menu design" /></div>}
    {studio.load.status === 'loading' && <div className="st-body"><div className="st-side"><SkeletonRows rows={5} label="Loading the studio" /></div><div className="st-canvas is-loading" /></div>}
    {studio.load.status === 'ready' && studio.draft && <>
      {(studio.publishError || flash || studio.restored) && <div className="st-messages">
        {studio.publishError && <p className="st-banner is-error" role="alert"><StudioIcon name="alert" size={16} />{studio.publishError}</p>}
        {flash && <p className="st-banner" role="status"><StudioIcon name="check" size={16} />{flash}</p>}
        {studio.restored && !flash && <p className="st-banner" role="status"><StudioIcon name="edit" size={16} />We restored your unpublished draft from this device.
          <button type="button" className="o-btn is-small is-quiet" onClick={studio.discard}>Discard it</button>
          <button type="button" className="o-btn is-small is-quiet" onClick={studio.dismissRestored}>OK</button></p>}
      </div>}
      <div className="st-mode" role="radiogroup" aria-label="Show">
        {['edit', 'preview'].map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'is-on' : undefined} onClick={() => setMode(value)}>{value === 'edit' ? 'Edit' : 'Preview'}</button>)}
      </div>
      <div className="st-body">
        <div className="st-side">
          <div className="st-rail" role="tablist" aria-label="Studio panels" aria-orientation="vertical"
            onKeyDown={(event) => {
              const index = TABS.findIndex((entry) => entry.key === tab);
              const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
              if (next === undefined) return;
              event.preventDefault();
              const target = TABS[(next + TABS.length) % TABS.length];
              setTab(target.key);
              event.currentTarget.querySelector(`#st-tab-${target.key}`)?.focus();
            }}>
            {TABS.map((entry) => <button key={entry.key} id={`st-tab-${entry.key}`} type="button" role="tab" aria-selected={tab === entry.key} aria-controls="st-panel" tabIndex={tab === entry.key ? 0 : -1}
              className={`st-tab${tab === entry.key ? ' is-on' : ''}`} onClick={() => setTab(entry.key)}>
              <StudioIcon name={entry.icon} size={19} /><span>{entry.short || entry.label}</span>
            </button>)}
          </div>
          <section id="st-panel" className="st-panel" role="tabpanel" aria-labelledby={`st-tab-${tab}`} tabIndex={0}>
            <active.Panel studio={studio} onPick={pick} selected={selected} />
          </section>
        </div>
        <div className="st-canvas">
          <div className="st-canvas-bar">
            <div className="st-devices" role="radiogroup" aria-label="Preview size">
              {Object.entries(DEVICES).map(([key, value]) => <button key={key} type="button" role="radio" aria-checked={device === key} className={device === key ? 'is-on' : undefined} onClick={() => setDevice(key)}>
                <StudioIcon name={key} size={16} />{value.label}
              </button>)}
            </div>
            <span className="st-canvas-note">Live preview · try it, nothing is sent</span>
          </div>
          <PreviewCanvas studio={studio} device={device} focus={focus} />
        </div>
      </div>
    </>}
    <LeaveDialog open={Boolean(leaveTo)} onStay={() => setLeaveTo(null)} onLeave={() => { const to = leaveTo; setLeaveTo(null); navigate(to); }} />
  </div>;
}
