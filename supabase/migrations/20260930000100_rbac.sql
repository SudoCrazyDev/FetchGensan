-- FetchGensan :: role-based access control for staff
--
-- Before this migration, staff access was one enum column: profiles.role
-- was 'dispatcher' or 'admin', and is_staff() compared against it. That
-- cannot express "can record cash top-ups but cannot edit fares", and the
-- only way to make someone a dispatcher was an SQL update.
--
-- The model now:
--
--   permissions        fixed catalogue, one row per thing the code checks.
--                      Seeded here, never written by clients: a permission
--                      nothing enforces would be a checkbox that lies.
--   roles              named bundles of permissions. Admins create them.
--   role_permissions   which permissions each role grants.
--   user_roles         who holds which role.
--
-- has_permission() is the single check. is_staff() is redefined on top of
-- it, so every existing policy and RPC that says "staff" now means "holds
-- console.access" without being rewritten.
--
-- The built-in `admin` role always holds every permission, including ones
-- added by later migrations; its row in role_permissions is not consulted.
--
-- profiles.role is kept, and stays truthful: it is DERIVED from user_roles
-- by a trigger below (admin > dispatcher > driver/customer), so older
-- readers of that column keep working. Nothing should write it directly.
--
-- Every write goes through a SECURITY DEFINER RPC at the bottom. Clients get
-- SELECT on these tables and nothing else, same as the rest of the schema.

-- ---------------------------------------------------------------- tables

create table permissions (
  key         text primary key check (key ~ '^[a-z]+\.[a-z_]+$'),
  category    text not null,
  label       text not null,
  description text not null default '',
  sort_order  int  not null default 0
);

