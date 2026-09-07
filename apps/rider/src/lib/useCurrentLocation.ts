import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

import { GENSAN_CENTER, type LatLng, isPlausibleFix } from '@fetch/core';

export type PermissionState = 'unknown' | 'granted' | 'denied';

/**
 * The customer's current position, used to seed the pickup pin.
 *
 * Deliberately never blocks booking. Location permission is denied often
 * enough -- and GPS indoors in a concrete building fails often enough --
 * that a flow which requires a fix would lose real bookings. When there is
 * no fix we fall back to the city centre and let the customer drag the pin,
 * which they end up doing regardless because a phone fix is routinely 50m
 * out and the pickup needs to be the right side of the street.
 */
export function useCurrentLocation() {
  const [position, setPosition] = useState<LatLng | null>(null);
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [loading, setLoading] = useState(true);

  const request = useCallback(async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        setPermission('denied');
        return;
      }

      setPermission('granted');

      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const next: LatLng = {
        latitude: fix.coords.latitude,
        longitude: fix.coords.longitude,
      };

      // A phone that has not locked on reports (0, 0). Booking from Null
      // Island is a real bug, not a hypothetical.
      if (isPlausibleFix(next)) setPosition(next);
    } catch {
      // Timeouts and "location services disabled" both land here. Neither
      // is worth an error screen; the fallback pin covers it.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void request();
  }, [request]);

  return {
    position,
    /** Always usable, whether or not we got a real fix. */
    startingPoint: position ?? GENSAN_CENTER,
    isRealFix: position !== null,
    permission,
    loading,
    retry: request,
  };
}
