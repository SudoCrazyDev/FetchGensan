/**
 * Location reporting while the driver is online.
 *
 * This is the load-bearing piece of the driver app. If pings stop,
 * `can_accept_jobs()` treats the driver as stale after 90 seconds and they
 * silently receive no work -- the worst failure mode in the product,
 * because the app still looks fine.
 *
 * Three deliberate choices:
 *
 * 1. Two cadences. On a job, customers are watching a moving dot, so 8
 *    seconds. Idle, nobody is watching and the only consumer is the
 *    matching query, so 25 seconds. Habal-habal drivers are on prepaid
 *    data; halving idle traffic is real money to them.
 *
 * 2. Foreground service on Android. Without `expo-location`'s foreground
 *    service, Xiaomi/Oppo/Realme/Vivo ROMs suspend the app within minutes
 *    of the screen locking and the driver goes stale mid-shift. The
 *    persistent notification is the price of being dispatchable.
 *
 * 3. Failures are counted, not thrown. A dropped ping on a bad signal is
 *    normal; the UI only complains after several consecutive misses, and
 *    then it tells the driver they may be invisible to dispatch.
 */

import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { useApi } from '@fetch/api/react';
import { type LatLng, isPlausibleFix } from '@fetch/core';

const ON_JOB_INTERVAL_MS = 8_000;
const IDLE_INTERVAL_MS = 25_000;

/** Consecutive failures before we warn the driver they may be invisible. */
const FAILURE_WARN_THRESHOLD = 3;

export interface LocationPingState {
  position: LatLng | null;
  permission: 'unknown' | 'granted' | 'denied' | 'background-denied';
  /** True when several pings in a row have failed. */
  stale: boolean;
  lastPingAt: Date | null;
  requestPermission: () => Promise<boolean>;
}

export function useLocationPing(enabled: boolean, onJob: boolean): LocationPingState {
  const api = useApi();

  const [position, setPosition] = useState<LatLng | null>(null);
  const [permission, setPermission] = useState<LocationPingState['permission']>('unknown');
  const [lastPingAt, setLastPingAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);

  const failures = useRef(0);
  const watcher = useRef<Location.LocationSubscription | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The watcher writes here and the timer reads it, so a re-render is not
  // needed between a fix arriving and it being sent.
  const latest = useRef<Location.LocationObject | null>(null);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== 'granted') {
      setPermission('denied');
      return false;
    }

    // Background is requested but not required: on Android the foreground
    // service covers the screen-locked case, and refusing to let someone
    // work because they declined "always" would cost us drivers.
    if (Platform.OS === 'android') {
      const background = await Location.requestBackgroundPermissionsAsync();
      setPermission(background.status === 'granted' ? 'granted' : 'background-denied');
    } else {
      setPermission('granted');
    }

    return true;
  }, []);

  const sendPing = useCallback(async () => {
    const fix = latest.current;
    if (!fix) return;

    const point: LatLng = {
      latitude: fix.coords.latitude,
      longitude: fix.coords.longitude,
    };
    if (!isPlausibleFix(point)) return;

    try {
      await api.driver.ping(
        point,
        fix.coords.heading ?? undefined,
        fix.coords.speed != null ? Math.max(0, fix.coords.speed * 3.6) : undefined,
      );
      failures.current = 0;
      setStale(false);
      setLastPingAt(new Date());
    } catch {
      failures.current += 1;
      if (failures.current >= FAILURE_WARN_THRESHOLD) setStale(true);
    }
  }, [api]);

  // Start and stop the GPS watcher with the online toggle.
  useEffect(() => {
    let cancelled = false;

    async function start() {
      const ok = await requestPermission();
      if (!ok || cancelled) return;

      watcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          // Report on movement, not on a clock -- a parked driver waiting
          // outside a terminal should not burn battery re-reporting the
          // same coordinate.
          distanceInterval: 15,
          timeInterval: 5_000,
          ...(Platform.OS === 'android'
            ? {
                foregroundService: {
                  notificationTitle: 'FetchGensan Rider — online',
                  notificationBody: 'Sharing your location so you get nearby bookings.',
                  notificationColor: '#F98A15',
                },
              }
            : {}),
        },
        (fix) => {
          latest.current = fix;
          const next = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
          if (isPlausibleFix(next)) setPosition(next);
        },
      );

      // Send one immediately: going online should make you dispatchable now,
      // not in 25 seconds.
      void sendPing();
    }

    function stop() {
      watcher.current?.remove();
      watcher.current = null;
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
      latest.current = null;
      failures.current = 0;
      setStale(false);
    }

    if (enabled) {
      void start();
    } else {
      stop();
    }

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, requestPermission, sendPing]);

  // Cadence switches when a job starts or ends.
  useEffect(() => {
    if (!enabled) return;

    const interval = onJob ? ON_JOB_INTERVAL_MS : IDLE_INTERVAL_MS;
    timer.current = setInterval(() => void sendPing(), interval);

    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [enabled, onJob, sendPing]);

  // Coming back to the foreground after the OS suspended us: ping at once
  // so the driver is not sitting stale while the next interval elapses.
  useEffect(() => {
    if (!enabled) return;

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sendPing();
    });

    return () => sub.remove();
  }, [enabled, sendPing]);

  return { position, permission, stale, lastPingAt, requestPermission };
}
