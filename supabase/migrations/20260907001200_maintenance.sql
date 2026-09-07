-- FetchGensan :: background maintenance
--
-- Dispatch is not fire-and-forget. Offers time out, drivers close the app
-- mid-shift, and a job nobody accepted has to widen its net or give up and
-- tell the customer. These are the sweepers that make that happen, plus the
-- schedule that runs them.

-- Offers nobody answered. Marking them 'timeout' is what frees the job to
-- be re-offered to a wider radius, and it also stops nearby_drivers() from
-- re-asking the same silent driver.
create or replace function expire_stale_offers()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n int;
begin
  update job_offers
     set response = 'timeout', responded_at = now()
   where response = 'pending' and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- How far to reach on each successive attempt. A habal-habal 6km away is
-- not a useful answer to a 2-minute-old booking, so widen gradually.
create or replace function dispatch_radius_for_attempt(p_attempt int)
returns int
language sql
immutable
as $fn$
  select case
    when p_attempt <= 1 then 2000
    when p_attempt = 2 then 3500
    when p_attempt = 3 then 5000
    else 7000
  end;
$fn$;

create or replace function max_dispatch_attempts()
returns int language sql immutable as $fn$ select 5 $fn$;

-- A job sitting in `searching` with no live offer either needs a wider net
-- or needs to be given up on. Giving up matters: a customer staring at a
-- spinner for ten minutes is worse than being told to try again.
create or replace function redispatch_waiting_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j record;
  touched int := 0;
begin
  for j in
    select id, dispatch_attempts
      from jobs
     where status = 'searching'
       and not exists (
         select 1 from job_offers o
         where o.job_id = jobs.id and o.response = 'pending'
       )
     order by created_at
     limit 100
  loop
    if j.dispatch_attempts >= max_dispatch_attempts() then
      update jobs set status = 'expired' where id = j.id;
      insert into job_events (job_id, event_type, payload)
      values (j.id, 'no_driver_found',
              jsonb_build_object('attempts', j.dispatch_attempts));
    else
      perform dispatch_job(j.id, dispatch_radius_for_attempt(j.dispatch_attempts + 1));
    end if;
    touched := touched + 1;
  end loop;

  return touched;
end;
$fn$;

-- Scheduled bookings become live bookings. Released 15 minutes ahead so
-- there is time to actually find someone.
create or replace function release_scheduled_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j record;
  n int := 0;
begin
  for j in
    select id from jobs
     where status = 'draft'
       and scheduled_for is not null
       and scheduled_for <= now() + interval '15 minutes'
     limit 100
  loop
    update jobs set status = 'searching' where id = j.id;
    perform dispatch_job(j.id);
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

-- The app was killed, the phone died, or signal dropped. Whatever the
-- reason, a driver we have not heard from is not available, and leaving
-- them "online" makes the dispatcher board lie.
create or replace function reap_stale_drivers()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n int;
begin
  update drivers
     set is_online = false
   where is_online
     and (location_updated_at is null
          or location_updated_at < now() - interval '5 minutes')
     and active_job_id is null;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- The GPS trail is for live tracking and recent disputes, not forever.
create or replace function prune_driver_locations(p_keep interval default interval '21 days')
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n int;
begin
  delete from driver_locations where recorded_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- One entry point so the schedule has a single thing to call.
create or replace function dispatch_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  expired_offers int;
  redispatched int;
  released int;
  reaped int;
begin
  expired_offers := expire_stale_offers();
  released := release_scheduled_jobs();
  redispatched := redispatch_waiting_jobs();
  reaped := reap_stale_drivers();

  return jsonb_build_object(
    'expired_offers', expired_offers,
    'released_scheduled', released,
    'redispatched', redispatched,
    'reaped_drivers', reaped,
    'at', now()
  );
end;
$fn$;

-- ---------------------------------------------------------------- schedule
--
-- pg_cron is available on Supabase but has to be enabled for the project.
-- Wrapped so a local `supabase db reset` without the extension still
-- succeeds -- the sweepers are then driven by the Edge Function in
-- supabase/functions/dispatch-tick instead.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Offers expire in 25 seconds, so a 10-second tick keeps the worst-case
    -- wait before re-offering under a minute.
    perform cron.schedule('fetchgensan-dispatch-tick', '10 seconds',
                          'select dispatch_tick()');
    perform cron.schedule('fetchgensan-prune-locations', '0 3 * * *',
                          'select prune_driver_locations()');
  else
    raise notice 'pg_cron unavailable -- drive dispatch_tick() from the Edge Function instead';
  end if;
exception when others then
  raise notice 'could not schedule cron jobs: %', sqlerrm;
end
$do$;

-- ---------------------------------------------------------------- realtime
--
-- What the apps subscribe to. Kept to the minimum: RLS still applies to
-- realtime, so a client only receives changes on rows it could have read.

do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table jobs;
    alter publication supabase_realtime add table job_offers;
    alter publication supabase_realtime add table errand_items;
  end if;
exception when duplicate_object then
  null;
end
$do$;

-- Realtime sends only the primary key on UPDATE unless the table has a
-- full replica identity. The apps need the new status, so ask for the
-- whole row.
alter table jobs replica identity full;
alter table job_offers replica identity full;
