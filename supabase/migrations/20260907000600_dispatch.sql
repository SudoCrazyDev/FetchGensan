-- FetchGensan :: dispatch
-- Model: broadcast the job to the nearest eligible drivers, first accept
-- wins. With a fleet of tens rather than thousands this beats a scoring
-- engine on every axis that matters -- it is obvious, debuggable, and the
-- atomic claim makes double-assignment impossible.

create table job_offers (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references jobs (id) on delete cascade,
  driver_id    uuid not null references drivers (id) on delete cascade,
  distance_m   int not null default 0,
  response     offer_response not null default 'pending',
  offered_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  round        int not null default 1,

  unique (job_id, driver_id)
);

create index job_offers_driver_pending_idx on job_offers (driver_id, expires_at)
  where response = 'pending';
create index job_offers_job_idx on job_offers (job_id, offered_at desc);

-- Recent GPS trail. Powers the customer live map and settles disputes about
-- whether a driver ever showed up. Pruned by the cron in 20260907001000.
create table driver_locations (
  id          bigserial primary key,
  driver_id   uuid not null references drivers (id) on delete cascade,
  job_id      uuid references jobs (id) on delete set null,
  location    geography (point, 4326) not null,
  heading     numeric (5, 2),
  speed_kph   numeric (6, 2),
  recorded_at timestamptz not null default now()
);

create index driver_locations_driver_idx on driver_locations (driver_id, recorded_at desc);
create index driver_locations_job_idx on driver_locations (job_id, recorded_at)
  where job_id is not null;

-- ---------------------------------------------------------------- eligibility

-- A driver location goes stale when the app is killed or loses signal.
-- Offering a job to a stale driver is the fastest way to make a customer
-- wait for nothing, so treat anything older than this as offline.
create or replace function location_staleness_limit()
returns interval language sql immutable as $fn$ select interval '90 seconds' $fn$;

create or replace function can_accept_jobs(d drivers)
returns boolean
language sql
stable
as $fn$
  select d.status = 'approved'
     and d.is_online
     and d.wallet_balance_centavos > d.credit_floor_centavos
     and d.active_job_id is null
     and d.location is not null
     and d.location_updated_at > now() - location_staleness_limit();
$fn$;

-- ---------------------------------------------------------------- matching

