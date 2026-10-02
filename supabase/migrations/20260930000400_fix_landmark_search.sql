-- FetchGensan :: landmark search, second regression from the lockdown
--
-- BUG FIX. search_landmarks() is `stable`, not security definer, so it runs
-- as the caller -- and it calls point_of() to measure distance from the
-- customer. 20260908000100 made point_of() owner-only as an "internal
-- helper", so every search failed with
--
--   permission denied for function point_of
--
-- for customers and signed-out users alike: the landmark list in the
-- booking screen came back empty. 20260908000200 fixed the is_staff() half
-- of the same problem; its test searched with no location, which never
-- reaches point_of(), so this half stayed hidden. The privilege test now
-- searches near a point.
--
-- point_of() is `st_setsrid(st_makepoint(lng, lat), 4326)::geography`:
-- pure, immutable arithmetic that reads no table. Granting it leaks nothing.

grant execute on function point_of(double precision, double precision) to anon, authenticated;
