import UserIcon from './UserIcon';
import { STATUS_LABEL, exactTime, initials, relativeTime, roleLabel, ROLE_OPTIONS } from './users-model';

export function Avatar({ user, size = 'md' }) {
  return <span className={`u-avatar is-${size}${user.status === 'suspended' ? ' is-muted' : ''}`} aria-hidden="true">{initials(user.name, user.email)}</span>;
}

export function UserBadges({ user }) {
  return <>
    {user.isSelf && <span className="u-badge is-self">You</span>}
    {user.isPrimaryAdmin && <span className="u-badge is-primary" title="Primary admin"><UserIcon name="lock" size={11} /><span className="u-badge-text">Primary admin</span></span>}
  </>;
}

export function RoleChip({ role }) {
  const option = ROLE_OPTIONS.find((item) => item.value === role);
  return <span className={`u-role is-${role || 'none'}`}>
    {option && <UserIcon name={option.icon} size={13} />}{roleLabel(role)}
  </span>;
}

export function StatusChip({ status }) {
  return <span className={`u-status is-${status}`}><span className="u-status-dot" aria-hidden="true" />{STATUS_LABEL[status] || status}</span>;
}

const midSentence = (text) => text.replace(/^(Just now|Yesterday)$/, (word) => word.toLowerCase());

/**
 * Relative time with the exact time in a tooltip (hover or focus) and for screen readers.
 * `label` is visible text before the relative time ("Invited 3 h ago"); `inline` lowercases it mid-sentence.
 */
export function TimeAgo({ value, empty = 'Never', prefix = '', label = '', inline = false }) {
  if (!value) return <span className="u-muted">{empty}</span>;
  const exact = exactTime(value);
  const relative = relativeTime(value);
  const text = label ? `${label} ${midSentence(relative)}` : inline ? midSentence(relative) : relative;
  return <time className={`u-time${label ? ' is-labelled' : ''}`} dateTime={value} tabIndex={0} data-tip={`${prefix}${exact}`}>
    <span aria-hidden="true">{text}</span><span className="visually-hidden">{prefix}{exact}</span>
  </time>;
}

export function RestaurantName({ user }) {
  if (!user.restaurant) return <span className="u-muted">{user.role === 'admin' ? 'Cravio team' : 'Not assigned'}</span>;
  const extra = (user.restaurants?.length || 1) - 1;
  return <span className="u-restaurant" title={user.restaurants?.map((item) => item.name).join(', ')}>
    <span className="u-ellipsis">{user.restaurant.name}</span>{extra > 0 && <span className="u-muted"> +{extra}</span>}
  </span>;
}
