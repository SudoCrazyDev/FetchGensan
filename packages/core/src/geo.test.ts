import { describe, expect, it } from 'vitest';

import {
  GENSAN_CENTER,
  type LatLng,
  estimateRoadMeters,
  estimateSeconds,
  formatDistance,
  formatDuration,
  fromPoint,
  haversineMeters,
  isPlausibleFix,
  looksInServiceArea,
  toPoint,
} from './geo';

const KCC: LatLng = { latitude: 6.1155, longitude: 125.1783 };
const AIRPORT: LatLng = { latitude: 6.1075, longitude: 125.0965 };

describe('coordinate ordering', () => {
  it('converts to PostGIS [lng, lat] and back', () => {
    // The bug this guards: passing {latitude, longitude} straight into
    // ST_MakePoint puts every booking in the Indian Ocean.
    expect(toPoint(KCC)).toEqual([125.1783, 6.1155]);
    expect(fromPoint(toPoint(KCC))).toEqual(KCC);
  });

  it('puts longitude first, which is the opposite of the maps SDK', () => {
    const [first] = toPoint(GENSAN_CENTER);
    expect(first).toBeGreaterThan(100); // longitude 125.x, not latitude 6.x
  });
});

describe('distance', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(KCC, KCC)).toBe(0);
  });

  it('measures a known Gensan hop within a sensible tolerance', () => {
    // City centre to the airport is roughly 9km as the crow flies.
    const m = haversineMeters(GENSAN_CENTER, AIRPORT);
    expect(m).toBeGreaterThan(8_000);
    expect(m).toBeLessThan(10_000);
  });

  it('is symmetric', () => {
    expect(haversineMeters(KCC, AIRPORT)).toBeCloseTo(haversineMeters(AIRPORT, KCC), 6);
  });

  it('estimates a road distance longer than the straight line', () => {
    const crow = haversineMeters(GENSAN_CENTER, AIRPORT);
    expect(estimateRoadMeters(GENSAN_CENTER, AIRPORT)).toBeGreaterThan(crow);
  });
});

describe('formatting', () => {
  it('rounds short distances to something a human would say', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(142)).toBe('140 m');
    expect(formatDistance(999)).toBe('1000 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(12_400)).toBe('12 km');
  });

  it('describes durations without false precision', () => {
    expect(formatDuration(30)).toBe('under a minute');
    expect(formatDuration(300)).toBe('5 min');
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(5400)).toBe('1 hr 30 min');
  });

  it('estimates a plausible habal-habal ETA', () => {
    // ~5km at 22kph should land in the 10-20 minute band.
    const seconds = estimateSeconds(5000);
    expect(seconds).toBeGreaterThan(600);
    expect(seconds).toBeLessThan(1200);
  });
});

describe('GPS sanity', () => {
  it('rejects Null Island, which is what a phone reports before it has a fix', () => {
    expect(isPlausibleFix({ latitude: 0, longitude: 0 })).toBe(false);
  });

  it('rejects missing and non-finite coordinates', () => {
    expect(isPlausibleFix(null)).toBe(false);
    expect(isPlausibleFix(undefined)).toBe(false);
    expect(isPlausibleFix({ latitude: Number.NaN, longitude: 125 })).toBe(false);
    expect(isPlausibleFix({ latitude: 6.1, longitude: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('rejects impossible coordinates', () => {
    expect(isPlausibleFix({ latitude: 91, longitude: 125 })).toBe(false);
    expect(isPlausibleFix({ latitude: 6.1, longitude: 181 })).toBe(false);
  });

  it('accepts a real Gensan fix', () => {
    expect(isPlausibleFix(KCC)).toBe(true);
  });
});

describe('service area', () => {
  it('accepts points around General Santos', () => {
    expect(looksInServiceArea(GENSAN_CENTER)).toBe(true);
    expect(looksInServiceArea(KCC)).toBe(true);
    expect(looksInServiceArea(AIRPORT)).toBe(true);
  });

  it('rejects somewhere we do not serve', () => {
    // Davao City, ~150km away.
    expect(looksInServiceArea({ latitude: 7.1907, longitude: 125.4553 })).toBe(false);
    // Manila.
    expect(looksInServiceArea({ latitude: 14.5995, longitude: 120.9842 })).toBe(false);
  });
});
