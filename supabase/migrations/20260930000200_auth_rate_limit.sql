-- FetchGensan :: rate limiting for the auth edge function
--
-- supabase/functions/auth fronts sign-in and password reset. Supabase Auth
-- has its own coarse per-IP limits, but they cannot express "five wrong
-- passwords for this account, then wait", and on Philippine mobile data a
-- per-IP limit alone is nearly useless: carriers put thousands of phones
-- behind one CGNAT address. So attempts are counted per account AND per IP,
-- with the per-IP ceiling set high.
--
-- Keys arrive already hashed (SHA-256 of the normalised phone/email, or of
-- the IP), so this table never holds a phone number or an address.
--
-- Service role only. No client role can read or call any of this.

create table auth_attempts (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  key_hash   text not null,
  created_at timestamptz not null default now()
);

create index auth_attempts_lookup_idx on auth_attempts (bucket, key_hash, created_at);

alter table auth_attempts enable row level security;
-- Deliberately no policies: RLS on with nothing granted is "nobody but the
-- service role", which bypasses RLS.

-- Records one attempt against a sliding window, or refuses it.
--
-- Returns 0 when the attempt is allowed (and has been counted), otherwise
-- the number of seconds until the oldest attempt in the window ages out.
--
-- The check and the insert happen under one advisory lock per key. Without
-- it, ten parallel requests would all read "4 of 5 used" and all get
-- through -- which is precisely what a password-guessing script does.
create or replace function auth_rate_limit_hit(
  p_bucket         text,
  p_key_hash       text,
  p_max            int,
  p_window_seconds int
)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  window_start timestamptz := now() - make_interval(secs => p_window_seconds);
  used int;
  oldest timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_bucket || ':' || p_key_hash, 0));

  delete from auth_attempts
   where bucket = p_bucket and key_hash = p_key_hash and created_at < window_start;

  select count(*), min(created_at) into used, oldest
    from auth_attempts
   where bucket = p_bucket and key_hash = p_key_hash;

  if used >= p_max then
    return greatest(
      1,
      ceil(extract(epoch from oldest + make_interval(secs => p_window_seconds) - now()))::int
    );
  end if;

  insert into auth_attempts (bucket, key_hash) values (p_bucket, p_key_hash);
  return 0;
end;
$fn$;

-- Forgets a key's attempts: called after a successful sign-in, so someone
-- who fumbled their password twice does not carry that into tomorrow.
create or replace function auth_rate_limit_clear(p_bucket text, p_key_hash text)
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from auth_attempts where bucket = p_bucket and key_hash = p_key_hash;
$fn$;

-- Keys that never come back leave rows behind; the longest window is an
-- hour, so anything a day old is dead weight.
create or replace function prune_auth_attempts()
returns int
language sql
security definer
set search_path = public
as $fn$
  with gone as (
    delete from auth_attempts where created_at < now() - interval '1 day' returning 1
  )
  select count(*)::int from gone;
$fn$;

revoke all on auth_attempts from anon, authenticated;
revoke all on function
  auth_rate_limit_hit(text, text, int, int),
  auth_rate_limit_clear(text, text),
  prune_auth_attempts()
from public, anon, authenticated;

grant execute on function
  auth_rate_limit_hit(text, text, int, int),
  auth_rate_limit_clear(text, text),
  prune_auth_attempts()
to service_role;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fetchgensan-prune-auth-attempts', '17 3 * * *',
                          'select prune_auth_attempts()');
  end if;
exception when others then
  raise notice 'could not schedule prune_auth_attempts: %', sqlerrm;
end
$do$;
