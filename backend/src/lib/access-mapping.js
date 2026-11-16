// Applies a REVIEWED account mapping after migration 008 (docs/v2/MIGRATION-008.md).
// Input (JSON):
// {
//   "businesses": [
//     { "name": "Abdis Group",                         // optional: rename the business
//       "restaurantIds": ["<uuid>", "<uuid>"],          // branches; the first restaurant's business is kept,
//                                                       //   the others move into it (their empty auto-business is removed)
//       "owners": ["owner@example.com"],                // business-owner grants (all branches)
//       "operations": [{ "email": "ops@example.com", "branchIds": ["<uuid>"] }] }
//   ]
// }
// Nothing is inferred: every restaurant, email and branch must be named. Unknown ids/emails, a branch outside the
// entry, a restaurant listed twice, or moving a restaurant whose business already has grants all abort the whole run.
// Branch memberships (restaurant_members) are never changed: legacy owners keep their branch-manager access.
// Run inside a transaction; returns the list of changes for review.
import { isId } from './business.js';

const fail = (message) => { const error = new Error(message); error.mapping = true; throw error; };

export async function applyAccessMapping(db, mapping, { actorId = null } = {}) {
  if (!mapping || !Array.isArray(mapping.businesses) || !mapping.businesses.length) fail('Mapping needs a non-empty "businesses" list.');
  const changes = [];
  const seen = new Set();
  const userId = async (email) => {
    if (typeof email !== 'string') fail('Every account must be an email address.');
    const { rows } = await db.query('select id from auth.users where lower(email) = lower($1)', [email.trim()]);
    if (!rows[0]) fail(`No Cravio account for ${email}.`);
    return rows[0].id;
  };

  for (const [index, entry] of mapping.businesses.entries()) {
    const label = `businesses[${index}]`;
    const ids = (entry.restaurantIds || []).map((id) => (isId(id) ? id.toLowerCase() : fail(`${label}: invalid restaurant id ${id}.`)));
    if (!ids.length) fail(`${label}: list at least one restaurant.`);
    for (const id of ids) { if (seen.has(id)) fail(`${label}: restaurant ${id} appears twice.`); seen.add(id); }
    const { rows: restaurants } = await db.query('select id, name, business_id from public.restaurants where id = any($1::uuid[])', [ids]);
    if (restaurants.length !== ids.length) fail(`${label}: unknown restaurant id.`);
    const byId = new Map(restaurants.map((row) => [row.id, row]));
    const target = byId.get(ids[0]).business_id;

    // Group further restaurants into the first one's business.
    for (const id of ids.slice(1)) {
      const from = byId.get(id).business_id;
      if (from === target) continue;
      const { rows: grants } = await db.query('select 1 from public.business_members where business_id = $1 limit 1', [from]);
      if (grants.length) fail(`${label}: ${byId.get(id).name} belongs to a business that already has access grants; resolve that by hand.`);
      await db.query('update public.restaurants set business_id = $1 where id = $2', [target, id]);
      const { rows: left } = await db.query('select 1 from public.restaurants where business_id = $1 limit 1', [from]);
      if (!left.length) await db.query('delete from public.businesses where id = $1', [from]);
      changes.push(`Moved ${byId.get(id).name} into the business of ${byId.get(ids[0]).name}`);
    }
    if (entry.name) {
      const name = String(entry.name).trim();
      if (!name || name.length > 120) fail(`${label}: business name must be 1–120 characters.`);
      await db.query('update public.businesses set name = $1 where id = $2', [name, target]);
      changes.push(`Named the business “${name}”`);
    }
    for (const email of entry.owners || []) {
      const id = await userId(email);
      const { rows } = await db.query(`insert into public.business_members (business_id, user_id, role, granted_by) values ($1, $2, 'owner', $3)
        on conflict (business_id, user_id) do update set role = 'owner' returning (xmax = 0) as inserted`, [target, id, actorId]);
      await db.query('delete from public.business_member_branches where business_id = $1 and user_id = $2', [target, id]);
      changes.push(`${rows[0].inserted ? 'Granted' : 'Confirmed'} business owner: ${email}`);
    }
    for (const grant of entry.operations || []) {
      const id = await userId(grant.email);
      const branches = (grant.branchIds || []).map((b) => (isId(b) ? b.toLowerCase() : fail(`${label}: invalid branch id ${b}.`)));
      if (!branches.length) fail(`${label}: ${grant.email} needs at least one branch.`);
      for (const b of branches) if (!ids.includes(b)) fail(`${label}: branch ${b} for ${grant.email} is not in this business entry.`);
      const { rows: existing } = await db.query('select role from public.business_members where business_id = $1 and user_id = $2', [target, id]);
      if (existing[0]?.role === 'owner') fail(`${label}: ${grant.email} is listed as owner and operations.`);
      if (!existing[0]) await db.query(`insert into public.business_members (business_id, user_id, role, granted_by) values ($1, $2, 'operations', $3)`, [target, id, actorId]);
      await db.query('delete from public.business_member_branches where business_id = $1 and user_id = $2', [target, id]);
      for (const b of branches) await db.query('insert into public.business_member_branches (business_id, user_id, restaurant_id, granted_by) values ($1, $2, $3, $4)', [target, id, b, actorId]);
      changes.push(`Operations manager ${grant.email}: ${branches.length} branch${branches.length === 1 ? '' : 'es'}`);
    }
    await db.query(`insert into public.access_events (business_id, actor_id, action, detail) values ($1, $2, 'mapping_applied', $3)`,
      [target, actorId, JSON.stringify({ entry: index, restaurants: ids.length, owners: (entry.owners || []).length, operations: (entry.operations || []).length })]);
  }
  return changes;
}
