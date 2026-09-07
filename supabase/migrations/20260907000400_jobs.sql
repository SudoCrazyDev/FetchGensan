-- FetchGensan :: jobs -- rides, errands and deliveries in one table
-- One table with a `job_type` discriminator. The three products share ~90%
-- of their lifecycle, contacts, geography and money; splitting them would
-- triple the dispatch and RLS surface for no gain.

create table jobs (
  id                uuid primary key default gen_random_uuid(),
  reference         text not null unique default generate_job_reference(),

  customer_id       uuid not null references profiles (id) on delete restrict,
  driver_id         uuid references drivers (id) on delete set null,

  job_type          job_type not null,
  status            job_status not null default 'draft',

  -- ------------------------------------------------------------ geography
  -- For a ride/delivery, pickup is where the customer or parcel is.
  -- For an errand, pickup is the STORE and dropoff is the customer.
  pickup_location   geography (point, 4326) not null,
  pickup_label      text not null default '',
  pickup_landmark   text not null default '',

  dropoff_location  geography (point, 4326) not null,
  dropoff_label     text not null default '',
  dropoff_landmark  text not null default '',

  -- Deliveries often go to someone who is not the account holder.
  recipient_name    text not null default '',
  recipient_phone   text not null default '',

  notes             text not null default '',

  distance_meters   int not null default 0,
  duration_seconds  int not null default 0,

  -- ------------------------------------------------------------ money
  -- Every amount is integer centavos. quoted_* is what the customer agreed
  -- to at booking; items_cost is discovered at the store; final_total is
  -- what changes hands.
  base_fare_centavos       int not null default 0,
  distance_fare_centavos   int not null default 0,
  time_fare_centavos       int not null default 0,
  service_fee_centavos     int not null default 0,
  night_surcharge_centavos int not null default 0,
  quoted_fare_centavos     int not null default 0,

  items_cost_centavos      int not null default 0,  -- errand: receipt total
  items_budget_centavos    int not null default 0,  -- errand: customer's cap

  final_total_centavos     int not null default 0,
  commission_bps           int not null default 0,
  commission_centavos      int not null default 0,

  payment_method    payment_method not null default 'cash',
  payment_status    payment_status not null default 'pending',

  -- ------------------------------------------------------------ timing
  scheduled_for     timestamptz,           -- null = ASAP
  dispatch_radius_m int not null default 2000,
  dispatch_attempts int not null default 0,

  created_at        timestamptz not null default now(),
  assigned_at       timestamptz,
  arrived_pickup_at timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,

  cancelled_by      uuid references profiles (id),
  cancel_reason     text,

  updated_at        timestamptz not null default now(),

  -- Plain lng/lat alongside the geography columns.
  --
  -- PostgREST serialises a `geography` as WKB hex, which no client can use
  -- without a parser. Generated columns mean every existing select and
  -- every RLS policy gets usable coordinates for free -- no extra view, no
  -- second round trip on the tracking screen. Stored rather than virtual
  -- so they can be indexed later if needed.
  pickup_lng   double precision generated always as (st_x(pickup_location::geometry)) stored,
  pickup_lat   double precision generated always as (st_y(pickup_location::geometry)) stored,
  dropoff_lng  double precision generated always as (st_x(dropoff_location::geometry)) stored,
  dropoff_lat  double precision generated always as (st_y(dropoff_location::geometry)) stored,

  constraint jobs_money_nonneg check (
    quoted_fare_centavos >= 0
    and items_cost_centavos >= 0
    and items_budget_centavos >= 0
    and final_total_centavos >= 0
    and commission_centavos >= 0
  ),
  -- A job past `assigned` must have a driver. Guards against a stray update
  -- clearing driver_id while the job is live.
  constraint jobs_driver_required check (
    status in ('draft', 'searching', 'cancelled', 'expired') or driver_id is not null
  ),
  -- Only errands carry item costs.
  constraint jobs_items_only_errand check (
    job_type = 'errand' or (items_cost_centavos = 0 and items_budget_centavos = 0)
  )
);

create trigger jobs_updated_at before update on jobs
  for each row execute function set_updated_at();

create index jobs_customer_idx on jobs (customer_id, created_at desc);
create index jobs_driver_idx on jobs (driver_id, created_at desc);
create index jobs_status_idx on jobs (status, created_at desc);
-- The dispatcher's live board reads exactly this set.
create index jobs_live_idx on jobs (created_at desc)
  where status in ('searching', 'assigned', 'arriving', 'arrived_pickup',
                   'shopping', 'awaiting_approval', 'in_progress');
create index jobs_pickup_idx on jobs using gist (pickup_location);
create index jobs_scheduled_idx on jobs (scheduled_for)
  where scheduled_for is not null and status = 'draft';

-- Only one live job per driver, enforced at the database. Two concurrent
-- accepts cannot both win.
create unique index jobs_one_active_per_driver_idx on jobs (driver_id)
  where status in ('assigned', 'arriving', 'arrived_pickup', 'shopping',
                   'awaiting_approval', 'in_progress');

-- ---------------------------------------------------------------- errand items

create table errand_items (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references jobs (id) on delete cascade,
  position             int not null default 0,
  name                 text not null,
  quantity             numeric (10, 2) not null default 1,
  unit                 text not null default 'pc',
  notes                text not null default '',
  -- Filled in by the driver at the store.
  actual_price_centavos int,
  is_available          boolean,
  substitute_note       text not null default '',
  created_at            timestamptz not null default now(),

  constraint errand_items_qty_positive check (quantity > 0),
  constraint errand_items_price_nonneg check (actual_price_centavos is null or actual_price_centavos >= 0)
);

create index errand_items_job_idx on errand_items (job_id, position);

-- Receipt photos the driver uploads before asking for approval. Multiple,
-- because a single supermarket run can produce several receipts.
create table errand_receipts (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references jobs (id) on delete cascade,
  storage_path text not null,
  total_centavos int not null default 0,
  uploaded_by  uuid not null references profiles (id),
  created_at   timestamptz not null default now()
);

create index errand_receipts_job_idx on errand_receipts (job_id);

-- ---------------------------------------------------------------- audit log

-- Append-only. This is what you read when a customer and a driver disagree
-- about what happened, so nothing here is ever updated or deleted.
create table job_events (
  id          bigserial primary key,
  job_id      uuid not null references jobs (id) on delete cascade,
  actor_id    uuid references profiles (id),
  event_type  text not null,
  from_status job_status,
  to_status   job_status,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index job_events_job_idx on job_events (job_id, created_at);
