import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider, useSessionUser } from '@fetch/api/react';
import { Loading, ThemeProvider, useTheme } from '@fetch/ui';

import { api } from '@/lib/supabase';

/**
 * Sends a signed-out user to the phone screen and a signed-in user out of
 * it. Lives in an effect rather than a conditional render so the router
 * owns navigation state -- conditionally swapping the whole tree on auth
 * loses any in-progress booking on a token refresh.
 */
function AuthGate() {
  const { userId, loading } = useSessionUser();
  const segments = useSegments();
  const router = useRouter();

  const inAuthFlow = segments[0] === 'sign-in';

  useEffect(() => {
    if (loading) return;

    if (!userId && !inAuthFlow) {
      router.replace('/sign-in');
    } else if (userId && inAuthFlow) {
      router.replace('/');
    }
  }, [userId, loading, inAuthFlow, router]);

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
        <Stack.Screen
          name="book/[type]"
          options={{ title: 'Book', presentation: 'card' }}
        />
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
          <ThemeProvider>
            <StatusBar style="auto" />
            <Navigator />
          </ThemeProvider>
        </ApiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
