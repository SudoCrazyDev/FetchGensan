-- FetchGensan :: read models
-- Views that exist so a client can be given exactly the columns it needs,
-- and no more. Placed after jobs/job_offers because they depend on them.

-- What a customer is allowed to see about the driver assigned to them.
-- Deliberately narrow: name, photo, vehicle, rating. No phone number, no
-- location history, no wallet balance.
--
-- security_invoker is deliberately OFF (the view runs as its owner and so
-- bypasses RLS on drivers/profiles) because the authorisation lives in the
-- WHERE clause below instead. Restricting *columns* is what we need here,
-- and RLS only restricts rows -- a row policy permissive enough to show a
-- customer their driver name would also expose that driver wallet balance.
create view public_driver_info
with (security_invoker = false)
as
select
  d.id,
  p.full_name,
  p.avatar_path,
  d.vehicle_make,
  d.vehicle_model,
  d.vehicle_color,
  d.plate_number,
  driver_rating(d.*) as rating,
  d.rating_count,
  d.completed_jobs
from drivers d
join profiles p on p.id = d.id
where
  d.id = auth.uid()
  or is_staff()
  -- a driver who has been, or is about to be, on one of your bookings
  or exists (
    select 1 from jobs j
    where j.customer_id = auth.uid() and j.driver_id = d.id
  )
  or exists (
    select 1 from job_offers o
    join jobs j on j.id = o.job_id
    where j.customer_id = auth.uid()
      and o.driver_id = d.id
      and o.response = 'pending'
  );

-- Live position of the driver on one of your bookings, for the tracking map.
-- A function rather than a view so the job id is an explicit argument and
-- there is no way to enumerate the fleet.
create or replace function job_driver_position(p_job_id uuid)
returns table (lng double precision, lat double precision, heading numeric, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    st_x(d.location::geometry),
    st_y(d.location::geometry),
    d.heading,
    d.location_updated_at
  from jobs j
  join drivers d on d.id = j.driver_id
  where j.id = p_job_id
    and (j.customer_id = auth.uid() or j.driver_id = auth.uid() or is_staff())
    and j.status in ('assigned', 'arriving', 'arrived_pickup', 'shopping',
                     'awaiting_approval', 'in_progress');
$fn$;

-- The dispatcher live board. One row per in-flight job with everything the
-- console needs, so the admin app does not fan out into six queries.
create view dispatch_board
with (security_invoker = false)
as
select
  j.id,
  j.reference,
  j.job_type,
  j.status,
  j.created_at,
  j.assigned_at,
  j.scheduled_for,
  j.notes,
  j.dispatch_attempts,
  j.dispatch_radius_m,

  j.pickup_label,
  j.pickup_landmark,
  j.pickup_lng,
  j.pickup_lat,
  j.dropoff_label,
  j.dropoff_landmark,
  j.dropoff_lng,
  j.dropoff_lat,

  j.distance_meters,
  j.quoted_fare_centavos,
  j.items_cost_centavos,
  j.final_total_centavos,
  j.payment_method,
  j.payment_status,

  cust.full_name  as customer_name,
  cust.phone      as customer_phone,
  j.driver_id,
  drv.full_name   as driver_name,
  drv.phone       as driver_phone,
  d.plate_number,
  st_x(d.location::geometry) as driver_lng,
  st_y(d.location::geometry) as driver_lat,
  d.location_updated_at      as driver_location_updated_at,

  -- How long this has been waiting. The number a dispatcher actually scans.
  extract(epoch from now() - j.created_at)::int as age_seconds,
  (select count(*) from job_offers o
    where o.job_id = j.id and o.response = 'pending')::int as pending_offers
from jobs j
join profiles cust on cust.id = j.customer_id
left join drivers d on d.id = j.driver_id
left join profiles drv on drv.id = j.driver_id
where is_staff()
  and j.status in ('draft', 'searching', 'assigned', 'arriving', 'arrived_pickup',
                   'shopping', 'awaiting_approval', 'in_progress', 'expired');

-- Driver roster for the admin console, including the numbers that decide
-- whether someone can work: wallet balance and pending documents.
create view driver_roster
with (security_invoker = false)
as
select
  d.id,
  p.full_name,
  p.phone,
  p.is_blocked,
  d.status,
  d.is_online,
  d.plate_number,
  d.vehicle_make,
  d.vehicle_model,
  driver_rating(d.*) as rating,
  d.rating_count,
  d.completed_jobs,
  d.cancelled_jobs,
  d.wallet_balance_centavos,
  d.credit_floor_centavos,
  d.active_job_id,
  d.location_updated_at,
  can_accept_jobs(d.*) as is_dispatchable,
  (select count(*) from driver_documents dd
    where dd.driver_id = d.id and dd.status = 'pending')::int as pending_documents
from drivers d
join profiles p on p.id = d.id
where is_staff();
