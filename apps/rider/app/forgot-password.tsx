import { useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { ResetPasswordForm, Screen } from '@fetch/ui';

export default function ForgotPassword() {
  const api = useApi();
  const router = useRouter();
  const { identifier } = useLocalSearchParams<{ identifier?: string }>();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll edges={['bottom']}>
        <ResetPasswordForm
          initialIdentifier={identifier}
          describeError={humanizeError}
          onRequestCode={async (id) => {
            await api.auth.requestPasswordReset(id);
          }}
          onReset={async (id, code, password) => {
            // Signs in on success; the AuthGate then leaves this screen.
            await api.auth.resetPassword(id, code, password);
          }}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/sign-in'))}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}
