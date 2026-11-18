// Owner Recipes (/owner/inventory/recipes): what goes into each dish and what it costs, for the branch picked at the top (P1-16).
// The list and the recipe sheet are shared with the branch manager's Recipes page (RecipesPage.jsx).
import { useState } from 'react';
import { OwnerFrame } from './parts';
import { BranchPicker, NoBranches, RecipesPanel, effectiveBranch } from './RecipesPage';

export default function OwnerRecipesPage() {
  const [chosen, setChosen] = useState(null);
  return <OwnerFrame title="Recipes" description="What goes into each dish, and what it costs you to make."
    actions={(ctx) => <BranchPicker ctx={ctx} value={effectiveBranch(ctx, chosen)} onChange={setChosen} />}>
    {(ctx) => { const branchId = effectiveBranch(ctx, chosen); return branchId ? <RecipesPanel key={branchId} ownerCtx={ctx} branchId={branchId} /> : <NoBranches />; }}
  </OwnerFrame>;
}
