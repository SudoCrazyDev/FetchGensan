import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image, KeyboardAvoidingView, Platform, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { Screen, SignInForm, Stack, Txt, brand, useTheme } from '@fetch/ui';

export default function SignIn() {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const { identifier } = useLocalSearchParams<{ identifier?: string }>();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Stack gap={6}>
            <Stack gap={2}>
              <Image
                source={require('../assets/brand-mark.png')}
                style={{ width: 49, height: 64, marginBottom: t.space(2) }}
                accessibilityIgnoresInvertColors
                accessible={false}
              />
              <Txt size="display" weight="700">
                {brand.name}
              </Txt>
              <Txt tone="muted" size="title">
                {brand.tagline}
              </Txt>
            </Stack>

            <SignInForm
              initialIdentifier={identifier}
              describeError={humanizeError}
              onSignIn={async (id, password) => {
                await api.auth.signInWithPassword(id, password);
                // The AuthGate in _layout.tsx picks up the session and redirects.
              }}
              onForgotPassword={(id) =>
                router.push({ pathname: '/forgot-password', params: id ? { identifier: id } : {} })
              }
            />
          </Stack>
        </View>

        <Txt size="small" tone="muted" align="center" style={{ marginTop: t.space(6) }}>
          By continuing you agree to our terms of service.
        </Txt>
      </Screen>
    </KeyboardAvoidingView>
  );
}
