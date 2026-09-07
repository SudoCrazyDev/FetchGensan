-- FetchGensan :: job lifecycle RPCs
-- Clients never UPDATE jobs directly -- RLS forbids it. Every state change
-- goes through one of these functions so the money, the audit log, the
-- driver active_job_id and the wallet all move together.

-- A client-reported road distance can never be shorter than the straight
-- line between the two points, and in a city grid is rarely more than ~2.5x
-- it. Anything outside that band is a spoofed or broken client, so we fall
-- back to a conservative estimate rather than trusting or rejecting it.
create or replace function sanitize_distance(
  p_pickup   geography,
  p_dropoff  geography,
  p_reported int
)
returns int
language plpgsql
immutable
as $fn$
declare
  crow int;
begin
  crow := st_distance(p_pickup, p_dropoff)::int;

  if p_reported is null or p_reported < crow then
    -- 1.35 is the usual detour factor for a city street grid.
    return ceil(crow * 1.35)::int;
  end if;

  if p_reported > crow * 2.5 then
    return ceil(crow * 2.5)::int;
  end if;

  return p_reported;
end;
$fn$;

create or replace function point_of(p_lng double precision, p_lat double precision)
returns geography
language sql
immutable
as $fn$
  select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
$fn$;

create or replace function in_service_area(p_point geography)
returns boolean
language sql
stable
as $fn$
  -- No zones configured yet means "serve everywhere"; useful before launch.
  select not exists (select 1 from service_zones where is_active)
      or exists (select 1 from service_zones
                 where is_active and st_intersects(area, p_point));
$fn$;

-- ---------------------------------------------------------------- create

-- Books a job and prices it server-side. `p_items` is a JSON array for
-- errands: [{"name":"...","quantity":2,"unit":"kg","notes":"..."}]
create or replace function create_job(
  p_job_type         job_type,
  p_pickup_lng       double precision,
  p_pickup_lat       double precision,
  p_dropoff_lng      double precision,
  p_dropoff_lat      double precision,
  p_pickup_label     text default '',
  p_pickup_landmark  text default '',
  p_dropoff_label    text default '',
  p_dropoff_landmark text default '',
  p_notes            text default '',
  p_recipient_name   text default '',
  p_recipient_phone  text default '',
  p_reported_distance_m int default null,
  p_reported_duration_s int default null,
  p_items            jsonb default '[]'::jsonb,
  p_items_budget_centavos int default 0,
  p_payment_method   payment_method default 'cash',
  p_scheduled_for    timestamptz default null
)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  pickup geography;
  dropoff geography;
  dist int;
  q record;
  j jobs;
  item jsonb;
  idx int := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from profiles where id = auth.uid() and is_blocked) then
    raise exception 'this account cannot book' using errcode = 'insufficient_privilege';
  end if;

  -- One live booking at a time per customer. Without this, a customer
  -- tapping through a laggy screen books three habal-habal at once.
  if exists (
    select 1 from jobs
    where customer_id = auth.uid()
      and status in ('searching', 'assigned', 'arriving', 'arrived_pickup',
                     'shopping', 'awaiting_approval', 'in_progress')
  ) then
    raise exception 'you already have a booking in progress'
      using errcode = 'check_violation';
  end if;

  pickup := point_of(p_pickup_lng, p_pickup_lat);
  dropoff := point_of(p_dropoff_lng, p_dropoff_lat);

  if not in_service_area(pickup) then
    raise exception 'pickup is outside our service area'
      using errcode = 'check_violation';
  end if;

  if st_distance(pickup, dropoff) < 50 then
    raise exception 'pickup and drop-off are the same place'
      using errcode = 'check_violation';
  end if;

  if p_job_type <> 'errand' and p_items_budget_centavos > 0 then
    raise exception 'only errands carry an item budget' using errcode = 'check_violation';
  end if;

  dist := sanitize_distance(pickup, dropoff, p_reported_distance_m);

  select * into q from quote_fare(
    p_job_type, dist, coalesce(p_reported_duration_s, 0),
    coalesce(p_scheduled_for, now())
  );

  insert into jobs (
    customer_id, job_type, status,
    pickup_location, pickup_label, pickup_landmark,
    dropoff_location, dropoff_label, dropoff_landmark,
    recipient_name, recipient_phone, notes,
    distance_meters, duration_seconds,
    base_fare_centavos, distance_fare_centavos, time_fare_centavos,
    service_fee_centavos, night_surcharge_centavos, quoted_fare_centavos,
    items_budget_centavos, final_total_centavos,
    commission_bps, payment_method, scheduled_for
  ) values (
    auth.uid(), p_job_type,
    -- A scheduled booking waits as draft until its window opens.
    -- The casts are required: a bare CASE over string literals is `text`,
    -- and Postgres will not implicitly coerce that to an enum column.
    case when p_scheduled_for is null
         then 'searching'::job_status
         else 'draft'::job_status end,
    pickup, p_pickup_label, p_pickup_landmark,
    dropoff, p_dropoff_label, p_dropoff_landmark,
    p_recipient_name, p_recipient_phone, p_notes,
    dist, coalesce(p_reported_duration_s, 0),
    q.base_fare_centavos, q.distance_fare_centavos, q.time_fare_centavos,
    q.service_fee_centavos, q.night_surcharge_centavos, q.total_centavos,
    case when p_job_type = 'errand' then p_items_budget_centavos else 0 end,
    q.total_centavos,
    q.commission_bps, p_payment_method, p_scheduled_for
  )
  returning * into j;

  if p_job_type = 'errand' then
    for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
      insert into errand_items (job_id, position, name, quantity, unit, notes)
      values (
        j.id, idx,
        coalesce(item ->> 'name', 'Item'),
        coalesce((item ->> 'quantity')::numeric, 1),
        coalesce(item ->> 'unit', 'pc'),
        coalesce(item ->> 'notes', '')
      );
      idx := idx + 1;
    end loop;
  end if;

  -- Go straight out to nearby drivers. Done here rather than from a trigger
  -- on jobs: dispatch_job() writes back to jobs, and a trigger that fires
  -- itself is a bad way to find out about recursion.
  if j.status = 'searching' then
    perform dispatch_job(j.id);
    select * into j from jobs where id = j.id;
  end if;

  return j;
