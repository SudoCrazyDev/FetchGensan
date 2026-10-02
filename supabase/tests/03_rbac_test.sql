-- FetchGensan :: RBAC and auth rate-limit assertions
--
-- Unlike 01, most of this runs with `set local role authenticated` and a
-- JWT subject set, so grants AND row level security apply exactly as they
-- would over the API. The escalation guards are the point: each "must fail"
-- below is a way someone with a little access could otherwise give
-- themselves a lot.

\set ON_ERROR_STOP on
\timing off

do $$
declare
  adm  uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  adm2 uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  dsp  uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  hlp  uuid := 'aaaaaaaa-0000-0000-0000-000000000004';
  cst  uuid := 'aaaaaaaa-0000-0000-0000-000000000005';
  admin_role uuid;
  dispatcher_role uuid;
  helpdesk_role uuid;
  perms text[];
  n int;
  failed boolean;
  err text;
begin
  select id into admin_role from roles where key = 'admin';
  select id into dispatcher_role from roles where key = 'dispatcher';

  insert into auth.users (id, phone, email) values
    (adm,  '+639180000001', 'admin@example.test'),
    (adm2, '+639180000002', 'admin2@example.test'),
    (dsp,  '+639180000003', null),
    (hlp,  '+639180000004', 'helpdesk@example.test'),
    (cst,  '+639180000005', null);

  insert into user_roles (user_id, role_id) values
    (adm, admin_role),
    (dsp, dispatcher_role);

  -- ------------------------------------------------------------ account type

  if (select role from profiles where id = adm) <> 'admin'
     or (select role from profiles where id = dsp) <> 'dispatcher'
     or (select role from profiles where id = cst) <> 'customer' then
    raise exception 'FAIL: profiles.role is not derived from user_roles';
  end if;
  raise notice 'ok   profiles.role follows the roles someone holds';

  -- ------------------------------------------------------------ dispatcher

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', dsp::text, true);

  if not is_staff() then
    raise exception 'FAIL: a dispatcher is not staff';
  end if;
  if has_permission('users.view') then
    raise exception 'FAIL: a dispatcher can see user accounts';
  end if;
  perms := my_permissions();
  if perms <> array['console.access', 'drivers.manage', 'wallet.topup'] then
    raise exception 'FAIL: dispatcher permissions are %', perms;
  end if;
  select count(*) into n from list_users();
  if n <> 0 then
    raise exception 'FAIL: a dispatcher can list % users', n;
  end if;
  select count(*) into n from roles;
  if n <> 1 then
    raise exception 'FAIL: a dispatcher should see only their own role, saw %', n;
  end if;
  raise notice 'ok   dispatcher: staff, but no user or role management';

  -- ------------------------------------------------------------ customer

  perform set_config('request.jwt.claim.sub', cst::text, true);
  if is_staff() or cardinality(my_permissions()) <> 0 then
    raise exception 'FAIL: a customer has staff permissions';
  end if;

  failed := false;
  begin
    insert into roles (key, name) values ('sneaky', 'Sneaky');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a client inserted into roles directly'; end if;

  failed := false;
  begin
    insert into user_roles (user_id, role_id) values (cst, admin_role);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a customer granted themselves admin'; end if;

  failed := false;
  begin
    perform set_user_roles(cst, array[admin_role]);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a customer called set_user_roles'; end if;
  raise notice 'ok   customer: no permissions, and no way to write roles';

  -- ------------------------------------------------------------ admin

  perform set_config('request.jwt.claim.sub', adm::text, true);

  select count(*) into n from permissions where not has_permission(key);
  if n <> 0 then
    raise exception 'FAIL: admin is missing % permissions', n;
  end if;
  if has_permission('no.such_permission') then
    raise exception 'FAIL: an unknown permission key was granted';
  end if;
  raise notice 'ok   admin holds every permission; unknown keys fail closed';

  select id into helpdesk_role
    from create_role('helpdesk', 'Help desk', 'Answers the phone',
                     array['users.view', 'users.manage']);
  perform set_user_roles(hlp, array[helpdesk_role]);
  perform set_user_roles(adm2, array[admin_role]);

  select count(*) into n from list_users();
  if n < 5 then
    raise exception 'FAIL: admin sees only % users', n;
  end if;
  select count(*) into n from list_users('helpdesk@');
  if n <> 1 then
    raise exception 'FAIL: searching users by email found % rows', n;
  end if;
  select count(*) into n from list_users('0918 000 0003');
  if n <> 1 then
    raise exception 'FAIL: searching users by a local-format phone found % rows', n;
  end if;
  select user_count into n from list_roles() where key = 'helpdesk';
  if n <> 1 then
    raise exception 'FAIL: list_roles user_count for helpdesk is %', n;
  end if;
  raise notice 'ok   admin creates roles, assigns them, and lists users';

  failed := false;
  begin
    perform update_role(admin_role, 'Boss', '', array['console.access']);
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: the admin role was edited'; end if;

  failed := false;
  begin
    perform delete_role(dispatcher_role);
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: a built-in role was deleted'; end if;

  failed := false;
  begin
    perform delete_role(helpdesk_role);
  exception when foreign_key_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: a role still held by someone was deleted'; end if;

  failed := false;
  begin
    perform create_role('helpdesk', 'Dupe', '', '{}');
  exception when unique_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: a duplicate role key was accepted'; end if;

  failed := false;
  begin
    perform create_role('ghost', 'Ghost', '', array['made.up']);
  exception when invalid_parameter_value then failed := true;
  end;
  if not failed then raise exception 'FAIL: a role with an unknown permission was created'; end if;

  failed := false;
  begin
    perform set_user_blocked(adm, true);
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: an admin deactivated themselves'; end if;
  raise notice 'ok   built-in roles, held roles and self-deactivation are protected';

  -- Last-admin guard. adm2 is also an admin, so adm may step down...
  perform set_user_roles(adm2, '{}');
  -- ...but now adm is the only one left and may not.
  failed := false;
  begin
    perform set_user_roles(adm, '{}');
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: the last admin removed their own admin role'; end if;
  perform set_user_roles(adm2, array[admin_role]);
  raise notice 'ok   the last active admin cannot be removed';

  -- ------------------------------------------------------------ escalation

  perform set_config('request.jwt.claim.sub', hlp::text, true);

  if is_staff() then
    raise exception 'FAIL: helpdesk (no console.access) counts as staff';
  end if;

  failed := false;
  begin
    perform set_user_roles(cst, array[dispatcher_role]);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: helpdesk granted a role with permissions it does not hold';
  end if;

  failed := false;
  begin
    perform set_user_roles(hlp, array[helpdesk_role, admin_role]);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: helpdesk made itself admin'; end if;

  failed := false;
  begin
    perform set_user_blocked(adm, true);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: helpdesk deactivated an admin'; end if;

  if can_manage_user(adm) then
    raise exception 'FAIL: helpdesk may manage (e.g. reset the password of) an admin';
  end if;
  if not can_manage_user(cst) then
    raise exception 'FAIL: helpdesk may not manage a plain customer';
  end if;

  failed := false;
  begin
    perform create_role('mine', 'Mine', '', '{}');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: helpdesk created a role without roles.manage'; end if;

  perform update_user_profile(cst, 'Maria S.', 'Prefers text over calls');
  raise notice 'ok   nobody can grant, or act on someone with, more than they hold';

  -- ------------------------------------------------------------ blocking

  perform set_config('request.jwt.claim.sub', adm::text, true);
  perform set_user_blocked(dsp, true);

  perform set_config('request.jwt.claim.sub', dsp::text, true);
  if is_staff() or cardinality(my_permissions()) <> 0 then
    raise exception 'FAIL: a deactivated dispatcher kept their permissions';
  end if;

  perform set_config('request.jwt.claim.sub', adm::text, true);
  perform set_user_blocked(dsp, false);
  raise notice 'ok   deactivating someone removes every permission immediately';

  -- ------------------------------------------------------------ enforcement

  perform update_role(dispatcher_role, 'Dispatcher', 'Runs the live board',
                      array['console.access', 'drivers.manage']);

  perform set_config('request.jwt.claim.sub', dsp::text, true);
  failed := false;
  begin
    perform record_topup(cst, 10000, 'test');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: record_topup ran without wallet.topup';
  end if;
  raise notice 'ok   record_topup requires wallet.topup, not just staff';

  perform set_config('request.jwt.claim.sub', adm::text, true);
  perform set_user_roles(dsp, '{}');

  reset role;

  if (select role from profiles where id = dsp) <> 'customer' then
    raise exception 'FAIL: removing every role did not revert profiles.role';
  end if;
  raise notice 'ok   removing staff roles reverts the account type';
