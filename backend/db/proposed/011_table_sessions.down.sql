-- Rollback for 011_table_sessions.sql. Removes table sessions and the guest_carts link.
-- Orders and guest carts stay; carts simply lose which session they came from.
alter table if exists public.guest_carts drop column if exists session_id;
drop table if exists public.table_session_members, public.table_sessions;
