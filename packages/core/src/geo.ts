/**
 * Geography helpers.
 *
 * Note the ordering trap that costs everyone a day at least once: PostGIS
 * and GeoJSON are (lng, lat); react-native-maps and the Google Maps JS API
 * are ({ latitude, longitude }). `LatLng` below is the app-facing shape and
 * `toPoint`/`fromPoint` are the only places the two meet.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** [lng, lat] -- PostGIS and GeoJSON ordering. */
export type Point = [number, number];

export function toPoint(p: LatLng): Point {
  return [p.longitude, p.latitude];
}

export function fromPoint(p: Point): LatLng {
  return { latitude: p[1], longitude: p[0] };
}

const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Typical detour factor for a city street grid. Used to estimate a road
 * distance before the Directions API has answered, and mirrored by
 * `sanitize_distance()` in the lifecycle migration.
 */
export const STREET_DETOUR_FACTOR = 1.35;

export function estimateRoadMeters(a: LatLng, b: LatLng): number {
  return Math.ceil(haversineMeters(a, b) * STREET_DETOUR_FACTOR);
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * Habal-habal average speed through General Santos traffic, used for ETAs
 * before a routing answer arrives. Deliberately pessimistic: a motorcycle
 * filters through traffic faster than a car, but the pickup leg includes
 * finding the customer, which is where the minutes actually go.
 */
export const AVG_SPEED_KPH = 22;

export function estimateSeconds(meters: number): number {
  return Math.ceil((meters / 1000 / AVG_SPEED_KPH) * 3600);
}

/** General Santos City centre -- the initial map camera for a cold start. */
export const GENSAN_CENTER: LatLng = { latitude: 6.1128, longitude: 125.1716 };

export const GENSAN_REGION = {
  ...GENSAN_CENTER,
  latitudeDelta: 0.09,
  longitudeDelta: 0.09,
};

/**
 * A coordinate a phone reports as (0, 0) is a GPS fix that has not landed
 * yet, not the Gulf of Guinea. Booking from Null Island is the classic
 * mobile geo bug, so it gets an explicit guard.
 */
export function isPlausibleFix(p: LatLng | null | undefined): p is LatLng {
  if (!p) return false;
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false;
  if (p.latitude === 0 && p.longitude === 0) return false;
  return Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
}

/**
 * Rough bounding box of the launch service area, for a cheap early reject
 * before the pin is sent to `in_service_area()` in the database.
 *
 * The west edge has to reach past 125.10 to include General Santos City
 * Airport (125.0965) and Makar Wharf. Early-morning airport runs are one of
 * the advertised use cases, so a box that clipped them would have rejected
 * exactly the bookings worth the most. Keep this in step with the
 * `service_zones` polygon in supabase/seed.sql.
 */
export const SERVICE_BOUNDS = {
  minLat: 6.0,
  maxLat: 6.25,
  minLng: 125.05,
  maxLng: 125.3,
};

export function looksInServiceArea(p: LatLng): boolean {
  return (
    p.latitude >= SERVICE_BOUNDS.minLat &&
    p.latitude <= SERVICE_BOUNDS.maxLat &&
    p.longitude >= SERVICE_BOUNDS.minLng &&
    p.longitude <= SERVICE_BOUNDS.maxLng
  );
}
