import { requireRole } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';
import { transaction } from '../inventory/database.js';
import { command, snapshot, text } from '../inventory/domain.js';
async function handle({request,body}) {
  const context=await requireRole(request,'owner');
  try {
    return await transaction(context.user.id,async db=>{
      let business=(await db.query('select * from private.stock_businesses where owner_id=$1',[context.user.id])).rows[0];
      if(body?.action==='setup'){
        if(!business) business=(await db.query('insert into private.stock_businesses(owner_id,name) values($1,$2) returning *',[context.user.id,text(body.name,'Business name')])).rows[0];
      } else if(body){
        if(!business) throw new HttpError(409,'Set up your inventory business first.');
        await command(db,business.id,context.user.id,body);
      }
      return {business:business||null,...(business?await snapshot(db,business.id):{}),policy:{access:'Account owner only',units:'Explicit base units; no automatic pack or cake conversions',sales:'Manual entries; POS not connected',negativeStock:false}};
    });
  }catch(error){
    if(error.code==='42P01') throw new HttpError(503,'Inventory needs the new database migration before it can be used.');
    if(error.code==='23505') throw new HttpError(409,'This SKU or location already exists.');
    if(['22007','22008','23514','22P02','22003'].includes(error.code)) throw new HttpError(400,'Check the date, quantity and selected records.');
    throw error;
  }
}
export const routes=[{method:'GET',path:'/api/inventory',handler:handle},{method:'POST',path:'/api/inventory',handler:handle}];
