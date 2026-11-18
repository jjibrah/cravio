// Evidence attachments (P2-06, migration 016): invoice and goods photos, delivery notes, emergency receipts, transfer and discrepancy proof.
// Files live in the PRIVATE Supabase Storage bucket 'inventory-evidence' at <businessId>/<entityType>/<uuid>.<ext>; public.attachments is the
// index (who uploaded, mime, size, sha256, where it may be viewed). Nothing public ever points at the bucket: viewing is a signed URL that
// lasts at most 5 minutes (D2-8) and is only handed to someone who can view the stock location the evidence belongs to.
//
// The storage dependency is injected so tests never touch the network. It has the same shape as tests/inv/helpers.js fakeStorage():
//   createSignedUpload({ path, contentType, size }) -> { token }      put(path, token, bytes)      createSignedUrl(path, seconds) -> { url, expiresAt }
//   remove(path)
// supabaseStorage() adapts the real Supabase client to that shape.
//
// Who may do what (entity location decides, never the caller's say-so):
//   upload  entity type -> capability at the entity's location:  po, invoice -> inv.purchase.create;  grn, return -> inv.stock.record;
//           emergency -> inv.emergency.create;  transfer -> inv.transfer.receive;  discrepancy -> inv.exception.resolve.
//           The owner holds all of them everywhere; a branch manager only at their own branch; operations managers and waiters never.
//   view    inv.view at the location (owner, the branch manager of that branch, operations managers on their branches).
//   Evidence with no location (an invoice not tied to a receipt yet) is owner-only.
// A different business's attachment is simply "not found".
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { isId } from '../lib/business.js';
import { authorize, can, denyAndAudit } from './permissions.js';
import { record } from './audit.js';

const fail = (status, message, code, extra = {}) => new HttpError(status, message, { code, ...extra });

export const BUCKET = 'inventory-evidence';
export const MAX_BYTES = 8 * 1024 * 1024;          // D2-8: 8 MB (the table allows up to 10 MB so the limit can be raised without a migration)
export const SIGNED_URL_SECONDS = 300;
export const ENTITY_TYPES = Object.freeze(['po', 'grn', 'invoice', 'return', 'emergency', 'transfer', 'discrepancy', 'wastage', 'adjustment']);
export const MIME_EXTENSIONS = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' });
const UPLOAD_CAPABILITY = Object.freeze({ po: 'inv.purchase.create', invoice: 'inv.purchase.create', grn: 'inv.stock.record', return: 'inv.stock.record',
  emergency: 'inv.emergency.create', transfer: 'inv.transfer.receive', discrepancy: 'inv.exception.resolve', wastage: 'inv.adjust.create', adjustment: 'inv.adjust.create' });

const NO_FILE = 'Choose a photo or PDF to attach.';
const WRONG_TYPE = 'Only photos (JPEG, PNG, WebP) and PDFs can be attached.';

