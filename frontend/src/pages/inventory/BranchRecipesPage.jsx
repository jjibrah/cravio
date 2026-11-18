// Branch Recipes (/branch/:id/recipes): the same list and recipe sheet as the owner's, for this branch only (P1-16).
// The branch comes from the active branch (X-Cravio-Branch), so no id is needed here.
import { PageHeader } from '../../components/dashboard/PageFrame';
import { RecipesPanel } from './RecipesPage';
import '../../components/owner/overview.css';
import '../business/business.css';

export default function BranchRecipesPage() {
  return <div className="biz-stack">
    <PageHeader title="Recipes" description="What goes into each dish, so stock goes down as you serve. Food cost shows when you can see costs." />
    <RecipesPanel />
  </div>;
}
