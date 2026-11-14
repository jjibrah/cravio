import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/dashboard/PageFrame';
import { api, useApi } from '../../lib/api';
import { useNotifications } from '../../components/notifications/NotificationProvider';
import '../../components/owner/owner.css';
import './inventory.css';

const labels={opening:'Opening balance',output:'Finished production',sale:'Manual sale',waste:'Waste',dispatch:'Dispatch',count:'Physical count',receive:'Receive transfer',transit_loss:'Resolve transit loss'};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const date=value=>new Date(value).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'});
const qty=value=>Number(value).toLocaleString('en-KE',{maximumFractionDigits:3});
function Field({name,label,options,type='text',required=true,defaultValue,...props}) {
  const id=`inventory-${name}`;
  return <div className="iv-field"><label htmlFor={id}>{label}</label>{options
    ? <select id={id} name={name} required={required} defaultValue="" {...props}><option value="" disabled={required}>Choose…</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
    : <input id={id} name={name} type={type} required={required} defaultValue={defaultValue} {...props}/>}</div>;
}
function Panel({title,children}){return <section className="o-panel"><header className="o-panel-head"><h2 className="o-panel-title">{title}</h2></header><div className="o-panel-body">{children}</div></section>;}
function Table({heads,rows,empty}){return <div className="iv-scroll"><table className="iv-table"><thead><tr>{heads.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.length?rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>):<tr><td colSpan={heads.length} className="iv-empty">{empty}</td></tr>}</tbody></table></div>;}

