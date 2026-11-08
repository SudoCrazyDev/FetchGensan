-- FetchGensan :: reconcile the console work with role-based access control
--
-- Two lines of work landed in parallel. 20260930000100_rbac replaced the
-- profiles.role enum checks with permissions (has_permission()), and added
-- its own set_driver_status() / assign_job() / set_user_blocked() /
-- set_user_roles(). 20261002000100_admin_console added the rest of the
-- console's RPCs, guarded by the old model: require_staff() and
-- `auth_role() = 'admin'`.
--
-- RBAC is the model that stays. This migration:
--
--   * moves every remaining admin_* RPC onto require_permission(), with a
--     new `wallet.adjust` permission for the two money corrections that are
--     more sensitive than a cash top-up;
--   * drops the console RPCs RBAC already provides a better version of
--     (admin_set_driver_status, admin_assign_job, admin_set_blocked,
--     admin_set_role) and the two old-model guards;
--   * folds what those duplicates did that RBAC's did not into RBAC's
--     functions: a reason on reject/suspend, assigning a job that has
--     already expired (exactly the job a dispatcher most needs to assign by
--     hand), and a push to the rider who was assigned;
--   * keeps profiles.role derived (register_driver refreshes it rather than
--     writing it).
--
-- ORDER. On a fresh database this runs after both 20260930* and 20261002*.
-- The hosted project received 20261002* first and 20260930* afterwards.
-- Everything here is written so the end state is the same either way:
-- every function both lines touch is re-created below, and every grant is
-- re-stated.

-- ---------------------------------------------------------------- permission

insert into permissions (key, category, label, description, sort_order) values
  ('wallet.adjust', 'Money', 'Correct wallets',
   'Post wallet adjustments (refunds, payouts, corrections) and change a rider''s credit limit.', 35)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- duplicates

drop function if exists admin_set_driver_status(uuid, driver_status, text);
drop function if exists admin_assign_job(uuid, uuid);
drop function if exists admin_set_blocked(uuid, boolean, text);
drop function if exists admin_set_role(uuid, user_role);

-- ---------------------------------------------------------------- driver status

-- RBAC's set_driver_status(), plus the reason. Rejecting or suspending
-- someone without telling them why is how a rider ends up at the office
-- arguing; the reason is kept on their profile notes, dated.
drop function if exists set_driver_status(uuid, driver_status);