/** The file type the first bytes really are, or null. Trusts the content, never the filename or the declared type. */
export function sniffMime(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Real storage: an adapter over a Supabase client (defaults to the service client, loaded lazily so tests need no env). */
export function supabaseStorage(client = null) {
  let resolved = client;
  const files = async () => {
    if (!resolved) resolved = (await import('../lib/supabase.js')).serviceClient();
    return resolved.storage.from(BUCKET);
  };
  const types = new Map();
  const wrap = (error, fallback) => {
    if (!error) return;
    console.error('[inventory] storage error:', error.message || error);
    throw fail(503, fallback, 'storage_unavailable');
  };
  return {
    async createSignedUpload({ path, contentType }) {
      const { data, error } = await (await files()).createSignedUploadUrl(path);
      wrap(error, 'Couldn’t store the file just now. Try again.');
      types.set(data.token, contentType);
      return { path, token: data.token };
    },
    async put(path, token, bytes) {
      const { error } = await (await files()).uploadToSignedUrl(path, token, bytes, { contentType: types.get(token) });
      types.delete(token);
      wrap(error, 'Couldn’t store the file just now. Try again.');
    },
    async createSignedUrl(path, expiresIn = SIGNED_URL_SECONDS) {
      const { data, error } = await (await files()).createSignedUrl(path, expiresIn);
      wrap(error, 'Couldn’t open the file just now. Try again.');
      return { url: data.signedUrl, expiresAt: new Date(Date.now() + expiresIn * 1000) };
    },
    async remove(path) {
      const { error } = await (await files()).remove([path]);
      if (error) console.error('[inventory] could not remove an orphaned file:', error.message || error);
    },
  };
}

/* ---------- helpers ---------- */

const needId = (value, label) => {
  if (!isId(value)) throw fail(400, `${label} is invalid.`, 'bad_id');
  return String(value).toLowerCase();
};

function decodeFile(file) {
  if (!file || typeof file !== 'object') throw fail(400, NO_FILE, 'file_required');
  let bytes = null;
  if (Buffer.isBuffer(file.bytes)) bytes = file.bytes;
  else if (file.bytes instanceof Uint8Array) bytes = Buffer.from(file.bytes);
  else if (typeof file.base64 === 'string') {
    const text = file.base64.replace(/^data:[^;,]*;base64,/, '').replace(/\s/g, '');
    if (text.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) throw fail(413, 'That file is too big. The limit is 8 MB.', 'file_too_big');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw fail(400, 'The file couldn’t be read. Choose it again.', 'bad_file');
    bytes = Buffer.from(text, 'base64');
  }
  if (!bytes || bytes.length === 0) throw fail(400, NO_FILE, 'file_required');
  if (bytes.length > MAX_BYTES) throw fail(413, 'That file is too big. The limit is 8 MB.', 'file_too_big');
  const type = String(file.type || '').toLowerCase().trim();
  if (!Object.hasOwn(MIME_EXTENSIONS, type)) throw fail(400, WRONG_TYPE, 'bad_file_type');
  const sniffed = sniffMime(bytes);
  if (!sniffed) throw fail(400, 'That file isn’t a photo or PDF we can read. Choose a JPEG, PNG, WebP or PDF.', 'bad_file_type');
  if (sniffed !== type) throw fail(400, 'The file doesn’t match its type. Choose it again.', 'file_type_mismatch');
  const name = String(file.name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || null;
  return { bytes, mime: sniffed, name };
}

/**
 * Where an entity's evidence belongs: { locationId } (null = owner only), after checking the entity is this business's.
 * po/grn/return/invoice read their own row; emergency, transfer and discrepancy tables arrive with later migrations, so for those the
 * caller names the location and it must be one of this business's locations.
 */
async function entityLocation(db, scope, entityType, entityId, locationId) {
  const find = async (sql) => (await db.query(sql, [entityId, scope.businessId])).rows[0];
  const missing = () => fail(404, 'That record isn’t in this business.', 'entity_not_found');
  const column = { po: 'select deliver_to_location_id as l from public.purchase_orders where id = $1 and business_id = $2',
    grn: 'select location_id as l from public.goods_receipts where id = $1 and business_id = $2',
    return: 'select location_id as l from public.supplier_returns where id = $1 and business_id = $2' }[entityType];
  if (column) {
    const row = await find(column);
    if (!row) throw missing();
    return { locationId: row.l };
  }
  if (entityType === 'invoice') {
    if (!(await find('select id from public.supplier_invoices where id = $1 and business_id = $2'))) throw missing();
    const grn = (await db.query('select location_id from public.goods_receipts where invoice_id = $1 and business_id = $2 order by created_at limit 1', [entityId, scope.businessId])).rows[0];
    return { locationId: grn?.location_id ?? null };
  }
  const place = locationId ? needId(locationId, 'The location') : null;
  if (!place || !scope.locations.some((l) => l.id === place)) throw fail(400, 'Say which branch or warehouse this evidence belongs to.', 'location_required');
  return { locationId: place };
}

const view = (row) => ({ id: row.id, entityType: row.entity_type, entityId: row.entity_id, locationId: row.location_id, name: row.original_name, mime: row.mime,
  sizeBytes: row.size_bytes, sha256: row.sha256, uploadedBy: row.uploaded_by, createdAt: row.created_at });
const COLUMNS = 'id, entity_type, entity_id, location_id, storage_path, original_name, mime, size_bytes, sha256, uploaded_by, created_at';

/** May this person see evidence at that location? Evidence without a location is the owner's alone. */
const canView = (scope, locationId) => (locationId ? can(scope, 'inv.view', { locationId }) : scope.roles.includes('owner') && can(scope, 'inv.view'));

/* ---------- service ---------- */

/**
 * Stores one file and records it. `db` is the pool or a transaction: nothing here needs a transaction (one insert), and a denied attempt must be
 * audited outside one. `restrictToLocationId` (branch routes) refuses evidence for any other place.
 * Uploading the same file again for the same record returns the existing attachment instead of storing a second copy.
 */
export async function upload(db, scope, { entityType, entityId, locationId = null, file, storage, restrictToLocationId = null } = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw fail(400, `The record type must be one of: ${ENTITY_TYPES.join(', ')}.`, 'bad_entity_type');
  const id = needId(entityId, 'The record');
  if (!storage) throw new TypeError('attachments.upload needs a storage.');
  const { bytes, mime, name } = decodeFile(file);
  const place = (await entityLocation(db, scope, entityType, id, locationId)).locationId;
  if (restrictToLocationId && place !== restrictToLocationId) {
    throw await denyAndAudit(db, scope, UPLOAD_CAPABILITY[entityType], { locationId: place, entity: 'attachment', error: fail(403, 'You don’t have access to this branch.', 'branch_forbidden') });
  }
  if (place) await authorize(db, scope, UPLOAD_CAPABILITY[entityType], { locationId: place, entity: 'attachment' });
  else if (!scope.roles.includes('owner')) throw await denyAndAudit(db, scope, UPLOAD_CAPABILITY[entityType], { entity: 'attachment' });
  else await authorize(db, scope, UPLOAD_CAPABILITY[entityType], { entity: 'attachment' });

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const same = (await db.query(`select ${COLUMNS} from public.attachments where business_id = $1 and entity_type = $2 and entity_id = $3 and sha256 = $4 and deleted_at is null limit 1`,
    [scope.businessId, entityType, id, sha256])).rows[0];
  if (same) return { ...view(same), duplicate: true };

  const path = `${scope.businessId}/${entityType}/${randomUUID()}.${MIME_EXTENSIONS[mime]}`;
  const slot = await storage.createSignedUpload({ path, contentType: mime, size: bytes.length });
  await storage.put(path, slot.token, bytes);
  let row;
  try {
    row = (await db.query(`insert into public.attachments (business_id, entity_type, entity_id, location_id, storage_path, original_name, mime, size_bytes, sha256, uploaded_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`, [scope.businessId, entityType, id, place, path, name, mime, bytes.length, sha256, scope.userId])).rows[0];
  } catch (error) {
    await storage.remove(path).catch(() => {});   // never leave an unindexed file behind
    throw error;
  }
  await record(db, { businessId: scope.businessId, locationId: place, actorId: scope.userId, actorRole: scope.role, entity: 'attachment', entityId: row.id, action: 'upload',
    before: null, after: { entityType, entityId: id, mime, sizeBytes: bytes.length, sha256 } });
  return { ...view(row), duplicate: false };
}

/** A link that opens the file for at most 5 minutes. Refused (403, audited) unless the caller can view that entity's location. */
export async function signedUrl(db, scope, attachmentId, { storage, expiresIn = SIGNED_URL_SECONDS, restrictToLocationId = null } = {}) {
  if (!storage) throw new TypeError('attachments.signedUrl needs a storage.');
  const id = needId(attachmentId, 'The attachment');
  const row = (await db.query(`select ${COLUMNS} from public.attachments where id = $1 and business_id = $2 and deleted_at is null`, [id, scope.businessId])).rows[0];
  if (!row) throw fail(404, 'That file isn’t available.', 'attachment_not_found');
  const wrongBranch = restrictToLocationId && row.location_id !== restrictToLocationId;
  if (wrongBranch || !canView(scope, row.location_id)) {
    throw await denyAndAudit(db, scope, 'inv.view', { locationId: row.location_id, entity: 'attachment', entityId: row.id });
  }
  const seconds = Math.min(SIGNED_URL_SECONDS, Math.max(1, Math.floor(Number(expiresIn) || SIGNED_URL_SECONDS)));
  const signed = await storage.createSignedUrl(row.storage_path, seconds);
  await record(db, { businessId: scope.businessId, locationId: row.location_id, actorId: scope.userId, actorRole: scope.role, entity: 'attachment', entityId: row.id, action: 'view', before: null, after: null });
  return { ...view(row), url: signed.url, expiresAt: signed.expiresAt };
}

/** The attachments on one record that the caller may see (newest first). Never exposes the storage path. */
export async function list(db, scope, { entityType, entityId, restrictToLocationId = null } = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw fail(400, `The record type must be one of: ${ENTITY_TYPES.join(', ')}.`, 'bad_entity_type');
  const id = needId(entityId, 'The record');
  const rows = (await db.query(`select ${COLUMNS} from public.attachments where business_id = $1 and entity_type = $2 and entity_id = $3 and deleted_at is null order by created_at desc, id`,
    [scope.businessId, entityType, id])).rows;
  return rows.filter((r) => canView(scope, r.location_id) && (!restrictToLocationId || r.location_id === restrictToLocationId)).map(view);
}
