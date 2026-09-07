-- FetchGensan :: push notification tokens
--
-- The driver app's realtime subscription and its poll both die when Android
-- suspends the process, which on budget ROMs happens minutes after the
-- screen locks. Push is the only channel the OS itself will wake, so this
-- table is what makes a 2am booking actually reach a driver.
--
-- Per device, not per driver: a driver with a work phone and a spare should
-- get the offer on both.

create table driver_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references profiles (id) on delete cascade,
  -- Expo push token, e.g. ExponentPushToken[xxxxxxxx].
  token        text not null unique,
  platform     text not null default 'unknown',
  device_name  text not null default '',
  -- Bumped on every app launch. A token nobody has used in months is a
  -- reinstalled or sold phone; prune on that.
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index driver_push_tokens_driver_idx on driver_push_tokens (driver_id);
create index driver_push_tokens_stale_idx on driver_push_tokens (last_seen_at);

alter table driver_push_tokens enable row level security;

create policy driver_push_tokens_own on driver_push_tokens
  for select using (driver_id = auth.uid());

create policy driver_push_tokens_staff on driver_push_tokens
  for select using (is_staff());

grant select on driver_push_tokens to authenticated;

-- Registration goes through an RPC rather than an insert policy, so the
-- token can be re-pointed when a phone is handed to a different driver
-- without a client being able to write an arbitrary driver_id.
create or replace function register_push_token(
  p_token       text,
  p_platform    text default 'unknown',
  p_device_name text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  insert into driver_push_tokens (driver_id, token, platform, device_name)
  values (auth.uid(), p_token, p_platform, p_device_name)
  on conflict (token) do update
    set driver_id = auth.uid(),
        platform = excluded.platform,
        device_name = excluded.device_name,
        last_seen_at = now();
end;
$fn$;

grant execute on function register_push_token(text, text, text) to authenticated;

create or replace function unregister_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from driver_push_tokens
   where token = p_token and driver_id = auth.uid();
$fn$;

grant execute on function unregister_push_token(text) to authenticated;

create or replace function prune_push_tokens(p_older_than interval default interval '90 days')
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n int;
begin
  delete from driver_push_tokens where last_seen_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end;
$fn$;
