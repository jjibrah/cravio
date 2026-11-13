import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export const configured = Boolean(url && publicKey);

/** Queries as the signed-in user, so Row Level Security applies. Prefer this. */
export function userClient(token) {
  return createClient(url, publicKey, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
}

let verifier;
/** A shared anonymous client used only to verify access tokens (its JWKS cache is shared across requests). */
export function verifierClient() {
  verifier ||= createClient(url, publicKey, options);
  return verifier;
}

let service;
/** Bypasses RLS. Use only after the caller's permission has been checked in code. */
export function serviceClient() {
  if (!url || !serviceKey) throw new Error('The server is missing its Supabase service key.');
  service ||= createClient(url, serviceKey, options);
  return service;
}