export default function InventoryPage({section}) {
  const {data,error,loading,refresh}=useApi('/api/inventory',{ttl:5000});
  const {notify}=useNotifications();
  const [params,setParams]=useSearchParams();
  const tabs=['Stock','Locations','Products','Record','Transfers','History'];
  const requested=params.get('view');
  const tab=tabs.includes(requested)?requested:'Stock';
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState('');
  const [movement,setMovement]=useState('output');
  const [location,setLocation]=useState('');
  const [product,setProduct]=useState('');
  const request=useRef(null);
  const countBasis=useRef(null);
  const submit=action=>async event=>{
    event.preventDefault(); if(busy)return;
    const form=event.currentTarget;
    const body={action,...Object.fromEntries(new FormData(form))};
    if(action==='movement'){
      body.action=movement;
      if(movement==='count')body.expectedBalance=countBasis.current?.balance ?? data.balances.find(b=>b.location_id===body.locationId&&b.product_id===body.productId)?.quantity ?? '0';
    }
    const signature=JSON.stringify(body);
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    body.commandId=request.current.id;
    setBusy(true);setFailure('');
    try{
      await api('/api/inventory',{method:'POST',body});
      request.current=null;countBasis.current=null;
      if(!['movement','complete_task'].includes(action))form.reset();
      await refresh();notify('Changes recorded');
    }catch(e){setFailure(e.message);}finally{setBusy(false);}
  };
  const locations=data?.locations||[], products=data?.products||[];
  const locationName=id=>locations.find(x=>x.id===id)?.name||'—';
  const productName=id=>products.find(x=>x.id===id)?.name||'—';
  const balance=(l,p)=>data?.balances?.find(b=>b.location_id===l&&b.product_id===p)?.quantity||'0';
  const transfers=data?.transfers||[];
  const unresolved=transfers.filter(t=>Number(t.remaining)>0);
  const button=(label='Record')=><button className="o-btn is-primary" disabled={busy}>{busy?'Saving…':label}</button>;
  const selection=<><Field name="locationId" label="Location" options={locations} onChange={e=>{setLocation(e.target.value);countBasis.current=null;}}/><Field name="productId" label="Product" options={products} onChange={e=>{setProduct(e.target.value);countBasis.current=null;}}/></>;
  return <div className="iv-page"><PageHeader title={section.label} description={section.description}><button type="button" className="o-btn" onClick={refresh} disabled={busy}>Refresh</button></PageHeader>
    {error&&<div className="iv-notice" role="alert">{error.message} <button className="o-btn" onClick={refresh}>Try again</button></div>}
    {failure&&<div className="iv-notice" role="alert">{failure}</div>}
    {loading&&<p role="status">Loading your business…</p>}
    {data&&!data.business&&<Panel title="Set up inventory"><p className="iv-muted">Create an inventory workspace for your account. Add your real locations and product units; nothing is prefilled with assumed Fayaz data.</p><form className="iv-form" onSubmit={submit('setup')}><Field name="name" label="Business name" maxLength={160}/>{button('Create workspace')}</form></Panel>}
    {data?.business&&<>
      <div className="iv-context"><strong>{data.business.name}</strong><span>Account owner access · Manual sales · Base units</span></div>
      {section.path==='inventory'&&<>
        <nav className="o-segmented" aria-label="Inventory views">{tabs.map(t=><button key={t} type="button" className={`o-segment${tab===t?' is-selected':''}`} aria-current={tab===t?'page':undefined} onClick={()=>{setParams({view:t});setFailure('');}}>{t}</button>)}</nav>
        {tab==='Stock'&&<Panel title="Stock by location"><p className="iv-muted">As of {date(data.asOf)}. Sales are manual entries; this balance is not connected to the POS. Low-stock thresholds are configured per product.</p><Table heads={['Location','Product','On hand','Unit','Attention']} rows={locations.flatMap(l=>products.map(p=>[l.name,p.name,qty(balance(l.id,p.id)),p.unit,Number(balance(l.id,p.id))<=Number(p.low_stock)?'At or below threshold':'—']))} empty="Add locations and products to start tracking stock."/></Panel>}
        {tab==='Locations'&&<Panel title="Locations"><form className="iv-form" onSubmit={submit('location')}><Field name="name" label="Location name" maxLength={160}/><Field name="kind" label="Type" options={[{id:'bakery',name:'Bakery / production'},{id:'outlet',name:'Sales outlet'},{id:'warehouse',name:'Warehouse'}]}/>{button('Add location')}</form><Table heads={['Location','Type']} rows={locations.map(l=>[l.name,l.kind])} empty="Add the bakery and each outlet separately."/></Panel>}
        {tab==='Products'&&<Panel title="Finished products"><p className="iv-muted">Choose one base unit for each SKU. Enter quantities in that unit throughout. Tray-to-piece and cake-to-slice conversions are not automated in this preview.</p><form className="iv-form" onSubmit={submit('product')}><Field name="sku" label="SKU / product code" maxLength={60}/><Field name="name" label="Product name" maxLength={160}/><Field name="unit" label="Base unit (for example, piece)" maxLength={30}/><Field name="lowStock" label="Low-stock threshold" type="number" min="0" max="999999999" step="0.001" defaultValue="0"/>{button('Add product')}</form><Table heads={['SKU','Product','Base unit','Threshold']} rows={products.map(p=>[p.sku,p.name,p.unit,qty(p.low_stock)])} empty="Add a finished product to begin."/></Panel>}
        {tab==='Record'&&<Panel title="Record a stock movement"><p className="iv-muted">Every posting is saved with your account, time and reference. Negative stock is blocked. Sales recorded here do not change Cravio orders or mark bills paid.</p><form className="iv-form" onSubmit={submit('movement')}>
          <Field name="kind" label="Movement" options={['opening','output','sale','waste','dispatch','count'].map(id=>({id,name:labels[id]}))} value={movement} onChange={e=>{setMovement(e.target.value);countBasis.current=null;}}/>{selection}
          {movement==='dispatch'&&<Field name="destinationId" label="Destination" options={locations.filter(l=>l.id!==location)}/>}
          <Field name="quantity" label={movement==='count'?'Physical quantity counted':'Quantity in product base units'} onFocus={()=>{if(movement==='count'&&!countBasis.current)countBasis.current={balance:balance(location,product)};}} type="number" min={movement==='count'?'0':'0.001'} max="999999999" step="0.001"/>
          <Field name="reason" label="Reference / reason" maxLength={500}/>
          {movement==='output'&&<><Field name="batch" label="Batch reference (optional)" required={false}/><Field name="expiresOn" label="Expiry date (optional)" type="date" required={false}/></>}
          {location&&product&&<p className="iv-muted">Current recorded balance: {qty(balance(location,product))} {products.find(p=>p.id===product)?.unit}. {movement==='count'?'Submitting replaces the expected balance with your physical count and records the difference. Count while movements are paused.':''}</p>}
          {movement==='count'&&<label className="iv-check"><input type="checkbox" required/>I have checked the physical count and approve posting its difference.</label>}{button('Post movement')}
        </form></Panel>}
        {tab==='Transfers'&&<><Panel title="Dispatched stock"><p className="iv-muted">A dispatch reduces source stock. Only confirmed receipts increase destination stock. Outstanding quantities remain in transit until received or explicitly recorded as loss.</p><Table heads={['Sent','From → to','Product','Sent quantity','Received','Transit loss','Unresolved']} rows={transfers.map(t=>[date(t.created_at),`${locationName(t.source_id)} → ${locationName(t.destination_id)}`,productName(t.product_id),qty(t.quantity),qty(t.received),qty(t.lost),qty(t.remaining)])} empty="Record a dispatch to create a transfer."/></Panel><Panel title="Receive or resolve"><form className="iv-form" onSubmit={submit('transfer')}><Field name="action" label="Action" options={['receive','transit_loss'].map(id=>({id,name:labels[id]}))}/><Field name="transferId" label="Outstanding transfer" options={unresolved.map(t=>({id:t.id,name:`${locationName(t.source_id)} → ${locationName(t.destination_id)} · ${productName(t.product_id)} · ${qty(t.remaining)} unresolved`}))}/><Field name="quantity" label="Quantity to receive / record as lost" type="number" min="0.001" step="0.001"/><Field name="reason" label="Receipt reference / loss reason" maxLength={500}/>{button('Confirm')}</form></Panel></>}
        {tab==='History'&&<Panel title="Movement history"><p className="iv-muted">Most recent 200 posted entries. Batch and expiry fields record production provenance; batch-level depletion and expiry availability are future work.</p><Table heads={['When','Location','Product','Action','Quantity','Reference','Batch','Actor']} rows={data.movements.map(m=>[date(m.created_at),locationName(m.location_id),productName(m.product_id),labels[m.kind],qty(m.quantity),m.reason,m.batch||'—',m.actor_id])} empty="Posted movements will appear here."/></Panel>}
      </>}
      {section.path==='management'&&<><Panel title="Daily checklist"><p className="iv-muted">Create tasks for a specific day and location. Completion is timestamped and attributed to your account. Recurring templates, team assignment and approval rules will follow the agreed SOP.</p><form className="iv-form" onSubmit={submit('task')}><Field name="title" label="Task" maxLength={300}/><Field name="locationId" label="Location (optional)" options={locations} required={false}/><Field name="day" label="Business day" type="date" defaultValue={today()}/>{button('Add task')}</form><Table heads={['Day','Location','Task','Status','Action']} rows={data.tasks.map(t=>[String(t.day).slice(0,10),locationName(t.location_id),t.title,t.completed_at?`Completed ${date(t.completed_at)}`:'Open',t.completed_at?'—':<form onSubmit={submit('complete_task')}><input type="hidden" name="taskId" value={t.id}/>{button('Complete')}</form>])} empty="Add your opening, closing or handover tasks."/></Panel></>}
      {section.path==='assistant'&&<><div className="iv-notice"><strong>AI placeholder · OpenRouter not connected</strong><p>No model is running and no business data is sent to an AI provider. The facts below come directly from your inventory records.</p></div><Panel title="Owner briefing — recorded facts"><dl className="iv-facts"><div><dt>Locations</dt><dd>{locations.length}</dd></div><div><dt>Finished products</dt><dd>{products.length}</dd></div><div><dt>Unresolved transfers</dt><dd>{unresolved.length}</dd></div><div><dt>Open checklist tasks</dt><dd>{data.tasks.filter(t=>!t.completed_at).length}</dd></div></dl><p className="iv-muted">Source: your inventory workspace, as of {date(data.asOf)}. Sales and waste reflect manual postings only. Checklist counts cover the most recent 200 tasks.</p></Panel><Panel title="Planned assistance"><p>Daily briefings with linked records, questions about stock and sales, and reviewed menu-import drafts will use OpenRouter after a model, budget and data policy are configured.</p><p className="iv-muted">Demand forecasts need complete sales history. Ingredient-margin advice needs recipe costs. Neither is available in this preview.</p></Panel></>}
    </>}
  </div>;
}
