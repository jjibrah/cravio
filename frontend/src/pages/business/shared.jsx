// Shared pieces of the owner / operations-manager interface (/owner).
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, OIcon } from '../../components/owner/ui';
import { formatKsh } from '../../lib/format';

/** Error state that explains a missing database update instead of a generic failure. */
export function OwnerError({ error, onRetry, what }) {
  if (error?.details?.code === 'business_schema_missing') {
    return <EmptyState icon="info" tone="neutral" title="The owner interface isn’t switched on yet">
      It needs database update 008 (businesses and branch access), which is waiting for review. Branch workspaces keep working meanwhile.
    </EmptyState>;
  }
  return <ErrorState error={error} onRetry={onRetry} what={what} />;
}

const STATUS = { live: 'Live', onboarding: 'Setting up' };
export function BranchStatus({ status }) {
  return <span className={`o-status-chip is-${status === 'live' ? 'paid' : 'taken'}`}><span className="o-status-chip-dot" aria-hidden="true" />{STATUS[status] || status}</span>;
}

export const money = (value) => formatKsh(value);
export const timeAgo = (iso) => {
  if (!iso) return 'No orders yet';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
};

/** Open the branch's own workspace (only shown when the account holds a manager role there). */
export function WorkspaceLink({ branch, small = true }) {
  if (!branch.canOpenWorkspace) return null;
  return <Link className={`o-btn is-quiet${small ? ' is-small' : ''}`} to={`/branch/${branch.id}`}>
    {small ? 'Open workspace' : 'Open branch workspace'}<OIcon name="arrowRight" size={14} />
  </Link>;
}

export const roleName = { owner: 'Business owner', operations: 'Operations manager', manager: 'Branch manager', waiter: 'Waiter' };
