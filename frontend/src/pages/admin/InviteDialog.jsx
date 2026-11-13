import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api';
import Dialog from './Dialog';
import UserIcon from './UserIcon';
import { ROLE_OPTIONS } from './users-model';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const empty = { email: '', name: '', role: 'owner', restaurantName: '', restaurantId: '' };

function validate(values) {
  const errors = {};
  const email = values.email.trim();
  if (!email) errors.email = 'Enter an email address.';
  else if (!EMAIL.test(email) || email.length > 254) errors.email = 'Enter a valid email address, like name@restaurant.com.';
  if (!values.name.trim()) errors.name = 'Enter their name.';
  else if (values.name.trim().length > 120) errors.name = 'Keep the name under 120 characters.';
  if (values.role === 'owner' && !values.restaurantName.trim()) errors.restaurantName = 'Enter the restaurant’s name.';
  else if (values.role === 'owner' && values.restaurantName.trim().length > 120) errors.restaurantName = 'Keep the restaurant name under 120 characters.';
  if (values.role === 'waiter' && !values.restaurantId) errors.restaurantId = 'Choose the restaurant this waiter works at.';
  return errors;
}

function Field({ id, label, hint, error, children }) {
  return <div className={`u-field${error ? ' has-error' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {children}
    {error ? <p className="u-field-error" id={`${id}-error`}><UserIcon name="alert" size={13} />{error}</p>
      : hint ? <p className="u-field-hint" id={`${id}-hint`}>{hint}</p> : null}
  </div>;
}

export default function InviteDialog({ open, onClose, onInvited }) {
  const [values, setValues] = useState(empty);
  const [touched, setTouched] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restaurants, setRestaurants] = useState({ state: 'idle', items: [] });
  const [attempt, setAttempt] = useState(0);
  const emailRef = useRef(null);
  const ids = { email: useId(), name: useId(), restaurantName: useId(), restaurantId: useId(), role: useId(), form: useId() };

  useEffect(() => {
    if (!open) return;
    setValues(empty); setTouched({}); setServerErrors({}); setFormError(''); setSubmitted(false); setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || values.role !== 'waiter' || restaurants.state === 'ready' || restaurants.state === 'loading') return undefined;
    const controller = new AbortController();
    setRestaurants({ state: 'loading', items: [] });
    api('/api/admin/restaurants', { signal: controller.signal })
      .then((data) => setRestaurants({ state: 'ready', items: data.restaurants || [] }))
      .catch((error) => { if (error.name !== 'AbortError') setRestaurants({ state: 'error', items: [], message: error.message }); });
    return () => controller.abort();
    // Fetched once per dialog session, when Waiter is first chosen (or on retry).
  }, [open, values.role, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!open) setRestaurants({ state: 'idle', items: [] }); }, [open]);

  const clientErrors = validate(values);
  const errorFor = (field) => serverErrors[field] || ((submitted || touched[field]) ? clientErrors[field] : undefined);
  const set = (field) => (event) => {
    const value = event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => ({ ...current, [field]: undefined }));
    setFormError('');
  };
  const blur = (field) => () => setTouched((current) => ({ ...current, [field]: true }));
  const describe = (field) => (errorFor(field) ? `${ids[field]}-error` : undefined);

  async function submit(event) {
    event.preventDefault();
    setSubmitted(true);
    setFormError('');
    const errors = validate(values);
    const firstInvalid = ['email', 'name', 'restaurantName', 'restaurantId'].find((field) => errors[field]);
    if (firstInvalid) { document.getElementById(ids[firstInvalid])?.focus(); return; }
    setBusy(true);
    try {
      const body = { email: values.email.trim(), name: values.name.trim(), role: values.role };
      if (values.role === 'owner') body.restaurantName = values.restaurantName.trim();
      if (values.role === 'waiter') body.restaurantId = values.restaurantId;
      const data = await api('/api/admin/users/invite', { method: 'POST', body });
      onInvited(data.user);
    } catch (error) {
      const field = error.details?.field;
      if (field && ids[field]) {
        setServerErrors({ [field]: error.message });
        document.getElementById(ids[field])?.focus();
      } else setFormError(error.message);
    } finally { setBusy(false); }
  }

  const selected = ROLE_OPTIONS.find((option) => option.value === values.role);
  const waiterBlocked = values.role === 'waiter' && !(restaurants.state === 'ready' && restaurants.items.length);

  return <Dialog open={open} onClose={onClose} variant="modal" initialFocus={emailRef} className="u-invite"
    header={(titleId) => <div className="u-dialog-heading">
      <span className="u-dialog-glyph"><UserIcon name="userPlus" size={18} /></span>
      <div><h2 id={titleId} className="u-dialog-title">Invite user</h2>
        <p className="u-dialog-sub">They’ll get an email with a link to set their password.</p></div>
    </div>}
    footer={<>
      <button type="button" className="u-btn is-secondary" onClick={onClose}>Cancel</button>
      <button type="submit" form={ids.form} className="u-btn is-primary" disabled={busy || waiterBlocked}>{busy ? 'Sending invite…' : 'Send invite'}</button>
    </>}>
    <form id={ids.form} className="u-form" onSubmit={submit} noValidate>
      {formError && <div className="error-pill u-form-error" role="alert"><UserIcon name="alert" size={15} /><span>{formError}</span></div>}
      <div className="u-field-row">
        <Field id={ids.email} label="Email" error={errorFor('email')}>
          <input ref={emailRef} id={ids.email} type="email" autoComplete="off" spellCheck={false} placeholder="name@restaurant.com"
            value={values.email} onChange={set('email')} onBlur={blur('email')} aria-invalid={Boolean(errorFor('email'))} aria-describedby={describe('email')} />
        </Field>
        <Field id={ids.name} label="Name" error={errorFor('name')}>
          <input id={ids.name} type="text" autoComplete="off" placeholder="Jane Doe" value={values.name}
            onChange={set('name')} onBlur={blur('name')} aria-invalid={Boolean(errorFor('name'))} aria-describedby={describe('name')} />
        </Field>
      </div>

      <fieldset className="u-roles">
        <legend>Role</legend>
        <div className="u-role-cards">
          {ROLE_OPTIONS.map((option) => <label key={option.value} className={`u-role-card${values.role === option.value ? ' is-selected' : ''}`}>
            <input type="radio" name={ids.role} value={option.value} checked={values.role === option.value}
              onChange={() => { setValues((current) => ({ ...current, role: option.value })); setServerErrors({}); setFormError(''); }} />
            <span className="u-role-card-icon"><UserIcon name={option.icon} size={16} /></span>
            <span className="u-role-card-label">{option.label}</span>
            <span className="u-role-card-hint">{option.hint}</span>
            <span className="u-role-card-check" aria-hidden="true"><UserIcon name="check" size={12} /></span>
          </label>)}
        </div>
        <p className="u-role-description">{selected.description}</p>
      </fieldset>

      {values.role === 'admin' && <div className="u-callout is-warning" role="note">
        <UserIcon name="internal" size={15} />
        <span>Admins can see and change everything on Cravio, including other users. Only invite people on the Cravio team.</span>
      </div>}

      {values.role === 'owner' && <Field id={ids.restaurantName} label="Restaurant name" error={errorFor('restaurantName')}
        hint="We’ll create the restaurant. They’ll finish setting it up when they sign in.">
        <input id={ids.restaurantName} type="text" autoComplete="off" placeholder="Trattoria Roma" value={values.restaurantName}
          onChange={set('restaurantName')} onBlur={blur('restaurantName')} aria-invalid={Boolean(errorFor('restaurantName'))}
          aria-describedby={describe('restaurantName') || `${ids.restaurantName}-hint`} />
      </Field>}

      {values.role === 'waiter' && (restaurants.state === 'loading' || restaurants.state === 'idle'
        ? <div className="u-field"><span className="u-label">Restaurant</span><span className="u-select-skeleton sk" aria-label="Loading restaurants" role="status" /></div>
        : restaurants.state === 'error'
          ? <div className="u-callout is-error" role="alert"><UserIcon name="alert" size={15} />
            <span>Couldn’t load restaurants. {restaurants.message}</span>
            <button type="button" className="u-btn is-link" onClick={() => { setRestaurants({ state: 'idle', items: [] }); setAttempt((value) => value + 1); }}>Retry</button></div>
          : restaurants.items.length === 0
            ? <div className="u-callout" role="note"><UserIcon name="restaurants" size={15} />
              <span><strong>No restaurants yet.</strong> Waiters join an existing restaurant. Invite an owner first; their restaurant will show up here.</span></div>
            : <Field id={ids.restaurantId} label="Restaurant" error={errorFor('restaurantId')}>
              <div className="u-select">
                <select id={ids.restaurantId} value={values.restaurantId} onChange={set('restaurantId')} onBlur={blur('restaurantId')}
                  aria-invalid={Boolean(errorFor('restaurantId'))} aria-describedby={describe('restaurantId')}>
                  <option value="">Choose a restaurant</option>
                  {restaurants.items.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>
                    {restaurant.name}{restaurant.status === 'onboarding' ? ' (setting up)' : ''}
                  </option>)}
                </select>
                <UserIcon name="chevron" size={14} className="u-select-chevron" />
              </div>
            </Field>)}
    </form>
  </Dialog>;
}
