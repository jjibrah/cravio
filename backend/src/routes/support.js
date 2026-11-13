// Contact Cravio: owners and managers send support requests and read Cravio's replies.
// Needs migration 006 (support_requests). Before it is applied, GET answers { available: false } and POST a 503.
// Reads and writes use the caller's own client, so the table's RLS decides what they can touch.
import { HttpError } from '../lib/http.js';
import { isMissingSchema, kenyanPhone, text } from '../lib/restaurants.js';
import { managerContext, rateLimit, withBody } from '../lib/operations.js';

export const SUPPORT_TYPES = ['question', 'problem', 'billing', 'feature', 'complaint'];
export const URGENCIES = ['low', 'normal', 'urgent'];
const MAX_OPEN = 20;
const NOT_INSTALLED = 'Messages to Cravio aren’t available yet. The database update hasn’t been applied. Call, WhatsApp or email us instead.';
export const SUPPORT_COLUMNS = 'id, restaurant_id, created_by, type, subject, message, urgency, contact_name, contact_phone, contact_email, status, admin_note, created_at, updated_at, resolved_at';

/** True when migration 006 hasn't been applied (table or columns missing). */
export const supportMissing = (error) => isMissingSchema(error) || ['42703', 'PGRST204'].includes(error?.code);

export const supportOut = (row) => ({
  id: row.id,
  restaurantId: row.restaurant_id,
  type: row.type,
  subject: row.subject,
  message: row.message,
  urgency: row.urgency,
  contactName: row.contact_name,
  contactPhone: row.contact_phone,
  contactEmail: row.contact_email,
  status: row.status,
  adminNote: row.admin_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at,
});

function optionalEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!clean) return null;
  if (clean.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    throw new HttpError(400, 'Enter a valid email address, like name@example.com.', { field: 'contactEmail' });
  }
  return clean;
}

/** Wraps a validator so its 400 names the field. */
function field(name, fn) {
  try { return fn(); }
  catch (error) {
    if (error instanceof HttpError && error.status === 400 && !error.details) error.details = { field: name };
    throw error;
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/restaurant/support',
    async handler({ request }) {
      const { client, restaurantId } = await managerContext(request);
      const { data, error } = await client.from('support_requests').select(SUPPORT_COLUMNS)
        .eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(100);
      if (error) {
        if (supportMissing(error)) return { available: false, requests: [] };
        throw error;
      }
      return { available: true, requests: data.map(supportOut) };
    },
  },
  {
    method: 'POST',
    path: '/api/restaurant/support',
    handler: withBody(async ({ request, body }) => {
      const { client, user, restaurantId } = await managerContext(request);

      const type = body.type;
      if (!SUPPORT_TYPES.includes(type)) throw new HttpError(400, 'Choose what this is about.', { field: 'type' });
      const urgency = body.urgency ?? 'normal';
      if (!URGENCIES.includes(urgency)) throw new HttpError(400, 'Choose how urgent this is.', { field: 'urgency' });
      // Keep line breaks in the message; only trim the ends.
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) throw new HttpError(400, 'Tell us what’s going on.', { field: 'message' });
      if (message.length > 4000) throw new HttpError(400, 'Keep the message under 4,000 characters.', { field: 'message' });
      // The subject is optional: without one, the first line of the message stands in.
      const subject = field('subject', () => text(body.subject, 'the subject', { max: 140 }))
        || message.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
      const contactName = field('contactName', () => text(body.contactName, 'your name', { max: 120 })) ?? null;
      const contactPhone = field('contactPhone', () => kenyanPhone(body.contactPhone)) ?? null;
      const contactEmail = optionalEmail(body.contactEmail);
      if (!contactPhone && !contactEmail) throw new HttpError(400, 'Add a phone number or email so we can get back to you.', { field: 'contactPhone' });

      rateLimit([
        { key: `support:user:${user.id}`, limit: 6, windowMs: 10 * 60_000 },
        { key: `support:restaurant:${restaurantId}`, limit: 30, windowMs: 24 * 60 * 60_000 },
      ], 'You’ve sent a lot of messages just now. Please wait a few minutes, or call us.');

      const { count, error: countError } = await client.from('support_requests')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId).in('status', ['open', 'in_progress']);
      if (countError) {
        if (supportMissing(countError)) throw new HttpError(503, NOT_INSTALLED);
        throw countError;
      }
      if ((count || 0) >= MAX_OPEN) {
        throw new HttpError(429, `You have ${count} open requests. We’ll work through those first; call us if it’s urgent.`);
      }

      const { data, error } = await client.from('support_requests').insert({
        restaurant_id: restaurantId, created_by: user.id, type, subject, message, urgency,
        contact_name: contactName, contact_phone: contactPhone, contact_email: contactEmail,
      }).select(SUPPORT_COLUMNS).single();
      if (error) {
        if (supportMissing(error)) throw new HttpError(503, NOT_INSTALLED);
        if (error.code === '23514') throw new HttpError(400, 'Some details are invalid. Check them and try again.');
        if (error.code === '42501') throw new HttpError(403, 'Only owners and managers can do this.');
        throw error;
      }
      return { request: supportOut(data), message: 'Message sent. We’ll get back to you soon.' };
    }),
  },
];