end;
$fn$;

-- ---------------------------------------------------------------- advance

-- Moves a job to its next status. The guard trigger decides whether the
-- transition is legal; this function decides whether the CALLER is allowed
-- to ask for it.
create or replace function advance_job(p_job_id uuid, p_to job_status)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.id is null then
    raise exception 'job not found' using errcode = 'no_data_found';
  end if;

  -- Only the assigned driver, or staff, drives a job forward. The one
  -- exception is a customer approving an errand receipt, which has its own
  -- function below.
  if not (j.driver_id = auth.uid() or is_staff()) then
    raise exception 'not your job' using errcode = 'insufficient_privilege';
  end if;

  if p_to = 'completed' then
    raise exception 'use complete_job() so the fare and wallet settle together'
      using errcode = 'check_violation';
  end if;
  if p_to = 'cancelled' then
    raise exception 'use cancel_job()' using errcode = 'check_violation';
  end if;

  update jobs set status = p_to where id = p_job_id returning * into j;
  return j;
end;
$fn$;

-- ---------------------------------------------------------------- errands

-- Driver is at the store and reports what things actually cost. This is the
-- heart of the errand product: the customer approved a fee, not a total, so
-- the real receipt has to come back for approval before delivery.
create or replace function submit_errand_receipt(
  p_job_id       uuid,
  p_items        jsonb,          -- [{"id":uuid,"actual_price_centavos":1234,"is_available":true,"substitute_note":""}]
  p_receipt_path text default null
)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
  item jsonb;
  items_total int := 0;
  cfg fare_config;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.driver_id <> auth.uid() and not is_staff() then
    raise exception 'not your job' using errcode = 'insufficient_privilege';
  end if;
  if j.job_type <> 'errand' then
    raise exception 'not an errand' using errcode = 'check_violation';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    update errand_items
       set actual_price_centavos = (item ->> 'actual_price_centavos')::int,
           is_available = coalesce((item ->> 'is_available')::boolean, true),
           substitute_note = coalesce(item ->> 'substitute_note', '')
     where id = (item ->> 'id')::uuid and job_id = p_job_id;
  end loop;

  select coalesce(sum(actual_price_centavos), 0) into items_total
    from errand_items
   where job_id = p_job_id and coalesce(is_available, true);

  cfg := active_fare_config('errand');
  if items_total > cfg.max_item_float_centavos then
    raise exception 'receipt total %c exceeds the %c float limit -- ask dispatch to approve',
      items_total, cfg.max_item_float_centavos using errcode = 'check_violation';
  end if;

  if p_receipt_path is not null then
    insert into errand_receipts (job_id, storage_path, total_centavos, uploaded_by)
    values (p_job_id, p_receipt_path, items_total, auth.uid());
  end if;

  update jobs
     set items_cost_centavos = items_total,
         final_total_centavos = quoted_fare_centavos + items_total,
         status = 'awaiting_approval'
   where id = p_job_id
  returning * into j;

  insert into job_events (job_id, actor_id, event_type, payload)
  values (p_job_id, auth.uid(), 'receipt_submitted',
          jsonb_build_object('items_cost_centavos', items_total,
                             'final_total_centavos', j.final_total_centavos));

  return j;