create table roles (
  id          uuid primary key default gen_random_uuid(),
  -- Stable identifier for code and seed scripts. Names can change; keys do not.
  key         text not null unique check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        text not null check (length(btrim(name)) between 1 and 60),
  description text not null default '' check (length(description) <= 280),
  -- Built-in roles cannot be deleted, and `admin` cannot be edited at all.
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger roles_updated_at before update on roles
  for each row execute function set_updated_at();

create table role_permissions (
  role_id        uuid not null references roles (id) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

create table user_roles (
  user_id    uuid not null references profiles (id) on delete cascade,
  -- RESTRICT: delete_role() refuses while anyone holds the role, so a role
  -- never disappears out from under someone mid-shift.
  role_id    uuid not null references roles (id) on delete restrict,
  granted_by uuid references profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index user_roles_role_idx on user_roles (role_id);

-- ---------------------------------------------------------------- catalogue
--
-- Only permissions that something actually enforces. Where each is checked:
--
--   console.access   is_staff(), and so every staff policy, view and RPC
--                    written before this migration
--   drivers.manage   write policies on drivers and driver_documents
--   wallet.topup     record_topup()
--   pricing.manage   write policy on fare_config
--   users.view       list_users(), and reading other people's roles
--   users.manage     set_user_roles(), set_user_blocked(), update_user_profile(),
--                    and the admin-users edge function
--   roles.manage     create_role(), update_role(), delete_role()

insert into permissions (key, category, label, description, sort_order) values
  ('console.access', 'Dispatch', 'Use the dispatch console',
   'Sign in to the console, see the live board, jobs and the driver roster, and act on bookings.', 10),
  ('drivers.manage', 'Drivers', 'Approve drivers and documents',
   'Approve, suspend or reject riders and review their uploaded documents.', 20),
  ('wallet.topup', 'Money', 'Record cash top-ups',
   'Credit a rider''s wallet when they hand over cash at the office.', 30),
  ('pricing.manage', 'Money', 'Edit fares',
   'Change base fares, per-kilometre rates, surcharges and commission.', 40),
  ('users.view', 'People', 'See user accounts',
   'Look up customers, riders and staff, and see which roles they hold.', 50),
  ('users.manage', 'People', 'Manage user accounts',
   'Create accounts, reset passwords, assign roles, and deactivate people.', 60),
  ('roles.manage', 'People', 'Manage roles',
   'Create, edit and delete roles and choose what each one can do.', 70);

insert into roles (key, name, description, is_system) values
  ('admin', 'Admin', 'Full access to everything, including users and roles.', true),
  ('dispatcher', 'Dispatcher', 'Runs the live board and the driver roster.', true);

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  cross join permissions p
 where r.key = 'admin';

insert into role_permissions (role_id, permission_key)
select r.id, k
  from roles r
  cross join unnest(array['console.access', 'drivers.manage', 'wallet.topup']) as k
 where r.key = 'dispatcher';

-- ---------------------------------------------------------------- checks

-- Every permission `p_user_id` holds through their roles. Blocked accounts
-- are NOT filtered here on purpose: this is what the escalation guards
-- compare against, and a deactivated admin is still an admin for the
-- purposes of "may you edit this person".
create or replace function user_permission_keys(p_user_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select pm.key
    from permissions pm
   where exists (
     select 1
       from user_roles ur
       join roles r on r.id = ur.role_id
      where ur.user_id = p_user_id
        and (
          r.key = 'admin'
          or exists (select 1 from role_permissions rp
                      where rp.role_id = r.id and rp.permission_key = pm.key)
        )
   );
$fn$;

create or replace function role_permission_keys(p_role_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select pm.key
    from permissions pm
    join roles r on r.id = p_role_id
   where r.key = 'admin'
      or exists (select 1 from role_permissions rp
                  where rp.role_id = r.id and rp.permission_key = pm.key);
$fn$;

-- THE check. True when the caller holds the permission through any role and
-- their account is not blocked. An unknown key is false for everyone,
-- admins included, so a typo in a policy fails closed.
create or replace function has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    exists (select 1 from profiles where id = auth.uid() and not is_blocked)
    and p_permission in (select user_permission_keys(auth.uid())),
    false
  );
$fn$;

-- What the console asks once after sign-in, to decide which pages to show.
-- Cosmetic: every page is still guarded by the database.
create or replace function my_permissions()
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(k order by k), '{}')
    from user_permission_keys(auth.uid()) as k
   where exists (select 1 from profiles where id = auth.uid() and not is_blocked);
$fn$;

-- Redefined, same signature, so the anon/authenticated grants and every
-- policy that calls it carry over untouched.
create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select has_permission('console.access');
$fn$;

-- Escalation guard: you may only manage someone whose powers are a subset
-- of your own. Without it, anyone with users.manage could reset an admin's
-- password and sign in as them.
create or replace function can_manage_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select has_permission('users.manage')
     and not exists (
       select user_permission_keys(p_user_id)
       except
       select user_permission_keys(auth.uid())
     );
$fn$;

-- For the roles/role_permissions read policies: a staff member may always
-- see the roles they themselves hold.
create or replace function role_is_mine(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from user_roles where user_id = auth.uid() and role_id = p_role_id);
$fn$;

create or replace function require_permission(p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  what text;
begin
  if not has_permission(p_permission) then
    select label into what from permissions where key = p_permission;
    raise exception 'you need the "%" permission to do that', coalesce(what, p_permission)
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

-- Unblocked holders of the admin role, optionally not counting one person.
create or replace function active_admin_count(p_excluding uuid default null)
returns int
language sql
stable
security definer
set search_path = public
as $fn$
  select count(distinct ur.user_id)::int
    from user_roles ur
    join roles r on r.id = ur.role_id and r.key = 'admin'
    join profiles p on p.id = ur.user_id and not p.is_blocked
   where p_excluding is null or ur.user_id <> p_excluding;
$fn$;

-- ---------------------------------------------------------------- profiles.role

-- Keeps the legacy enum column in step with the roles someone holds.
create or replace function refresh_account_type(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  derived user_role;
begin
  if exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
              where ur.user_id = p_user_id and r.key = 'admin') then
    derived := 'admin';
  elsif 'console.access' in (select user_permission_keys(p_user_id)) then
    derived := 'dispatcher';
  elsif exists (select 1 from drivers where id = p_user_id) then
    derived := 'driver';
  else
    derived := 'customer';
  end if;

  update profiles set role = derived where id = p_user_id and role is distinct from derived;
end;
$fn$;

create or replace function user_roles_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform refresh_account_type(coalesce(new.user_id, old.user_id));
  return null;
end;
$fn$;

create trigger user_roles_account_type
  after insert or delete on user_roles
  for each row execute function user_roles_changed();

create or replace function role_permissions_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform refresh_account_type(ur.user_id)
     from user_roles ur
    where ur.role_id = coalesce(new.role_id, old.role_id);
  return null;
end;
$fn$;

create trigger role_permissions_account_type
  after insert or delete on role_permissions
  for each row execute function role_permissions_changed();

-- ---------------------------------------------------------------- backfill

-- Everyone who was staff under the old enum keeps exactly the access they had.
insert into user_roles (user_id, role_id)
select p.id, r.id
  from profiles p
  join roles r on r.key = p.role::text
 where p.role in ('dispatcher', 'admin')
on conflict do nothing;

-- ---------------------------------------------------------------- policies

alter table permissions      enable row level security;
alter table roles            enable row level security;
alter table role_permissions enable row level security;
alter table user_roles       enable row level security;

-- The catalogue is not a secret; the role editor needs it.
create policy permissions_read on permissions
  for select using (true);

create policy roles_read on roles
  for select using (
    has_permission('users.view') or has_permission('roles.manage') or role_is_mine(roles.id)
  );

create policy role_permissions_read on role_permissions
  for select using (
    has_permission('users.view') or has_permission('roles.manage')
    or role_is_mine(role_permissions.role_id)
  );

create policy user_roles_read on user_roles
  for select using (user_id = auth.uid() or has_permission('users.view'));

-- Replace the two policies that checked the old enum directly, and split
-- "staff may write anything" into the specific permission for it.

drop policy profiles_all_staff on profiles;
create policy profiles_write_users_manage on profiles
  for update using (has_permission('users.manage')) with check (has_permission('users.manage'));

drop policy fare_config_staff on fare_config;
create policy fare_config_pricing on fare_config
  for all using (has_permission('pricing.manage')) with check (has_permission('pricing.manage'));

drop policy drivers_all_staff on drivers;
create policy drivers_write_staff on drivers
  for all using (has_permission('drivers.manage')) with check (has_permission('drivers.manage'));

-- driver_documents had no separate staff SELECT policy; the old FOR ALL
-- policy was carrying reads too, so reads get their own before it goes.
drop policy driver_documents_staff on driver_documents;
create policy driver_documents_select_staff on driver_documents
  for select using (is_staff());
create policy driver_documents_write_staff on driver_documents
  for all using (has_permission('drivers.manage')) with check (has_permission('drivers.manage'));

-- ---------------------------------------------------------------- record_topup

create or replace function record_topup(
  p_driver_id uuid,
  p_amount    bigint,
  p_note      text default ''
)
returns wallet_transactions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform require_permission('wallet.topup');
  if p_amount <= 0 then
    raise exception 'top-up must be positive' using errcode = 'check_violation';
  end if;
  return adjust_wallet(p_driver_id, 'topup', p_amount, null, p_note);
end;
$fn$;

-- ---------------------------------------------------------------- reads

-- The Users page. A function rather than a view because it reads
-- auth.users for email and last sign-in, and a view over auth.users is
-- exactly what Supabase's security advisor flags.
create or replace function list_users(
  p_search text default '',
  p_limit  int  default 100,
  p_offset int  default 0
)
returns table (
  id              uuid,
  full_name       text,
  phone           text,
  email           text,
  account_type    user_role,
  is_blocked      boolean,
  is_driver       boolean,
  notes           text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  roles           jsonb
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    p.id,
    p.full_name,
    p.phone,
    u.email::text,
    p.role,
    p.is_blocked,
    exists (select 1 from drivers d where d.id = p.id),
    p.notes,
    p.created_at,
    u.last_sign_in_at,
    coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'key', r.key, 'name', r.name)
                       order by r.name)
        from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = p.id
    ), '[]'::jsonb)
  from profiles p
  join auth.users u on u.id = p.id
  where has_permission('users.view')
    and (
      coalesce(btrim(p_search), '') = ''
      or p.full_name ilike '%' || btrim(p_search) || '%'
      -- Phone numbers are stored E.164, people type 0917 123 4567: compare
      -- digits only, minus the leading 0 or 63.
      or (length(regexp_replace(p_search, '\D', '', 'g')) >= 3
          and p.phone like '%' || regexp_replace(regexp_replace(p_search, '\D', '', 'g'),
                                                 '^(63|0)', '') || '%')
      or u.email ilike '%' || btrim(p_search) || '%'
    )
  order by p.created_at desc
  limit least(greatest(p_limit, 1), 500)
  offset greatest(p_offset, 0);
$fn$;

create or replace function list_roles()
returns table (
  id          uuid,
  key         text,
  name        text,
  description text,
  is_system   boolean,
  permissions text[],
  user_count  int,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    r.id,
    r.key,
    r.name,
    r.description,
    r.is_system,
    coalesce((select array_agg(k order by k) from role_permission_keys(r.id) as k), '{}'),
    (select count(*) from user_roles ur where ur.role_id = r.id)::int,
    r.created_at
  from roles r
  where has_permission('users.view') or has_permission('roles.manage')
  order by r.is_system desc, r.name;
$fn$;

-- ---------------------------------------------------------------- role writes

create or replace function assert_known_permissions(p_permissions text[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  unknown text;
begin
  select k into unknown
    from unnest(coalesce(p_permissions, '{}')) as k
   where k not in (select key from permissions)
   limit 1;
  if unknown is not null then
    raise exception 'unknown permission "%"', unknown using errcode = 'invalid_parameter_value';
  end if;
end;
$fn$;

-- You cannot hand out a power you do not have yourself.
create or replace function assert_can_grant(p_permissions text[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  missing text;
begin
  select pm.label into missing
    from unnest(coalesce(p_permissions, '{}')) as k
    join permissions pm on pm.key = k
   where k not in (select user_permission_keys(auth.uid()))
   limit 1;
  if missing is not null then
    raise exception 'you cannot grant "%" because you do not have it yourself', missing
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

create or replace function create_role(
  p_key         text,
  p_name        text,
  p_description text default '',
  p_permissions text[] default '{}'
)
returns roles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_role roles;
begin
  perform require_permission('roles.manage');
  perform assert_known_permissions(p_permissions);
  perform assert_can_grant(p_permissions);

  begin
    insert into roles (key, name, description)
    values (lower(btrim(p_key)), btrim(p_name), coalesce(btrim(p_description), ''))
    returning * into new_role;
  exception
    when unique_violation then
      raise exception 'a role with the key "%" already exists', lower(btrim(p_key))
        using errcode = 'unique_violation';
    when check_violation then
      raise exception 'role keys are 2-40 lowercase letters, digits or underscores, '
                      'starting with a letter, and names are 1-60 characters'
        using errcode = 'check_violation';
  end;

  insert into role_permissions (role_id, permission_key)
  select new_role.id, k from unnest(coalesce(p_permissions, '{}')) as k
  on conflict do nothing;

  return new_role;
end;
$fn$;

create or replace function update_role(
  p_role_id     uuid,
  p_name        text,
  p_description text,
  p_permissions text[]
)
returns roles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r roles;
  added text[];
begin
  perform require_permission('roles.manage');

  select * into r from roles where id = p_role_id for update;
  if r.id is null then
    raise exception 'that role no longer exists' using errcode = 'no_data_found';
  end if;
  if r.key = 'admin' then
    raise exception 'the Admin role is built in and always has every permission'
      using errcode = 'check_violation';
  end if;

  perform assert_known_permissions(p_permissions);

  select coalesce(array_agg(k), '{}') into added
    from unnest(coalesce(p_permissions, '{}')) as k
   where k not in (select role_permission_keys(p_role_id));
  perform assert_can_grant(added);

  begin
    update roles
       set name = btrim(p_name),
           description = coalesce(btrim(p_description), '')
     where id = p_role_id
    returning * into r;
  exception when check_violation then
    raise exception 'role names are 1-60 characters and descriptions at most 280'
      using errcode = 'check_violation';
  end;

  delete from role_permissions
   where role_id = p_role_id
     and permission_key <> all (coalesce(p_permissions, '{}'));

  insert into role_permissions (role_id, permission_key)
  select p_role_id, k from unnest(coalesce(p_permissions, '{}')) as k
  on conflict do nothing;

  return r;
end;
$fn$;

create or replace function delete_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r roles;
  holders int;
begin
  perform require_permission('roles.manage');

  select * into r from roles where id = p_role_id for update;
  if r.id is null then
    raise exception 'that role no longer exists' using errcode = 'no_data_found';
  end if;
  if r.is_system then
    raise exception 'the % role is built in and cannot be deleted', r.name
      using errcode = 'check_violation';
  end if;

  select count(*) into holders from user_roles where role_id = p_role_id;
  if holders > 0 then
    raise exception '% still % this role. Take it off them first.',
      case when holders = 1 then '1 person' else holders || ' people' end,
      case when holders = 1 then 'has' else 'have' end
      using errcode = 'foreign_key_violation';
  end if;

  delete from roles where id = p_role_id;
end;
$fn$;

-- ---------------------------------------------------------------- user writes

create or replace function assert_can_manage(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform require_permission('users.manage');
  if not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'that account no longer exists' using errcode = 'no_data_found';
  end if;
  if not can_manage_user(p_user_id) then
    raise exception 'that person has permissions you do not, so only someone with at least '
                    'their access can change their account'
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

-- Replaces the full set of roles someone holds.
create or replace function set_user_roles(p_user_id uuid, p_role_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  wanted uuid[] := coalesce(p_role_ids, '{}');
  added_perms text[];
  admin_id uuid;
begin
  perform assert_can_manage(p_user_id);

  if exists (select 1 from unnest(wanted) as w where w not in (select id from roles)) then
    raise exception 'one of those roles no longer exists' using errcode = 'no_data_found';
  end if;

  -- Every permission the new roles would add must be one the caller holds.
  select coalesce(array_agg(distinct k), '{}') into added_perms
    from unnest(wanted) as w
    cross join lateral role_permission_keys(w) as k
   where w not in (select role_id from user_roles where user_id = p_user_id);
  perform assert_can_grant(added_perms);

  select id into admin_id from roles where key = 'admin';
  if exists (select 1 from user_roles where user_id = p_user_id and role_id = admin_id)
     and admin_id <> all (wanted)
     and active_admin_count(p_user_id) = 0 then
    raise exception 'FetchGensan needs at least one active admin. Make someone else an admin first.'
      using errcode = 'check_violation';
  end if;

  delete from user_roles
   where user_id = p_user_id
     and role_id <> all (wanted);

  insert into user_roles (user_id, role_id, granted_by)
  select p_user_id, w, auth.uid() from unnest(wanted) as w
  on conflict do nothing;
end;
$fn$;

create or replace function set_user_blocked(p_user_id uuid, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_can_manage(p_user_id);

  if p_blocked and p_user_id = auth.uid() then
    raise exception 'you cannot deactivate your own account' using errcode = 'check_violation';
  end if;

  if p_blocked
     and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                  where ur.user_id = p_user_id and r.key = 'admin')
     and active_admin_count(p_user_id) = 0 then
    raise exception 'FetchGensan needs at least one active admin. Make someone else an admin first.'
      using errcode = 'check_violation';
  end if;

  update profiles set is_blocked = p_blocked where id = p_user_id;
end;
$fn$;

create or replace function update_user_profile(
  p_user_id   uuid,
  p_full_name text,
  p_notes     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform assert_can_manage(p_user_id);

  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'enter a name' using errcode = 'check_violation';
  end if;

  update profiles
     set full_name = btrim(p_full_name),
         notes = nullif(btrim(coalesce(p_notes, '')), '')
   where id = p_user_id;
end;
$fn$;

-- ---------------------------------------------------------------- grants
--
-- The migration-000100 lockdown made new functions owner-only by default.
-- Grant back exactly what a signed-in client calls. The internal helpers
-- (user_permission_keys, role_permission_keys, require_permission,
-- active_admin_count, refresh_account_type, assert_*) stay owner-only;
-- they are reached through the RPCs above, which run as owner.

grant select on permissions, roles, role_permissions, user_roles to authenticated;

grant execute on function
  has_permission(text),
  my_permissions(),
  can_manage_user(uuid),
  role_is_mine(uuid),
  list_users(text, int, int),
  list_roles(),
  create_role(text, text, text, text[]),
  update_role(uuid, text, text, text[]),
  delete_role(uuid),
  set_user_roles(uuid, uuid[]),
  set_user_blocked(uuid, boolean),
  update_user_profile(uuid, text, text),
  record_topup(uuid, bigint, text)
to authenticated;

grant execute on all functions in schema public to service_role;
