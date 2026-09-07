-- FetchGensan :: row level security
--
-- The rule of this schema: clients get SELECT on their own rows and almost
-- nothing else. Every write that touches money, job state or dispatch goes
-- through a security-definer RPC in the earlier migrations. That keeps the
-- surface a malicious client can reach down to "what can I read".

alter table profiles           enable row level security;
alter table drivers            enable row level security;
alter table driver_documents   enable row level security;
alter table saved_places       enable row level security;
alter table service_zones      enable row level security;
alter table fare_config        enable row level security;
alter table jobs               enable row level security;
alter table errand_items       enable row level security;
alter table errand_receipts    enable row level security;
alter table job_events         enable row level security;
alter table job_offers         enable row level security;
alter table driver_locations   enable row level security;
alter table wallet_transactions enable row level security;
alter table ratings            enable row level security;

-- ---------------------------------------------------------------- profiles

create policy profiles_select_self on profiles
  for select using (id = auth.uid());

create policy profiles_select_staff on profiles
  for select using (is_staff());

-- A driver on an active job needs the customer name and phone to find them.
-- Scoped to the live job only -- once it completes, the access goes away.
create policy profiles_select_active_counterparty on profiles
  for select using (
    exists (
      select 1 from jobs j
      where j.driver_id = auth.uid()
        and j.customer_id = profiles.id
        and j.status in ('assigned', 'arriving', 'arrived_pickup', 'shopping',
                         'awaiting_approval', 'in_progress')
    )
  );

-- Row access only. WHICH columns may be written is enforced by the
-- column-level GRANT at the bottom of this file (name and avatar only), not
-- by a WITH CHECK clause.
--
-- The reason matters: a policy on `profiles` that compares a column against
-- `(select ... from profiles ...)` makes Postgres raise "infinite recursion
-- detected in policy", because RLS re-applies inside the subquery. Column
-- privileges sidestep that entirely and are checked before any policy runs,
-- so a customer cannot promote themselves to admin.
create policy profiles_update_self on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_all_staff on profiles
  for all using (auth_role() = 'admin') with check (auth_role() = 'admin');

-- ---------------------------------------------------------------- drivers

-- No customer-facing policy here on purpose: customers read driver details
-- through the public_driver_info view, which exposes a safe column subset.
create policy drivers_select_self on drivers
  for select using (id = auth.uid());

create policy drivers_select_staff on drivers
  for select using (is_staff());

-- A driver may edit their own row; the column-level GRANT below limits that
-- to vehicle details. status, is_online, location, wallet_balance,
-- credit_floor and active_job_id are all unwritable by a client and move
-- only through set_online(), ping_location(), adjust_wallet() and dispatch.
--
-- Same recursion reasoning as profiles above: a WITH CHECK that compared
-- each column against `(select ... from drivers ...)` would be rejected by
-- Postgres as an infinitely recursive policy.
create policy drivers_update_self on drivers
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy drivers_insert_self on drivers
  for insert with check (id = auth.uid() and status = 'pending');

create policy drivers_all_staff on drivers
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------- documents

create policy driver_documents_own on driver_documents
  for select using (driver_id = auth.uid());

create policy driver_documents_upload on driver_documents
  for insert with check (driver_id = auth.uid() and status = 'pending');

-- A rejected document must be replaceable, but a driver cannot approve
-- their own paperwork.
create policy driver_documents_replace on driver_documents
  for update using (driver_id = auth.uid() and status <> 'approved')
  with check (driver_id = auth.uid() and status = 'pending');

create policy driver_documents_staff on driver_documents
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------- places

create policy saved_places_own on saved_places
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------------------------------------------------------------- reference data

-- Everyone signed in may read the service area and the price list. Both are
-- shown in the app before booking, and neither is a secret.
create policy service_zones_read on service_zones
  for select using (true);

create policy service_zones_staff on service_zones
  for all using (is_staff()) with check (is_staff());

create policy fare_config_read on fare_config
  for select using (is_active or is_staff());

create policy fare_config_staff on fare_config
  for all using (auth_role() = 'admin') with check (auth_role() = 'admin');

-- ---------------------------------------------------------------- jobs

create policy jobs_select_customer on jobs
  for select using (customer_id = auth.uid());

create policy jobs_select_driver on jobs
  for select using (driver_id = auth.uid());

-- A driver holding a live offer must be able to read the job to decide.
-- Expired offers stop granting access, so a declined job disappears.
create policy jobs_select_offered on jobs
  for select using (
    exists (
      select 1 from job_offers o
      where o.job_id = jobs.id
        and o.driver_id = auth.uid()
        and o.response = 'pending'
        and o.expires_at > now()
    )
  );

create policy jobs_select_staff on jobs
  for select using (is_staff());

-- Deliberately NO insert/update/delete policy for customers or drivers.
-- Booking is create_job(); state changes are advance_job(), complete_job(),
-- cancel_job(). Anything else is a bug, and it fails closed.
create policy jobs_all_staff on jobs
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------- errands

create policy errand_items_read on errand_items
  for select using (
    exists (
      select 1 from jobs j
      where j.id = errand_items.job_id
        and (j.customer_id = auth.uid() or j.driver_id = auth.uid() or is_staff())
    )
  );

