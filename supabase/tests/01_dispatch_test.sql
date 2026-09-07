-- FetchGensan :: database assertions
--
-- Covers the behaviour that only the database can be trusted to get right:
-- the fare formula, the state machine guard, the atomic claim, the
-- commission base, and the uniqueness rules that stop one driver holding
-- two jobs or one customer booking three habal-habal by double-tapping.

\set ON_ERROR_STOP on
\timing off

do $$
declare
  cust uuid := '11111111-1111-1111-1111-111111111111';
  drv1 uuid := '22222222-2222-2222-2222-222222222222';
  drv2 uuid := '33333333-3333-3333-3333-333333333333';
  q record;
  j jobs;
  j2 jobs;
  claimed jobs;
  commission int;
  fare_total int;
  errand_job jobs;
  item_id uuid;
  failed boolean;
begin
  -- ------------------------------------------------------------ fixtures

  insert into auth.users (id, phone) values
    (cust, '+639170000001'),
    (drv1, '+639170000002'),
    (drv2, '+639170000003');

  -- handle_new_user() should already have made the profiles.
  if (select count(*) from profiles where id in (cust, drv1, drv2)) <> 3 then
    raise exception 'FAIL: handle_new_user did not mirror auth.users into profiles';
  end if;
  raise notice 'ok   handle_new_user mirrors auth users into profiles';

  update profiles set full_name = 'Maria Santos' where id = cust;
  update profiles set full_name = 'Ramon Dela Cruz' where id = drv1;
  update profiles set full_name = 'Boy Reyes' where id = drv2;

  -- Two approved drivers, both online, both right next to the pickup.
  insert into drivers (id, status, is_online, plate_number, location, location_updated_at)
  values
    (drv1, 'approved', true, 'GS 1111',
     point_of(125.1720, 6.1130)::geography, now()),
    (drv2, 'approved', true, 'GS 2222',
     point_of(125.1722, 6.1132)::geography, now());

  if not (select can_accept_jobs(d.*) from drivers d where d.id = drv1) then
    raise exception 'FAIL: an approved, online, freshly-located driver is not dispatchable';
  end if;
  raise notice 'ok   can_accept_jobs accepts a healthy driver';

  -- A stale location must take a driver out of the pool.
  update drivers set location_updated_at = now() - interval '5 minutes' where id = drv2;
  if (select can_accept_jobs(d.*) from drivers d where d.id = drv2) then
    raise exception 'FAIL: a driver with a stale location is still dispatchable';
  end if;
  update drivers set location_updated_at = now() where id = drv2;
  raise notice 'ok   a stale location makes a driver undispatchable';

  -- ------------------------------------------------------------ fares

  select * into q from quote_fare('ride', 3500, 0, '2026-01-15T04:00:00Z'::timestamptz);
  if q.total_centavos <> 3900 then
    raise exception 'FAIL: 3.5km daytime ride should be 3900 centavos, got %', q.total_centavos;
  end if;
  raise notice 'ok   quote_fare: 3.5km day ride = PHP 39 (matches fare.test.ts)';

  select * into q from quote_fare('ride', 1200, 0, '2026-01-15T04:00:00Z'::timestamptz);
  if q.total_centavos <> 2500 then
    raise exception 'FAIL: short daytime ride should be 2500, got %', q.total_centavos;
  end if;
  raise notice 'ok   quote_fare: inside the included distance = base fare only';

  -- 23:00 Manila is inside the night window.
  select * into q from quote_fare('ride', 1200, 0, '2026-01-15T15:00:00Z'::timestamptz);
  if q.night_surcharge_centavos <> 1500 or q.total_centavos <> 4000 then
    raise exception 'FAIL: night ride should be 4000 with 1500 surcharge, got % / %',
      q.total_centavos, q.night_surcharge_centavos;
  end if;
  raise notice 'ok   quote_fare: 23:00 Manila adds the night surcharge';

  -- 06:00 Manila is outside it (window ends at 05:00, exclusive).
  select * into q from quote_fare('ride', 1200, 0, '2026-01-15T22:00:00Z'::timestamptz);
  if q.night_surcharge_centavos <> 0 then
    raise exception 'FAIL: 06:00 should be daytime, got surcharge %', q.night_surcharge_centavos;
  end if;
  raise notice 'ok   quote_fare: 06:00 Manila is daytime again';

  select * into q from quote_fare('errand', 1500, 0, '2026-01-15T04:00:00Z'::timestamptz);
  if q.total_centavos <> 8000 then
    raise exception 'FAIL: errand service should be 8000, got %', q.total_centavos;
  end if;
  raise notice 'ok   quote_fare: errand = base + service fee';

  -- ------------------------------------------------------------ booking

  perform set_config('request.jwt.claim.sub', cust::text, true);

  j := create_job(
    p_job_type => 'ride',
    p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
    p_dropoff_lng => 125.1783, p_dropoff_lat => 6.1155,
    p_pickup_label => 'Gaisano Mall',
    p_pickup_landmark => 'Tabi sa main entrance',
    p_dropoff_label => 'KCC Mall'
  );

  if j.status <> 'searching' then
    raise exception 'FAIL: a new ASAP booking should be searching, got %', j.status;
  end if;
  if j.reference not like 'FG-%' then
    raise exception 'FAIL: job reference should look like FG-XXXXXX, got %', j.reference;
  end if;
  raise notice 'ok   create_job books and immediately searches (%)', j.reference;

  -- create_job dispatches on the way out, so offers should already exist.
  if (select count(*) from job_offers where job_id = j.id and response = 'pending') = 0 then
    raise exception 'FAIL: create_job did not broadcast to any nearby driver';
  end if;
  raise notice 'ok   create_job broadcast to % nearby driver(s)',
    (select count(*) from job_offers where job_id = j.id);

  -- One live booking per customer.
  failed := false;
  begin
    perform create_job(
      p_job_type => 'ride',
      p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
      p_dropoff_lng => 125.1783, p_dropoff_lat => 6.1155
    );
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a customer was allowed two live bookings at once';
  end if;
  raise notice 'ok   a customer cannot hold two live bookings';

  -- Pickup and drop-off in the same place is refused.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', drv2::text, true);
    perform create_job(
      p_job_type => 'ride',
      p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
      p_dropoff_lng => 125.1719, p_dropoff_lat => 6.1128
    );
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a zero-distance booking was accepted';
  end if;
  raise notice 'ok   a zero-distance booking is refused';

  -- ------------------------------------------------------------ the claim

  perform set_config('request.jwt.claim.sub', drv1::text, true);
  claimed := claim_job(j.id);

  if claimed.driver_id <> drv1 or claimed.status <> 'assigned' then
    raise exception 'FAIL: claim_job did not assign the job, got driver=% status=%',
      claimed.driver_id, claimed.status;
  end if;
  if claimed.assigned_at is null then
    raise exception 'FAIL: the guard trigger did not stamp assigned_at';
  end if;
  raise notice 'ok   claim_job assigns and the trigger stamps assigned_at';

  if (select active_job_id from drivers where id = drv1) <> j.id then
    raise exception 'FAIL: the winning driver active_job_id was not set';
  end if;
  raise notice 'ok   the winning driver is marked busy';

  -- The loser must be refused, not given a second copy of the job.
  perform set_config('request.jwt.claim.sub', drv2::text, true);
  failed := false;
  begin
    perform claim_job(j.id);
  exception
    when lock_not_available then failed := true;  -- lost the race
    when check_violation then failed := true;     -- offer already withdrawn
  end;
  if not failed then
    raise exception 'FAIL: two drivers both claimed the same job';
  end if;
  raise notice 'ok   the second driver to accept is refused (first-accept-wins)';

  -- Everyone else's offer is withdrawn so their card disappears.
  if exists (select 1 from job_offers
             where job_id = j.id and driver_id <> drv1 and response = 'pending') then
    raise exception 'FAIL: a losing driver still holds a pending offer';
  end if;
  raise notice 'ok   losing offers are withdrawn';

  -- ------------------------------------------------------------ state machine

  perform set_config('request.jwt.claim.sub', drv1::text, true);

  -- A ride cannot go shopping.
  failed := false;
  begin
    perform advance_job(j.id, 'shopping');
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a ride was allowed into the errand-only shopping state';
  end if;
  raise notice 'ok   the guard trigger blocks an errand-only state on a ride';

  -- And it cannot skip straight to in_progress from assigned.
  failed := false;
  begin
    perform advance_job(j.id, 'in_progress');
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a job skipped from assigned straight to in_progress';
  end if;
  raise notice 'ok   the guard trigger blocks a skipped transition';

  perform advance_job(j.id, 'arriving');
  perform advance_job(j.id, 'arrived_pickup');
  perform advance_job(j.id, 'in_progress');
  j := complete_job(j.id);

  if j.status <> 'completed' or j.completed_at is null then
    raise exception 'FAIL: complete_job left the job at % ', j.status;
  end if;
  raise notice 'ok   a ride walks the full lifecycle to completed';

  -- Completing twice must be harmless: mobile data drops mid-request.
  j2 := complete_job(j.id);
  if j2.status <> 'completed' then
    raise exception 'FAIL: a repeated complete_job broke the job';
  end if;
  if (select count(*) from wallet_transactions
      where job_id = j.id and kind = 'commission') <> 1 then
    raise exception 'FAIL: commission was charged twice for one job';
  end if;
  raise notice 'ok   complete_job is idempotent and charges commission once';

  -- ------------------------------------------------------------ money

  select final_total_centavos, commission_centavos
    into fare_total, commission
    from jobs where id = j.id;

  -- Gaisano to KCC is roughly 1km, which is inside the 2km the base fare
  -- already covers, so this ride is the PHP 25 minimum. (The 3.5km = PHP 39
  -- case is asserted directly against quote_fare above.)
  if fare_total <> 2500 then
    raise exception 'FAIL: expected a 2500 centavo fare for the short hop, got %', fare_total;
  end if;

  -- 15% of PHP 25.
  if commission <> 375 then
    raise exception 'FAIL: expected 375 centavos commission on a PHP 25 ride, got %', commission;
  end if;

  -- And state the rule, not just the number, so a fare change does not
  -- silently invalidate this check.
  if commission <> round(fare_total::numeric * 1500 / 10000)::int then
    raise exception 'FAIL: commission % is not 15%% of the fare %', commission, fare_total;
  end if;
  raise notice 'ok   commission on a cash ride is 15%% of the fare';

  -- Cash: the driver holds our cut, so their balance goes negative.
  if (select wallet_balance_centavos from drivers where id = drv1) <> -commission then
    raise exception 'FAIL: expected a -% wallet balance, got %',
      commission, (select wallet_balance_centavos from drivers where id = drv1);
  end if;
  raise notice 'ok   a cash booking leaves the driver owing commission';

  if (select active_job_id from drivers where id = drv1) is not null then
    raise exception 'FAIL: the driver was left holding a completed job';
  end if;
  raise notice 'ok   completing a job frees the driver';

  -- The audit log is append-only.
  failed := false;
  begin
    update job_events set event_type = 'tampered' where job_id = j.id;
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: job_events was mutable';
  end if;
  raise notice 'ok   job_events rejects updates';

  -- ------------------------------------------------------------ errands

  perform set_config('request.jwt.claim.sub', cust::text, true);

  errand_job := create_job(
    p_job_type => 'errand',
    p_pickup_lng => 125.1783, p_pickup_lat => 6.1155,
    p_dropoff_lng => 125.1719, p_dropoff_lat => 6.1128,
    p_pickup_label => 'KCC Supermarket',
    p_dropoff_label => 'Home',
    p_items => '[{"name":"Rice","quantity":5,"unit":"kg","notes":"Sinandomeng"},
                 {"name":"Eggs","quantity":1,"unit":"tray","notes":""}]'::jsonb,
    p_items_budget_centavos => 50000
  );

  if (select count(*) from errand_items where job_id = errand_job.id) <> 2 then
    raise exception 'FAIL: errand items were not created';
  end if;
  raise notice 'ok   create_job stores the shopping list';

  -- Walk it to the store.
  perform set_config('request.jwt.claim.sub', drv1::text, true);
  update jobs set driver_id = drv1, status = 'assigned' where id = errand_job.id;
  update drivers set active_job_id = errand_job.id where id = drv1;
  perform advance_job(errand_job.id, 'arriving');
  perform advance_job(errand_job.id, 'arrived_pickup');
  perform advance_job(errand_job.id, 'shopping');

  select id into item_id from errand_items where job_id = errand_job.id order by position limit 1;

  errand_job := submit_errand_receipt(
    errand_job.id,
    jsonb_build_array(
      jsonb_build_object('id', item_id, 'actual_price_centavos', 27500, 'is_available', true),
      jsonb_build_object(
        'id', (select id from errand_items where job_id = errand_job.id order by position desc limit 1),
        'actual_price_centavos', 0, 'is_available', false)
    )
  );

  if errand_job.status <> 'awaiting_approval' then
    raise exception 'FAIL: submitting a receipt should await approval, got %', errand_job.status;
  end if;
  -- Only the available item counts: PHP 275 rice, eggs out of stock.
  if errand_job.items_cost_centavos <> 27500 then
    raise exception 'FAIL: expected 27500 items cost, got %', errand_job.items_cost_centavos;
  end if;
  raise notice 'ok   an unavailable item is excluded from the receipt total';

  -- PHP 80 service + PHP 275 items.
  if errand_job.final_total_centavos <> 35500 then
    raise exception 'FAIL: expected a 35500 total, got %', errand_job.final_total_centavos;
  end if;
  raise notice 'ok   the errand total is service fee plus real receipt';

  -- The driver must not be able to skip the customer's approval.
  failed := false;
  begin
    perform advance_job(errand_job.id, 'completed');
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a driver completed an errand without customer approval';
  end if;
  raise notice 'ok   a driver cannot bypass receipt approval';

  perform set_config('request.jwt.claim.sub', cust::text, true);
  errand_job := approve_errand_total(errand_job.id);
  if errand_job.status <> 'in_progress' then
    raise exception 'FAIL: approval should start delivery, got %', errand_job.status;
  end if;
  raise notice 'ok   customer approval moves the errand to delivery';

  perform set_config('request.jwt.claim.sub', drv1::text, true);
  errand_job := complete_job(errand_job.id);

  -- THE important one: commission is on the PHP 80 service, not the PHP 355
  -- total. 20% of 8000 = 1600. Charging on the total would be 7100.
  select commission_centavos into commission from jobs where id = errand_job.id;
  if commission <> 1600 then
    raise exception
      'FAIL: errand commission must be 20%% of the PHP 80 service fee (1600), got % '
      '-- it is being charged on the groceries', commission;
  end if;
  raise notice 'ok   errand commission is charged on the service, NOT the goods';

  -- ------------------------------------------------------------ constraints

  -- A ride may not carry item costs.
  failed := false;
  begin
    insert into jobs (customer_id, job_type, pickup_location, dropoff_location,
                      items_cost_centavos)
    values (cust, 'ride', point_of(125.17, 6.11), point_of(125.18, 6.12), 5000);
  exception when check_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a ride was allowed an item cost';
  end if;
  raise notice 'ok   only errands may carry item costs';

  -- One live job per driver, enforced by a unique index.
  failed := false;
  begin
    insert into jobs (customer_id, driver_id, job_type, status,
                      pickup_location, dropoff_location)
    values (cust, drv1, 'ride', 'assigned',
            point_of(125.17, 6.11), point_of(125.18, 6.12));
    insert into jobs (customer_id, driver_id, job_type, status,
                      pickup_location, dropoff_location)
    values (cust, drv1, 'ride', 'assigned',
            point_of(125.17, 6.11), point_of(125.18, 6.12));
  exception when unique_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'FAIL: one driver was assigned two live jobs';
  end if;
  raise notice 'ok   a driver cannot hold two live jobs';

  -- ------------------------------------------------------------ geography

  if not in_service_area(point_of(125.0965, 6.1075)) then
    raise exception 'FAIL: the airport is outside the seeded service area';
  end if;
  raise notice 'ok   the airport is inside the service area';

  if in_service_area(point_of(125.4553, 7.1907)) then
    raise exception 'FAIL: Davao is inside the service area';
  end if;
  raise notice 'ok   Davao is outside the service area';

  if (select count(*) from search_landmarks('gaisano')) = 0 then
    raise exception 'FAIL: fuzzy landmark search found nothing for "gaisano"';
  end if;
  raise notice 'ok   fuzzy landmark search works';

  -- A client-reported distance shorter than the straight line is replaced.
  if sanitize_distance(point_of(125.10, 6.10), point_of(125.20, 6.20), 5) <= 5 then
    raise exception 'FAIL: sanitize_distance trusted an impossible client distance';
  end if;
  raise notice 'ok   sanitize_distance rejects an impossible client distance';

  raise notice '';
  raise notice 'ALL DATABASE ASSERTIONS PASSED';
end
$$;
