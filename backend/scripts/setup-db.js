import { readFileSync } from 'node:fs';
import { createDatabase, env } from './clients.js';

const db = createDatabase();
const reset = process.argv.includes('--reset');
const email = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
if (!email || !email.includes('@')) throw new Error('Set SUPER_ADMIN_EMAIL in backend/.env first.');
if (reset && !process.argv.includes('--confirm-reset')) {
  throw new Error('Reset deletes application data and Auth users. Pass --confirm-reset explicitly.');
}

try {
  await db.connect();
  await db.query('begin');
  if (reset) {
    const { rows: [storage] } = await db.query('select count(*)::int as count from storage.objects');
    if (storage.count) throw new Error('Empty Storage using the Storage API before resetting Auth users.');
    await db.query('drop trigger if exists cravio_auth_user_created on auth.users');
    await db.query('drop schema if exists private cascade');
    await db.query('drop schema public cascade');
    await db.query('create schema public authorization postgres');
    await db.query('grant usage on schema public to anon, authenticated, service_role');
    await db.query('delete from auth.users');
  }
  await db.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(`insert into private.admin_account (singleton, email) values (true, $1)
    on conflict (singleton) do update set email = excluded.email`, [email]);
  // Also handles an admin created manually before this script was run.
  await db.query(`insert into public.profiles (id, name, role)
    select id, 'Super Admin', 'admin' from auth.users where lower(email) = $1
    on conflict (id) do update set role = 'admin'`, [email]);
  await db.query('commit');
  console.log(reset ? 'Application schema and Auth users reset; role schema installed.' : 'Role schema installed.');
  console.log(`Reserved admin email: ${email}. Create and confirm this user in Supabase Auth.`);
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error('Database setup failed:', error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
