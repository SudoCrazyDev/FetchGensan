/**
 * First-run name prompt.
 *
 * Phone OTP signs a customer in with nothing but a number, and the rider
 * who accepts the booking is then shown a blank name. One field, asked
 * once, straight after the code -- the only moment the customer expects to
 * be asked anything.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { humanizeError } from '@fetch/api';
import { qk, useApi } from '@fetch/api/react';
import { profileUpdateSchema } from '@fetch/core';
import { Button, Field, Screen, Stack, Txt } from '@fetch/ui';

export default function Welcome() {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = profileUpdateSchema.safeParse({ full_name: name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter your name');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const profile = await api.profile.update({ full_name: parsed.data.full_name });
      queryClient.setQueryData(qk.profile, profile);
      router.replace('/');
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'center' }}
      >
        <View>
          <Stack gap={5}>
            <Stack gap={1}>
              <Txt size="heading" weight="700">
                What should we call you?
              </Txt>
              <Txt tone="muted">Your rider sees this name when they come to pick you up.</Txt>
            </Stack>

            <Field
              label="Your name"
              value={name}
              onChangeText={(v) => {
                setName(v);
                setError(null);
              }}
              placeholder="Maria Santos"
              autoFocus
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              error={error}
              editable={!busy}
            />

            <Button label="Continue" size="lg" loading={busy} onPress={() => void save()} />
          </Stack>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
