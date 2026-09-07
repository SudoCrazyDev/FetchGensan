-- FetchGensan :: local development seed
-- Runs on `supabase db reset`. Local stack only -- never point this at
-- production.

-- ---------------------------------------------------------------- service area
--
-- A rough box around General Santos City so bookings are not rejected in
-- development. REPLACE THIS before launch with the actual barangay
-- boundaries you intend to serve: a box includes water and farmland you
-- would not send a habal-habal to.

-- The west edge reaches to 125.05 so the airport (125.0965) and Makar Wharf
-- fall inside it. Keep in step with SERVICE_BOUNDS in packages/core/src/geo.ts.
insert into service_zones (name, area, is_active)
values (
  'General Santos City (development box)',
  st_geogfromtext('POLYGON((
    125.050 6.250,
    125.300 6.250,
    125.300 6.000,
    125.050 6.000,
    125.050 6.250
  ))'),
  true
)
on conflict do nothing;

-- ---------------------------------------------------------------- landmarks
--
-- !! THE COORDINATES BELOW ARE APPROXIMATE PLACEHOLDERS. !!
-- They put each landmark in roughly the right part of the city, which is
-- enough to exercise the booking flow, distance banding and fare maths in
-- development. They are NOT survey-accurate and several are likely off by
-- a few hundred metres.
--
-- Before launch, replace every row with a coordinate you have confirmed --
-- ideally by standing there with the driver app open, or by long-pressing
-- the spot in Google Maps and copying the pin. A landmark that is 400m out
-- sends a driver to the wrong gate, and that is exactly the failure that
-- makes a customer go back to hailing on the street.

insert into landmark_suggestions (name, category, location) values
  ('Gaisano Mall of Gensan',             'mall',       st_geogfromtext('POINT(125.1719 6.1128)')),
  ('KCC Mall of Gensan',                 'mall',       st_geogfromtext('POINT(125.1783 6.1155)')),
  ('Robinsons Place Gensan',             'mall',       st_geogfromtext('POINT(125.1690 6.1093)')),
  ('SM City General Santos',             'mall',       st_geogfromtext('POINT(125.1660 6.1210)')),
  ('General Santos City Hall',           'government', st_geogfromtext('POINT(125.1717 6.1128)')),
  ('Gensan Public Market',               'market',     st_geogfromtext('POINT(125.1745 6.1108)')),
  ('Bulaong Terminal',                   'terminal',   st_geogfromtext('POINT(125.1830 6.1176)')),
  ('General Santos City Airport',        'transport',  st_geogfromtext('POINT(125.0965 6.1075)')),
  ('Makar Wharf',                        'transport',  st_geogfromtext('POINT(125.1300 6.1050)')),
  ('Dr. Jorge P. Royeca Hospital',       'hospital',   st_geogfromtext('POINT(125.1741 6.1163)')),
  ('Mindanao State University Gensan',   'school',     st_geogfromtext('POINT(125.1508 6.1093)')),
  ('Notre Dame of Dadiangas University', 'school',     st_geogfromtext('POINT(125.1723 6.1141)')),
  ('Plaza Heneral Santos',               'landmark',   st_geogfromtext('POINT(125.1713 6.1120)')),
  ('Queen Tuna Park',                    'landmark',   st_geogfromtext('POINT(125.1638 6.1063)'))
on conflict (name) do nothing;

-- ---------------------------------------------------------------- test users
--
-- Auth users need the Admin API (password and phone verification are not
-- reachable from plain SQL), so they are created by:
--
--   pnpm seed:users
--
-- which creates:
--   +639170000001  customer    Maria Santos
--   +639170000002  driver      Ramon Dela Cruz   (approved, has wallet balance)
--   +639170000003  driver      Boy Reyes         (pending -- tests the gate)
--   +639170000004  dispatcher  Ops Desk
--
-- On the local stack any OTP code is accepted; use 123456.
