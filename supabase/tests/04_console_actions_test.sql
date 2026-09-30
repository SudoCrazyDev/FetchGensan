-- FetchGensan :: the console's driver buttons
--
-- Regression test for set_driver_status() and assign_job(). Their
-- predecessors were raw UPDATEs that no client role had the column
-- privileges to run, so the buttons failed for everyone. Run as
-- `authenticated`, so the grants are exercised for real.

\set ON_ERROR_STOP on
\timing off

do $$
declare
  dsp  uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  cust uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  drv  uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
  j jobs;
  failed boolean;
begin
  insert into auth.users (id, phone) values
    (dsp, '+639190000001'), (cust, '+639190000002'), (drv, '+639190000003');
  insert into user_roles (user_id, role_id) select dsp, id from roles where key = 'dispatcher';
  insert into drivers (id, status, plate_number) values (drv, 'pending', 'GS 9090');

  set local role authenticated;

  -- A rider may not approve themselves, directly or through the RPC.
  perform set_config('request.jwt.claim.sub', drv::text, true);
  failed := false;
  begin
    perform set_driver_status(drv, 'approved');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a rider approved themselves'; end if;
  raise notice 'ok   set_driver_status needs drivers.manage';

  perform set_config('request.jwt.claim.sub', dsp::text, true);
  perform set_driver_status(drv, 'approved');
  if (select status from drivers where id = drv) <> 'approved' then
    raise exception 'FAIL: dispatcher could not approve a rider';
  end if;
  raise notice 'ok   a dispatcher can approve a rider';

  -- Book a job as the customer, then hand it over by hand.
  perform set_config('request.jwt.claim.sub', cust::text, true);
  j := create_job(
    p_job_type => 'ride',
    p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
    p_dropoff_lng => 125.1783, p_dropoff_lat => 6.1155
  );

  failed := false;
  begin
    perform assign_job(j.id, drv);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a customer assigned a rider'; end if;

  perform set_config('request.jwt.claim.sub', dsp::text, true);
  perform assign_job(j.id, drv);
  reset role;

  if (select status from jobs where id = j.id) <> 'assigned'
     or (select driver_id from jobs where id = j.id) <> drv
     or (select active_job_id from drivers where id = drv) <> j.id then
    raise exception 'FAIL: manual assignment did not assign the job';
  end if;
  if not exists (select 1 from job_events where job_id = j.id and event_type = 'manual_assign') then
    raise exception 'FAIL: manual assignment left no audit event';
  end if;
  raise notice 'ok   a dispatcher can assign a searching job by hand, and it is logged';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', dsp::text, true);

  failed := false;
  begin
    perform assign_job(j.id, drv);
  exception when others then failed := true;
  end;
  if not failed then raise exception 'FAIL: an already-assigned job was assigned again'; end if;

  failed := false;
  begin
    perform set_driver_status(drv, 'suspended');
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: a rider mid-booking was suspended'; end if;
  raise notice 'ok   no double assignment, no suspending a rider mid-booking';

  reset role;
  raise notice '';
  raise notice 'ALL CONSOLE ACTION ASSERTIONS PASSED';
end
$$;
