import { useCallback, useId, useState } from 'react';
import { OIcon } from '../../components/owner/ui';
import { Modal } from '../../components/owner/Drawer';
import { useNotifications } from '../../components/notifications/NotificationProvider';

/* Small building blocks shared by every Settings tab. */

/** A white card with a title, a one-line explanation and, optionally, a footer of actions. */
export function SettingsCard({ title, description, children, footer, id, tone }) {
  const generated = useId();
  const titleId = id ? `${id}-title` : generated;
  return <section className={`st-card${tone ? ` is-${tone}` : ''}`} id={id} aria-labelledby={titleId}>
    <header className="st-card-head">
      <h2 className="st-card-title" id={titleId}>{title}</h2>
      {description && <p className="st-card-desc">{description}</p>}
    </header>
    <div className="st-card-body">{children}</div>
    {footer && <footer className="st-card-foot">{footer}</footer>}
  </section>;
}

/** Label + control + hint or error. `children` receives the props the control needs. */
export function Field({ label, hint, error, optional, children, className = '' }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return <div className={`st-field ${className}`}>
    <label className="st-label" htmlFor={id}>{label}{optional && <span className="st-optional">Optional</span>}</label>
    {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
    {error ? <p className="st-error" id={`${id}-error`} role="alert"><OIcon name="alert" size={14} />{error}</p>
      : hint && <p className="st-hint" id={`${id}-hint`}>{hint}</p>}
  </div>;
}

/** "Save changes" / "Discard" shown only when something changed. */
export function SaveActions({ dirty, saving, onSave, onReset, label = 'Save changes' }) {
  return <div className="st-save">
    <span className={`st-save-status${dirty ? ' is-dirty' : ''}`} aria-live="polite">{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
    {dirty && <button type="button" className="o-btn is-quiet" onClick={onReset} disabled={saving}>Discard</button>}
    <button type="button" className="o-btn is-primary" onClick={onSave} disabled={!dirty || saving}>{saving ? 'Saving…' : label}</button>
  </div>;
}

/**
 * Runs a save: shows a success pill, or an error pill (and returns the error) when it fails.
 * `run(fn, success)` resolves to true on success.
 */
export function useSaver() {
  const { notify } = useNotifications();
  const [saving, setSaving] = useState(false);
  const run = useCallback(async (fn, success = 'Changes saved') => {
    setSaving(true);
    try {
      await fn();
      if (success) notify(success);
      return true;
    } catch (error) {
      notify(error.message || 'Could not save. Please try again.', { type: 'error', duration: 7000 });
      return false;
    } finally { setSaving(false); }
  }, [notify]);
  return [saving, run];
}

/** A yes/no confirmation for anything destructive. */
export function Confirm({ open, title, children, confirmLabel, onConfirm, onClose, busy }) {
  return <Modal open={open} onClose={onClose} title={title}>
    <div className="st-confirm">
      <div className="st-confirm-text">{children}</div>
      <div className="st-confirm-actions">
        <button type="button" className="o-btn" onClick={onClose} disabled={busy} data-autofocus>Cancel</button>
        <button type="button" className="o-btn is-danger-solid" onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </div>
  </Modal>;
}

/** An on/off switch with a visible label. */
export function Switch({ checked, onChange, label, disabled }) {
  return <button type="button" role="switch" aria-checked={checked} className={`st-switch${checked ? ' is-on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="st-switch-track" aria-hidden="true"><span className="st-switch-thumb" /></span>
    <span className="st-switch-label">{label}</span>
  </button>;
}

export function Note({ tone = 'info', icon = 'info', children }) {
  return <p className={`o-note is-${tone} st-note`}><OIcon name={icon} size={16} /><span>{children}</span></p>;
}

export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
