// Proves firing order of row-level vs statement-level AFTER INSERT triggers on order_items.
import { freshDatabase, createUser } from '/Users/it-macmini-5/projects/p2/cravio/backend/tests/support/pg.js';
const db = await freshDatabase();
const owner = await createUser(db, 'o@x.test', { role: 'owner' });
const r = (await db.query(`insert into public.restaurants (owner_id,name,status) values ($1,'R','live') returning id`, [owner])).rows[0].id;
const cat = (await db.query(`insert into public.menu_categories (restaurant_id,name) values ($1,'c') returning id`, [r])).rows[0].id;
const mi = (await db.query(`insert into public.menu_items (restaurant_id,category_id,name,price) values ($1,$2,'d',1) returning id`, [r, cat])).rows[0].id;
await db.exec(`
 create table plog(n serial, who text);
 create function plog_fn() returns trigger language plpgsql as $$ begin insert into plog(who) values (tg_name); return null; end $$;
 create trigger zzz_row_late after insert on public.order_items for each row execute function plog_fn();
 create trigger aaa_row_early after insert on public.order_items for each row execute function plog_fn();
 create trigger aaa_stmt_early after insert on public.order_items referencing new table as t for each statement execute function plog_fn();
 create trigger zzz_stmt_late after insert on public.order_items referencing new table as t for each statement execute function plog_fn();`);
const o = (await db.query(`insert into public.orders (restaurant_id,status) values ($1,'taken') returning id`, [r])).rows[0].id;
await db.query(`insert into public.order_items (order_id,restaurant_id,item_id,name,unit_price,quantity,line_total) select $1,$2,$3,'d'||g,1,1,1 from generate_series(1,2) g`, [o, r, mi]);
console.log((await db.query('select who from plog order by n')).rows.map(x => x.who).join(' -> '));
const { rows } = await db.query(`select tgname from pg_trigger where tgrelid='public.order_items'::regclass and not tgisinternal order by tgname`);
console.log('all triggers alphabetical:', rows.map(x => x.tgname).join(', '));
