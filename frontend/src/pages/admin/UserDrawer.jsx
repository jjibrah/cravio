import { useEffect, useId, useRef, useState } from 'react';
import Dialog from './Dialog';
import UserIcon from './UserIcon';
import { Avatar, RestaurantName, StatusChip, TimeAgo, UserBadges } from './parts';
import { ROLE_OPTIONS, blockedReason, exactTime, firstName, roleArticle, roleLabel } from './users-model';

function Confirm({ tone = 'danger', title, children, confirmLabel, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className={`u-confirm is-${tone}`} role="alertdialog" aria-label={title} aria-describedby={undefined}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <p className="u-confirm-title">{title}</p>
    <p className="u-confirm-text">{children}</p>
    <div className="u-confirm-actions">
      <button ref={ref} data-autofocus type="button" className="u-btn is-secondary is-sm" onClick={onCancel}>Cancel</button>
      <button type="button" className={`u-btn is-sm ${tone === 'danger' ? 'is-danger' : 'is-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>;
}

function Blocked({ reason }) {
  if (!reason) return null;
  return <p className="u-blocked"><UserIcon name="lock" size={13} />{reason}</p>;
}

function RoleControl({ value, disabled, onChange, labelledBy }) {
  const refs = useRef([]);
  const index = ROLE_OPTIONS.findIndex((option) => option.value === value);
  function onKeyDown(event) {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!delta || disabled) return;
    event.preventDefault();
    const next = (Math.max(index, 0) + delta + ROLE_OPTIONS.length) % ROLE_OPTIONS.length;
    refs.current[next]?.focus();
  }
  return <div className={`u-segmented${disabled ? ' is-disabled' : ''}`} role="radiogroup" aria-labelledby={labelledBy} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
    {ROLE_OPTIONS.map((option, i) => {
      const checked = option.value === value;
      return <button key={option.value} ref={(element) => { refs.current[i] = element; }} type="button" role="radio" aria-checked={checked}
        tabIndex={checked || (index < 0 && i === 0) ? 0 : -1} disabled={disabled}
        className={`u-segment${checked ? ' is-checked' : ''}`} onClick={() => !checked && onChange(option.value)}>
        <UserIcon name={option.icon} size={14} />{option.label}
      </button>;
    })}
  </div>;
}

/**
 * User details drawer. `intent` pre-stages a confirmation from the row menu:
 * { type: 'suspend' } or { type: 'role', role }.
 */
export default function UserDrawer({ user, open, onClose, intent, activeAdmins, onChangeRole, onRename, onSuspend, onReactivate, onResend }) {
  const [confirm, setConfirm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const roleLabelId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!open) return;
    setConfirm(intent || null);
    setEditing(false);
    setNameError('');
  }, [open, intent, user?.id]);

  if (!user) return <Dialog open={false} onClose={onClose} variant="drawer" title="User details" />;

  const first = firstName(user.name);
  const roleBlocked = blockedReason(user, 'role', { activeAdmins, nextRole: user.role === 'admin' ? 'owner' : 'admin' });
  const roleSelfOrPrimary = user.isSelf || user.isPrimaryAdmin;
  const suspendBlocked = user.status === 'suspended' ? blockedReason(user, 'reactivate') : blockedReason(user, 'suspend', { activeAdmins });
  const renameBlocked = blockedReason(user, 'rename');

  function requestRole(role) {
    if (user.role === 'admin' || role === 'admin') setConfirm({ type: 'role', role });
    else onChangeRole(user, role);
  }

  function saveName(event) {
    event.preventDefault();
    const name = draft.trim().replace(/\s+/g, ' ');
    if (!name) { setNameError('Enter a name.'); return; }
    if (name.length > 120) { setNameError('Keep the name under 120 characters.'); return; }
    setEditing(false);
    if (name !== user.name) onRename(user, name);
  }

  const roleConfirm = confirm?.type === 'role' && confirm.role !== user.role ? confirm : null;
  const demoting = roleConfirm && user.role === 'admin';

  return <Dialog open={open} onClose={onClose} variant="drawer" className="u-drawer"
    header={(titleId) => <div className="u-drawer-identity">
      <Avatar user={user} size="lg" />
      <div className="u-drawer-names">
        <h2 id={titleId} className="u-dialog-title u-ellipsis">{user.name}</h2>
        <p className="u-dialog-sub u-ellipsis">{user.email}</p>
        <div className="u-drawer-badges"><StatusChip status={user.status} /><UserBadges user={user} /></div>
      </div>
    </div>}>
    {user.status === 'suspended' && <div className="u-callout is-error"><UserIcon name="ban" size={15} />
      <span><strong>Suspended.</strong> {first} can’t sign in until you reactivate the account.</span></div>}
    {user.status === 'invited' && <div className="u-callout is-warning"><UserIcon name="mail" size={15} />
      <span><strong>Invite not accepted yet.</strong> Sent <TimeAgo value={user.invited_at || user.created_at} empty="recently" inline />.</span>
      {!blockedReason(user, 'resend') && <button type="button" className="u-btn is-link" onClick={() => onResend(user)}>Resend invite</button>}
    </div>}
    {(user.isPrimaryAdmin || user.isSelf) && <div className="u-callout"><UserIcon name="lock" size={15} />
      <span>{user.isPrimaryAdmin && !user.isSelf ? 'This is the primary admin account. Other admins can’t suspend, demote or edit it.'
        : user.isPrimaryAdmin ? 'You’re the primary admin. Your account always keeps admin access.'
          : 'This is your account. Another admin has to change your role or suspend you.'}</span></div>}

    <section className="u-section" aria-labelledby={roleLabelId}>
      <h3 className="u-section-title" id={roleLabelId}>Role</h3>
      <RoleControl value={user.role} labelledBy={roleLabelId} disabled={roleSelfOrPrimary || Boolean(user.pending)}
        onChange={(role) => {
          const reason = blockedReason(user, 'role', { activeAdmins, nextRole: role });
          if (reason) setConfirm({ type: 'blocked', reason }); else requestRole(role);
        }} />
      {roleSelfOrPrimary ? <Blocked reason={roleBlocked} />
        : confirm?.type === 'blocked' ? <Blocked reason={confirm.reason} />
          : <p className="u-section-hint">{ROLE_OPTIONS.find((option) => option.value === user.role)?.description || 'No role yet. Choose one to give access.'}</p>}
      {roleConfirm && (demoting
        ? <Confirm title={`Remove admin access from ${first}?`} confirmLabel={`Make ${roleLabel(roleConfirm.role).toLowerCase()}`}
          onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); onChangeRole(user, roleConfirm.role); }}>
          {first} will lose access to the admin workspace right away and become {roleArticle[roleConfirm.role]}.
        </Confirm>
        : <Confirm tone="neutral" title={`Make ${first} an admin?`} confirmLabel="Make admin"
          onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); onChangeRole(user, 'admin'); }}>
          Admins can see and change everything on Cravio, including other users and restaurants.
        </Confirm>)}
    </section>

    <section className="u-section">
      <h3 className="u-section-title">Details</h3>
      <dl className="u-details">
        <div className="u-detail"><dt id={nameId}>Name</dt><dd>
          {editing ? <form className="u-inline-edit" onSubmit={saveName}>
            <input data-autofocus aria-labelledby={nameId} value={draft} autoFocus onChange={(event) => { setDraft(event.target.value); setNameError(''); }}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); } }}
              aria-invalid={Boolean(nameError)} aria-describedby={nameError ? `${nameId}-error` : undefined} />
            <button type="submit" className="u-btn is-primary is-sm">Save</button>
            <button type="button" className="u-btn is-secondary is-sm" onClick={() => setEditing(false)}>Cancel</button>
            {nameError && <p className="u-field-error" id={`${nameId}-error`}>{nameError}</p>}
          </form> : <span className="u-detail-value">
            <span className="u-ellipsis">{user.name}</span>
            {renameBlocked ? <span className="u-tip" data-tip={renameBlocked} tabIndex={0} aria-label={renameBlocked}><UserIcon name="lock" size={13} /></span>
              : <button type="button" className="u-btn is-link" onClick={() => { setDraft(user.name); setEditing(true); }} aria-label={`Rename ${user.name}`}>Rename</button>}
          </span>}
        </dd></div>
        <div className="u-detail"><dt>Email</dt><dd className="u-ellipsis">{user.email}</dd></div>
        <div className="u-detail"><dt>Restaurant</dt><dd><RestaurantName user={user} /></dd></div>
        <div className="u-detail"><dt>Status</dt><dd><StatusChip status={user.status} /></dd></div>
        <div className="u-detail"><dt>Created</dt><dd>{user.created_at ? <time dateTime={user.created_at}>{exactTime(user.created_at)}</time> : '—'}</dd></div>
        <div className="u-detail"><dt>Last sign-in</dt><dd>{user.last_sign_in_at
          ? <><time dateTime={user.last_sign_in_at}>{exactTime(user.last_sign_in_at)}</time> <span className="u-muted">· <TimeAgo value={user.last_sign_in_at} inline /></span></>
          : <span className="u-muted">Never signed in</span>}</dd></div>
      </dl>
    </section>

    <section className="u-section">
      <h3 className="u-section-title">Access</h3>
      {user.status === 'suspended' ? <div className="u-access-row">
        <div><p className="u-access-title">Reactivate account</p><p className="u-section-hint">{first} will be able to sign in again with their existing password.</p></div>
        <button type="button" className="u-btn is-secondary" disabled={Boolean(suspendBlocked) || user.pending} onClick={() => onReactivate(user)}>
          <UserIcon name="restore" size={15} />Reactivate</button>
      </div> : <div className="u-access-row">
        <div><p className="u-access-title">Suspend account</p><p className="u-section-hint">Removes access without deleting anything. You can reactivate at any time.</p></div>
        <button type="button" className="u-btn is-danger-outline" disabled={Boolean(suspendBlocked) || user.pending || confirm?.type === 'suspend'}
          onClick={() => setConfirm({ type: 'suspend' })}><UserIcon name="ban" size={15} />Suspend</button>
      </div>}
      <Blocked reason={suspendBlocked} />
      {confirm?.type === 'suspend' && user.status !== 'suspended' && !suspendBlocked && <Confirm title={`Suspend ${first}?`} confirmLabel={`Suspend ${first}`}
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); onSuspend(user); }}>
        {first} will be signed out and can’t sign in until you reactivate the account.
      </Confirm>}
    </section>
  </Dialog>;
}
