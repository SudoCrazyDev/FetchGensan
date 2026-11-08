/**
 * Push for customers: "rider found", "please approve your total",
 * "delivered". Sent by the jobs_push_status trigger through the push-notify
 * edge function (20261002000200_app_flow_fixes.sql).
 *
 * The errand approval step is the one that needs this most -- the rider is
 * standing at a till waiting, and a customer who has put their phone down
 * would otherwise never know.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { useApi, useSessionUser } from '@fetch/api/react';

let configured = false;

/**
 * expo-notifications throws on web for this hook ("not available on web"),
 * and the rider app has a web build. Chosen once at module load, so the
 * same hook runs on every render and hook order never changes.
 */
const useLastResponse: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === 'web' ? () => undefined : Notifications.useLastNotificationResponse;

export function configureNotifications(): void {
  if (configured || Platform.OS === 'web') return;
  configured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('default', {
      name: 'Booking updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }
}

/** Registers this device once per launch, and opens the booking on tap. */
export function usePush(): void {
  const api = useApi();
  const router = useRouter();
  const { userId } = useSessionUser();
  const attempted = useRef(false);

  useEffect(() => {
    if (!userId || attempted.current || Platform.OS === 'web' || !Device.isDevice) return;
    attempted.current = true;

    void (async () => {
      try {
        const existing = await Notifications.getPermissionsAsync();
        const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
        if (!granted) return;

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        // No project id means no Expo push token can be issued; see
        // app.config.ts. Not fatal -- the app still updates while open.
        if (!projectId) return;

        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
        await api.client.rpc('register_push_token', {
          p_token: token,
          p_platform: Platform.OS,
          p_device_name: Device.modelName ?? '',
        });
      } catch {
        // Degraded delivery, never a crash.
      }
    })();
  }, [api, userId]);

  // useLastNotificationResponse also catches the tap that launched the app
  // from cold, which a listener attached after mount would miss.
  const lastResponse = useLastResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web' || !lastResponse || !userId) return;
    const id = lastResponse.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const jobId = lastResponse.notification.request.content.data?.jobId;
    if (typeof jobId === 'string') router.push(`/job/${jobId}`);
  }, [lastResponse, userId, router]);
}
