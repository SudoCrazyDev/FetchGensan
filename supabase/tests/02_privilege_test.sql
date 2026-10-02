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
         'prune_push_tokens',
         -- push fan-out: fires HTTP requests with a secret from Vault
         'send_push',
         'push_on_offer',
         'push_on_job_status',
         'push_on_manual_assign',
         -- internal guards for the admin RPCs
         'require_staff',
         'require_admin'
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
  --
  -- Extension-owned functions are excluded, and the reason matters. PostGIS
  -- and pg_trgm install ~775 functions into `public`, all granting EXECUTE
  -- to PUBLIC. On hosted Supabase they are owned by `supabase_admin`, and
  -- `postgres` is not a superuser there, so our revoke cannot touch them --
  -- it skips them silently. Locally psql IS superuser, so the same revoke
  -- strips them, and the unfiltered assertion passes here while being
  -- impossible to satisfy in production.
  --
  -- That divergence is the trap: an assertion that can only pass locally
  -- reports a lockdown we do not actually have. It is also not worth
  -- chasing -- st_distance() and friends are pure maths, not SECURITY
  -- DEFINER, and touch none of our tables. Supabase ships every project
  -- this way. What must hold is that nothing WE own is reachable.
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and has_function_privilege('public', p.oid, 'execute')
     and not exists (
       select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
     );

  if n > 0 then
    select string_agg(p.proname, ', ') into bad
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and has_function_privilege('public', p.oid, 'execute')
       and not exists (
         select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
       );
    raise exception
      'FAIL: % function(s) we own still carry an EXECUTE grant to PUBLIC: %', n, bad;
  end if;
  raise notice 'ok   no function we own grants EXECUTE to PUBLIC';

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
      'unregister_push_token', 'generate_job_reference', 'bump_landmark',
      -- called inside public_driver_info / driver_roster, which run their
      -- functions as the caller
      'driver_rating', 'can_accept_jobs', 'location_staleness_limit',
      -- called by search_landmarks(), which runs as the caller
      'point_of',
      -- called by quote_fare(), which runs as the caller
      'active_fare_config', 'is_night_hours',
      -- 20261002000200: driver signup, errand review, contact
      'register_driver', 'reject_errand_total', 'job_customer_contact',
      -- 20261002000100: the console. Each checks is_staff()/admin inside.
      'admin_set_driver_status', 'admin_review_document', 'admin_set_credit_floor',
      'admin_wallet_adjustment', 'admin_assign_job', 'admin_set_blocked',
      'admin_set_role', 'admin_update_fare', 'admin_upsert_landmark',
      'admin_daily_stats'
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

end
$$;

-- ---------------------------------------------------------------- actually call it
--
-- The grant check above is necessary but NOT sufficient, and this is the
-- exact gap that shipped a regression: search_landmarks() carried its anon
-- grant correctly, and the call still failed with
--
--   permission denied for function is_staff
--
-- because search_landmarks() is `stable` rather than security definer, so
-- landmark_suggestions' read policy -- `using (is_active or is_staff())` --
-- was evaluated as anon, and anon had lost EXECUTE on is_staff().
--
-- A privilege graph cannot show that. The only way to catch it is to switch
-- into the role and make the call.
--
-- `set local role` is also the one way this suite gets real RLS coverage:
-- psql connects as superuser and bypasses row level security, but once the
-- current role is anon, policies apply normally.
do $$
declare
  n int;
begin
  set local role anon;
  begin
    select count(*) into n from search_landmarks('', null, null, 5);
  exception when others then
    reset role;
    raise exception
      'FAIL: anon holds the grant on search_landmarks but cannot CALL it: % (%)',
      sqlerrm, sqlstate;
  end;
  reset role;
  raise notice 'ok   anon can actually execute search_landmarks (% rows)', n;

  raise notice '';
  raise notice 'ALL PRIVILEGE ASSERTIONS PASSED';
end
$$;
