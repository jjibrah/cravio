import { NavLink } from 'react-router-dom';
import { branchesWithRole } from '../../lib/branch';
import Icon from '../Icon';

/*
 * Moving between the areas this account may use: the owner overview (business grant), the branches it manages,
 * and the waiter app. Hidden when there is nowhere else to go. Lists only branches from /api/me, which the
 * backend derived from the account's own memberships; it never offers a branch the account can't open.
 */
export default function BranchSwitcher({ account, scope, onNavigate }) {
  const managed = branchesWithRole(account, 'manager');
  const waiting = branchesWithRole(account, 'waiter');
  const owner = (account.businesses || []).length > 0;
  const others = managed.filter((branch) => branch.id !== scope.branch?.id);
  if (!others.length && !(owner && scope.area !== 'owner') && !(scope.area === 'owner' && managed.length) && !waiting.length) return null;

  const link = (to, icon, label, meta) => <NavLink key={to} to={to} onClick={onNavigate} end
    className={({ isActive }) => `sidebar-link branch-switch-link${isActive ? ' is-active' : ''}`}>
    <span className="nav-icon"><Icon name={icon} size={16} /></span>
    <span className="branch-switch-text"><span>{label}</span>{meta && <small>{meta}</small>}</span>
  </NavLink>;

  return <div className="sidebar-group branch-switcher" role="group" aria-label="Switch workspace">
    <p className="sidebar-group-label">{scope.area === 'owner' ? 'Your branches' : 'Switch to'}</p>
    {owner && scope.area !== 'owner' && link('/owner', 'overview', 'Owner overview', 'All your branches')}
    {(scope.area === 'owner' ? managed : others).map((branch) => link(`/branch/${branch.id}`, 'restaurants', branch.name, branch.location || 'Branch manager'))}
    {waiting.length > 0 && link('/waiter', 'orders', 'Waiter app', waiting.length === 1 ? waiting[0].name : `${waiting.length} branches`)}
  </div>;
}
