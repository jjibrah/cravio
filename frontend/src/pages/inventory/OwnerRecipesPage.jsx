// Owner Recipes (/owner/inventory/recipes). Placeholder until P1-16 (recipe editor with food cost). The data is already there:
// GET /api/owner/inventory/:biz/recipes?branch=<id> (see lib/inventory.js `owner.recipes`). P1-16 replaces the body of this page.
import { EmptyState, OwnerFrame } from './parts';

export default function OwnerRecipesPage() {
  return <OwnerFrame title="Recipes" description="What goes into each dish, and what it costs you to make.">
    {() => <EmptyState icon="utensils" tone="neutral" title="Recipes are coming next">
      Soon you’ll be able to say what goes into each dish, so stock goes down as you serve and you can see what every dish costs.
    </EmptyState>}
  </OwnerFrame>;
}
