-- Customer self-registration and ID verification.
--
-- Customers now sign themselves up in the rider app (see the `register`
-- routes in supabase/functions/auth), then photograph an ID, front and
-- back, a selfie, and a selfie holding the ID. The account is approved
-- automatically the moment all four are on file -- nobody reviews them
-- first -- so the photos are a record to go back to after an incident,
-- not a gate a person operates.
--
-- A customer cannot book until verified. Accounts that existed before
-- this migration, and accounts staff or the seed script create, count as
-- verified (see the column default below).

-- ---------------------------------------------------------------- profile

-- Defaults to now(), which verifies every existing account (nobody already
-- riding is locked out) and every account staff or the seed script create.
-- Only self-registration starts unverified: the auth function's
-- register/start sets verified_at to null with the service role straight
-- after creating the account. (It cannot be decided in handle_new_user():
-- Supabase Auth inserts the user first and writes app_metadata after, so
-- the insert trigger never sees how the account was made.)
alter table profiles add column verified_at timestamptz default now();

-- ---------------------------------------------------------------- documents

create table customer_documents (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles (id) on delete cascade,
  doc_type      text not null
                check (doc_type in ('id_front', 'id_back', 'selfie', 'selfie_with_id')),
  storage_path  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (profile_id, doc_type)
);

create trigger customer_documents_updated_at before update on customer_documents
  for each row execute function set_updated_at();

alter table customer_documents enable row level security;

create policy customer_documents_select_self on customer_documents
  for select using (profile_id = auth.uid());

create policy customer_documents_select_staff on customer_documents
  for select using (has_permission('users.view'));

-- No insert/update policy: writes go through record_customer_document(),
-- which also decides verification.
grant select on customer_documents to authenticated;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-ids', 'customer-ids', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "customer ids are readable by their owner"
  on storage.objects for select
  using (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "customer ids are readable by user managers"
  on storage.objects for select
  using (bucket_id = 'customer-ids' and has_permission('users.view'));

create policy "customers upload their own ids"
  on storage.objects for insert
  with check (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "customers replace their own ids"
  on storage.objects for update
  using (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------- record

-- Records one uploaded photo and, once all four are on file, verifies the
-- account. Returns the caller's verified_at (null until complete).
--
-- The file itself must already be in storage under the caller's folder:
-- checking storage.objects stops a client recording a path it never
-- uploaded, which would verify an account with no photos at all.
create or replace function record_customer_document(p_doc_type text, p_storage_path text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  verified timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  if p_doc_type not in ('id_front', 'id_back', 'selfie', 'selfie_with_id') then
    raise exception 'unknown document type' using errcode = 'check_violation';
  end if;

  if split_part(p_storage_path, '/', 1) <> uid::text then
    raise exception 'that photo is not yours' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'customer-ids' and name = p_storage_path
  ) then
    raise exception 'that photo did not finish uploading, please try again'
      using errcode = 'check_violation';
  end if;

  insert into customer_documents (profile_id, doc_type, storage_path)
  values (uid, p_doc_type, p_storage_path)
  on conflict (profile_id, doc_type)
  do update set storage_path = excluded.storage_path;

  -- Auto-approval: all four present means verified. Never un-verifies:
  -- replacing a photo later keeps the account usable.
  update profiles
     set verified_at = now()
   where id = uid
     and verified_at is null
     and (select count(*) from customer_documents where profile_id = uid) = 4;

  select verified_at into verified from profiles where id = uid;
  return verified;
end;
$fn$;

grant execute on function record_customer_document(text, text) to authenticated;

-- ---------------------------------------------------------------- booking gate

-- On the insert rather than inside create_job(), so no booking path --
-- including any added later -- can skip it.
create or replace function jobs_require_verified_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if exists (
    select 1 from profiles
    where id = new.customer_id and verified_at is null
  ) then
    raise exception 'please finish verifying your ID before booking'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$fn$;

create trigger jobs_require_verified_customer
  before insert on jobs
  for each row execute function jobs_require_verified_customer();

-- ---------------------------------------------------------------- registration lookup

-- What the auth function's `register` routes need to know before creating
-- or reusing an account. auth.users is not reachable through PostgREST,
-- so this reads it for them. service_role only: answering "does this email
-- have an account" to anyone else would let a stranger test addresses.
create or replace function registration_lookup(p_email text, p_phone text)
returns table (
  email_user_id   uuid,
  email_confirmed boolean,
  self_registered boolean,
  phone_owner_id  uuid
)
language sql
stable
security definer
set search_path = public, auth
as $fn$
  select
    u.id,
    u.email_confirmed_at is not null,
    coalesce((u.raw_app_meta_data ->> 'self_registered')::boolean, false),
    (
      -- auth.users stores phones without the '+'; profiles keeps it.
      select coalesce(
        (select id from auth.users where phone = ltrim(p_phone, '+') limit 1),
        (select id from profiles where phone = p_phone limit 1)
      )
    )
  from (select 1) one
  left join auth.users u on lower(u.email) = lower(p_email);
$fn$;

grant execute on function registration_lookup(text, text) to service_role;
