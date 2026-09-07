-- FetchGensan :: profiles, drivers, documents, saved places

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  phone        text unique not null,
  full_name    text not null default '',
  avatar_path  text,
  role         user_role not null default 'customer',
  is_blocked   boolean not null default false,
  -- Set when a customer no-shows or abuses the service; dispatchers see it.
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

create index profiles_role_idx on profiles (role);
create index profiles_name_trgm_idx on profiles using gin (full_name gin_trgm_ops);

-- Reads `role` without re-triggering RLS on profiles. Every role check in
-- this schema goes through here -- a policy that selects from profiles
-- directly deadlocks itself.
create or replace function auth_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth_role() in ('dispatcher', 'admin'), false);
$$;

-- Mirror new auth users into profiles. Phone-OTP signups land here with
-- the phone already verified by Supabase Auth.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, full_name)
  values (
    new.id,
    coalesce(new.phone, new.email, new.id::text),
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- drivers

create table drivers (
  id                     uuid primary key references profiles (id) on delete cascade,
  status                 driver_status not null default 'pending',

  vehicle_make           text not null default '',
  vehicle_model          text not null default '',
  vehicle_color          text not null default '',
  plate_number           text not null default '',
  license_number         text not null default '',

  -- Availability. `is_online` is the driver's own toggle; can_accept_jobs()
  -- is the real gate (approval + wallet + no active job).
  is_online              boolean not null default false,
  last_online_at         timestamptz,

  location               geography (point, 4326),
  heading                numeric (5, 2),
  location_updated_at    timestamptz,

  rating_sum             int not null default 0,
  rating_count           int not null default 0,

  -- NEGATIVE balance is the normal state on a cash-only fleet: the driver
  -- collected the full fare in cash and now owes us commission. They top up
  -- to clear it. Once they pass credit_floor they can no longer go online.
  wallet_balance_centavos bigint not null default 0,
  credit_floor_centavos   bigint not null default -50000, -- -PHP 500.00

  active_job_id          uuid,
  completed_jobs         int not null default 0,
  cancelled_jobs         int not null default 0,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger drivers_updated_at before update on drivers
  for each row execute function set_updated_at();

-- The index that makes "who is near this pickup" fast. Partial, because we
-- only ever query drivers who are online and approved.
create index drivers_location_idx on drivers using gist (location)
  where is_online and status = 'approved';

create index drivers_status_idx on drivers (status);
create index drivers_online_idx on drivers (is_online) where is_online;
create unique index drivers_plate_idx on drivers (plate_number) where plate_number <> '';

create or replace function driver_rating(d drivers)
returns numeric
language sql
stable
as $$
  select case when d.rating_count = 0 then null
              else round(d.rating_sum::numeric / d.rating_count, 2) end;
$$;

-- ---------------------------------------------------------------- documents

create table driver_documents (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references drivers (id) on delete cascade,
  doc_type      document_type not null,
  storage_path  text not null,
  status        document_status not null default 'pending',
  expires_on    date,
  reviewed_by   uuid references profiles (id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger driver_documents_updated_at before update on driver_documents
  for each row execute function set_updated_at();

create unique index driver_documents_latest_idx on driver_documents (driver_id, doc_type);
create index driver_documents_status_idx on driver_documents (status) where status = 'pending';

-- ---------------------------------------------------------------- places

-- Gensan addressing is landmark-based, not street-based. `landmark_note` is
-- the field drivers actually read ("tabi sa Gaisano, likod ng bakery").
-- address_line is best-effort reverse geocoding and may be wrong or empty.
create table saved_places (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles (id) on delete cascade,
  label         text not null,
  landmark_note text not null default '',
  address_line  text not null default '',
  location      geography (point, 4326) not null,
  use_count     int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger saved_places_updated_at before update on saved_places
  for each row execute function set_updated_at();

create index saved_places_profile_idx on saved_places (profile_id, use_count desc);

-- ---------------------------------------------------------------- zones

-- Where we actually operate. A pickup outside every active zone is refused
-- at booking time rather than sitting in `searching` forever.
create table service_zones (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  area       geography (polygon, 4326) not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create index service_zones_area_idx on service_zones using gist (area) where is_active;
