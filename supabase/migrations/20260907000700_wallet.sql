-- FetchGensan :: driver wallet and commission
--
-- Why this exists on a cash-only launch: when a customer pays cash, the
-- driver walks away holding 100% of the fare, including our commission.
-- The wallet is the ledger of what they owe us. It goes negative, they top
-- up to clear it, and set_online() refuses them once they pass the floor.
-- Retrofitting this later means migrating live money, so it ships in v1.

create table wallet_transactions (
  id                     bigserial primary key,
  driver_id              uuid not null references drivers (id) on delete restrict,
  job_id                 uuid references jobs (id) on delete set null,
  kind                   wallet_txn_kind not null,

  -- Signed. Negative reduces the balance (commission owed, payout sent),
  -- positive increases it (top-up, reimbursement, goodwill adjustment).
  amount_centavos        bigint not null,
  balance_after_centavos bigint not null,

  note                   text not null default '',
  created_by             uuid references profiles (id),
  created_at             timestamptz not null default now(),

  constraint wallet_txn_nonzero check (amount_centavos <> 0)
);

create index wallet_transactions_driver_idx on wallet_transactions (driver_id, created_at desc);
create unique index wallet_transactions_commission_once_idx
  on wallet_transactions (job_id) where kind = 'commission';

-- Append-only, same reasoning as job_events: this is a money ledger.
create trigger wallet_transactions_immutable before update or delete on wallet_transactions
  for each row execute function reject_mutation();

-- The ONLY way a wallet balance changes. Locks the driver row, so
-- concurrent commission and top-up writes cannot interleave and produce a
-- wrong balance_after.
create or replace function adjust_wallet(
  p_driver_id uuid,
  p_kind      wallet_txn_kind,
  p_amount    bigint,
  p_job_id    uuid default null,
  p_note      text default ''
)
returns wallet_transactions
language plpgsql
security definer
set search_path = public
as $fn$
declare
  new_balance bigint;
  txn wallet_transactions;
begin
  update drivers
     set wallet_balance_centavos = wallet_balance_centavos + p_amount
   where id = p_driver_id
  returning wallet_balance_centavos into new_balance;

  if new_balance is null then
    raise exception 'driver % not found', p_driver_id using errcode = 'no_data_found';
  end if;

  insert into wallet_transactions
    (driver_id, job_id, kind, amount_centavos, balance_after_centavos, note, created_by)
  values
    (p_driver_id, p_job_id, p_kind, p_amount, new_balance, p_note, auth.uid())
  returning * into txn;

  return txn;
end;
$fn$;

-- Commission is charged on the SERVICE, never on the goods. A PHP 2,000
-- grocery run earns us a cut of the PHP 80 errand fee, not PHP 300 of the
-- customer groceries. Getting this backwards is the fastest way to lose a
-- fleet.
create or replace function commission_base_centavos(j jobs)
returns int
language sql
immutable
as $fn$
  select greatest(0, j.final_total_centavos - j.items_cost_centavos);
$fn$;

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

  if j.status <> 'completed' then
    raise exception 'job % is not completed', j.reference using errcode = 'check_violation';
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

-- Dispatcher records a cash top-up a driver handed over at the office.
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
  if not is_staff() then
    raise exception 'only staff can record top-ups' using errcode = 'insufficient_privilege';
  end if;
  if p_amount <= 0 then
    raise exception 'top-up must be positive' using errcode = 'check_violation';
  end if;
  return adjust_wallet(p_driver_id, 'topup', p_amount, null, p_note);
end;
$fn$;
