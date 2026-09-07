import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider, useDriverMe, useSessionUser } from '@fetch/api/react';
import { Loading, ThemeProvider, useTheme } from '@fetch/ui';

import { configureNotifications } from '@/lib/alerts';
import { api } from '@/lib/supabase';

configureNotifications();

/**
 * Three destinations, in order of precedence: sign in, finish onboarding,
 * or work. A driver with no `drivers` row cannot go online, so sending them
 * anywhere but onboarding would show a toggle that always fails.
 */
function AuthGate() {
  const { userId, loading: sessionLoading } = useSessionUser();
  const { data: driver, isLoading: driverLoading } = useDriverMe();
  const segments = useSegments();
  const router = useRouter();

  const inAuthFlow = segments[0] === 'sign-in';
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
    } else if (driver && inOnboarding) {
      router.replace('/');
    }
  }, [userId, sessionLoading, driver, driverLoading, inAuthFlow, inOnboarding, router]);

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
        <Stack.Screen name="onboarding" options={{ title: 'Set up your account' }} />
        <Stack.Screen name="job" options={{ title: 'Current booking' }} />
        <Stack.Screen name="receipt" options={{ title: 'Receipt' }} />
        <Stack.Screen name="wallet" options={{ title: 'Earnings & wallet' }} />
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
