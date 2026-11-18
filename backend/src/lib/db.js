// Direct Postgres access for the v2 business and stock features (transactions, row locks). Runs as the server's
// database role, so every caller must check the user's branch/business access first (routes do, then lib/*).
import { HttpError } from './http.js';
import { database } from './pool.js';

const SCHEMA = { business: 'database update 008', stock: 'database update 009 (inventory)', legal: 'database update 010 (terms and conditions)' };

/** Runs fn(client) on one pooled connection, optionally in a transaction; maps database errors to HTTP errors. */
export async function withDb(fn, { transaction = false, feature = 'business' } = {}) {
  const client = await database().connect();
  try {
    if (!transaction) return await fn(client);
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    if (transaction) await client.query('rollback').catch(() => {});
    if (error instanceof HttpError) throw error;
    if (['42P01', '42703', '42883'].includes(error.code)) {
      throw new HttpError(503, `This needs ${SCHEMA[feature]}, which hasn’t been applied yet.`, { code: `${feature}_schema_missing` });
    }
    if (error.code === 'P0001' && error.hint === 'stock_sold_out') throw new HttpError(409, error.message, { code: 'sold_out' });
    if (error.code === '23505') throw new HttpError(409, 'That already exists.');
    if (['23503', '23514', '22P02', '22003'].includes(error.code)) throw new HttpError(400, 'Some details are invalid. Check them and try again.');
    throw error;
  } finally { client.release(); }
}
