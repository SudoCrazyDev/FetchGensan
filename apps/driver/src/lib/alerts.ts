/**
 * Getting a driver's attention when a booking comes in.
 *
 * A driver is wearing a helmet, in traffic, or asleep at 3am. A silent
 * in-app card is not an alert. This module escalates: haptics for a phone
 * in a pocket, a repeating vibration pattern because one buzz gets missed,
 * and a local notification so the offer surfaces even when the app is
 * backgrounded.
 *
 * Note the deliberate limitation: none of this survives the OS killing the
 * app. That needs a real push notification from the server -- see
 * supabase/functions/push-notify -- and this local layer is what makes the
 * app usable while it is alive.
 */

import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';

/** A 6-second pattern: buzz, pause, buzz. Hard to miss, easy to stop. */
const OFFER_PATTERN = Platform.select({
  android: [0, 600, 300, 600, 300, 900],
  default: [0, 600, 300, 600],
}) as number[];

let offerAlertActive = false;

export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    // A dedicated MAX-importance channel. Android will not heads-up a
    // default-importance notification, and a booking offer that does not
    // interrupt is a booking offer that expires.
    void Notifications.setNotificationChannelAsync('offers', {
      name: 'Booking offers',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: OFFER_PATTERN,
      lightColor: '#F98A15',
      sound: 'default',
      bypassDnd: false,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });

    // Everything that is not an offer: a job dispatch assigned by hand, a
    // booking cancelled under you. The push-notify function sends those on
    // `default`, and Android silently drops a notification aimed at a
    // channel that does not exist.
    void Notifications.setNotificationChannelAsync('default', {
      name: 'Booking updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;

  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/** Start alerting about a new offer. Repeats until stopped or it expires. */
export function startOfferAlert(summary: string): void {
  if (offerAlertActive) return;
  offerAlertActive = true;

  Vibration.vibrate(OFFER_PATTERN, true);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

  void Notifications.scheduleNotificationAsync({
    content: {
      title: 'New booking nearby',
      body: summary,
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.MAX,
      ...(Platform.OS === 'android' ? { channelId: 'offers' } : {}),
    },
    trigger: null,
  });
}

export function stopOfferAlert(): void {
  if (!offerAlertActive) return;
  offerAlertActive = false;
  Vibration.cancel();
  void Notifications.dismissAllNotificationsAsync();
}

/** Light confirmation for an ordinary tap that changed job state. */
export function tapFeedback(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

export function successFeedback(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function errorFeedback(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}
