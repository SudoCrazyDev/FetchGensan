-- FetchGensan :: extensions, enums, shared helpers
-- Money is ALWAYS stored as integer centavos. Never float, never numeric-for-money.

create extension if not exists "postgis";
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------- enums

create type user_role as enum ('customer', 'driver', 'dispatcher', 'admin');

create type driver_status as enum ('pending', 'approved', 'suspended', 'rejected');

create type job_type as enum ('ride', 'errand', 'delivery');

-- One machine for all three job types. `awaiting_approval` and `shopping`
-- are only reachable by errands; see packages/core/src/job-state.ts for the
-- authoritative transition table (mirrored by assert_job_transition below).
create type job_status as enum (
  'draft',
  'searching',
  'assigned',
  'arriving',
  'arrived_pickup',
  'shopping',
  'awaiting_approval',
  'in_progress',
  'completed',
  'cancelled',
  'expired'
);

create type payment_method as enum ('cash', 'gcash', 'maya', 'card');
create type payment_status as enum ('pending', 'authorized', 'paid', 'failed', 'refunded');

create type offer_response as enum ('pending', 'accepted', 'declined', 'timeout', 'withdrawn');

create type wallet_txn_kind as enum ('commission', 'topup', 'payout', 'adjustment', 'errand_float');

create type document_type as enum (
  'drivers_license',
  'or_cr',
  'selfie_with_license',
  'nbi_clearance',
  'barangay_clearance',
  'vehicle_photo'
);

create type document_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------- helpers

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Human-friendly job reference, e.g. FG-7K3P2Q. Unambiguous alphabet:
-- no 0/O/1/I/L so drivers can read it aloud over the phone without confusion.
create or replace function generate_job_reference()
returns text
language plpgsql
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return 'FG-' || result;
end;
$$;