end
$$;

-- ---------------------------------------------------------------- rate limit

do $$
declare
  r int;
  i int;
begin
  for i in 1..5 loop
    r := auth_rate_limit_hit('login:id', 'k1', 5, 900);
    if r <> 0 then
      raise exception 'FAIL: attempt % of 5 was refused', i;
    end if;
  end loop;

  r := auth_rate_limit_hit('login:id', 'k1', 5, 900);
  if r <= 0 or r > 900 then
    raise exception 'FAIL: 6th attempt should be refused with a retry-after, got %', r;
  end if;

  if auth_rate_limit_hit('login:id', 'k2', 5, 900) <> 0 then
    raise exception 'FAIL: one key''s attempts locked out a different key';
  end if;
  if auth_rate_limit_hit('reset:id', 'k1', 5, 900) <> 0 then
    raise exception 'FAIL: buckets are not independent';
  end if;
  raise notice 'ok   rate limit refuses the attempt after the limit, per key and bucket';

  perform auth_rate_limit_clear('login:id', 'k1');
  if auth_rate_limit_hit('login:id', 'k1', 5, 900) <> 0 then
    raise exception 'FAIL: clearing a key did not lift the limit';
  end if;
  raise notice 'ok   a successful sign-in clears the account''s count';

  -- Attempts older than the window stop counting.
  insert into auth_attempts (bucket, key_hash, created_at)
  select 'login:id', 'k3', now() - interval '20 minutes' from generate_series(1, 5);
  if auth_rate_limit_hit('login:id', 'k3', 5, 900) <> 0 then
    raise exception 'FAIL: attempts outside the window still counted';
  end if;
  if (select count(*) from auth_attempts where key_hash = 'k3') <> 1 then
    raise exception 'FAIL: expired attempts were not deleted';
  end if;
  raise notice 'ok   the window slides and expired attempts are cleaned up';

  if has_function_privilege('anon', 'auth_rate_limit_hit(text, text, int, int)', 'execute')
     or has_function_privilege('authenticated', 'auth_rate_limit_clear(text, text)', 'execute')
     or has_table_privilege('authenticated', 'auth_attempts', 'select') then
    raise exception 'FAIL: a client role can reach the rate limiter';
  end if;
  raise notice 'ok   only the service role can touch the rate limiter';

  raise notice '';
  raise notice 'ALL RBAC ASSERTIONS PASSED';
end
$$;
