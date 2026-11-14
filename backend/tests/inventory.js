// Runs all writes (including migration rehearsal) inside a transaction that always rolls back.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDatabase } from '../scripts/clients.js';
import { command, quantity } from '../src/inventory/domain.js';
const db=createDatabase();
let checks=0;
const equal=(a,b)=>{assert.equal(a,b);checks++;};
try {
 await db.connect();await db.query('begin');
 if(!(await db.query("select to_regclass('private.stock_businesses') as table")).rows[0].table)await db.query(readFileSync(new URL('../db/migrations/007_inventory_preview.sql',import.meta.url),'utf8'));
 const users=(await db.query('select id from auth.users limit 2')).rows;
 assert.equal(users.length,2,'Need two existing users for rollback-only fixtures.');
 // A savepoint lets rejected commands fail without aborting the outer rehearsal transaction.
 const rejects=async(fn,status)=>{await db.query('savepoint expected_error');try{await assert.rejects(fn,e=>e.status===status);checks++;}finally{await db.query('rollback to savepoint expected_error');}};
 const owner=users[0].id, otherOwner=users[1].id;
 // Existing inventory is never changed. Refuse fixtures for users with a claimed business.
 const existing=await db.query('select 1 from private.stock_businesses where owner_id=any($1::uuid[])',[users.map(u=>u.id)]);
 assert.equal(existing.rowCount,0,'Choose unclaimed users; refusing to test against existing inventory.');
 const business=(await db.query("insert into private.stock_businesses(owner_id,name) values($1,'Rollback test') returning id",[owner])).rows[0].id;
 const other=(await db.query("insert into private.stock_businesses(owner_id,name) values($1,'Other rollback test') returning id",[otherOwner])).rows[0].id;
 const run=body=>command(db,business,owner,{commandId:randomUUID(),...body});
 const a=(await run({action:'location',name:'Bakery',kind:'bakery'})).id;
 const b=(await run({action:'location',name:'Outlet',kind:'outlet'})).id;
 const p=(await run({action:'product',sku:'TEST',name:'Pastry',unit:'piece',lowStock:'2'})).id;
 const bal=async l=>String((await db.query('select quantity from private.stock_balances where location_id=$1 and product_id=$2',[l,p])).rows[0]?.quantity||'0');
 const entry={action:'output',locationId:a,productId:p,quantity:'100.125',reason:'Batch',commandId:randomUUID()};
 await run(entry);await run(entry);equal(await bal(a),'100.125');
 await rejects(()=>run({...entry,quantity:'1'}),409);
 await rejects(()=>run({action:'sale',locationId:a,productId:p,quantity:'101',reason:'oversell'}),409);equal(await bal(a),'100.125');
 const transfer=(await run({action:'dispatch',locationId:a,destinationId:b,productId:p,quantity:'50',reason:'Delivery'})).id;
 equal(await bal(a),'50.125');equal(await bal(b),'0');
 const receipt={action:'receive',transferId:transfer,quantity:'47',reason:'Receiver count',commandId:randomUUID()};
 await run(receipt);await run(receipt);equal(await bal(b),'47.000');
 equal((await db.query('select (quantity-received-lost)::text as remaining from private.stock_transfers where id=$1',[transfer])).rows[0].remaining,'3.000');
 await rejects(()=>run({action:'receive',transferId:transfer,quantity:'4',reason:'too much'}),409);
 await run({action:'transit_loss',transferId:transfer,quantity:'3',reason:'Damaged in transit'});
 equal((await db.query('select (quantity-received-lost)::text as remaining from private.stock_transfers where id=$1',[transfer])).rows[0].remaining,'0.000');
 await run({action:'sale',locationId:b,productId:p,quantity:'7',reason:'POS close'});
 await rejects(()=>run({action:'count',locationId:b,productId:p,quantity:'39',expectedBalance:'47',reason:'stale count'}),409);
 await run({action:'count',locationId:b,productId:p,quantity:'39',expectedBalance:'40',reason:'Approved count'});equal(await bal(b),'39.000');
 await rejects(()=>command(db,other,otherOwner,{commandId:randomUUID(),action:'sale',locationId:a,productId:p,quantity:'1',reason:'cross-business'}),404);
 await rejects(()=>run({action:'opening',locationId:a,productId:p,quantity:'10',reason:'duplicate opening'}),409);
 for(const table of ['stock_businesses','stock_locations','stock_products','stock_balances','stock_transfers','stock_movements','stock_commands','stock_tasks']){
  const r=(await db.query("select relrowsecurity,has_table_privilege('authenticated',oid,'select') as readable from pg_class where oid=$1::regclass",[`private.${table}`])).rows[0];equal(r.relrowsecurity,true);equal(r.readable,false);
 }
 assert.throws(()=>quantity('0.0001'));assert.throws(()=>quantity('-1'));checks+=2;
 console.log(`Inventory: ${checks} assertions passed. All fixtures and DDL rolled back.`);
} finally {await db.query('rollback').catch(()=>{});await db.end();}
