import { createHash } from 'node:crypto';
import { HttpError } from '../lib/http.js';
const fail = (message) => { throw new HttpError(400, message); };
export const text = (value, label, max=160) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length>max) fail(`${label} is required (up to ${max} characters).`);
  return value.trim();
};
export function quantity(value, zero=false) {
  const s=String(value ?? '');
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s) || (!zero && Number(s)===0)) fail('Enter a positive quantity with up to three decimal places.');
  return s;
}
export function uuid(value) {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('Choose a valid record.');
  return value;
}
async function member(db, table, id, business) {
  const result=await db.query(`select * from private.${table} where id=$1 and business_id=$2`,[uuid(id),business]);
  if (!result.rowCount) throw new HttpError(404,'This record is not part of your business.');
  return result.rows[0];
}
export async function command(db, business, actor, body) {
  const key=uuid(body.commandId);
  const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const previous=await db.query('select * from private.stock_commands where business_id=$1 and command_id=$2',[business,key]);
  if(previous.rowCount){
    if(previous.rows[0].payload_hash!==hash) throw new HttpError(409,'This submission was already used with different details. Refresh before retrying.');
    return previous.rows[0].result;
  }
  const reason=body.reason ? text(body.reason,'Reason',500) : '';
  let result={ok:true};
  const log=async(location,product,kind,amount,transfer=null)=>{
    await db.query(`insert into private.stock_movements(business_id,location_id,product_id,kind,quantity,reason,batch,expires_on,transfer_id,actor_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[business,location,product,kind,amount,reason,body.batch?text(body.batch,'Batch'):null,body.expiresOn||null,transfer,actor]);
  };
  const change=async(location,product,delta)=>{
    await db.query(`insert into private.stock_balances(business_id,location_id,product_id) values($1,$2,$3) on conflict do nothing`,[business,location,product]);
    const updated=await db.query(`update private.stock_balances set quantity=quantity+$3::numeric where location_id=$1 and product_id=$2 and quantity+$3::numeric>=0 returning quantity`,[location,product,delta]);
    if(!updated.rowCount) throw new HttpError(409,'Not enough stock. Refresh the balance and check the quantity.');
  };
  if(body.action==='location'){
    const kind=body.kind;
    if(!['bakery','outlet','warehouse'].includes(kind)) fail('Choose a location type.');
    const row=await db.query('insert into private.stock_locations(business_id,name,kind) values($1,$2,$3) returning id',[business,text(body.name,'Location name'),kind]);
    result.id=row.rows[0].id;
  } else if(body.action==='product'){
    const row=await db.query('insert into private.stock_products(business_id,sku,name,unit,low_stock) values($1,$2,$3,$4,$5) returning id',[business,text(body.sku,'SKU',60),text(body.name,'Product name'),text(body.unit,'Base unit',30),quantity(body.lowStock||'0',true)]);
    result.id=row.rows[0].id;
  } else if(body.action==='task'){
    if(body.locationId) await member(db,'stock_locations',body.locationId,business);
    await db.query('insert into private.stock_tasks(business_id,location_id,title,day,created_by) values($1,$2,$3,$4,$5)',[business,body.locationId||null,text(body.title,'Task',300),body.day,actor]);
  } else if(body.action==='complete_task'){
    const task=await member(db,'stock_tasks',body.taskId,business);
    if(!task.completed_at) await db.query('update private.stock_tasks set completed_at=now(),completed_by=$2 where id=$1',[task.id,actor]);
  } else if(['receive','transit_loss'].includes(body.action)){
    const transfer=await member(db,'stock_transfers',body.transferId,business);
    const amount=quantity(body.quantity);
    if(!reason) fail('Record a receipt reference or a reason for the transit loss.');
    const field=body.action==='receive'?'received':'lost';
    const updated=await db.query(`update private.stock_transfers set ${field}=${field}+$2::numeric where id=$1 and received+lost+$2::numeric<=quantity returning id`,[transfer.id,amount]);
    if(!updated.rowCount) throw new HttpError(409,'Quantity exceeds the unresolved amount in this transfer.');
    if(body.action==='receive') await change(transfer.destination_id,transfer.product_id,amount);
    await log(transfer.destination_id,transfer.product_id,body.action,amount,transfer.id);
  } else if(['opening','output','sale','waste','dispatch','count'].includes(body.action)){
    if(!reason) fail('A reference or reason is required for this stock movement.');
    await member(db,'stock_locations',body.locationId,business);
    await member(db,'stock_products',body.productId,business);
    const amount=quantity(body.quantity,body.action==='count');
    if(body.action==='opening' && (await db.query('select 1 from private.stock_movements where location_id=$1 and product_id=$2 limit 1',[body.locationId,body.productId])).rowCount) throw new HttpError(409,'Opening stock can only be recorded before the first movement. Use a physical count to reconcile existing stock.');
    if(body.action==='dispatch'){
      await member(db,'stock_locations',body.destinationId,business);
      if(body.destinationId===body.locationId) fail('Choose a different destination.');
      await change(body.locationId,body.productId,`-${amount}`);
      const row=await db.query(`insert into private.stock_transfers(business_id,source_id,destination_id,product_id,quantity,created_by) values($1,$2,$3,$4,$5,$6) returning id`,[business,body.locationId,body.destinationId,body.productId,amount,actor]);
      await log(body.locationId,body.productId,'dispatch',`-${amount}`,row.rows[0].id);
      result.id=row.rows[0].id;
    } else if(body.action==='count'){
      const balance=await db.query('select quantity from private.stock_balances where location_id=$1 and product_id=$2',[body.locationId,body.productId]);
      const expected=quantity(body.expectedBalance,true);
      if(!(await db.query('select $1::numeric=$2::numeric as same',[expected,balance.rows[0]?.quantity||'0'])).rows[0].same) throw new HttpError(409,'Stock changed while you counted. Refresh and reconcile the intervening movement.');
      // Decimal subtraction is performed by Postgres, never binary floating point.
      const delta=(await db.query('select $1::numeric-$2::numeric as delta',[amount,balance.rows[0]?.quantity||'0'])).rows[0].delta;
      await change(body.locationId,body.productId,delta);
      await log(body.locationId,body.productId,'count',delta);
    } else {
      const delta=['sale','waste'].includes(body.action)?`-${amount}`:amount;
      await change(body.locationId,body.productId,delta);
      await log(body.locationId,body.productId,body.action,delta);
    }
  } else fail('Choose a supported inventory action.');
  await db.query('insert into private.stock_commands values($1,$2,$3,$4)',[business,key,hash,result]);
  return result;
}
export async function snapshot(db,business) {
  const queries={
    locations:['select * from private.stock_locations where business_id=$1 order by name'],
    products:['select * from private.stock_products where business_id=$1 order by name'],
    balances:['select * from private.stock_balances where business_id=$1'],
    transfers:['select *,quantity-received-lost as remaining from private.stock_transfers where business_id=$1 order by created_at desc'],
    movements:['select * from private.stock_movements where business_id=$1 order by created_at desc limit 200'],
    tasks:['select *,day::text as day from private.stock_tasks where business_id=$1 order by day desc,created_at desc limit 200'],
  };
  const result={};
  for(const [key,[sql]] of Object.entries(queries)) result[key]=(await db.query(sql,[business])).rows;
  return {...result,asOf:new Date().toISOString()};
}
