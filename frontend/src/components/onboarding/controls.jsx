import { createContext, forwardRef, useContext, useEffect, useId, useLayoutEffect, useRef } from 'react';
import OnbIcon from './OnbIcon';

/* Step wiring: a step tells the shell what Continue does and whether it's allowed. */
export const StepContext = createContext(null);

/**
 * @param {{ canContinue?: boolean, onContinue?: () => Promise<boolean|void>|boolean|void,
 *   continueLabel?: string, skipLabel?: string, hideContinue?: boolean, hideSkip?: boolean }} config
 * onContinue saves the step's answers; return false to stay (after showing an inline error).
 */
export function useStep(config) {
  const context = useContext(StepContext);
  const ref = useRef(config);
  ref.current = config;
  useLayoutEffect(() => context.bind(ref), [context]);
  const { canContinue = true, continueLabel, skipLabel, hideContinue = false, hideSkip = false } = config;
  useEffect(() => {
    context.setUi({ canContinue, continueLabel, skipLabel, hideContinue, hideSkip });
  }, [context, canContinue, continueLabel, skipLabel, hideContinue, hideSkip]);
  return context;
}

/** A big tappable choice: radio (single) or checkbox (multi) semantics. */
export function OptionCard({ selected, onSelect, icon, label, hint, multi = false, className = '', ...props }) {
  return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected}
    className={`onb-option${selected ? ' is-selected' : ''} ${className}`} onClick={onSelect} {...props}>
    {icon && <span className="onb-option-icon"><OnbIcon name={icon} size={22} /></span>}
    <span className="onb-option-text"><strong>{label}</strong>{hint && <span>{hint}</span>}</span>
    <span className="onb-option-check" aria-hidden="true"><OnbIcon name="check" size={14} /></span>
  </button>;
}

export function Chip({ selected, onToggle, children, count, ...props }) {
  return <button type="button" role="checkbox" aria-checked={selected} className={`onb-chip${selected ? ' is-selected' : ''}`} onClick={onToggle} {...props}>
    {selected && <OnbIcon name="check" size={14} />}<span>{children}</span>{count ? <span className="onb-chip-count">{count}</span> : null}
  </button>;
}

/** Label, control and an inline error that the control points at. */
export const Field = forwardRef(function Field({ label, hint, error, optional, children, className = '' }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined;
  return <div className={`onb-field ${className}`} ref={ref}>
    <label htmlFor={id}>{label}{optional && <span className="onb-optional">Optional</span>}</label>
    {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
    {hint && !error && <p className="onb-field-hint" id={hintId}>{hint}</p>}
    {error && <p className="onb-field-error" id={errorId} role="alert"><OnbIcon name="alert" size={14} />{error}</p>}
  </div>;
});

export function InlineError({ children, id }) {
  if (!children) return null;
  return <p className="onb-field-error" id={id} role="alert"><OnbIcon name="alert" size={14} />{children}</p>;
}

/** Large − n + control for counts. */
export function Stepper({ value, onChange, min = 1, max = 200, label }) {
  const clamp = (number) => Math.min(max, Math.max(min, number));
  return <div className="onb-stepper" role="group" aria-label={label}>
    <button type="button" className="onb-stepper-button" onClick={() => onChange(clamp((value || 0) - 1))} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}><OnbIcon name="minus" size={26} /></button>
    <input className="onb-stepper-value" type="number" inputMode="numeric" min={min} max={max} value={value || ''} aria-label={label}
      onChange={(event) => onChange(event.target.value === '' ? '' : clamp(Math.round(Number(event.target.value))))}
      onBlur={() => { if (!value) onChange(min); }} />
    <button type="button" className="onb-stepper-button" onClick={() => onChange(clamp((value || 0) + 1))} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}><OnbIcon name="plus" size={26} /></button>
  </div>;
}

export function Toggle({ checked, onChange, label }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`onb-switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
    <span className="onb-switch-thumb" aria-hidden="true" />
  </button>;
}

/** "Add your own" chip input. */
export function AddOwn({ placeholder, onAdd, label = 'Add your own', max = 40 }) {
  const inputRef = useRef(null);
  const id = useId();
  function add() {
    const value = inputRef.current.value.trim().replace(/\s+/g, ' ');
    if (!value) { inputRef.current.focus(); return; }
    onAdd(value.slice(0, max));
    inputRef.current.value = '';
    inputRef.current.focus();
  }
  return <div className="onb-add-own">
    <label htmlFor={id} className="visually-hidden">{label}</label>
    <input id={id} ref={inputRef} placeholder={placeholder} maxLength={max}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); add(); } }} />
    <button type="button" className="onb-secondary" onClick={add}><OnbIcon name="plus" size={16} />Add</button>
  </div>;
}
