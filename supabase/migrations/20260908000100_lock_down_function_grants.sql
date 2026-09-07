-- FetchGensan :: close the function-privilege hole
--
-- SECURITY FIX. Before this migration every function in `public` was
-- callable by unauthenticated callers holding the publishable key -- which
-- ships inside the app bundle and is therefore public knowledge.
--
-- WHY 20260907001100_rls.sql did not prevent it:
--
--   revoke all on all functions in schema public from anon, authenticated;
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default, and
-- `anon` inherits PUBLIC. Revoking from the two named roles leaves the
-- PUBLIC grant untouched, so the revoke accomplished nothing. It was also
-- placed in migration 001100, so the functions created in 001200-001500 were
-- never even named by it.
--
-- What that exposed, confirmed by probing the live project:
--
--   adjust_wallet()          SECURITY DEFINER, no auth check, writes the
--                            money ledger. Anyone could zero out a driver's
--                            commission debt or push them past their credit
--                            floor so they could not work.
--   settle_job_money()       Recomputes and posts commission.
--   dispatch_tick()          Expires offers, re-dispatches, marks drivers
--                            offline -- all of dispatch, from the internet.
--   prune_driver_locations() Deletes the GPS trail (dispute evidence).
--   prune_push_tokens()      Deletes push registrations.
--
-- The fix is to revoke from PUBLIC (not just the named roles), change the
-- schema default so future functions do not reintroduce it, and then grant
-- back only the functions a client is actually meant to call.

-- ---------------------------------------------------------------- revoke

revoke all on all functions in schema public from public;
revoke all on all functions in schema public from anon, authenticated;

-- Belt and braces: `routines` also covers procedures.
do $do$
begin
  execute 'revoke all on all routines in schema public from public, anon, authenticated';
exception when others then
  raise notice 'routine-level revoke skipped: %', sqlerrm;
end
$do$;

-- Without this, the very next `create function` in a later migration is
-- granted to PUBLIC all over again and we are back where we started.
alter default privileges in schema public revoke execute on functions from public;

-- service_role is only reachable with the secret key (edge functions,
-- server-side jobs). It is trusted and must keep working -- the
-- dispatch-tick function calls dispatch_tick() with it.
grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------- grant back
--
-- The allowlist. Anything not named here is owner-only, which means it can
-- still be called *internally* by a SECURITY DEFINER function (that runs as
-- the owner) but not by a client.
--
-- Deliberately ABSENT, and never to be added:
--   adjust_wallet()          the only writer of the money ledger; reached
--                            only via settle_job_money() and record_topup()
--   settle_job_money()       reached only via complete_job()
--   dispatch_tick() and the sweepers  driven by pg_cron, or by the edge
--                            function using the service role
--   prune_driver_locations(), prune_push_tokens()   destructive
--   every internal helper (sanitize_distance, point_of, can_accept_jobs, ...)

grant execute on function
  -- booking and lifecycle
  create_job(job_type, double precision, double precision, double precision, double precision,
             text, text, text, text, text, text, text, int, int, jsonb, int,
             payment_method, timestamptz),
  advance_job(uuid, job_status),
  complete_job(uuid),
  cancel_job(uuid, text),
  submit_errand_receipt(uuid, jsonb, text),
  approve_errand_total(uuid),
  rate_job(uuid, int, text),

  -- driver side
  claim_job(uuid),
  decline_job(uuid),
  ping_location(double precision, double precision, numeric, numeric),
  set_online(boolean),

  -- reads
  quote_fare(job_type, int, int, timestamptz),
  job_driver_position(uuid),
  auth_role(),
  is_staff(),

  -- dispatcher console. record_topup() checks is_staff() internally, which
  -- is what actually protects it.
  record_topup(uuid, bigint, text),
  nearby_drivers(uuid, int, int),

  -- Re-broadcasting a job. Granted to every signed-in user on purpose: it
  -- only ever re-offers an already-`searching` job to nearby drivers, and a
  -- customer nudging their own stuck booking is a feature. It is also called
  -- internally by create_job(), so it cannot carry an is_staff() guard --
  -- that would evaluate the *customer's* uid and break booking.
  dispatch_job(uuid, int, int),

  -- RLS policy predicates. EXECUTE is required because policies are
  -- evaluated as the calling role.
  job_is_mine(uuid),
  job_is_my_assignment(uuid),
  job_participant(uuid),
  job_items_editable(uuid),
  has_live_offer(uuid),
  is_active_job_counterparty(uuid),
  job_receipt_uploadable(uuid),

  -- push registration
  register_push_token(text, text, text),
  unregister_push_token(text),

  -- Evaluated as the inserting role, because it is a column DEFAULT on jobs
  -- rather than a call inside a security-definer function.
  generate_job_reference()
to authenticated;

-- Landmarks are public reference data: the booking screen shows them before
-- the customer has necessarily signed in. bump_landmark writes, so it stays
-- signed-in only.
grant execute on function search_landmarks(text, double precision, double precision, int)
  to anon, authenticated;
grant execute on function bump_landmark(uuid) to authenticated;

-- ---------------------------------------------------------------- null guard
--
-- Separate bug found by the same probe: calling settle_job_money() with an
-- id that does not exist fell straight through its own status check, because
-- `null <> 'completed'` evaluates to NULL rather than true, so the guard
-- never fired and execution continued into adjust_wallet(). Any comparison
-- against a row that might not exist needs the existence test first.

create or replace function settle_job_money(p_job_id uuid)
returns wallet_transactions
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
  commission int;
  txn wallet_transactions;
begin
  select * into j from jobs where id = p_job_id;

  -- `j.status <> 'completed'` alone is NULL when the job is missing, and a
  -- NULL condition is not true, so the function used to carry on regardless.
  if j.id is null then
    raise exception 'job % not found', p_job_id using errcode = 'no_data_found';
  end if;

  if j.status <> 'completed' then
    raise exception 'job % is not completed', j.reference using errcode = 'check_violation';
  end if;

  if j.driver_id is null then
    raise exception 'job % has no driver to settle with', j.reference
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from wallet_transactions
             where job_id = p_job_id and kind = 'commission') then
    -- Already settled. Completing a job is retried on flaky mobile data,
    -- so this has to be idempotent.
    select * into txn from wallet_transactions
     where job_id = p_job_id and kind = 'commission';
    return txn;
  end if;

  commission := round(commission_base_centavos(j)::numeric * j.commission_bps / 10000)::int;

  update jobs set commission_centavos = commission where id = p_job_id;

  if j.payment_method = 'cash' then
    -- Driver holds the cash including our cut. Debit what they owe us.
    txn := adjust_wallet(j.driver_id, 'commission', -commission, p_job_id,
                         format('Commission on %s', j.reference));
  else
    -- We collected digitally. Credit the driver their earnings plus any
    -- item cost they fronted; a payout run clears this to zero.
    txn := adjust_wallet(j.driver_id, 'commission',
                         (j.final_total_centavos - commission)::bigint, p_job_id,
                         format('Earnings on %s (digital)', j.reference));
  end if;

  return txn;
end;
$fn$;

-- settle_job_money is reached only through complete_job(). Re-creating it
-- above resets its privileges, so make sure it is not client-callable.
revoke all on function settle_job_money(uuid) from public, anon, authenticated;
grant execute on function settle_job_money(uuid) to service_role;