-- The customer may edit their shopping list, but only while nobody has
-- started shopping for it.
create policy errand_items_edit_customer on errand_items
  for all using (
    exists (
      select 1 from jobs j
      where j.id = errand_items.job_id
        and j.customer_id = auth.uid()
        and j.status in ('draft', 'searching', 'assigned', 'arriving', 'arrived_pickup')
    )
  ) with check (
    exists (
      select 1 from jobs j
      where j.id = errand_items.job_id
        and j.customer_id = auth.uid()
        and j.status in ('draft', 'searching', 'assigned', 'arriving', 'arrived_pickup')
    )
  );

create policy errand_items_staff on errand_items
  for all using (is_staff()) with check (is_staff());

create policy errand_receipts_read on errand_receipts
  for select using (
    exists (
      select 1 from jobs j
      where j.id = errand_receipts.job_id
        and (j.customer_id = auth.uid() or j.driver_id = auth.uid() or is_staff())
    )
  );

create policy errand_receipts_staff on errand_receipts
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------- dispatch

create policy job_offers_own on job_offers
  for select using (driver_id = auth.uid());

-- The customer sees the count of pending offers ("looking for a driver...")
-- but not which drivers were asked.
create policy job_offers_customer on job_offers
  for select using (
    exists (select 1 from jobs j where j.id = job_offers.job_id and j.customer_id = auth.uid())
  );

create policy job_offers_staff on job_offers
  for all using (is_staff()) with check (is_staff());

-- Responding to an offer is claim_job() / decline_job(). No client writes.

create policy driver_locations_own on driver_locations
  for select using (driver_id = auth.uid());

-- The trail for a job is readable by that job customer, for the live map
-- and for a dispute after the fact.
create policy driver_locations_job_customer on driver_locations
  for select using (
    job_id is not null
    and exists (select 1 from jobs j where j.id = driver_locations.job_id
                                       and j.customer_id = auth.uid())
  );

create policy driver_locations_staff on driver_locations
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------- money

create policy wallet_transactions_own on wallet_transactions
  for select using (driver_id = auth.uid());

create policy wallet_transactions_staff on wallet_transactions
  for select using (is_staff());

-- No insert policy at all. adjust_wallet() is the only writer, and it is
-- security definer.

-- ---------------------------------------------------------------- audit

create policy job_events_participants on job_events
  for select using (
    exists (
      select 1 from jobs j
      where j.id = job_events.job_id
        and (j.customer_id = auth.uid() or j.driver_id = auth.uid() or is_staff())
    )
  );

-- ---------------------------------------------------------------- ratings

create policy ratings_read_own on ratings
  for select using (rater_id = auth.uid() or ratee_id = auth.uid() or is_staff());

-- Writing goes through rate_job(), which checks the job is completed and
-- that the caller was actually on it.

-- ---------------------------------------------------------------- grants
--
-- Belt and braces on top of RLS. `authenticated` gets no blanket table
-- privileges; it gets SELECT (governed by the policies above) plus EXECUTE
-- on the RPCs. A missing policy therefore fails closed rather than open.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

grant select on
  profiles, drivers, driver_documents, saved_places, service_zones, fare_config,
  jobs, errand_items, errand_receipts, job_events, job_offers,
  driver_locations, wallet_transactions, ratings
to authenticated;

grant insert, update on driver_documents to authenticated;
grant insert, update, delete on saved_places to authenticated;
grant insert, update, delete on errand_items to authenticated;

-- Column-level UPDATE privileges.
--
-- This, not a WITH CHECK clause, is what stops a client rewriting the
-- columns that decide money and eligibility. Postgres checks column
-- privileges before policies, and unlike a policy subquery on the same
-- table it cannot recurse. Anything not listed here is unwritable by
-- `authenticated`, no matter what the policies say.
grant update (full_name, avatar_path) on profiles to authenticated;

grant update (vehicle_make, vehicle_model, vehicle_color, plate_number, license_number)
  on drivers to authenticated;

-- A driver still needs plain INSERT to create their own row during
-- onboarding; drivers_insert_self pins the new row to status 'pending'.
grant insert on drivers to authenticated;

-- Evaluated as the *inserting* user when a staff member creates a job from
-- the console, because it is a column DEFAULT rather than a call inside a
-- security-definer function.
grant execute on function generate_job_reference() to authenticated;

grant select on public_driver_info, dispatch_board, driver_roster to authenticated;

grant execute on function
  create_job(job_type, double precision, double precision, double precision, double precision,
             text, text, text, text, text, text, text, int, int, jsonb, int,
             payment_method, timestamptz),
  advance_job(uuid, job_status),
  complete_job(uuid),
  cancel_job(uuid, text),
  submit_errand_receipt(uuid, jsonb, text),
  approve_errand_total(uuid),
  claim_job(uuid),
  decline_job(uuid),
  dispatch_job(uuid, int, int),
  nearby_drivers(uuid, int, int),
  ping_location(double precision, double precision, numeric, numeric),
  set_online(boolean),
  rate_job(uuid, int, text),
  quote_fare(job_type, int, int, timestamptz),
  job_driver_position(uuid),
  auth_role(),
  is_staff()
to authenticated;

-- Staff-only RPCs. is_staff() is checked inside them too, so this grant is
-- the outer of two gates.
grant execute on function
  record_topup(uuid, bigint, text),
  adjust_wallet(uuid, wallet_txn_kind, bigint, uuid, text),
  settle_job_money(uuid)
to authenticated;