end;
$fn$;

-- Customer accepts the real total and the driver sets off to deliver.
create or replace function approve_errand_total(p_job_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.customer_id <> auth.uid() and not is_staff() then
    raise exception 'not your booking' using errcode = 'insufficient_privilege';
  end if;
  if j.status <> 'awaiting_approval' then
    raise exception 'nothing to approve' using errcode = 'check_violation';
  end if;

  update jobs set status = 'in_progress' where id = p_job_id returning * into j;

  insert into job_events (job_id, actor_id, event_type, payload)
  values (p_job_id, auth.uid(), 'total_approved',
          jsonb_build_object('final_total_centavos', j.final_total_centavos));

  return j;
end;
$fn$;

-- ---------------------------------------------------------------- finish

create or replace function complete_job(p_job_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.driver_id <> auth.uid() and not is_staff() then
    raise exception 'not your job' using errcode = 'insufficient_privilege';
  end if;

  if j.status = 'completed' then
    return j; -- idempotent: mobile data drops mid-request all the time
  end if;

  update jobs
     set status = 'completed',
         final_total_centavos = case
           when job_type = 'errand' then quoted_fare_centavos + items_cost_centavos
           else quoted_fare_centavos end,
         payment_status = case when payment_method = 'cash' then 'paid' else payment_status end
   where id = p_job_id
  returning * into j;

  perform settle_job_money(p_job_id);

  update drivers
     set active_job_id = null,
         completed_jobs = completed_jobs + 1
   where id = j.driver_id;

  select * into j from jobs where id = p_job_id;
  return j;
end;
$fn$;

create or replace function cancel_job(p_job_id uuid, p_reason text default '')
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.id is null then
    raise exception 'job not found' using errcode = 'no_data_found';
  end if;

  if not (j.customer_id = auth.uid() or j.driver_id = auth.uid() or is_staff()) then
    raise exception 'not your job' using errcode = 'insufficient_privilege';
  end if;

  -- Once the errand shopping has started the driver is holding goods they
  -- paid for. Cancelling then is a dispatcher decision, not a tap.
  if j.status in ('shopping', 'awaiting_approval') and not is_staff() then
    raise exception 'the driver has already bought your items -- contact dispatch'
      using errcode = 'check_violation';
  end if;

  update jobs
     set status = 'cancelled',
         cancelled_by = auth.uid(),
         cancel_reason = p_reason
   where id = p_job_id
  returning * into j;

  update job_offers set response = 'withdrawn', responded_at = now()
   where job_id = p_job_id and response = 'pending';

  if j.driver_id is not null then
    update drivers
       set active_job_id = null,
           cancelled_jobs = cancelled_jobs + case when j.cancelled_by = j.driver_id then 1 else 0 end
     where id = j.driver_id;
  end if;

  return j;
end;
$fn$;