create or replace function set_driver_status(
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
  perform require_permission('drivers.manage');

  select * into d from drivers where id = p_driver_id for update;
  if d.id is null then
    raise exception 'that rider no longer exists' using errcode = 'no_data_found';
  end if;

  if p_status <> 'approved' and d.active_job_id is not null then
    raise exception 'this rider is on a booking right now. Reassign or finish it first.'
      using errcode = 'check_violation';
  end if;

  update drivers
     set status = p_status,
         -- Anyone taken off the road goes offline at once, rather than
         -- sitting "online" but silently receiving no offers.
         is_online = case when p_status = 'approved' then is_online else false end
   where id = p_driver_id
  returning * into d;

  if coalesce(trim(p_reason), '') <> '' then
    update profiles
       set notes = concat_ws(E'\n', nullif(notes, ''),
                             format('[%s] %s: %s',
                                    to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI'),
                                    p_status, trim(p_reason)))
     where id = p_driver_id;
  end if;

  return d;
end;
$fn$;

-- ---------------------------------------------------------------- manual assign

-- RBAC's assign_job(), widened to `expired` and `draft`. After the last
-- dispatch round a booking expires -- and that is precisely when a
-- dispatcher picks up the phone and assigns someone by hand, so refusing
-- expired jobs refused the main use of the button. The state machine has
-- no expired -> assigned edge, so step through `searching`.
create or replace function assign_job(p_job_id uuid, p_driver_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
  j jobs;
  assigned jobs;
begin
  perform require_permission('console.access');

  select * into d from drivers where id = p_driver_id for update;
  if d.id is null then
    raise exception 'that rider no longer exists' using errcode = 'no_data_found';
  end if;
  if d.status <> 'approved' then
    raise exception 'only approved riders can be given bookings' using errcode = 'check_violation';
  end if;
  if exists (select 1 from profiles where id = p_driver_id and is_blocked) then
    raise exception 'that rider''s account is deactivated' using errcode = 'check_violation';
  end if;
  if d.active_job_id is not null then
    raise exception 'that rider is already on a booking' using errcode = 'check_violation';
  end if;

  select * into j from jobs where id = p_job_id for update;
  if j.id is null then
    raise exception 'that booking no longer exists' using errcode = 'no_data_found';
  end if;
  if j.driver_id is null and j.status in ('expired', 'draft') then
    update jobs set status = 'searching' where id = p_job_id;
  end if;

  -- Same race guard as claim_job(): if a rider accepted an offer a moment
  -- ago, they keep it.
  update jobs
     set driver_id = p_driver_id,
         status = 'assigned'
   where id = p_job_id
     and status = 'searching'
     and driver_id is null
  returning * into assigned;

  if assigned.id is null then
    raise exception 'that booking is no longer waiting for a rider' using errcode = 'lock_not_available';
  end if;

  update job_offers set response = 'withdrawn', responded_at = now()
   where job_id = p_job_id and response = 'pending';

  update drivers set active_job_id = assigned.id where id = p_driver_id;

  insert into job_events (job_id, actor_id, event_type, payload)
  values (p_job_id, auth.uid(), 'manual_assign', jsonb_build_object('driver_id', p_driver_id));

  return assigned;
end;
$fn$;

-- The push trigger from 20261002000200 listened for the event name the
-- dropped admin_assign_job() wrote. Listen for both, so history written by
-- either is treated alike.
drop trigger if exists job_events_push_manual_assign on job_events;
create trigger job_events_push_manual_assign after insert on job_events
  for each row when (new.event_type in ('manual_assign', 'manually_assigned'))
  execute function push_on_manual_assign();

-- ---------------------------------------------------------------- rider signup

-- Unchanged from 20261002000200 except the last step: profiles.role is
-- derived from roles and the drivers table now (20260930000100), so ask for
-- it to be re-derived instead of leaving a new rider labelled `customer`.
create or replace function register_driver(
  p_full_name      text,
  p_vehicle_make   text,
  p_vehicle_model  text,
  p_vehicle_color  text,
  p_plate_number   text,
  p_license_number text
)
returns drivers
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
  plate text := upper(regexp_replace(trim(coalesce(p_plate_number, '')), '\s+', ' ', 'g'));
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'enter your full name -- customers see it when you accept'
      using errcode = 'check_violation';
  end if;
  if plate = '' then
    raise exception 'enter your plate number' using errcode = 'check_violation';
  end if;
  if exists (select 1 from drivers where plate_number = plate and id <> auth.uid()) then
    raise exception 'that plate number is already registered to another rider'
      using errcode = 'check_violation';
  end if;

  update profiles set full_name = trim(p_full_name) where id = auth.uid();

  insert into drivers (id, vehicle_make, vehicle_model, vehicle_color, plate_number, license_number)
  values (auth.uid(), trim(coalesce(p_vehicle_make, '')), trim(coalesce(p_vehicle_model, '')),
          trim(coalesce(p_vehicle_color, '')), plate, trim(coalesce(p_license_number, '')))
  on conflict (id) do update
    set vehicle_make   = excluded.vehicle_make,
        vehicle_model  = excluded.vehicle_model,
        vehicle_color  = excluded.vehicle_color,
        plate_number   = excluded.plate_number,
        license_number = excluded.license_number
  returning * into d;

  perform refresh_account_type(auth.uid());

  return d;
end;
$fn$;

-- ---------------------------------------------------------------- console RPCs

-- Same bodies as 20261002000100; only the guard changes, from the old
-- enum-based require_staff()/require_admin() to the permission each needs.

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
  perform require_permission('drivers.manage');

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

create or replace function admin_set_credit_floor(p_driver_id uuid, p_floor_centavos bigint)
returns drivers
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
begin
  perform require_permission('wallet.adjust');

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
  perform require_permission('wallet.adjust');

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
  perform require_permission('pricing.manage');

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
  perform require_permission('console.access');

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
  perform require_permission('console.access');

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

drop function if exists require_staff();
drop function if exists require_admin();

-- ---------------------------------------------------------------- grants

-- Re-stated in full: on the hosted project 20260930* ran after
-- 20261002*, and this file must leave the same privileges either way.
revoke all on function
  set_driver_status(uuid, driver_status, text),
  assign_job(uuid, uuid),
  register_driver(text, text, text, text, text, text),
  admin_review_document(uuid, document_status, text),
  admin_set_credit_floor(uuid, bigint),
  admin_wallet_adjustment(uuid, bigint, text),
  admin_update_fare(job_type, int, int, int, int, int, int, int, int, int, int, int),
  admin_upsert_landmark(uuid, text, text, double precision, double precision, boolean),
  admin_daily_stats(int)
from public, anon;

grant execute on function
  set_driver_status(uuid, driver_status, text),
  assign_job(uuid, uuid),
  register_driver(text, text, text, text, text, text),
  admin_review_document(uuid, document_status, text),
  admin_set_credit_floor(uuid, bigint),
  admin_wallet_adjustment(uuid, bigint, text),
  admin_update_fare(job_type, int, int, int, int, int, int, int, int, int, int, int),
  admin_upsert_landmark(uuid, text, text, double precision, double precision, boolean),
  admin_daily_stats(int)
to authenticated, service_role;

-- Grants both lines made to fix the lockdown; harmless to repeat.
grant execute on function point_of(double precision, double precision) to anon, authenticated;
grant execute on function
  driver_rating(drivers),
  can_accept_jobs(drivers),
  location_staleness_limit(),
  active_fare_config(job_type),
  is_night_hours(fare_config, timestamptz),
  reject_errand_total(uuid, text),
  job_customer_contact(uuid)
to authenticated;

revoke all on function send_push(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function push_on_offer(), push_on_job_status(), push_on_manual_assign()
  from public, anon, authenticated;

-- service_role is the trusted server key (edge functions, cron) and keeps
-- EXECUTE on everything, as 20260908000100 established. Re-stated last so a
-- fresh database and the hosted one (where 20260930000100's blanket grant
-- ran after 20261002*) end with the same ACLs.
grant execute on all functions in schema public to service_role;
