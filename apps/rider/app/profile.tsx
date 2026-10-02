import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi, useProfile, useRemovePlace, useSavedPlaces } from '@fetch/api/react';
import { formatPhPhone } from '@fetch/core';
import {
  Button,
  Card,
  Divider,
  Field,
  Loading,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
} from '@fetch/ui';

import { DISPATCH_PHONE } from '@/lib/config';

export default function ProfileScreen() {
  const api = useApi();
  const router = useRouter();
  const { data: profile, isLoading, refetch } = useProfile();
  const { data: saved } = useSavedPlaces();
  const removePlace = useRemovePlace();

  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile) setName(profile.full_name);
  }, [profile]);

  if (isLoading) return <Loading />;

  async function save() {
    setSaving(true);
    try {
      await api.profile.update({ full_name: name.trim() });
      await refetch();
      Alert.alert('Saved');
    } catch (e) {
      Alert.alert('Could not save', humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  function signOut() {
    Alert.alert('Sign out?', 'You will need your mobile number to sign back in.', [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void api.auth.signOut().then(() => router.replace('/sign-in'));
        },
      },
    ]);
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          <Card>
            <Stack gap={3}>
              <Field
                label="Your name"
                value={name}
                onChangeText={setName}
                placeholder="Maria Santos"
                hint="Your rider sees this when they accept your booking."
              />
              <Row justify="space-between">
                <Txt size="small" tone="muted">
                  Mobile
                </Txt>
                <Txt size="small" weight="600">
                  {profile ? formatPhPhone(profile.phone) : '—'}
                </Txt>
              </Row>
              <Button
                label="Save"
                loading={saving}
                disabled={!name.trim() || name.trim() === profile?.full_name}
                onPress={() => void save()}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Saved places</Txt>
              {saved && saved.length > 0 ? (
                saved.map((place, index) => (
                  <Stack key={place.id} gap={2}>
                    {index > 0 ? <Divider /> : null}
                    <Row justify="space-between" align="flex-start">
                      <Stack gap={0.5} style={{ flex: 1 }}>
                        <Txt size="small" weight="600">
                          {place.label}
                        </Txt>
                        {place.landmark_note ? (
                          <Txt size="small" tone="muted">
                            {place.landmark_note}
                          </Txt>
                        ) : null}
                      </Stack>
                      <Pressable
                        hitSlop={10}
                        accessibilityLabel={`Remove ${place.label}`}
                        onPress={() =>
                          Alert.alert(`Remove "${place.label}"?`, undefined, [
                            { text: 'Keep', style: 'cancel' },
                            {
                              text: 'Remove',
                              style: 'destructive',
                              onPress: () => removePlace.mutate(place.id),
                            },
                          ])
                        }
                      >
                        <Txt size="small" tone="danger">
                          Remove
                        </Txt>
                      </Pressable>
                    </Row>
                  </Stack>
                ))
              ) : (
                <Txt size="small" tone="muted">
                  Type a name under "Save this place as" when you pick a spot, and it appears here.
                </Txt>
              )}
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Need help?</Txt>
              <Txt size="small" tone="muted">
                Dispatch is staffed around the clock.
              </Txt>
              <Button
                label="Call dispatch"
                variant="secondary"
                onPress={() => void Linking.openURL(`tel:${DISPATCH_PHONE}`)}
              />
            </Stack>
          </Card>

          <Button label="Sign out" variant="danger" onPress={signOut} />

          <Txt size="caption" tone="muted" align="center">
            FetchGensan 0.1.0
          </Txt>

          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
