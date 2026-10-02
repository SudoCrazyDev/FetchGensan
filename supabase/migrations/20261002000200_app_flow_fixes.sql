-- FetchGensan :: fixes found walking each app's flow end to end
--
-- Each section is a gap that stopped a real flow, not a nice-to-have.

-- ---------------------------------------------------------------- driver signup

-- Saving vehicle details used `.upsert({ id, ...vehicle })`. The UPDATE half
-- of an upsert sets every column it was sent -- including `id`, which
-- `authenticated` has no UPDATE privilege on -- so the second save of the
-- onboarding form failed with "permission denied for table drivers". A
-- function also lets the driver's name be written in the same step, which
-- matters: the name is what a customer sees on the "your rider" card.
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

  return d;
end;
$fn$;

-- ---------------------------------------------------------------- saved places

-- PostgREST returns `geography` as WKB hex, so the rider app could list a
-- saved place but not put it on the map -- tapping "Home" kept whatever the
-- previous pin was, which is an easy way to book a ride from the wrong
-- place. Same generated-column approach as jobs.pickup_lng.
alter table saved_places
  add column if not exists lng double precision
    generated always as (st_x(location::geometry)) stored,
  add column if not exists lat double precision
    generated always as (st_y(location::geometry)) stored;

-- ---------------------------------------------------------------- errands

