-- FetchGensan :: admin console RPCs and read models
--
-- The console shipped calling raw `.update()` on `drivers` and `jobs`, which
-- the column-level grants in 20260907001100 refuse: `authenticated` may only
-- write vehicle details on `drivers`, and nothing at all on `jobs`. So the
-- Approve button on a pending driver failed with "permission denied for
-- table drivers" -- a driver could sign up and never be let in.
--
-- The fix follows the rule the rest of the schema already keeps: staff
-- actions are SECURITY DEFINER functions that check the caller's role
-- themselves, rather than wider table grants that every signed-in client
-- would inherit.
--
-- Two tiers:
--   is_staff()           dispatchers and admins -- the people on shift
--   auth_role() = admin  the owner -- pricing, roles, money corrections

-- ---------------------------------------------------------------- helpers

create or replace function require_staff()
returns void language plpgsql stable security definer set search_path = public as $fn$
begin
  if not is_staff() then
    raise exception 'staff only' using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

create or replace function require_admin()
returns void language plpgsql stable security definer set search_path = public as $fn$
begin
  if coalesce(auth_role() <> 'admin', true) then
    raise exception 'only an admin can do this' using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------- drivers

-- Approve, reject, suspend or reinstate a driver.
--
-- Anything other than `approved` also takes them offline, so a suspended
-- driver stops receiving offers on the very next dispatch rather than at
-- their next app restart. Approval promotes the profile role to `driver`,
-- which is what the console and the reports use to tell the two apart.
create or replace function admin_set_driver_status(
  p_driver_id uuid,
  p_status    driver_status,
  p_reason    text default ''
)
returns drivers
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
begin
  perform require_staff();

  select * into d from drivers where id = p_driver_id for update;
  if d.id is null then
    raise exception 'driver not found' using errcode = 'no_data_found';
  end if;

  if p_status <> 'approved' and d.active_job_id is not null then
    raise exception 'this driver is on a job -- finish or cancel it first'
      using errcode = 'check_violation';
  end if;

  update drivers
     set status = p_status,
         is_online = case when p_status = 'approved' then is_online else false end
   where id = p_driver_id
  returning * into d;

  if p_status = 'approved' then
    update profiles set role = 'driver'
     where id = p_driver_id and role = 'customer';
  end if;

  if coalesce(p_reason, '') <> '' then
    update profiles
       set notes = concat_ws(E'\n', nullif(notes, ''),
                             format('[%s] %s: %s', to_char(now() at time zone 'Asia/Manila',
                                    'YYYY-MM-DD HH24:MI'), p_status, p_reason))
     where id = p_driver_id;
  end if;

  return d;
end;
$fn$;

-- Approve or reject one uploaded document.
create or replace function admin_review_document(
  p_doc_id uuid,
  p_status document_status,
  p_reason text default ''
)
returns driver_documents
language plpgsql
security definer
set search_path = public
as $fn$
declare
  doc driver_documents;
begin
  perform require_staff();

  if p_status = 'rejected' and coalesce(trim(p_reason), '') = '' then
    raise exception 'say why it was rejected -- the driver sees this'
      using errcode = 'check_violation';
  end if;

  update driver_documents
     set status = p_status,
         reject_reason = case when p_status = 'rejected' then p_reason else '' end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_doc_id
  returning * into doc;

  if doc.id is null then
    raise exception 'document not found' using errcode = 'no_data_found';
  end if;

  return doc;
end;
$fn$;

-- How far negative a driver may go before set_online() refuses them.
create or replace function admin_set_credit_floor(p_driver_id uuid, p_floor_centavos bigint)
returns drivers
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
begin
  perform require_admin();

  if p_floor_centavos > 0 then
    raise exception 'the credit floor is a limit on debt, so it must be zero or negative'
      using errcode = 'check_violation';
  end if;

  update drivers set credit_floor_centavos = p_floor_centavos
   where id = p_driver_id
  returning * into d;

  if d.id is null then
    raise exception 'driver not found' using errcode = 'no_data_found';
  end if;
  return d;
end;
$fn$;

-- A correction to a driver's wallet that is not a cash top-up: a refund of
-- commission on a disputed trip, a payout, a goodwill credit. Admin only,
-- and a note is mandatory because this is the one entry in the ledger that
-- does not explain itself.
create or replace function admin_wallet_adjustment(
  p_driver_id uuid,
  p_amount    bigint,
  p_note      text
)
returns wallet_transactions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform require_admin();

  if p_amount = 0 then
    raise exception 'an adjustment of zero does nothing' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_note), '') = '' then
    raise exception 'say why -- adjustments need a note for the ledger'
      using errcode = 'check_violation';
  end if;

  return adjust_wallet(p_driver_id, 'adjustment', p_amount, null, p_note);
