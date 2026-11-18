// /receive/<code>: where a dispatch note's QR code lands. Finds which of the signed-in manager's branches the
// dispatch is going to, then opens that branch's Inventory → Deliveries with the receipt form.
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Loading, PageShell } from '../AuthPages';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export default function ReceiveCodePage() {
  const { session, initializing } = useAuth();
  const { code } = useParams();
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    // The new engine first (returns the delivery with its destination); the old stock endpoint when inventory is off.
    api(`/api/inventory/receive/${encodeURIComponent(code)}`)
      .then(({ transfer }) => ({ transfer: true, branchId: transfer.toBranchId, id: transfer.id }), () => api(`/api/stock/receive/${encodeURIComponent(code)}`))
      .then((found) => live && setState({ status: 'found', found }), (error) => live && setState({ status: 'error', message: error.message }));
    return () => { live = false; };
  }, [session, code]);
  if (initializing) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'found') {
    const { found } = state;
    // A delivery to the Warehouse (a return) is received by the owner; the branch page redirects to the old Inventory page when the module is off.
    if (found.transfer && !found.branchId) return <Navigate to={`/owner/inventory/requests?receive=${found.id}`} replace />;
    return <Navigate to={`/branch/${found.branchId}/inventory/requests?receive=${found.id}`} replace />;
  }
  return <PageShell><h1>We couldn’t open that delivery</h1><p>{state.message}</p><p><Link to="/branch">Go to your branch</Link></p></PageShell>;
}
