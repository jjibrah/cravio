/* Public (signed-out) calls from the guest's phone, with the anonymous visitor id (docs/API.md §1). */

const VISITOR_KEY = 'cravio-visitor';
let memoryVisitor = '';

const randomId = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/** One random id per phone, kept in localStorage (or memory when storage is blocked). */
export function visitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) { id = randomId(); localStorage.setItem(VISITOR_KEY, id); }
    return id;
  } catch {
    if (!memoryVisitor) memoryVisitor = randomId();
    return memoryVisitor;
  }
}

export class GuestApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details || {}; }
}

/** fetch() for /api/public/*: adds X-Cravio-Visitor, parses JSON, throws GuestApiError with the server's sentence. */
export async function publicApi(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}${path}`, {
    method,
    signal,
    headers: { 'X-Cravio-Visitor': visitorId(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((error) => {
    if (error.name === 'AbortError') throw error;
    throw new GuestApiError(0, 'You seem to be offline. Check your connection and try again.');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new GuestApiError(response.status, data.error || 'Something went wrong. Please try again.', data.details);
  return data;
}

/** Safe localStorage JSON helpers. */
export function readJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
export function writeJson(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep in memory */ }
}

/** "ACD347" → "ACD 347" */
export const groupCode = (code = '') => `${code.slice(0, 3)} ${code.slice(3)}`.trim();