end;
$fn$;

-- ---------------------------------------------------------------- jobs

-- Manual assignment: the dispatcher's escape hatch when auto-dispatch has
-- found nobody and they are on the phone to a driver they trust.
--
-- Deliberately looser than claim_job(): the driver need not be online or
-- have a fresh location, because the dispatcher has just spoken to them.
-- Still refuses a driver who is unapproved, blocked or already on a job --
-- jobs_one_active_per_driver_idx would refuse the last one anyway, but with
-- a far less useful message.
create or replace function admin_assign_job(p_job_id uuid, p_driver_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
  d drivers;
begin
  perform require_staff();

  select * into j from jobs where id = p_job_id for update;
  if j.id is null then
    raise exception 'job not found' using errcode = 'no_data_found';
  end if;
  if j.status not in ('searching', 'expired', 'draft') then
    raise exception 'job % is % -- only a job still looking for a rider can be assigned',
      j.reference, j.status using errcode = 'check_violation';
  end if;

  select * into d from drivers where id = p_driver_id for update;
  if d.id is null then
    raise exception 'driver not found' using errcode = 'no_data_found';
  end if;
  if d.status <> 'approved' then
    raise exception 'that driver is %, not approved', d.status using errcode = 'check_violation';
  end if;
  if d.active_job_id is not null then
    raise exception 'that driver is already on a job' using errcode = 'check_violation';
  end if;
  if exists (select 1 from profiles where id = p_driver_id and is_blocked) then
    raise exception 'that driver is blocked' using errcode = 'check_violation';
  end if;

  -- The state machine has no expired -> assigned or draft -> assigned edge,
  -- and it should not grow one just for this. Step through `searching`.
  if j.status in ('expired', 'draft') then
    update jobs set status = 'searching' where id = p_job_id;
  end if;

  update jobs
     set driver_id = p_driver_id,
         status = 'assigned'
   where id = p_job_id
  returning * into j;

  update job_offers set response = 'accepted', responded_at = now()
   where job_id = p_job_id and driver_id = p_driver_id and response = 'pending';
  update job_offers set response = 'withdrawn', responded_at = now()
   where job_id = p_job_id and driver_id <> p_driver_id and response = 'pending';

  update drivers set active_job_id = p_job_id where id = p_driver_id;

  insert into job_events (job_id, actor_id, event_type, payload)
  values (p_job_id, auth.uid(), 'manually_assigned',
          jsonb_build_object('driver_id', p_driver_id));

  return j;
end;
$fn$;

-- ---------------------------------------------------------------- people

create or replace function admin_set_blocked(
  p_profile_id uuid,
  p_blocked    boolean,
  p_note       text default ''
)
returns profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  p profiles;
begin
  perform require_staff();

  if p_profile_id = auth.uid() then
    raise exception 'you cannot block yourself' using errcode = 'check_violation';
  end if;

  update profiles
     set is_blocked = p_blocked,
         notes = case
           when coalesce(p_note, '') = '' then notes
           else concat_ws(E'\n', nullif(notes, ''),
                          format('[%s] %s: %s',
                                 to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI'),
                                 case when p_blocked then 'blocked' else 'unblocked' end,
                                 p_note))
         end
   where id = p_profile_id
  returning * into p;

  if p.id is null then
    raise exception 'account not found' using errcode = 'no_data_found';
  end if;

  -- A blocked driver must stop receiving offers now, not when they next
  -- toggle. nearby_drivers() checks is_blocked too; this is belt and braces.
  if p_blocked then
    update drivers set is_online = false where id = p_profile_id;
  end if;

  return p;
end;
$fn$;

create or replace function admin_set_role(p_profile_id uuid, p_role user_role)
returns profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  p profiles;
begin
  perform require_admin();

  if p_profile_id = auth.uid() and p_role <> 'admin' then
    raise exception 'you cannot remove your own admin role -- ask another admin'
      using errcode = 'check_violation';
  end if;

  update profiles set role = p_role where id = p_profile_id returning * into p;
  if p.id is null then
    raise exception 'account not found' using errcode = 'no_data_found';
  end if;
  return p;
end;
$fn$;

-- ---------------------------------------------------------------- pricing

-- Replaces the live fare for one service.
--
-- A new row rather than an in-place update, so there is a history of what
-- the price was and when it changed. Bookings already made are unaffected:
-- every job copies its fare components at create_job() time.
create or replace function admin_update_fare(
  p_job_type                 job_type,
  p_base_fare_centavos       int,
  p_included_meters          int,
  p_per_km_centavos          int,
  p_per_minute_centavos      int,
  p_min_fare_centavos        int,
  p_service_fee_centavos     int,
  p_night_surcharge_centavos int,
  p_night_starts_hour        int,
  p_night_ends_hour          int,
  p_commission_bps           int,
  p_max_item_float_centavos  int
)
returns fare_config
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cfg fare_config;
begin
  perform require_admin();

  if p_included_meters < 0 then
    raise exception 'included distance cannot be negative' using errcode = 'check_violation';
  end if;
  if p_max_item_float_centavos < 0 then
    raise exception 'the item float limit cannot be negative' using errcode = 'check_violation';
  end if;

  update fare_config set is_active = false where job_type = p_job_type and is_active;

  insert into fare_config (
    job_type, base_fare_centavos, included_meters, per_km_centavos,
    per_minute_centavos, min_fare_centavos, service_fee_centavos,
    night_surcharge_centavos, night_starts_hour, night_ends_hour,
    commission_bps, max_item_float_centavos, is_active, effective_from
  ) values (
    p_job_type, p_base_fare_centavos, p_included_meters, p_per_km_centavos,
    p_per_minute_centavos, p_min_fare_centavos, p_service_fee_centavos,
    p_night_surcharge_centavos, p_night_starts_hour, p_night_ends_hour,
    p_commission_bps, p_max_item_float_centavos, true, now()
  )
  returning * into cfg;

  return cfg;
end;
$fn$;

-- ---------------------------------------------------------------- landmarks

-- Create or edit a landmark. This is how the approximate seed coordinates
-- get replaced with ones somebody has actually stood on.
create or replace function admin_upsert_landmark(
  p_id        uuid,
  p_name      text,
  p_category  text,
  p_lng       double precision,
  p_lat       double precision,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  out_id uuid;
begin
  perform require_staff();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'a landmark needs a name' using errcode = 'check_violation';
  end if;
  if p_lng is null or p_lat is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'that is not a valid coordinate' using errcode = 'check_violation';
  end if;

  if p_id is null then
    insert into landmark_suggestions (name, category, location, is_active)
    values (trim(p_name), coalesce(nullif(trim(p_category), ''), 'general'),
            point_of(p_lng, p_lat), coalesce(p_is_active, true))
    returning id into out_id;
  else
    update landmark_suggestions
       set name = trim(p_name),
           category = coalesce(nullif(trim(p_category), ''), 'general'),
           location = point_of(p_lng, p_lat),
           is_active = coalesce(p_is_active, true)
     where id = p_id
    returning id into out_id;

    if out_id is null then
      raise exception 'landmark not found' using errcode = 'no_data_found';
    end if;
  end if;

  return out_id;
end;
$fn$;

-- ---------------------------------------------------------------- reports

-- Per-day totals in Manila time, newest first. What the owner checks each
-- morning: how many trips, how much moved, how much of it is ours.
create or replace function admin_daily_stats(p_days int default 14)
returns table (
  day                date,
  completed          int,
  cancelled          int,
  expired            int,
  gross_centavos     bigint,
  items_centavos     bigint,
  commission_centavos bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform require_staff();

  return query
  with days as (
    select generate_series(
      (now() at time zone 'Asia/Manila')::date - (greatest(p_days, 1) - 1),
      (now() at time zone 'Asia/Manila')::date,
      interval '1 day'
    )::date as day
  )
  select
    days.day,
    count(j.id) filter (where j.status = 'completed')::int,
    count(j.id) filter (where j.status = 'cancelled')::int,
    count(j.id) filter (where j.status = 'expired')::int,
    coalesce(sum(j.final_total_centavos) filter (where j.status = 'completed'), 0)::bigint,
    coalesce(sum(j.items_cost_centavos) filter (where j.status = 'completed'), 0)::bigint,
    coalesce(sum(j.commission_centavos) filter (where j.status = 'completed'), 0)::bigint
  from days
  left join jobs j
    on (j.created_at at time zone 'Asia/Manila')::date = days.day
   and j.status in ('completed', 'cancelled', 'expired')
  group by days.day
  order by days.day desc;
end;
$fn$;

-- ---------------------------------------------------------------- read models

-- Every job, any status, with the names a dispatcher searches by. The live
-- board only shows in-flight work; this is for "a customer is on the phone
-- about yesterday's booking".
create view admin_jobs
with (security_invoker = false)
as
select
  j.id,
  j.reference,
  j.job_type,
  j.status,
  j.created_at,
  j.assigned_at,
  j.completed_at,
  j.cancelled_at,
  j.cancel_reason,
  j.cancelled_by,
  j.scheduled_for,
  j.notes,
  j.pickup_label,
  j.pickup_landmark,
  j.pickup_lng,
  j.pickup_lat,
  j.dropoff_label,
  j.dropoff_landmark,
  j.dropoff_lng,
  j.dropoff_lat,
  j.recipient_name,
  j.recipient_phone,
  j.distance_meters,
  j.quoted_fare_centavos,
  j.items_cost_centavos,
  j.items_budget_centavos,
  j.final_total_centavos,
  j.commission_centavos,
  j.payment_method,
  j.payment_status,
  j.dispatch_attempts,
  j.customer_id,
  cust.full_name as customer_name,
  cust.phone     as customer_phone,
  j.driver_id,
  drv.full_name  as driver_name,
  drv.phone      as driver_phone,
  d.plate_number
from jobs j
join profiles cust on cust.id = j.customer_id
left join drivers d on d.id = j.driver_id
left join profiles drv on drv.id = j.driver_id
where is_staff();

-- Customers with enough history to judge a no-show complaint.
create view admin_customers
with (security_invoker = false)
as
select
  p.id,
  p.phone,
  p.full_name,
  p.role,
  p.is_blocked,
  p.notes,
  p.created_at,
  (select count(*) from jobs j where j.customer_id = p.id and j.status = 'completed')::int
    as completed_jobs,
  (select count(*) from jobs j where j.customer_id = p.id and j.status = 'cancelled')::int
    as cancelled_jobs,
  (select max(j.created_at) from jobs j where j.customer_id = p.id) as last_booking_at
from profiles p
where is_staff();

-- Supabase's default privileges grant every new relation to anon. These
-- views already filter on is_staff(), but nothing anonymous should even see
-- the column list.
revoke all on admin_jobs, admin_customers from anon, public;
grant select on admin_jobs, admin_customers to authenticated;

-- Staff need to see inactive landmarks to re-enable them; the existing
-- policy allows that, this view just exposes usable coordinates.
create view admin_landmarks
with (security_invoker = false)
as
select
  l.id, l.name, l.category, l.use_count, l.is_active, l.created_at,
  st_x(l.location::geometry) as lng,
  st_y(l.location::geometry) as lat
from landmark_suggestions l
where is_staff();

revoke all on admin_landmarks from anon, public;
grant select on admin_landmarks to authenticated;

-- ---------------------------------------------------------------- grants

-- The schema default from 20260908000100 should leave these owner-only, but
-- that default is per creating role and does not hold in every environment
-- (the SQL test container proved it). Revoke from PUBLIC explicitly, then
-- name each grant: is_staff()/auth_role() inside is what protects them.
revoke all on function
  admin_set_driver_status(uuid, driver_status, text),
  admin_review_document(uuid, document_status, text),
  admin_set_credit_floor(uuid, bigint),
  admin_wallet_adjustment(uuid, bigint, text),
  admin_assign_job(uuid, uuid),
  admin_set_blocked(uuid, boolean, text),
  admin_set_role(uuid, user_role),
  admin_update_fare(job_type, int, int, int, int, int, int, int, int, int, int, int),
  admin_upsert_landmark(uuid, text, text, double precision, double precision, boolean),
  admin_daily_stats(int)
from public, anon;

grant execute on function
  admin_set_driver_status(uuid, driver_status, text),
  admin_review_document(uuid, document_status, text),
  admin_set_credit_floor(uuid, bigint),
  admin_wallet_adjustment(uuid, bigint, text),
  admin_assign_job(uuid, uuid),
  admin_set_blocked(uuid, boolean, text),
  admin_set_role(uuid, user_role),
  admin_update_fare(job_type, int, int, int, int, int, int, int, int, int, int, int),
  admin_upsert_landmark(uuid, text, text, double precision, double precision, boolean),
  admin_daily_stats(int)
to authenticated;

-- require_staff()/require_admin() are only called from inside the functions
-- above, which run as owner. No client needs them.
revoke all on function require_staff(), require_admin() from public, anon, authenticated;
