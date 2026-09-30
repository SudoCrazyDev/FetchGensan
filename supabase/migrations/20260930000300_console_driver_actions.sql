-- FetchGensan :: RPCs behind the console's driver buttons
--
-- BUG FIX. The Drivers page approved, rejected and suspended riders with a
-- raw `update drivers set status = ...`, and the API's manual assignment
-- did `update jobs set driver_id = ..., status = 'assigned'`. Neither could
-- ever work: 20260907001100_rls.sql grants `authenticated` UPDATE only on
-- a driver's vehicle columns and no UPDATE on jobs at all, so both failed
-- with "permission denied" for every user, admins included. The staff
-- policies on those tables were never reachable.
--
-- The fix follows the rule of this schema: a state change is an RPC, not
-- a wider column grant. Widening the grant would have let any driver
-- approve themselves, since drivers_update_self covers their own row.

-- ---------------------------------------------------------------- driver status

create or replace function set_driver_status(p_driver_id uuid, p_status driver_status)
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

  return d;
end;
$fn$;

-- ---------------------------------------------------------------- manual assign

-- The dispatcher's escape hatch when auto-dispatch has not found anyone
-- and they are on the phone with a rider they trust. Same effect as
-- claim_job(), minus the offer and the online/location checks: the
-- dispatcher has confirmed availability themselves.
create or replace function assign_job(p_job_id uuid, p_driver_id uuid)
returns jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  d drivers;
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

grant execute on function
  set_driver_status(uuid, driver_status),
  assign_job(uuid, uuid)
to authenticated;
grant execute on function
  set_driver_status(uuid, driver_status),
  assign_job(uuid, uuid)
to service_role;
