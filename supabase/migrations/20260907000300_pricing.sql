-- FetchGensan :: fare configuration
-- Pricing lives in the database so a dispatcher can change it from the admin
-- console. Changing fares must never require an app release.

create table fare_config (
  id                       uuid primary key default gen_random_uuid(),
  job_type                 job_type not null,

  base_fare_centavos       int not null,   -- covers the first `included_meters`
  included_meters          int not null default 2000,
  per_km_centavos          int not null,   -- charged beyond included_meters
  per_minute_centavos      int not null default 0,
  min_fare_centavos        int not null,
  service_fee_centavos     int not null default 0, -- errand/delivery handling

  -- 24/7 is the selling point, but 1am rides cost more to staff.
  night_surcharge_centavos int not null default 0,
  night_starts_hour        int not null default 22, -- inclusive, Asia/Manila
  night_ends_hour          int not null default 5,  -- exclusive

  -- Platform cut, in basis points. 1500 = 15.00%.
  commission_bps           int not null default 1500,

  -- Errand only: how much item cost a driver may front before we require
  -- a dispatcher to approve the job. Protects drivers from big-ticket scams.
  max_item_float_centavos  int not null default 100000, -- PHP 1,000.00

  is_active                boolean not null default true,
  effective_from           timestamptz not null default now(),
  created_at               timestamptz not null default now(),

  constraint fare_config_sane_money check (
    base_fare_centavos >= 0
    and per_km_centavos >= 0
    and per_minute_centavos >= 0
    and min_fare_centavos >= 0
    and service_fee_centavos >= 0
    and night_surcharge_centavos >= 0
  ),
  constraint fare_config_sane_commission check (commission_bps between 0 and 5000),
  constraint fare_config_sane_hours check (
    night_starts_hour between 0 and 23 and night_ends_hour between 0 and 23
  )
);

-- Exactly one live config per job type at a time.
create unique index fare_config_active_idx on fare_config (job_type) where is_active;

create or replace function active_fare_config(p_job_type job_type)
returns fare_config
language sql
stable
as $$
  select * from fare_config
  where job_type = p_job_type and is_active
  limit 1;
$$;

-- Is `at` inside the night window? Handles the wrap across midnight.
create or replace function is_night_hours(cfg fare_config, at timestamptz)
returns boolean
language sql
immutable
as $$
  select case
    when cfg.night_surcharge_centavos = 0 then false
    when cfg.night_starts_hour = cfg.night_ends_hour then false
    when cfg.night_starts_hour < cfg.night_ends_hour then
      extract(hour from at at time zone 'Asia/Manila')::int
        between cfg.night_starts_hour and cfg.night_ends_hour - 1
    else
      extract(hour from at at time zone 'Asia/Manila')::int >= cfg.night_starts_hour
      or extract(hour from at at time zone 'Asia/Manila')::int < cfg.night_ends_hour
  end;
$$;

-- Authoritative fare quote. The apps show a quote computed by the same
-- formula in packages/core for instant feedback, but this is the number
-- that gets written to the job -- a client is never trusted with a price.
create or replace function quote_fare(
  p_job_type       job_type,
  p_distance_m     int,
  p_duration_s     int default 0,
  p_at             timestamptz default now()
)
returns table (
  base_fare_centavos     int,
  distance_fare_centavos int,
  time_fare_centavos     int,
  service_fee_centavos   int,
  night_surcharge_centavos int,
  total_centavos         int,
  commission_bps         int
)
language plpgsql
stable
as $$
declare
  cfg fare_config;
  billable_m int;
  subtotal int;
begin
  cfg := active_fare_config(p_job_type);
  if cfg.id is null then
    raise exception 'no active fare_config for job_type %', p_job_type
      using errcode = 'no_data_found';
  end if;

  billable_m := greatest(0, coalesce(p_distance_m, 0) - cfg.included_meters);

  base_fare_centavos := cfg.base_fare_centavos;
  -- Round the per-km charge up to the nearest centavo, then to the nearest
  -- peso at the end. Drivers deal in coins, not fractions.
  distance_fare_centavos := ceil(billable_m::numeric / 1000 * cfg.per_km_centavos)::int;
  time_fare_centavos := ceil(coalesce(p_duration_s, 0)::numeric / 60 * cfg.per_minute_centavos)::int;
  service_fee_centavos := cfg.service_fee_centavos;
  night_surcharge_centavos := case when is_night_hours(cfg, p_at)
                                   then cfg.night_surcharge_centavos else 0 end;

  subtotal := base_fare_centavos + distance_fare_centavos + time_fare_centavos
            + service_fee_centavos + night_surcharge_centavos;

  subtotal := greatest(subtotal, cfg.min_fare_centavos);

  -- Round to the nearest peso so there is no coin-change argument.
  total_centavos := round(subtotal::numeric / 100) * 100;
  commission_bps := cfg.commission_bps;

  return next;
end;
$$;

-- ---------------------------------------------------------------- defaults
-- Starting numbers for General Santos City. Tune these from the admin
-- console once you have real trip data; they are a guess, not a benchmark.

insert into fare_config (
  job_type, base_fare_centavos, included_meters, per_km_centavos,
  min_fare_centavos, service_fee_centavos, night_surcharge_centavos, commission_bps
) values
  ('ride',     2500, 2000,  900, 2500,    0, 1500, 1500),
  ('delivery', 3000, 2000, 1000, 3000, 1000, 1500, 1500),
  ('errand',   3000, 2000, 1000, 5000, 5000, 1500, 2000);
