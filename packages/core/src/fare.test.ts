import { describe, expect, it } from 'vitest';

import {
  type FareConfig,
  commissionOn,
  driverEarnings,
  errandTotal,
  isNightHours,
  manilaHour,
  quoteFare,
} from './fare';
import { formatPeso, pesos } from './money';

/** Mirrors the 'ride' row seeded in 20260907000300_pricing.sql. */
const RIDE: FareConfig = {
  jobType: 'ride',
  baseFareCentavos: 2500,
  includedMeters: 2000,
  perKmCentavos: 900,
  perMinuteCentavos: 0,
  minFareCentavos: 2500,
  serviceFeeCentavos: 0,
  nightSurchargeCentavos: 1500,
  nightStartsHour: 22,
  nightEndsHour: 5,
  commissionBps: 1500,
  maxItemFloatCentavos: 100_000,
};

/** Mirrors the 'errand' row. */
const ERRAND: FareConfig = {
  ...RIDE,
  jobType: 'errand',
  baseFareCentavos: 3000,
  perKmCentavos: 1000,
  minFareCentavos: 5000,
  serviceFeeCentavos: 5000,
  commissionBps: 2000,
};

// Manila is UTC+8 year round, no daylight saving.
const at = (iso: string) => new Date(iso);
const NOON = at('2026-01-15T04:00:00Z'); // 12:00 Manila
const ELEVEN_PM = at('2026-01-15T15:00:00Z'); // 23:00 Manila
const TWO_AM = at('2026-01-15T18:00:00Z'); // 02:00 Manila next day
const SIX_AM = at('2026-01-15T22:00:00Z'); // 06:00 Manila next day

describe('quoteFare', () => {
  it('charges only the base fare inside the included distance', () => {
    const q = quoteFare(RIDE, 1200, 0, NOON);
    expect(q.distanceFareCentavos).toBe(0);
    expect(q.totalCentavos).toBe(2500);
    expect(formatPeso(q.totalCentavos)).toBe('₱25');
  });

  it('bills distance beyond the included metres and rounds to whole pesos', () => {
    // 3500m - 2000m included = 1500m billable at ₱9.00/km = ₱13.50
    // ₱25.00 base + ₱13.50 = ₱38.50, rounded to ₱39.
    const q = quoteFare(RIDE, 3500, 0, NOON);
    expect(q.distanceFareCentavos).toBe(1350);
    expect(q.totalCentavos).toBe(3900);
  });

  it('never returns a fraction of a peso', () => {
    for (let meters = 0; meters <= 15_000; meters += 137) {
      const q = quoteFare(RIDE, meters, 0, NOON);
      expect(q.totalCentavos % 100, `${meters}m produced a non-whole peso`).toBe(0);
    }
  });

  it('applies the minimum fare and says so', () => {
    const cheap: FareConfig = { ...RIDE, baseFareCentavos: 500, minFareCentavos: 2500 };
    const q = quoteFare(cheap, 100, 0, NOON);
    expect(q.minimumApplied).toBe(true);
    expect(q.totalCentavos).toBe(2500);
  });

  it('never decreases as the trip gets longer', () => {
    let previous = 0;
    for (let meters = 0; meters <= 20_000; meters += 250) {
      const total = quoteFare(RIDE, meters, 0, NOON).totalCentavos;
      expect(total, `fare dropped at ${meters}m`).toBeGreaterThanOrEqual(previous);
      previous = total;
    }
  });

  it('adds the night surcharge only inside the night window', () => {
    expect(quoteFare(RIDE, 1200, 0, NOON).nightSurchargeCentavos).toBe(0);
    expect(quoteFare(RIDE, 1200, 0, ELEVEN_PM).nightSurchargeCentavos).toBe(1500);
    expect(quoteFare(RIDE, 1200, 0, TWO_AM).nightSurchargeCentavos).toBe(1500);
    // 05:00 is the exclusive end, so 06:00 is daytime again.
    expect(quoteFare(RIDE, 1200, 0, SIX_AM).nightSurchargeCentavos).toBe(0);
  });

  it('reads the clock in Manila regardless of the device timezone', () => {
    // A phone set to UTC must not get a cheaper 11pm ride.
    expect(manilaHour(ELEVEN_PM)).toBe(23);
    expect(manilaHour(NOON)).toBe(12);
    expect(isNightHours(RIDE, ELEVEN_PM)).toBe(true);
  });

  it('handles a night window that does not wrap midnight', () => {
    const cfg: FareConfig = { ...RIDE, nightStartsHour: 1, nightEndsHour: 4 };
    expect(isNightHours(cfg, TWO_AM)).toBe(true);
    expect(isNightHours(cfg, ELEVEN_PM)).toBe(false);
  });

  it('ignores the night window when there is no surcharge configured', () => {
    const cfg: FareConfig = { ...RIDE, nightSurchargeCentavos: 0 };
    expect(isNightHours(cfg, TWO_AM)).toBe(false);
  });

  it('charges the errand service fee on top of the base', () => {
    // ₱30 base + ₱50 service fee, inside the included distance.
    const q = quoteFare(ERRAND, 1500, 0, NOON);
    expect(q.serviceFeeCentavos).toBe(5000);
    expect(q.totalCentavos).toBe(8000);
  });
});