-- Drivers who could take this job right now, nearest first. Excludes anyone
-- who already declined or timed out on it -- re-offering a declined job is
-- how you train drivers to ignore notifications.
create or replace function nearby_drivers(
  p_job_id   uuid,
  p_radius_m int default 2000,
  p_limit    int default 10
)
returns table (driver_id uuid, distance_m int, full_name text, rating numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    d.id,
    st_distance(d.location, j.pickup_location)::int as distance_m,
    p.full_name,
    driver_rating(d.*) as rating
  from jobs j
  join drivers d on can_accept_jobs(d.*)
  join profiles p on p.id = d.id
  where j.id = p_job_id
    and not p.is_blocked
    and st_dwithin(d.location, j.pickup_location, p_radius_m)
    and not exists (
      select 1 from job_offers o
      where o.job_id = j.id
        and o.driver_id = d.id
        and o.response in ('declined', 'timeout')
    )
  order by st_distance(d.location, j.pickup_location)
  limit p_limit;
$fn$;

create or replace function offer_window()
returns interval language sql immutable as $fn$ select interval '25 seconds' $fn$;

-- Broadcast a searching job to the nearest N eligible drivers. Idempotent
-- per (job, driver): a driver who already has a pending offer is skipped.
-- Returns how many drivers now hold a live offer.
create or replace function dispatch_job(
  p_job_id   uuid,
  p_radius_m int default null,
  p_limit    int default 5
)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
  radius int;
  notified int := 0;
begin
  select * into j from jobs where id = p_job_id for update;

  if j.id is null then
    raise exception 'job % not found', p_job_id using errcode = 'no_data_found';
  end if;

  -- Re-dispatching an expired job is how the widening retry works.
  if j.status not in ('searching', 'expired') then
    raise exception 'job % is % and cannot be dispatched', j.reference, j.status
      using errcode = 'check_violation';
  end if;

  radius := coalesce(p_radius_m, j.dispatch_radius_m);

  insert into job_offers (job_id, driver_id, distance_m, expires_at, round)
  select p_job_id, n.driver_id, n.distance_m, now() + offer_window(), j.dispatch_attempts + 1
  from nearby_drivers(p_job_id, radius, p_limit) n
  on conflict (job_id, driver_id) do nothing;

  notified := (select count(*) from job_offers
               where job_id = p_job_id and response = 'pending');

  update jobs
     set dispatch_attempts = j.dispatch_attempts + 1,
         dispatch_radius_m = radius,
         status = 'searching'
   where id = p_job_id;

  insert into job_events (job_id, event_type, payload)
  values (p_job_id, 'dispatched',
          jsonb_build_object('radius_m', radius, 'notified', notified,
                             'round', j.dispatch_attempts + 1));

  return notified;
end;
$fn$;

-- ---------------------------------------------------------------- the claim

-- First accept wins. The `where status = searching and driver_id is null`
-- clause is the whole concurrency story: two drivers tapping Accept in the
-- same millisecond both run this, exactly one updates a row, and the loser
-- gets a clean already-taken error instead of a corrupted job.
create or replace function claim_job(p_job_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
  claimed jobs;
begin
  select * into d from drivers where id = auth.uid() for update;

  if d.id is null then
    raise exception 'not a driver' using errcode = 'insufficient_privilege';
  end if;

  if not can_accept_jobs(d.*) then
    raise exception 'driver is not eligible to accept jobs right now'
      using errcode = 'check_violation',
            detail = format('status=%s online=%s wallet=%s active_job=%s',
                            d.status, d.is_online, d.wallet_balance_centavos, d.active_job_id);
  end if;

  if not exists (
    select 1 from job_offers
    where job_id = p_job_id and driver_id = d.id
      and response = 'pending' and expires_at > now()
  ) then
    raise exception 'no live offer for this job'
      using errcode = 'check_violation';
  end if;

  update jobs
     set driver_id = d.id,
         status = 'assigned'
   where id = p_job_id
     and status = 'searching'
     and driver_id is null
  returning * into claimed;

  if claimed.id is null then
    -- Another driver won the race. Not an error worth alarming about.
    update job_offers set response = 'withdrawn', responded_at = now()
     where job_id = p_job_id and driver_id = d.id and response = 'pending';
    raise exception 'job already taken' using errcode = 'lock_not_available';
  end if;

  update job_offers set response = 'accepted', responded_at = now()
   where job_id = p_job_id and driver_id = d.id;

  -- Everyone else notification is now dead; withdraw it so their app
  -- dismisses the card instead of showing a job they cannot take.
  update job_offers set response = 'withdrawn', responded_at = now()
   where job_id = p_job_id and driver_id <> d.id and response = 'pending';

  update drivers set active_job_id = claimed.id where id = d.id;

  return claimed;
end;
$fn$;

create or replace function decline_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update job_offers
     set response = 'declined', responded_at = now()
   where job_id = p_job_id and driver_id = auth.uid() and response = 'pending';

  insert into job_events (job_id, actor_id, event_type)
  values (p_job_id, auth.uid(), 'offer_declined');
end;
$fn$;

-- ---------------------------------------------------------------- location ping

-- Called by the driver app on a timer. Writes the current position to the
-- driver row (cheap, indexed, and what matching reads) and appends to the
-- trail only while on a job, so idle drivers do not fill the table.
create or replace function ping_location(
  p_lng       double precision,
  p_lat       double precision,
  p_heading   numeric default null,
  p_speed_kph numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  pt geography;
  active uuid;
begin
  pt := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;

  update drivers
     set location = pt,
         heading = coalesce(p_heading, heading),
         location_updated_at = now()
   where id = auth.uid()
  returning active_job_id into active;

  if active is not null then
    insert into driver_locations (driver_id, job_id, location, heading, speed_kph)
    values (auth.uid(), active, pt, p_heading, p_speed_kph);
  end if;
end;
$fn$;

-- Going online is a function, not a column update, so the eligibility
-- reasons can be reported back to the driver as a real message.
create or replace function set_online(p_online boolean)
returns drivers
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
begin
  select * into d from drivers where id = auth.uid() for update;

  if d.id is null then
    raise exception 'not a driver' using errcode = 'insufficient_privilege';
  end if;

  if p_online then
    if d.status <> 'approved' then
      raise exception 'your driver account is %, not approved yet', d.status
        using errcode = 'check_violation';
    end if;
    if d.wallet_balance_centavos <= d.credit_floor_centavos then
      raise exception 'you owe %c in commission -- top up to go back online',
        abs(d.wallet_balance_centavos) using errcode = 'check_violation';
    end if;
  end if;

  update drivers
     set is_online = p_online,
         last_online_at = case when p_online then now() else last_online_at end
   where id = d.id
  returning * into d;

  return d;
end;
$fn$;
