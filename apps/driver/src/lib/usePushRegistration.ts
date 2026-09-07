/**
 * Registers this device for booking-offer pushes.
 *
 * The in-app subscription and poll cover the case where the app is alive.
 * This covers the case that actually loses bookings: the OS has suspended
 * or killed the process, and only a real push will wake it.
 *
 * Runs on every launch so `last_seen_at` stays fresh -- that timestamp is
 * how a token belonging to a sold or wiped phone eventually gets pruned.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useApi, useSessionUser } from '@fetch/api/react';

export type PushState = 'unknown' | 'registered' | 'denied' | 'unsupported' | 'failed';

export function usePushRegistration(): { state: PushState; token: string | null } {
  const api = useApi();
  const { userId } = useSessionUser();

  const [state, setState] = useState<PushState>('unknown');
  const [token, setToken] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!userId || attempted.current) return;
    attempted.current = true;

    let cancelled = false;

    async function register() {
      // A simulator has no push service; trying produces a confusing error.
      if (!Device.isDevice) {
        setState('unsupported');
        return;
      }

      try {
        const existing = await Notifications.getPermissionsAsync();
        let granted = existing.granted;

        if (!granted) {
          const asked = await Notifications.requestPermissionsAsync();
          granted = asked.granted;
        }

        if (!granted) {
          setState('denied');
          return;
        }

        // The EAS project id is required for a push token. Without it the
        // call throws, which is why this is caught rather than assumed.
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          Constants.easConfig?.projectId ??
          undefined;

        const result = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );

        if (cancelled) return;

        await api.client.rpc('register_push_token', {
          p_token: result.data,
          p_platform: Platform.OS,
          p_device_name: Device.modelName ?? '',
        });

        setToken(result.data);
        setState('registered');
      } catch {
        // Never fatal. A driver with no push still gets offers while the
        // app is in the foreground, and blocking the app over this would
        // be far worse than degraded delivery.
        if (!cancelled) setState('failed');
      }
    }

    void register();

    return () => {
      cancelled = true;
    };
  }, [api, userId]);

  return { state, token };
}
