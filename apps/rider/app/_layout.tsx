import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider, useProfile, useSessionUser } from '@fetch/api/react';
import { Loading, ThemeProvider, useTheme } from '@fetch/ui';

import { configureNotifications, usePush } from '@/lib/push';
import { api } from '@/lib/supabase';

configureNotifications();

/** Screens a signed-out user may be on. */
const AUTH_SCREENS = new Set(['sign-in', 'forgot-password', 'register']);

/**
 * Sends a signed-out user to the sign-in screen and a signed-in user out of
 * it. Lives in an effect rather than a conditional render so the router
 * owns navigation state -- conditionally swapping the whole tree on auth
 * loses any in-progress booking on a token refresh.
 */
function AuthGate() {
  const { userId, loading } = useSessionUser();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const segments = useSegments();
  const router = useRouter();

  usePush();

  const inAuthFlow = AUTH_SCREENS.has(segments[0] ?? '');
  const inWelcome = segments[0] === 'welcome';
  const inVerify = segments[0] === 'verify-id';
  // A first sign-in has a profile row with no name yet.
  const needsName = !!profile && profile.full_name.trim() === '';
  // A self-registered customer who has not finished the ID photos. The
  // database refuses their bookings either way; this just takes them to
  // the screen that fixes it.
  const needsId = !!profile && profile.role === 'customer' && !profile.verified_at;

  useEffect(() => {
    if (loading) return;

    if (!userId) {
      if (!inAuthFlow) router.replace('/sign-in');
      return;
    }

    if (profileLoading) return;

    if (needsName) {
      if (!inWelcome) router.replace('/welcome');
    } else if (needsId) {
      if (!inVerify) router.replace('/verify-id');
    } else if (inAuthFlow || inWelcome || inVerify) {
      router.replace('/');
    }
  }, [
    userId,
    loading,
    profileLoading,
    needsName,
    needsId,
    inAuthFlow,
    inWelcome,
    inVerify,
    router,
  ]);

  return null;
}

function Navigator() {
  const t = useTheme();
  const { loading } = useSessionUser();

  if (loading) return <Loading label="Getting things ready" />;

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
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Forgot password' }} />
        <Stack.Screen name="register" options={{ title: 'Sign up' }} />
        <Stack.Screen
          name="verify-id"
          // No way back: there is nothing behind it but the sign-up form.
          options={{
            title: 'Sign up',
            headerBackVisible: false,
            headerLeft: () => null,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen name="book/[type]" options={{ title: 'Book', presentation: 'card' }} />
        <Stack.Screen name="job/[id]" options={{ title: 'Your booking' }} />
        <Stack.Screen name="history" options={{ title: 'Your bookings' }} />
        <Stack.Screen name="profile" options={{ title: 'Account' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ApiProvider api={api}>
          {/* Pinned light rather than following the phone's dark mode. */}
          <ThemeProvider scheme="light">
            <StatusBar style="dark" />
            <Navigator />
          </ThemeProvider>
        </ApiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
