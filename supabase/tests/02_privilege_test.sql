-- FetchGensan :: function privilege assertions
--
-- Regression test for the hole closed by 20260908000100.
--
-- Every function in `public` was callable by unauthenticated users because
-- `revoke ... from anon, authenticated` does not remove PostgreSQL's default
-- `execute ... to public` grant, and `anon` inherits PUBLIC. The money
-- ledger writer was reachable from the open internet.
--
-- These assertions check the privilege GRAPH rather than trying to call the
-- functions, so they hold regardless of what any function's own guards do.

\set ON_ERROR_STOP on

do $$
declare
  bad text;
  n int;
begin
  -- ------------------------------------------------------------ the allowlist
  --
  -- Functions a client must never be able to invoke directly. Each is either
  -- a money mover, a destructive sweeper, or dispatch machinery meant only
  -- for pg_cron and the service role.
  for bad in
    select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'adjust_wallet',
         'settle_job_money',
         'dispatch_tick',
         'expire_stale_offers',
         'redispatch_waiting_jobs',
         'release_scheduled_jobs',
         'reap_stale_drivers',
         'prune_driver_locations',
         'prune_push_tokens'
       )
       and (
         has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute')
       )
  loop
    raise exception
      'FAIL: %() is callable by anon or authenticated. It is SECURITY DEFINER '
      'and either writes money or destroys data -- it must be owner-only.', bad;
  end loop;
  raise notice 'ok   no money mover or sweeper is client-callable';

  -- ------------------------------------------------------------ no PUBLIC grants
  --
  -- The specific mistake: relying on a revoke from the named roles while the
  -- default PUBLIC grant stayed in place.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and has_function_privilege('public', p.oid, 'execute');

  if n > 0 then
    select string_agg(p.proname, ', ') into bad
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and has_function_privilege('public', p.oid, 'execute');
    raise exception
      'FAIL: % function(s) still carry an EXECUTE grant to PUBLIC: %', n, bad;
  end if;
  raise notice 'ok   no function in public grants EXECUTE to PUBLIC';

  -- ------------------------------------------------------------ default privileges
  --
  -- Without this, the next `create function` silently re-opens the hole.
  if exists (
    select 1
      from pg_default_acl d
      join pg_namespace ns on ns.oid = d.defaclnamespace
     where ns.nspname = 'public'
       and d.defaclobjtype = 'f'
       and array_to_string(d.defaclacl, ',') like '%=X/%'
       and array_to_string(d.defaclacl, ',') like '%"=X%'
  ) then
    raise exception 'FAIL: schema default still grants EXECUTE on new functions to PUBLIC';
  end if;
  raise notice 'ok   schema default no longer grants EXECUTE to PUBLIC';

  -- ------------------------------------------------------------ still usable
  --
  -- The lockdown must not have broken the app. These are the calls the three
  -- clients actually make.
  for bad in
    select fn from unnest(array[
      'create_job', 'advance_job', 'complete_job', 'cancel_job',
      'submit_errand_receipt', 'approve_errand_total', 'rate_job',
      'claim_job', 'decline_job', 'ping_location', 'set_online',
      'quote_fare', 'job_driver_position', 'auth_role', 'is_staff',
      'record_topup', 'nearby_drivers', 'dispatch_job',
      'job_is_mine', 'job_participant', 'has_live_offer',
      'job_items_editable', 'is_active_job_counterparty',
      'job_receipt_uploadable', 'register_push_token',
      'unregister_push_token', 'generate_job_reference', 'bump_landmark'
    ]) as fn
    where not exists (
      select 1 from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = fn
        and has_function_privilege('authenticated', p.oid, 'execute')
    )
  loop
    raise exception
      'FAIL: %() is NOT callable by authenticated -- the lockdown broke the app', bad;
  end loop;
  raise notice 'ok   every client-facing RPC is still callable by authenticated';

  -- Landmark search runs before sign-in on the booking screen.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'search_landmarks'
      and has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception 'FAIL: search_landmarks() must stay callable by anon';
  end if;
  raise notice 'ok   search_landmarks stays public';

  -- ------------------------------------------------------------ table privileges
  --
  -- Supabase configures default privileges that grant new tables to anon and
  -- authenticated, so a table added in a later migration can arrive with
  -- write access nobody intended. RLS is the backstop, but writes to these
  -- must not be reachable at the privilege level either.
  for bad in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in ('wallet_transactions', 'job_events', 'job_offers',
                         'driver_locations', 'fare_config')
       and (
         has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update')
         or has_table_privilege('anon', c.oid, 'delete')
         or has_table_privilege('authenticated', c.oid, 'insert')
         or has_table_privilege('authenticated', c.oid, 'update')
         or has_table_privilege('authenticated', c.oid, 'delete')
       )
  loop
    raise exception 'FAIL: % is directly writable by a client role', bad;
  end loop;
  raise notice 'ok   ledger, audit and dispatch tables are not client-writable';

  -- ------------------------------------------------------------ RLS everywhere
  --
  -- Extension-owned tables are excluded. PostGIS installs `spatial_ref_sys`
  -- into public -- a static table of coordinate-system definitions that
  -- cannot have RLS enabled without superuser and does not need it. Supabase
  -- flags the same table in its own linter as a known false positive.
  for bad in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and not c.relrowsecurity
       and not exists (
         select 1 from pg_depend d
         where d.objid = c.oid and d.deptype = 'e'
       )
  loop
    raise exception 'FAIL: table % has row level security disabled', bad;
  end loop;
  raise notice 'ok   row level security is enabled on every table we own';

  raise notice '';
  raise notice 'ALL PRIVILEGE ASSERTIONS PASSED';
end
$$;
