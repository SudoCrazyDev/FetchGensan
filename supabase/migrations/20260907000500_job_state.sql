-- FetchGensan :: job state machine
-- The transition table below is the single source of truth in the database.
-- packages/core/src/job-state.ts mirrors it for the client, and
-- packages/core/src/job-state.test.ts asserts the two stay in sync.

create or replace function allowed_job_transitions(p_type job_type, p_from job_status)
returns job_status[]
language sql
immutable
as $$
  select case p_from
    when 'draft'      then array['searching', 'cancelled']::job_status[]
    when 'searching'  then array['assigned', 'cancelled', 'expired']::job_status[]
    when 'assigned'   then array['arriving', 'cancelled']::job_status[]
    when 'arriving'   then array['arrived_pickup', 'cancelled']::job_status[]

    -- An errand goes shopping at the store; a ride or delivery just departs.
    when 'arrived_pickup' then
      case when p_type = 'errand'
           then array['shopping', 'cancelled']::job_status[]
           else array['in_progress', 'cancelled']::job_status[] end

    when 'shopping'          then array['awaiting_approval', 'cancelled']::job_status[]
    -- Customer approved the receipt: now the driver actually delivers.
    when 'awaiting_approval' then array['in_progress', 'shopping', 'cancelled']::job_status[]
    when 'in_progress'       then array['completed', 'cancelled']::job_status[]

    -- Terminal.
    when 'completed' then array[]::job_status[]
    when 'cancelled' then array[]::job_status[]
    -- An expired job can be pushed back out to a wider radius.
    when 'expired'   then array['searching', 'cancelled']::job_status[]
    else array[]::job_status[]
  end;
$$;

create or replace function guard_job_transition()
returns trigger
language plpgsql
as $$
declare
  allowed job_status[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := allowed_job_transitions(old.job_type, old.status);

  if not (new.status = any (allowed)) then
    raise exception
      'illegal job transition % -> % for % job %',
      old.status, new.status, old.job_type, old.reference
      using errcode = 'check_violation';
  end if;

  -- Stamp the lifecycle timestamps here so no caller can forget to, and so
  -- the values are always server time rather than a phone's clock.
  case new.status
    when 'assigned'         then new.assigned_at       := coalesce(new.assigned_at, now());
    when 'arrived_pickup'   then new.arrived_pickup_at := coalesce(new.arrived_pickup_at, now());
    when 'in_progress'      then new.started_at        := coalesce(new.started_at, now());
    when 'completed'        then new.completed_at      := coalesce(new.completed_at, now());
    when 'cancelled'        then new.cancelled_at      := coalesce(new.cancelled_at, now());
    else null;
  end case;

  return new;
end;
$$;

create trigger jobs_guard_transition before update of status on jobs
  for each row execute function guard_job_transition();

-- Every status change lands in the audit log automatically.
create or replace function log_job_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into job_events (job_id, actor_id, event_type, to_status, payload)
    values (new.id, auth.uid(), 'created', new.status,
            jsonb_build_object('job_type', new.job_type,
                               'quoted_fare_centavos', new.quoted_fare_centavos));
  elsif new.status is distinct from old.status then
    insert into job_events (job_id, actor_id, event_type, from_status, to_status, payload)
    values (new.id, auth.uid(), 'status_changed', old.status, new.status,
            jsonb_build_object('driver_id', new.driver_id));
  end if;
  return null;
end;
$$;

create trigger jobs_log_transition after insert or update of status on jobs
  for each row execute function log_job_transition();

-- job_events is append-only. Revoking at the table level is not enough --
-- this stops even a service-role mistake from rewriting history.
create or replace function reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end;
$$;

create trigger job_events_immutable before update or delete on job_events
  for each row execute function reject_mutation();
