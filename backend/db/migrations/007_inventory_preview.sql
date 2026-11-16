-- Additive owner-scoped preview. No existing restaurant tables or policies are changed.
create table private.stock_businesses (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null unique references auth.users(id) on delete cascade,
 name text not null, created_at timestamptz not null default now()
);
create table private.stock_locations (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references private.stock_businesses(id) on delete cascade,
 name text not null, kind text not null check(kind in ('bakery','outlet','warehouse')), unique(business_id,name)
);
create table private.stock_products (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references private.stock_businesses(id) on delete cascade,
 sku text not null, name text not null, unit text not null, low_stock numeric(15,3) not null default 0 check(low_stock>=0), unique(business_id,sku)
);
create table private.stock_balances (
 business_id uuid not null references private.stock_businesses(id) on delete cascade,
 location_id uuid not null references private.stock_locations(id) on delete cascade,
 product_id uuid not null references private.stock_products(id) on delete cascade,
 quantity numeric(15,3) not null default 0 check(quantity>=0), primary key(location_id,product_id)
);
create table private.stock_transfers (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references private.stock_businesses(id) on delete cascade,
 source_id uuid not null references private.stock_locations(id), destination_id uuid not null references private.stock_locations(id),
 product_id uuid not null references private.stock_products(id), quantity numeric(15,3) not null check(quantity>0),
 received numeric(15,3) not null default 0, lost numeric(15,3) not null default 0,
 created_at timestamptz not null default now(), created_by uuid not null references auth.users(id),
 check(source_id<>destination_id), check(received>=0 and lost>=0 and received+lost<=quantity)
);
create table private.stock_movements (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references private.stock_businesses(id) on delete cascade,
 location_id uuid not null references private.stock_locations(id), product_id uuid not null references private.stock_products(id),
 kind text not null check(kind in ('opening','output','sale','waste','dispatch','receive','transit_loss','count')),
 quantity numeric(15,3) not null, reason text not null, batch text, expires_on date,
 transfer_id uuid references private.stock_transfers(id), actor_id uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create index stock_movements_business_time on private.stock_movements(business_id,created_at desc);
create table private.stock_commands (
 business_id uuid not null references private.stock_businesses(id) on delete cascade, command_id uuid not null,
 payload_hash text not null, result jsonb not null, primary key(business_id,command_id)
);
create table private.stock_tasks (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references private.stock_businesses(id) on delete cascade,
 location_id uuid references private.stock_locations(id), title text not null, day date not null,
 completed_at timestamptz, completed_by uuid references auth.users(id), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
-- Private tables have no Data API grants. Server APIs verify the owner on every request.
alter table private.stock_businesses enable row level security;
alter table private.stock_locations enable row level security;
alter table private.stock_products enable row level security;
alter table private.stock_balances enable row level security;
alter table private.stock_transfers enable row level security;
alter table private.stock_movements enable row level security;
alter table private.stock_commands enable row level security;
alter table private.stock_tasks enable row level security;
revoke all on private.stock_businesses,private.stock_locations,private.stock_products,private.stock_balances,private.stock_transfers,private.stock_movements,private.stock_commands,private.stock_tasks from public,anon,authenticated;
