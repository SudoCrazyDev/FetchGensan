/**
 * Account: who you are on the app, your motorcycle, your papers, and the
 * way out. The driver app had no sign-out at all, which matters more than
 * it sounds -- riders share phones, and a phone handed to a cousin is
 * still signed in as the rider who owns the wallet.
 */

import { useRouter } from 'expo-router';
import { Alert, Linking, ScrollView } from 'react-native';

import { useApi, useDriverDocuments, useDriverMe, useProfile, useSetOnline } from '@fetch/api/react';
import { formatPhPhone } from '@fetch/core';
import { Badge, Button, Card, Divider, Loading, Row, Screen, Spacer, Stack, Txt } from '@fetch/ui';

import { DISPATCH_PHONE } from '@/lib/config';
import { REQUIRED_DOCUMENTS } from '@/lib/documents';

export default function DriverProfile() {
  const api = useApi();
  const router = useRouter();
  const { data: profile, isLoading } = useProfile();
  const { data: driver } = useDriverMe();
  const { data: documents } = useDriverDocuments();
  const setOnline = useSetOnline();

  if (isLoading) return <Loading />;

  const docs = documents ?? [];
  const rejected = docs.filter((d) => d.status === 'rejected').length;
  const approvedRequired = REQUIRED_DOCUMENTS.filter(
    (type) => docs.find((d) => d.doc_type === type)?.status === 'approved',
  ).length;

  function signOut() {
    Alert.alert(
      'Sign out?',
      'You will be taken offline and stop receiving bookings on this phone.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              // Offline first: a signed-out phone must not keep a rider
              // looking dispatchable until the stale-location reaper runs.
              if (driver?.is_online) await setOnline.mutateAsync(false).catch(() => undefined);
              await api.auth.signOut();
              router.replace('/sign-in');
            })();
          },
        },
      ],
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          <Card>
            <Stack gap={2}>
              <Row justify="space-between">
                <Txt size="title" weight="700">
                  {profile?.full_name || 'No name set'}
                </Txt>
                {driver ? (
                  <Badge
                    label={driver.status}
                    tone={
                      driver.status === 'approved'
                        ? 'success'
                        : driver.status === 'pending'
                          ? 'attention'
                          : 'danger'
                    }
                  />
                ) : null}
              </Row>
              <Txt size="small" tone="muted">
                {profile ? formatPhPhone(profile.phone) : ''}
              </Txt>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Motorcycle</Txt>
              <Txt size="small">
                {driver
                  ? `${driver.vehicle_color} ${driver.vehicle_make} ${driver.vehicle_model} · ${driver.plate_number}`
                  : 'Not set up yet'}
              </Txt>
              <Button
                label="Edit my details"
                variant="secondary"
                onPress={() => router.push('/onboarding')}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Row justify="space-between">
                <Txt weight="600">Documents</Txt>
                <Txt size="small" tone={rejected > 0 ? 'danger' : 'muted'}>
                  {rejected > 0
                    ? `${rejected} need a new photo`
                    : `${approvedRequired} of ${REQUIRED_DOCUMENTS.length} required approved`}
                </Txt>
              </Row>
              <Button
                label="View documents"
                variant="secondary"
                onPress={() => router.push({ pathname: '/onboarding', params: { step: 'documents' } })}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Before you rely on this phone</Txt>
              <Txt size="small" tone="muted">
                On Xiaomi, Realme, Oppo and Vivo phones, open Settings → Battery and set this app to
                “No restrictions”. Otherwise the phone puts the app to sleep and you miss bookings.
              </Txt>
              <Button
                label="Open phone settings"
                variant="ghost"
                onPress={() => void Linking.openSettings()}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Dispatch</Txt>
              <Txt size="small" tone="muted">
                Problem with a booking, your wallet or your account? Dispatch is staffed around
                the clock.
              </Txt>
              <Button
                label="Call dispatch"
                variant="secondary"
                onPress={() => void Linking.openURL(`tel:${DISPATCH_PHONE}`)}
              />
            </Stack>
          </Card>

          <Divider />

          <Button label="Sign out" variant="danger" onPress={signOut} />

          <Txt size="caption" tone="muted" align="center">
            FetchGensan Rider 0.1.0
          </Txt>
          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
