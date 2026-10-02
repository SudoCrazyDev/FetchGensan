import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider, useDriverMe, useSessionUser } from '@fetch/api/react';
import { Loading, ThemeProvider, useTheme } from '@fetch/ui';

import { configureNotifications } from '@/lib/alerts';
import { api } from '@/lib/supabase';

configureNotifications();

/** Screens a signed-out user may be on. */
const AUTH_SCREENS = new Set(['sign-in', 'forgot-password']);

/**
 * expo-notifications throws on web for this hook ("not available on web"),
 * and the rider app has a web build. Chosen once at module load, so the
 * same hook runs on every render and hook order never changes.
 */
const useLastResponse: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === 'web' ? () => undefined : Notifications.useLastNotificationResponse;

/**
 * Three destinations, in order of precedence: sign in, finish onboarding,
 * or work. A driver with no `drivers` row cannot go online, so sending them
 * anywhere but onboarding would show a toggle that always fails.
 *
 * It only ever pushes a rider INTO onboarding, never out of it. It used to
 * send anyone with a drivers row back home, and since saving the first step
 * creates that row, a rider was bounced off the documents step mid-upload.
 */
function AuthGate() {
  const { userId, loading: sessionLoading } = useSessionUser();
  const { data: driver, isLoading: driverLoading } = useDriverMe();
  const segments = useSegments();
  const router = useRouter();

  const inAuthFlow = AUTH_SCREENS.has(segments[0] ?? '');
  const inOnboarding = segments[0] === 'onboarding';

  useEffect(() => {
    if (sessionLoading) return;

    if (!userId) {
      if (!inAuthFlow) router.replace('/sign-in');
      return;
    }

    if (inAuthFlow) {
      router.replace('/');
      return;
    }

    // Wait for the driver row before deciding; redirecting on a loading
    // undefined bounces a registered driver through onboarding on every
    // cold start.
    if (driverLoading) return;

    if (!driver && !inOnboarding) {
      router.replace('/onboarding');
    }
  }, [userId, sessionLoading, driver, driverLoading, inAuthFlow, inOnboarding, router]);

  // Tapping a push opens the screen it is about. useLastNotificationResponse
  // also catches the tap that launched the app from cold, which a listener
  // attached after mount would miss.
  const lastResponse = useLastResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web' || !lastResponse || !userId || driverLoading) return;
    const id = lastResponse.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const kind = lastResponse.notification.request.content.data?.kind;
    router.navigate(kind === 'assigned' ? '/job' : '/');
  }, [lastResponse, userId, driverLoading, router]);

  return null;
}

function Navigator() {
  const t = useTheme();
  const { loading } = useSessionUser();

  if (loading) return <Loading label="Signing you in" />;

  return (
    <>
      <AuthGate />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.color.background },
          headerTitleStyle: { color: t.color.text, fontSize: t.font.title, fontWeight: '600' },
          headerTintColor: t.color.primary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.color.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Forgot password' }} />
        <Stack.Screen name="onboarding" options={{ title: 'Set up your account' }} />
        <Stack.Screen name="job" options={{ title: 'Current booking' }} />
        <Stack.Screen name="receipt" options={{ title: 'Receipt' }} />
        <Stack.Screen name="wallet" options={{ title: 'Earnings & wallet' }} />
        <Stack.Screen name="profile" options={{ title: 'Account' }} />
        <Stack.Screen name="rate" options={{ title: 'Rate the customer' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ApiProvider api={api}>
          {/*
            Pinned dark, not 'system'. A driver is looking at this on a
            handlebar mount at 2am; a white screen wrecks night vision and
            they have no free hand to change a setting.
          */}
          <ThemeProvider scheme="dark">
            <StatusBar style="light" />
            <Navigator />
          </ThemeProvider>
        </ApiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
