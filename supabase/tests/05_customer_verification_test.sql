-- FetchGensan :: customer ID verification
--
-- A self-registered customer cannot book until all four ID photos are on
-- file, recording one checks it was really uploaded to their own folder,
-- and the fourth photo approves the account without anyone reviewing it.
-- Runs as `authenticated` so the grants are exercised for real.

\set ON_ERROR_STOP on
\timing off

do $$
declare
  cust  uuid := 'cccccccc-0000-0000-0000-000000000001';
  old   uuid := 'cccccccc-0000-0000-0000-000000000002';
  t     text;
  v     timestamptz;
  j     jobs;
  failed boolean;
begin
  insert into auth.users (id, phone, email) values
    (cust, null, 'new.customer@example.com'),
    (old, '+639190000099', null);

  -- Staff-made and seeded accounts are verified on creation.
  if (select verified_at from profiles where id = old) is null then
    raise exception 'FAIL: an account not made by self-registration started unverified';
  end if;
  raise notice 'ok   non-self-registered accounts start verified';

  -- What the auth function's register/start does with the service role.
  update profiles set verified_at = null, phone = '+639190000098' where id = cust;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', cust::text, true);

  failed := false;
  begin
    j := create_job(
      p_job_type => 'ride',
      p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
      p_dropoff_lng => 125.1783, p_dropoff_lat => 6.1155
    );
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: an unverified customer booked a ride'; end if;
  raise notice 'ok   unverified customers cannot book';

  -- A path that was never uploaded must not count.
  failed := false;
  begin
    perform record_customer_document('id_front', cust::text || '/ghost.jpg');
  exception when check_violation then failed := true;
  end;
  if not failed then raise exception 'FAIL: recorded a photo that was never uploaded'; end if;
  raise notice 'ok   a photo must be in storage before it counts';

  -- Nor may anyone record a file from someone else's folder.
  failed := false;
  begin
    perform record_customer_document('id_front', old::text || '/theirs.jpg');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: recorded a photo from another folder'; end if;
  raise notice 'ok   only photos in your own folder count';

  -- The stub has no storage upload API; stand in for one as the owner.
  reset role;
  insert into storage.objects (bucket_id, name, owner)
  select 'customer-ids', cust::text || '/' || d || '.jpg', cust
  from unnest(array['id_front', 'id_back', 'selfie', 'selfie_with_id']) d;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', cust::text, true);

  foreach t in array array['id_front', 'id_back', 'selfie'] loop
    v := record_customer_document(t, cust::text || '/' || t || '.jpg');
    if v is not null then
      raise exception 'FAIL: verified after only some photos (%)', t;
    end if;
  end loop;
  raise notice 'ok   three of four photos is not enough';

  v := record_customer_document('selfie_with_id', cust::text || '/selfie_with_id.jpg');
  if v is null then raise exception 'FAIL: the fourth photo did not verify the account'; end if;
  raise notice 'ok   the fourth photo approves the account automatically';

  j := create_job(
    p_job_type => 'ride',
    p_pickup_lng => 125.1719, p_pickup_lat => 6.1128,
    p_dropoff_lng => 125.1783, p_dropoff_lat => 6.1155
  );
  raise notice 'ok   a verified customer can book';

  -- Customers cannot verify themselves by writing the column.
  reset role;
  update profiles set verified_at = null where id = cust;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', cust::text, true);
  failed := false;
  begin
    update profiles set verified_at = now() where id = cust;
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a customer set their own verified_at'; end if;
  raise notice 'ok   verified_at is not client-writable';

  -- The sign-up lookup answers "does this email exist", so only the
  -- service role may call it.
  failed := false;
  begin
    perform registration_lookup('new.customer@example.com', '');
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'FAIL: a client can call registration_lookup'; end if;
  raise notice 'ok   registration_lookup is service-role only';

  reset role;
end;
$$;