describe('errand money', () => {
  const fare = quoteFare(ERRAND, 1500, 0, NOON); // ₱80 service

  it('adds the real receipt to the service fare', () => {
    const total = errandTotal(fare, pesos(450));
    expect(total).toBe(53_000);
    expect(formatPeso(total)).toBe('₱530');
  });

  it('takes commission on the service only, never on the groceries', () => {
    const total = errandTotal(fare, pesos(450));
    const commission = commissionOn(total, pesos(450), fare.commissionBps);

    // 20% of the ₱80 service fee, not 20% of ₱530.
    expect(commission).toBe(1600);
    expect(formatPeso(commission)).toBe('₱16');
  });

  it('reimburses the driver the full item cost they fronted', () => {
    const itemsCost = pesos(450);
    const total = errandTotal(fare, itemsCost);
    const earnings = driverEarnings(total, itemsCost, fare.commissionBps);

    // Driver keeps ₱80 service minus ₱16 commission = ₱64, and the ₱450
    // they spent comes back to them separately.
    expect(earnings).toBe(6400);
  });

  it('does not charge commission on a receipt bigger than the whole fare', () => {
    // Pathological but real: a ₱5,000 grocery run on a ₱80 fee. Commission
    // must not go negative or eat the reimbursement.
    const itemsCost = pesos(5000);
    const total = errandTotal(fare, itemsCost);
    const commission = commissionOn(total, itemsCost, fare.commissionBps);
    expect(commission).toBe(1600);
    expect(commission).toBeGreaterThanOrEqual(0);
  });

  it('is safe when the item cost somehow exceeds the total', () => {
    expect(commissionOn(pesos(50), pesos(500), 2000)).toBe(0);
  });
});

describe('ride commission', () => {
  it('takes the full percentage when there are no goods involved', () => {
    const q = quoteFare(RIDE, 3500, 0, NOON); // ₱39
    expect(commissionOn(q.totalCentavos, 0, q.commissionBps)).toBe(585); // 15% of ₱39
    expect(driverEarnings(q.totalCentavos, 0, q.commissionBps)).toBe(3315);
  });

  it('always leaves the driver with more than the platform', () => {
    for (let meters = 500; meters <= 15_000; meters += 500) {
      const q = quoteFare(RIDE, meters, 0, NOON);
      const commission = commissionOn(q.totalCentavos, 0, q.commissionBps);
      const earnings = driverEarnings(q.totalCentavos, 0, q.commissionBps);
      expect(earnings).toBeGreaterThan(commission);
    }
  });
});
