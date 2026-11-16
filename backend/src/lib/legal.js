// Terms and conditions (migration 010): admin drafts, published versions, acceptances.
// `db` is anything with query(sql, params). Admin functions must be called after requireRole('admin').
import { HttpError } from './http.js';

export const KINDS = ['terms'];
const kindOf = (value) => { if (!KINDS.includes(value)) throw new HttpError(404, 'Unknown document.'); return value; };

export async function legalAvailable(db) {
  return (await db.query(`select to_regclass('public.legal_documents') is not null as ok`)).rows[0].ok;
}

const docOut = (row) => row && ({ id: row.id, kind: row.kind, version: row.version, title: row.title, body: row.body,
  requireExisting: row.require_existing, publishedAt: row.published_at });

/** The current (newest) published version, or null. */
export async function current(db, kind) {
  const { rows } = await db.query('select * from public.legal_documents where kind = $1 order by version desc limit 1', [kindOf(kind)]);
  return docOut(rows[0]) || null;
}

/** Admin view: the draft, the current version and every version with its acceptance count. */
export async function adminView(db, kind) {
  kindOf(kind);
  const [{ rows: drafts }, { rows: versions }, { rows: users }] = await Promise.all([
    db.query('select title, body, updated_at from public.legal_drafts where kind = $1', [kind]),
    db.query(`select d.id, d.version, d.title, d.require_existing, d.published_at, p.name as published_by,
        (select count(*) from public.legal_acceptances a where a.document_id = d.id)::int as accepted
      from public.legal_documents d left join public.profiles p on p.id = d.published_by where d.kind = $1 order by d.version desc`, [kind]),
    db.query(`select count(*)::int as n from public.profiles where role is distinct from 'admin'`),
  ]);
  const latest = versions[0] ? await current(db, kind) : null;
  return {
    kind,
    draft: drafts[0] ? { title: drafts[0].title, body: drafts[0].body, updatedAt: drafts[0].updated_at }
      : { title: latest?.title || 'Terms and conditions', body: latest?.body || '', updatedAt: null },
    current: latest,
    versions: versions.map((v) => ({ id: v.id, version: v.version, title: v.title, requireExisting: v.require_existing,
      publishedAt: v.published_at, publishedBy: v.published_by || null, accepted: v.accepted })),
    accountHolders: users[0].n,
  };
}

const cleanTitle = (value) => {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!title) throw new HttpError(400, 'Enter a title.');
  if (title.length > 120) throw new HttpError(400, 'Keep the title under 120 characters.');
  return title;
};
const cleanBody = (value, { required = false } = {}) => {
  if (typeof value !== 'string') throw new HttpError(400, 'The text must be text.');
  const body = value.replace(/\r\n/g, '\n');
  if (body.length > 100000) throw new HttpError(400, 'The text is too long (100,000 characters at most).');
  if (required && !body.trim()) throw new HttpError(400, 'Write the terms before publishing.');
  return body;
};

export async function saveDraft(db, actorId, kind, body = {}) {
  kindOf(kind);
  const title = cleanTitle(body.title);
  const text = cleanBody(body.body);
  await db.query(`insert into public.legal_drafts (kind, title, body, updated_by, updated_at) values ($1, $2, $3, $4, now())
    on conflict (kind) do update set title = excluded.title, body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`,
  [kind, title, text, actorId]);
  return { title, body: text };
}

/** Publishes the draft as the next version. Refuses an unchanged copy of the current version. Call in a transaction. */
export async function publish(db, actorId, kind, { requireExisting = true } = {}) {
  kindOf(kind);
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 13))', [`legal:${kind}`]);
  const { rows: drafts } = await db.query('select title, body from public.legal_drafts where kind = $1', [kind]);
  if (!drafts[0]) throw new HttpError(400, 'Save a draft before publishing.');
  const title = cleanTitle(drafts[0].title);
  const body = cleanBody(drafts[0].body, { required: true });
  const latest = await current(db, kind);
  if (latest && latest.title === title && latest.body === body) throw new HttpError(409, `Nothing changed since version ${latest.version}.`);
  const version = (latest?.version || 0) + 1;
  const { rows } = await db.query(`insert into public.legal_documents (kind, version, title, body, require_existing, published_by)
    values ($1, $2, $3, $4, $5, $6) returning *`, [kind, version, title, body, requireExisting !== false, actorId]);
  return docOut(rows[0]);
}

/**
 * Whether this user must accept the current terms before carrying on. Admins never do. With require_existing off,
 * only accounts created after that version was published must accept it.
 */
export async function status(db, userId, { role, createdAt }) {
  const latest = await current(db, 'terms');
  if (!latest) return { required: false, version: null };
  const { rows } = await db.query('select 1 from public.legal_acceptances where user_id = $1 and document_id = $2', [userId, latest.id]);
  const accepted = Boolean(rows[0]);
  const applies = role !== 'admin' && (latest.requireExisting || !createdAt || new Date(createdAt) >= new Date(latest.publishedAt));
  return { required: applies && !accepted, accepted, version: latest.version, title: latest.title };
}

/** Records acceptance of the current version (the client says which version it showed; it must still be current). */
export async function accept(db, userId, kind, version) {
  const latest = await current(db, kindOf(kind));
  if (!latest) throw new HttpError(404, 'There are no terms to accept.');
  if (Number(version) !== latest.version) throw new HttpError(409, 'The terms were just updated. Read the new version and accept again.', { version: latest.version });
  await db.query('insert into public.legal_acceptances (user_id, document_id) values ($1, $2) on conflict do nothing', [userId, latest.id]);
  return { version: latest.version, accepted: true };
}
