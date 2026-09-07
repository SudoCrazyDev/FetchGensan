-- FetchGensan :: storage buckets and their access rules

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Licenses, OR/CR, clearances. Private: only the owner and staff.
  ('driver-docs', 'driver-docs', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  -- Errand receipts. Private, and the customer on that job can see them.
  ('receipts', 'receipts', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp']),
  -- Profile photos. Public read, because they show on a live job card and
  -- signing every avatar URL is not worth the round trip.
  ('avatars', 'avatars', true, 2097152,
   array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Convention for every bucket below: the first path segment is the owner
-- uuid, e.g. driver-docs/<driver_id>/drivers_license.jpg. The policies key
-- off that segment, so a driver physically cannot write into another
-- driver folder.

-- Only the assigned driver, and only while the errand is actually running.
-- Security definer for the same recursion reason as the RLS predicates.
create or replace function job_receipt_uploadable(p_job_id uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from jobs
    where id = p_job_id
      and driver_id = auth.uid()
      and status in ('arrived_pickup', 'shopping', 'awaiting_approval')
  );
$fn$;

grant execute on function job_receipt_uploadable(uuid) to authenticated;

-- ---------------------------------------------------------------- driver-docs

create policy "driver docs are readable by their owner"
  on storage.objects for select
  using (
    bucket_id = 'driver-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "driver docs are readable by staff"
  on storage.objects for select
  using (bucket_id = 'driver-docs' and is_staff());

create policy "drivers upload their own docs"
  on storage.objects for insert
  with check (
    bucket_id = 'driver-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "drivers replace their own docs"
  on storage.objects for update
  using (
    bucket_id = 'driver-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------- receipts

create policy "receipts readable by the job participants"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    -- job_participant() is security-definer; see the predicates section of
    -- the RLS migration for why a direct subquery on `jobs` is not safe here.
    and job_participant(((storage.foldername(name))[1])::uuid)
  );

-- Only the assigned driver, and only while the errand is actually running.
create policy "assigned driver uploads receipts"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and job_receipt_uploadable(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------- avatars

create policy "avatars are world readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users manage their own avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users replace their own avatar"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users delete their own avatar"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