-- The receipt must come from the store, not from a driver who has not yet
-- arrived. The UI already enforced this; the server now does too.
create or replace function submit_errand_receipt(
  p_job_id       uuid,
  p_items        jsonb,
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

  if j.id is null then
    raise exception 'job not found' using errcode = 'no_data_found';
  end if;
  if j.driver_id is distinct from auth.uid() and not is_staff() then
    raise exception 'not your job' using errcode = 'insufficient_privilege';
  end if;
  if j.job_type <> 'errand' then
    raise exception 'not an errand' using errcode = 'check_violation';
  end if;
  if j.status <> 'shopping' then
    raise exception 'start shopping before sending the receipt' using errcode = 'check_violation';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    update errand_items
       set actual_price_centavos = greatest(0, coalesce((item ->> 'actual_price_centavos')::int, 0)),
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

-- The customer's only options on a receipt used to be Approve or phone
-- dispatch. This sends it back to the driver with a reason ("no, the 1kg
-- bag, not the 5kg"), which the state machine already allowed:
-- awaiting_approval -> shopping.
create or replace function reject_errand_total(p_job_id uuid, p_reason text default '')
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
  if j.customer_id is distinct from auth.uid() and not is_staff() then
    raise exception 'not your booking' using errcode = 'insufficient_privilege';
  end if;
  if j.status <> 'awaiting_approval' then
    raise exception 'nothing to review' using errcode = 'check_violation';
  end if;

  update jobs set status = 'shopping' where id = p_job_id returning * into j;

  insert into job_events (job_id, actor_id, event_type, payload)
  values (p_job_id, auth.uid(), 'total_rejected',
          jsonb_build_object('reason', coalesce(p_reason, ''),
                             'items_cost_centavos', j.items_cost_centavos));

  return j;
end;
$fn$;

-- Cancelling while the driver holds goods stays a dispatcher decision. But
-- an errand where nothing was in stock left both sides stuck: the driver
-- could not cancel, and neither could the customer, so it waited on a
-- phone call. A submitted receipt with zero item cost means nobody is out
-- of pocket, so either side may now cancel it.
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

  if j.status in ('completed', 'cancelled') then
    raise exception 'this booking is already %', j.status using errcode = 'check_violation';
  end if;

  if j.status in ('shopping', 'awaiting_approval') and not is_staff()
     and not (j.status = 'awaiting_approval' and j.items_cost_centavos = 0) then
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

-- ---------------------------------------------------------------- contact

-- The driver needs the customer's name and number to find them at a gate.
-- profiles_select_active_counterparty already allows exactly this read; a
-- function just saves the driver app knowing the policy shape, and returns
-- nothing once the job is over.
create or replace function job_customer_contact(p_job_id uuid)
returns table (full_name text, phone text)
language sql
stable
security definer
set search_path = public
as $fn$
  select p.full_name, p.phone
    from jobs j
    join profiles p on p.id = j.customer_id
   where j.id = p_job_id
     and (j.driver_id = auth.uid() or is_staff())
     and j.status in ('assigned', 'arriving', 'arrived_pickup', 'shopping',
                      'awaiting_approval', 'in_progress');
$fn$;

-- ---------------------------------------------------------------- push

-- Nothing ever called the push-notify edge function, so a driver with a
-- locked phone got no offers at all. These triggers call it through pg_net.
--
-- Configuration lives in Vault, not in this file, because the secret must
-- not be in git:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/push-notify',
--                              'push_notify_url');
--   select vault.create_secret('<same value as PUSH_NOTIFY_SECRET>', 'push_notify_secret');
--
-- Until both exist the triggers do nothing. They can never fail the
-- transaction that fired them: a push provider outage must not roll back a
-- dispatch or a completed trip.

do $do$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable -- push notifications stay off: %', sqlerrm;
end
$do$;

create or replace function send_push(
  p_profile_id uuid,
  p_job_id     uuid,
  p_title      text,
  p_body       text,
  p_kind       text default 'job'
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  url text;
  secret text;
begin
  if p_profile_id is null or to_regproc('net.http_post') is null
     or to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;

  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'push_notify_url'$q$
    into url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'push_notify_secret'$q$
    into secret;

  if url is null or secret is null then
    return;
  end if;

  execute $q$select net.http_post(url := $1, body := $2, headers := $3)$q$
    using url,
          jsonb_build_object('driver_id', p_profile_id, 'job_id', p_job_id,
                             'title', p_title, 'body', p_body, 'kind', p_kind),
          jsonb_build_object('content-type', 'application/json', 'x-push-secret', secret);
exception when others then
  raise warning 'push to % failed: %', p_profile_id, sqlerrm;
end;
$fn$;

create or replace function push_on_offer()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
begin
  select * into j from jobs where id = new.job_id;
  perform send_push(
    new.driver_id, new.job_id,
    case j.job_type when 'errand' then 'New errand nearby'
                    when 'delivery' then 'New delivery nearby'
                    else 'New ride nearby' end,
    format('%s · %s away. Tap to accept.',
           coalesce(nullif(j.pickup_landmark, ''), nullif(j.pickup_label, ''), 'Pinned pickup'),
           case when new.distance_m < 1000 then new.distance_m || ' m'
                else round(new.distance_m / 1000.0, 1) || ' km' end),
    'offer');
  return new;
end;
$fn$;

drop trigger if exists job_offers_push on job_offers;
create trigger job_offers_push after insert on job_offers
  for each row execute function push_on_offer();

-- Tells the customer when something they are waiting for happens, and the
-- driver when their job is assigned by hand or cancelled under them.
create or replace function push_on_job_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = old.status then
    return new;
  end if;

  case new.status
    when 'assigned' then
      perform send_push(new.customer_id, new.id, 'Rider found',
                        'Your rider is on the way. Open the app to track them.');
    when 'arrived_pickup' then
      if new.job_type <> 'errand' then
        perform send_push(new.customer_id, new.id, 'Your rider is here',
                          coalesce(nullif(new.pickup_landmark, ''), 'At your pick-up point.'));
      end if;
    when 'awaiting_approval' then
      perform send_push(new.customer_id, new.id, 'Please approve your errand total',
                        'Your rider is at the store waiting for your OK.');
    when 'shopping' then
      if old.status = 'awaiting_approval' then
        perform send_push(new.driver_id, new.id, 'Customer asked for changes',
                          'Open the job to see what they want changed.');
      end if;
    when 'completed' then
      perform send_push(new.customer_id, new.id, 'Delivered -- salamat!',
                        'Tap to rate your rider.');
    when 'expired' then
      perform send_push(new.customer_id, new.id, 'No riders free right now',
                        'We are still trying. You can also call dispatch.');
    when 'cancelled' then
      if new.cancelled_by is distinct from new.driver_id and new.driver_id is not null then
        perform send_push(new.driver_id, new.id, 'Booking cancelled',
                          coalesce(nullif(new.cancel_reason, ''), 'The booking was cancelled.'),
                          'cancelled');
      end if;
      if new.cancelled_by is distinct from new.customer_id then
        perform send_push(new.customer_id, new.id, 'Booking cancelled',
                          coalesce(nullif(new.cancel_reason, ''), 'Your booking was cancelled.'));
      end if;
    else
      null;
  end case;

  return new;
end;
$fn$;

drop trigger if exists jobs_push_status on jobs;
create trigger jobs_push_status after update of status on jobs
  for each row execute function push_on_job_status();

-- A driver who claimed a job already knows about it. One assigned by hand
-- from the console does not, and may have the app closed.
create or replace function push_on_manual_assign()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform send_push((new.payload ->> 'driver_id')::uuid, new.job_id,
                    'Dispatch assigned you a job',
                    'Open the app for the pick-up details.', 'assigned');
  return new;
end;
$fn$;

drop trigger if exists job_events_push_manual_assign on job_events;
create trigger job_events_push_manual_assign after insert on job_events
  for each row when (new.event_type = 'manually_assigned')
  execute function push_on_manual_assign();

-- ---------------------------------------------------------------- grants

-- Explicit revoke from PUBLIC first; see the note in 20261002000100.
revoke all on function
  register_driver(text, text, text, text, text, text),
  reject_errand_total(uuid, text),
  job_customer_contact(uuid)
from public, anon;

grant execute on function
  register_driver(text, text, text, text, text, text),
  reject_errand_total(uuid, text),
  job_customer_contact(uuid)
to authenticated;

-- Functions called inside a view execute with the CALLER's privileges, even
-- when the view itself is security_invoker = false. The lockdown in
-- 20260908000100 revoked these, so `public_driver_info` (the customer's
-- "your rider" card) and `driver_roster` (the console's Drivers page) both
-- failed with "permission denied for function driver_rating". Each is a pure
-- function of a row the caller has already been allowed to read; granting
-- EXECUTE exposes nothing new.
grant execute on function
  driver_rating(drivers),
  can_accept_jobs(drivers),
  location_staleness_limit()
to authenticated;

-- Same failure in search_landmarks(), which is not security definer and
-- calls point_of() to measure distance. The booking screen always passes
-- the customer's location, so landmark search errored on every phone that
-- had a GPS fix -- the main way a customer picks a place. point_of() only
-- builds a geography point from two numbers.
grant execute on function point_of(double precision, double precision) to anon, authenticated;

-- And in quote_fare(), the authoritative price the booking screen shows
-- before the customer taps Book. It is not security definer, so it calls
-- these two as the customer. Both read only the public price list.
grant execute on function
  active_fare_config(job_type),
  is_night_hours(fare_config, timestamptz)
to authenticated;

-- Re-creating a function keeps its ACL, but say it explicitly for the ones
-- replaced above so this file reads correctly on its own.
grant execute on function
  submit_errand_receipt(uuid, jsonb, text),
  cancel_job(uuid, text)
to authenticated;

revoke all on function send_push(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function push_on_offer(), push_on_job_status(), push_on_manual_assign() from public, anon, authenticated;
