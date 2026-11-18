// Idempotent commands for the inventory module (same semantics as `once` in src/stock/service.js, so this module
// does not depend on src/stock): a write sent with a commandId runs once; a retry gets the first result back.
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';

/**
 * Runs `fn` once per commandId inside the caller's transaction (public.stock_commands, 009).
 * No commandId = just run it. The same id reused for another business or kind is refused with 409.
 */
export async function once(db, { commandId, businessId, actorId, kind }, fn) {
  if (commandId === undefined || commandId === null) return fn();
  if (!isId(commandId)) throw new HttpError(400, 'commandId is invalid. Send a new unique id (a UUID) with each action.', { code: 'bad_command_id' });
  const key = commandId.toLowerCase();
  const { rows } = await db.query(`insert into public.stock_commands (id, business_id, actor_id, kind) values ($1, $2, $3, $4)
    on conflict (id) do nothing returning id`, [key, businessId, actorId, kind]);
  if (!rows.length) {
    const prior = (await db.query('select business_id, kind, result from public.stock_commands where id = $1', [key])).rows[0];
    if (prior.business_id !== businessId || prior.kind !== kind) {
      throw new HttpError(409, 'This request id was already used for something else. Start the action again so it gets a new id.', { code: 'command_conflict' });
    }
    return prior.result;
  }
  const result = await fn();
  await db.query('update public.stock_commands set result = $2 where id = $1', [key, JSON.stringify(result ?? {})]);
  return result;
}
