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
    and (
      is_staff()
      or exists (
        select 1 from jobs j
        where j.id::text = (storage.foldername(name))[1]
          and (j.customer_id = auth.uid() or j.driver_id = auth.uid())
      )
    )
  );

-- Only the assigned driver, and only while the errand is actually running.
create policy "assigned driver uploads receipts"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and exists (
      select 1 from jobs j
      where j.id::text = (storage.foldername(name))[1]
        and j.driver_id = auth.uid()
        and j.status in ('arrived_pickup', 'shopping', 'awaiting_approval')
    )
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
