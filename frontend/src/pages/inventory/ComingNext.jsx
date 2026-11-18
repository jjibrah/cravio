// Placeholder pages for the purchasing screens that arrive in later tickets: Receive goods (P2-15), Approvals (P2-16) and the
// branch Purchases page (P2-17). They are in the navigation now so the structure is final; each says plainly what it will do.
import { PageHeader } from '../../components/dashboard/PageFrame';
import { EmptyState, OwnerFrame } from './parts';
import '../../components/owner/overview.css';
import '../business/business.css';

export function OwnerReceivePage() {
  return <OwnerFrame title="Receive goods" description="Check in what arrives against what you ordered.">
    {() => <EmptyState icon="info" tone="neutral" title="Receiving goods is coming soon">
      When an order arrives you will count it here, note anything short or damaged, and the stock goes up by itself.
    </EmptyState>}
  </OwnerFrame>;
}

export function OwnerApprovalsPage() {
  return <OwnerFrame title="Approvals" description="Orders and requests waiting for your decision.">
    {() => <EmptyState icon="info" tone="neutral" title="The approvals inbox is coming soon">
      Everything that needs a yes or a no will be listed here in one place. For now, approve a purchase order from the order itself.
    </EmptyState>}
  </OwnerFrame>;
}

export function BranchPurchasesPage() {
  return <div className="biz-stack inv-page">
    <PageHeader title="Purchases" description="Emergency buys, with the receipt, when you can’t wait for the warehouse." />
    <EmptyState icon="info" tone="neutral" title="Purchases are coming soon">
      You will record what you bought, from whom and for how much, and attach the receipt.
    </EmptyState>
  </div>;
}
