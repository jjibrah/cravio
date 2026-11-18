// A page whose screen is built in a later ticket. Routes and navigation already point here, so the later ticket only swaps the
// component in App.jsx (INVENTORY_PAGES): branch Stock and History (P1-15), branch Recipes and owner Recipes (P1-16).
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState } from '../../components/owner/ui';
import '../../components/owner/overview.css';

export default function ComingNextPage({ section, area }) {
  const label = section?.label || 'This page';
  return <div className="biz-stack">
    <PageHeader title={label} description={section?.description} />
    <EmptyState icon="clock" tone="neutral" title={`${label} is coming next`}
      action={area === 'owner' ? <Link className="o-btn is-secondary" to="/owner/inventory">Go to Stock</Link> : null}>
      We’re building this part of inventory now. Your Stock page already works.
    </EmptyState>
  </div>;
}
