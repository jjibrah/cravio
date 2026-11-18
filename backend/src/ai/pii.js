// Privacy guard for AI prompts (12-ai-insights.md §1.5): no customer or staff names, phones, emails, payment references or
// addresses, ever. A cheap deny-list on field names plus pattern checks on the text. It fails closed with a 400 that names the
// kind of problem and never echoes the value.
import { HttpError } from '../lib/http.js';

const DENIED_KEY = /^(phone|mobile|msisdn|tel|telephone|email|e_?mail|customer_?name|guest_?name|diner_?name|waiter(_?name)?|staff_?name|employee_?name|user_?name|full_?name|first_?name|last_?name|surname|address|street|password|token|secret|api_?key|pin|kra_?pin|national_?id|id_?number|mpesa(_?\w*)?|bank(_?\w*)?|account_?number|card(_?number)?|payment_?(ref\w*|reference)|reference|contact(_?\w*)?|notes?|reason|comment)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+|\b00)?254[\s-]?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\b0[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\+\d{1,3}[\s-]?\d[\d\s-]{7,}\d/;
const LONG_DIGITS = /\b\d{10,}\b/;

const refuse = (kind, where) => new HttpError(400, 'This AI request was stopped because it contained personal details. Nothing was sent.', { code: 'ai_pii_blocked', kind, where });

function scanText(text, where) {
  if (typeof text !== 'string') return;
  if (EMAIL.test(text)) throw refuse('email', where);
  if (PHONE.test(text)) throw refuse('phone', where);
  if (LONG_DIGITS.test(text)) throw refuse('number', where);
}

function scanValue(value, where, depth = 0) {
  if (depth > 8) throw refuse('too_deep', where);
  if (typeof value === 'string') return scanText(value, where);
  if (Array.isArray(value)) { value.forEach((v, i) => scanValue(v, `${where}[${i}]`, depth + 1)); return; }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (DENIED_KEY.test(key)) throw refuse('field', `${where}.${key}`);
      scanValue(v, `${where}.${key}`, depth + 1);
    }
  }
}

/** Throws 400 { code: 'ai_pii_blocked' } when any part of the request looks personal. */
export function guardPrompt({ system, user, payload, cacheKey } = {}) {
  scanText(system, 'system');
  scanText(user, 'user');
  scanText(cacheKey, 'cacheKey');
  if (payload !== undefined) scanValue(payload, 'payload');
}
