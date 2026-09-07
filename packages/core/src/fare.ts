/**
 * Fare estimation, mirrored from `quote_fare()` in
 * supabase/migrations/20260907000300_pricing.sql.
 *
 * The database is the authority on price -- `create_job()` recomputes the
 * fare server-side and writes that number, so a tampered client cannot book
 * a ₱1 airport run. This mirror exists so the booking screen can show a
 * live estimate as the customer drags the pin, without a round trip per
 * frame.
 *
 * fare.test.ts pins the two implementations to the same worked examples. If
 * you change the formula, change it in both places.
 */

import type { JobType } from './job-state';
import { type Centavos, applyBps, roundToPeso } from './money';

/** Mirrors a row of `fare_config`. */
export interface FareConfig {
  jobType: JobType;
  baseFareCentavos: Centavos;
  includedMeters: number;
  perKmCentavos: Centavos;
  perMinuteCentavos: Centavos;
  minFareCentavos: Centavos;
  serviceFeeCentavos: Centavos;
  nightSurchargeCentavos: Centavos;
  nightStartsHour: number;
  nightEndsHour: number;
  commissionBps: number;
  maxItemFloatCentavos: Centavos;
}

export interface FareBreakdown {
  baseFareCentavos: Centavos;
  distanceFareCentavos: Centavos;
  timeFareCentavos: Centavos;
  serviceFeeCentavos: Centavos;
  nightSurchargeCentavos: Centavos;
  /** After the minimum-fare floor and peso rounding. */
  totalCentavos: Centavos;
  /** True when the floor kicked in, so the UI can explain the number. */
  minimumApplied: boolean;
  commissionBps: number;
}

const MANILA_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila',
  hour: 'numeric',
  hour12: false,
});

/** Hour of day (0-23) in Asia/Manila, whatever the device timezone is set to. */
export function manilaHour(at: Date): number {
  // A phone with the wrong timezone must not change what a fare costs.
  const hour = Number(MANILA_HOUR.format(at));
  return hour === 24 ? 0 : hour;
}

export function isNightHours(cfg: FareConfig, at: Date): boolean {
  if (cfg.nightSurchargeCentavos === 0) return false;
  if (cfg.nightStartsHour === cfg.nightEndsHour) return false;

  const hour = manilaHour(at);
  if (cfg.nightStartsHour < cfg.nightEndsHour) {
    return hour >= cfg.nightStartsHour && hour < cfg.nightEndsHour;
  }
  // Wraps midnight, e.g. starts 22 ends 5.
  return hour >= cfg.nightStartsHour || hour < cfg.nightEndsHour;
}

export function quoteFare(
  cfg: FareConfig,
  distanceMeters: number,
  durationSeconds = 0,
  at: Date = new Date(),
): FareBreakdown {
  const billableMeters = Math.max(0, distanceMeters - cfg.includedMeters);

  const baseFareCentavos = cfg.baseFareCentavos;
  const distanceFareCentavos = Math.ceil((billableMeters / 1000) * cfg.perKmCentavos);
  const timeFareCentavos = Math.ceil((durationSeconds / 60) * cfg.perMinuteCentavos);
  const serviceFeeCentavos = cfg.serviceFeeCentavos;
  const nightSurchargeCentavos = isNightHours(cfg, at) ? cfg.nightSurchargeCentavos : 0;

  const raw =
    baseFareCentavos +
    distanceFareCentavos +
    timeFareCentavos +
    serviceFeeCentavos +
    nightSurchargeCentavos;

  const minimumApplied = raw < cfg.minFareCentavos;
  const floored = Math.max(raw, cfg.minFareCentavos);

  return {
    baseFareCentavos,
    distanceFareCentavos,
    timeFareCentavos,
    serviceFeeCentavos,
    nightSurchargeCentavos,
    totalCentavos: roundToPeso(floored),
    minimumApplied,
    commissionBps: cfg.commissionBps,
  };
}

/**
 * What an errand actually costs the customer: the service fare plus the
 * real receipt. Shown as two lines in the app, never as one number, because
 * the customer approved a fee and is now being asked to accept a total.
 */
export function errandTotal(fare: FareBreakdown, itemsCostCentavos: Centavos): Centavos {
  return fare.totalCentavos + itemsCostCentavos;
}

/**
 * Our cut. Charged on the service only -- never on the goods.
 *
 * A ₱2,000 grocery run earns commission on the ₱80 errand fee, not on the
 * customer's groceries. `commission_base_centavos()` in the wallet
 * migration enforces the same rule.
 */
export function commissionOn(
  finalTotalCentavos: Centavos,
  itemsCostCentavos: Centavos,
  commissionBps: number,
): Centavos {
  const base = Math.max(0, finalTotalCentavos - itemsCostCentavos);
  return applyBps(base, commissionBps);
}

/** What the driver keeps once our commission is out. */
export function driverEarnings(
  finalTotalCentavos: Centavos,
  itemsCostCentavos: Centavos,
  commissionBps: number,
): Centavos {
  return (
    finalTotalCentavos -
    itemsCostCentavos -
    commissionOn(finalTotalCentavos, itemsCostCentavos, commissionBps)
  );
}

/** Maps a `fare_config` row as returned by PostgREST into a FareConfig. */
export function fareConfigFromRow(row: {
  job_type: JobType;
  base_fare_centavos: number;
  included_meters: number;
  per_km_centavos: number;
  per_minute_centavos: number;
  min_fare_centavos: number;
  service_fee_centavos: number;
  night_surcharge_centavos: number;
  night_starts_hour: number;
  night_ends_hour: number;
  commission_bps: number;
  max_item_float_centavos: number;
}): FareConfig {
  return {
    jobType: row.job_type,
    baseFareCentavos: row.base_fare_centavos,
    includedMeters: row.included_meters,
    perKmCentavos: row.per_km_centavos,
    perMinuteCentavos: row.per_minute_centavos,
    minFareCentavos: row.min_fare_centavos,
    serviceFeeCentavos: row.service_fee_centavos,
    nightSurchargeCentavos: row.night_surcharge_centavos,
    nightStartsHour: row.night_starts_hour,
    nightEndsHour: row.night_ends_hour,
    commissionBps: row.commission_bps,
    maxItemFloatCentavos: row.max_item_float_centavos,
  };
}
