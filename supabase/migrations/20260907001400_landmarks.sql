-- FetchGensan :: landmark suggestions
--
-- The single highest-leverage table in the project for usability. Street
-- addresses in General Santos mostly do not resolve in a geocoder, and
-- customers describe locations by landmark ("tabi sa KCC", "likod ng
-- Bulaong"). So the booking flow offers landmarks first and free-text
-- addresses last.
--
-- Populated from supabase/seed.sql in development and maintained by
-- dispatchers in the admin console in production.

create table landmark_suggestions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text not null default 'general',
  location   geography (point, 4326) not null,
  -- Bumped every time someone books to or from here, so the list orders
  -- itself by what Gensan actually uses rather than by what we guessed.
  use_count  int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),

  unique (name)
);

create index landmark_suggestions_location_idx
  on landmark_suggestions using gist (location) where is_active;
create index landmark_suggestions_name_idx
  on landmark_suggestions using gin (name gin_trgm_ops);
create index landmark_suggestions_popular_idx
  on landmark_suggestions (use_count desc) where is_active;

alter table landmark_suggestions enable row level security;

create policy landmark_suggestions_read on landmark_suggestions
  for select using (is_active or is_staff());

create policy landmark_suggestions_staff on landmark_suggestions
  for all using (is_staff()) with check (is_staff());

grant select on landmark_suggestions to authenticated, anon;

-- Fuzzy landmark search, nearest-and-most-used first. Trigram matching so
-- "gaisano", "gaisano mall" and "gasiano" all find the same place.
create or replace function search_landmarks(
  p_query    text default '',
  p_near_lng double precision default null,
  p_near_lat double precision default null,
  p_limit    int default 12
)
returns table (
  id         uuid,
  name       text,
  category   text,
  lng        double precision,
  lat        double precision,
  distance_m int
)
language sql
stable
as $fn$
  select
    l.id,
    l.name,
    l.category,
    st_x(l.location::geometry),
    st_y(l.location::geometry),
    case when p_near_lng is null or p_near_lat is null then null
         else st_distance(l.location, point_of(p_near_lng, p_near_lat))::int end
  from landmark_suggestions l
  where l.is_active
    and (
      coalesce(trim(p_query), '') = ''
      or l.name ilike '%' || p_query || '%'
      or similarity(l.name, p_query) > 0.2
    )
  order by
    -- An exact prefix match always wins, then fuzzy closeness, then how
    -- near it is, then how popular it is.
    (l.name ilike p_query || '%') desc,
    case when coalesce(trim(p_query), '') = '' then 0
         else similarity(l.name, p_query) end desc,
    case when p_near_lng is null then 0
         else st_distance(l.location, point_of(p_near_lng, p_near_lat)) end asc,
    l.use_count desc
  limit p_limit;
$fn$;

grant execute on function search_landmarks(text, double precision, double precision, int)
  to authenticated, anon;

create or replace function bump_landmark(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  update landmark_suggestions set use_count = use_count + 1 where id = p_id;
$fn$;

grant execute on function bump_landmark(uuid) to authenticated;
