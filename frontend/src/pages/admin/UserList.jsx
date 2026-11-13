import ActionsMenu from './ActionsMenu';
import UserIcon from './UserIcon';
import { Avatar, RestaurantName, RoleChip, StatusChip, TimeAgo, UserBadges } from './parts';
import { relativeTime } from './users-model';

const skeletonWidths = ['52%', '64%', '44%', '58%', '70%', '48%'];

function Identity({ user }) {
  return <span className="u-identity">
    <Avatar user={user} />
    <span className="u-identity-text">
      <span className="u-identity-name"><span className="u-ellipsis">{user.name}</span><UserBadges user={user} /></span>
      <span className="u-identity-email u-ellipsis">{user.email}</span>
    </span>
  </span>;
}

function lastActive(user) {
  if (user.status === 'invited') return <TimeAgo value={user.invited_at || user.created_at} label="Invited" prefix="Invited " empty="Invite pending" />;
  return <TimeAgo value={user.last_sign_in_at} />;
}

function TableSkeleton() {
  return skeletonWidths.map((width, row) => <tr key={row} className="u-row is-skeleton" aria-hidden="true">
    <td><span className="u-identity"><span className="sk u-avatar" /><span className="sk-stack"><span className="sk sk-text" style={{ width }} /><span className="sk sk-line" style={{ width: '38%' }} /></span></span></td>
    <td><span className="sk sk-pill" /></td>
    <td className="u-col-restaurant"><span className="sk sk-line" style={{ width: skeletonWidths[(row + 2) % 6] }} /></td>
    <td><span className="sk sk-pill" /></td>
    <td className="u-col-active"><span className="sk sk-line" style={{ width: 64 }} /></td>
    <td />
  </tr>);
}

export function UserTable({ users, loading, onOpen, menuFor, highlightId, caption }) {
  return <div className="u-table-wrap">
    <table className="u-table" aria-busy={loading || undefined}>
      <caption className="visually-hidden">{caption}</caption>
      <colgroup>
        <col className="u-c-user" /><col className="u-c-role" /><col className="u-c-restaurant u-col-restaurant" />
        <col className="u-c-status" /><col className="u-c-active u-col-active" /><col className="u-c-actions" />
      </colgroup>
      <thead><tr>
        <th scope="col">User</th><th scope="col">Role</th><th scope="col" className="u-col-restaurant">Restaurant</th>
        <th scope="col">Status</th><th scope="col" className="u-col-active">Last active</th><th scope="col"><span className="visually-hidden">Actions</span></th>
      </tr></thead>
      <tbody>
        {loading ? <TableSkeleton /> : users.map((user) => <tr key={user.id} data-user-id={user.id}
          className={`u-row${user.id === highlightId ? ' is-new' : ''}${user.pending ? ' is-pending' : ''}`}
          onClick={(event) => { if (!event.target.closest('button, a, [role="menu"]')) onOpen(user); }}>
          <td><button type="button" className="u-row-open" onClick={() => onOpen(user)} aria-label={`${user.name}, ${user.email}. View details`}><Identity user={user} /></button></td>
          <td><RoleChip role={user.role} /></td>
          <td className="u-col-restaurant"><RestaurantName user={user} /></td>
          <td><StatusChip status={user.status} /></td>
          <td className="u-col-active">{lastActive(user)}</td>
          <td className="u-cell-actions"><ActionsMenu label={`Actions for ${user.name}`} items={menuFor(user)} /></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

export function UserCards({ users, loading, onOpen, menuFor, highlightId, caption }) {
  if (loading) return <ul className="u-cards" aria-busy="true" aria-label={caption}>
    {skeletonWidths.slice(0, 4).map((width, index) => <li key={index} className="u-card is-skeleton" aria-hidden="true">
      <span className="u-identity"><span className="sk u-avatar" /><span className="sk-stack"><span className="sk sk-text" style={{ width }} /><span className="sk sk-line" style={{ width: '60%' }} /></span></span>
      <span className="u-card-meta"><span className="sk sk-pill" /><span className="sk sk-pill" /></span>
    </li>)}
  </ul>;
  return <ul className="u-cards" aria-label={caption}>
    {users.map((user) => <li key={user.id} data-user-id={user.id} className={`u-card${user.id === highlightId ? ' is-new' : ''}${user.pending ? ' is-pending' : ''}`}>
      <button type="button" className="u-card-open" onClick={() => onOpen(user)} aria-label={`${user.name}, ${user.email}. View details`}>
        <Identity user={user} />
        <span className="u-card-meta">
          <RoleChip role={user.role} /><StatusChip status={user.status} />
        </span>
        <span className="u-card-foot">
          <span className="u-card-restaurant"><UserIcon name="restaurants" size={13} /><RestaurantName user={user} /></span>
          <span className="u-card-active">{user.status === 'invited' ? 'Invite pending' : user.last_sign_in_at ? `Active ${relativeTime(user.last_sign_in_at).replace(/^(Just now|Yesterday)$/, (word) => word.toLowerCase())}` : 'Never signed in'}</span>
        </span>
      </button>
      <ActionsMenu label={`Actions for ${user.name}`} items={menuFor(user)} className="u-card-more" />
    </li>)}
  </ul>;
}
