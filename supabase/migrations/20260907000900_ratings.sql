-- FetchGensan :: ratings

create table ratings (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs (id) on delete cascade,
  rater_id   uuid not null references profiles (id) on delete cascade,
  ratee_id   uuid not null references profiles (id) on delete cascade,
  stars      int not null,
  comment    text not null default '',
  created_at timestamptz not null default now(),

  constraint ratings_stars_range check (stars between 1 and 5),
  -- One rating per person per job, in each direction.
  unique (job_id, rater_id)
);

create index ratings_ratee_idx on ratings (ratee_id, created_at desc);

-- Keeps drivers.rating_sum / rating_count in step with the ratings table so
-- the driver list can sort by rating without a join and an aggregate.
create or replace function apply_rating_to_driver()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update drivers
     set rating_sum = rating_sum + new.stars,
         rating_count = rating_count + 1
   where id = new.ratee_id;
  return null;
end;
$fn$;

create trigger ratings_apply_to_driver after insert on ratings
  for each row execute function apply_rating_to_driver();

create or replace function rate_job(
  p_job_id  uuid,
  p_stars   int,
  p_comment text default ''
)
returns ratings
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jobs;
  ratee uuid;
  r ratings;
begin
  select * into j from jobs where id = p_job_id;

  if j.id is null then
    raise exception 'job not found' using errcode = 'no_data_found';
  end if;
  if j.status <> 'completed' then
    raise exception 'you can only rate a completed booking' using errcode = 'check_violation';
  end if;

  -- Rating flows both ways: the customer rates the driver, the driver rates
  -- the customer. A driver refusing a repeat no-show is worth supporting.
  if auth.uid() = j.customer_id then
    ratee := j.driver_id;
  elsif auth.uid() = j.driver_id then
    ratee := j.customer_id;
  else
    raise exception 'you were not part of this booking' using errcode = 'insufficient_privilege';
  end if;

  if ratee is null then
    raise exception 'nobody to rate on this booking' using errcode = 'check_violation';
  end if;

  insert into ratings (job_id, rater_id, ratee_id, stars, comment)
  values (p_job_id, auth.uid(), ratee, p_stars, coalesce(p_comment, ''))
  returning * into r;

  return r;
end;
$fn$;
