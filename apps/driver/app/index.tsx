import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import {
  useClaimJob,
  useDeclineJob,
  useDriverActiveJob,
  useDriverMe,
  useOffers,
  useSetOnline,
} from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  customerStatusLabel,
  formatDistance,
  formatPeso,
} from '@fetch/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  Loading,
  Money,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import {
  errorFeedback,
  requestNotificationPermission,
  startOfferAlert,
  stopOfferAlert,
  successFeedback,
} from '@/lib/alerts';
import { usePushRegistration } from '@/lib/usePushRegistration';
import { useLocationPing } from '@/lib/useLocationPing';

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export default function DriverHome() {
  const t = useTheme();
  const router = useRouter();

  const { data: driver, isLoading } = useDriverMe();
  const { data: activeJob } = useDriverActiveJob();
  const { data: offers } = useOffers();
  const setOnline = useSetOnline();
  const claim = useClaimJob();
  const decline = useDeclineJob();

  const online = driver?.is_online ?? false;
  const onJob = !!activeJob;

  const ping = useLocationPing(online, onJob);
  // Registers this device so offers still arrive once Android suspends
  // the app. Non-blocking: a failure only degrades delivery.
  const push = usePushRegistration();

  const topOffer = useMemo(() => (offers ?? [])[0] ?? null, [offers]);
  const alertedFor = useRef<string | null>(null);

  useEffect(() => {
    void requestNotificationPermission();
  }, []);

  // Alert once per offer, and stop as soon as it is gone.
  useEffect(() => {
    if (topOffer && alertedFor.current !== topOffer.id) {
      alertedFor.current = topOffer.id;
      const job = topOffer.job;
      startOfferAlert(
        `${JOB_TYPE_LABELS[job.job_type]} · ${formatPeso(job.quoted_fare_centavos)} · ` +
          `${formatDistance(topOffer.distance_m)} away`,
      );
    }

    if (!topOffer) {
      alertedFor.current = null;
      stopOfferAlert();
    }
  }, [topOffer]);

  // Never leave the phone buzzing because a screen unmounted.
  useEffect(() => stopOfferAlert, []);

  if (isLoading) return <Loading />;

  const walletOwed = driver ? Math.min(0, driver.wallet_balance_centavos) : 0;
  const nearFloor =
    driver && driver.wallet_balance_centavos <= driver.credit_floor_centavos + 10_000;

  function toggleOnline(next: boolean) {
    setOnline.mutate(next, {
      onError: (e) => {
        errorFeedback();
        Alert.alert('Cannot go online', humanizeError(e));
      },
      onSuccess: () => successFeedback(),
    });
  }

  return (
    <Screen edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          {/* ------------------------------------------------ online toggle */}

          <Card
            style={{
              borderColor: online ? t.color.success : t.color.border,
              borderWidth: online ? 2 : undefined,
            }}
          >
            <Row justify="space-between">
              <Stack gap={1} style={{ flex: 1 }}>
                <Txt size="title" weight="700">
                  {online ? "You're online" : "You're offline"}
                </Txt>
                <Txt size="small" tone="muted">
                  {online
                    ? 'Bookings near you will come through.'
                    : 'Go online to start receiving bookings.'}
                </Txt>
              </Stack>
              <Switch
                value={online}
                onValueChange={toggleOnline}
                disabled={setOnline.isPending}
                trackColor={{ true: t.color.success, false: t.color.border }}
                thumbColor={t.color.surface}
              />
            </Row>
          </Card>

          {/* ------------------------------------------------ health warnings
              These matter more than they look. Each one is a way a driver
              can appear online while being undispatchable, which is the
              failure that makes them stop trusting the app. */}

          {online && ping.permission === 'denied' ? (
            <Card style={{ backgroundColor: t.color.dangerSoft, borderColor: 'transparent' }}>
              <Stack gap={2}>
                <Txt weight="700">Location is blocked</Txt>
                <Txt size="small">
                  Dispatch cannot see you, so you will get no bookings. Allow location to keep
                  working.
                </Txt>
                <Button
                  label="Allow location"
                  onPress={() => void ping.requestPermission()}
                />
              </Stack>
            </Card>
          ) : null}

          {online && ping.stale ? (
            <Card style={{ backgroundColor: t.color.dangerSoft, borderColor: 'transparent' }}>
              <Stack gap={1}>
                <Txt weight="700">Weak connection</Txt>
                <Txt size="small">
                  We have not been able to update your location. You may be invisible to
                  dispatch until your signal recovers.
                </Txt>
              </Stack>
            </Card>
          ) : null}

          {online && push.state === 'denied' ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Txt size="small">
                Notifications are off. You will only see bookings while this screen is open —
                turn them on so we can reach you when your phone is locked.
              </Txt>
            </Card>
          ) : null}

          {online && ping.permission === 'background-denied' ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Txt size="small">
                Background location is off. Keep this app open, or you may stop receiving
                bookings when your screen locks.
              </Txt>
            </Card>
          ) : null}

          {driver?.status !== 'approved' ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Stack gap={1}>
                <Txt weight="700">
                  {driver?.status === 'pending'
                    ? 'Waiting for approval'
                    : `Account ${driver?.status}`}
                </Txt>
                <Txt size="small">
                  {driver?.status === 'pending'
                    ? 'Dispatch is reviewing your documents. You can go online once approved.'
                    : 'Contact dispatch to sort this out.'}
                </Txt>
              </Stack>
            </Card>
          ) : null}

          {nearFloor ? (
            <Card style={{ backgroundColor: t.color.dangerSoft, borderColor: 'transparent' }}>
              <Stack gap={2}>
                <Txt weight="700">Top up soon</Txt>
                <Txt size="small">
                  You owe {formatPeso(Math.abs(walletOwed))} in commission. You will not be able
                  to go online once you pass your limit.
                </Txt>
                <Button label="See wallet" onPress={() => router.push('/wallet')} />
              </Stack>
            </Card>
          ) : null}

          {/* ------------------------------------------------ active job */}

          {activeJob ? (
            <Pressable onPress={() => router.push('/job')}>
              <Card style={{ borderColor: t.color.primary, borderWidth: 2 }}>
                <Stack gap={3}>
                  <Row justify="space-between">
                    <Badge label={JOB_TYPE_LABELS[activeJob.job_type]} tone="attention" />
                    <Txt size="small" tone="muted">
                      {activeJob.reference}
                    </Txt>
                  </Row>
                  <Txt size="title" weight="700">
                    {customerStatusLabel(activeJob.job_type, activeJob.status)}
                  </Txt>
                  <Txt size="small" tone="muted" numberOfLines={1}>
                    {activeJob.pickup_landmark || activeJob.pickup_label} →{' '}
                    {activeJob.dropoff_landmark || activeJob.dropoff_label}
                  </Txt>
                  <Button label="Open booking" size="lg" onPress={() => router.push('/job')} />
                </Stack>
              </Card>
            </Pressable>
          ) : null}

          {/* ------------------------------------------------ offers */}

          {!activeJob && (offers ?? []).length > 0 ? (
            <Stack gap={3}>
              <Txt size="title" weight="700">
                New bookings
              </Txt>

              {(offers ?? []).map((offer) => {
                const job = offer.job;
                const remaining = secondsLeft(offer.expires_at);

                return (
                  <Card
                    key={offer.id}
                    style={{ borderColor: t.color.primary, borderWidth: 2 }}
                  >
                    <Stack gap={4}>
                      <Row justify="space-between">
                        <Badge label={JOB_TYPE_LABELS[job.job_type]} tone="attention" />
                        <Txt size="small" weight="700" tone="primary">
                          {remaining}s
                        </Txt>
                      </Row>

                      <Row justify="space-between" align="flex-end">
                        <Stack gap={0.5}>
                          <Txt size="caption" tone="muted" weight="600">
                            YOU EARN
                          </Txt>
                          <Money centavos={job.quoted_fare_centavos} size="display" />
                        </Stack>
                        <Stack gap={0.5} style={{ alignItems: 'flex-end' }}>
                          <Txt size="caption" tone="muted" weight="600">
                            PICKUP
                          </Txt>
                          <Txt weight="600">{formatDistance(offer.distance_m)} away</Txt>
                        </Stack>
                      </Row>

                      <Divider />

                      <Stack gap={2}>
                        <Row gap={2} align="flex-start">
                          <Txt>{job.job_type === 'errand' ? '🏪' : '🟢'}</Txt>
                          <Stack gap={0.5} style={{ flex: 1 }}>
                            <Txt size="small" weight="600">
                              {job.pickup_label || 'Pinned location'}
                            </Txt>
                            {job.pickup_landmark ? (
                              <Txt size="small" tone="muted">
                                {job.pickup_landmark}
                              </Txt>
                            ) : null}
                          </Stack>
                        </Row>
                        <Row gap={2} align="flex-start">
                          <Txt>🔴</Txt>
                          <Stack gap={0.5} style={{ flex: 1 }}>
                            <Txt size="small" weight="600">
                              {job.dropoff_label || 'Pinned location'}
                            </Txt>
                            {job.dropoff_landmark ? (
                              <Txt size="small" tone="muted">
                                {job.dropoff_landmark}
                              </Txt>
                            ) : null}
                          </Stack>
                        </Row>
                        <Txt size="small" tone="muted">
                          {formatDistance(job.distance_meters)} trip · cash
                        </Txt>
                      </Stack>

                      {job.job_type === 'errand' ? (
                        <Card
                          style={{
                            backgroundColor: t.color.infoSoft,
                            borderColor: 'transparent',
                            padding: t.space(3),
                          }}
                        >
                          <Txt size="small">
                            You pay for the items first (up to{' '}
                            {formatPeso(job.items_budget_centavos)}), then the customer pays you
                            back plus the fee.
                          </Txt>
                        </Card>
                      ) : null}

                      <Stack gap={2}>
                        <Button
                          label="Accept"
                          size="lg"
                          loading={claim.isPending}
                          onPress={() => {
                            stopOfferAlert();
                            claim.mutate(job.id, {
                              onSuccess: () => {
                                successFeedback();
                                router.push('/job');
                              },
                              onError: (e) => {
                                errorFeedback();
                                Alert.alert('Could not accept', humanizeError(e));
                              },
                            });
                          }}
                        />
                        <Button
                          label="Pass"
                          variant="secondary"
                          onPress={() => {
                            stopOfferAlert();
                            decline.mutate(job.id);
                          }}
                        />
                      </Stack>
                    </Stack>
                  </Card>
                );
              })}
            </Stack>
          ) : null}

          {online && !activeJob && (offers ?? []).length === 0 ? (
            <Card>
              <Stack gap={2} style={{ alignItems: 'center', paddingVertical: t.space(6) }}>
                <Txt size="heading">🛵</Txt>
                <Txt weight="600">Waiting for bookings</Txt>
                <Txt size="small" tone="muted" align="center">
                  Keep this screen open. We will buzz you the moment something comes in near you.
                </Txt>
                {ping.lastPingAt ? (
                  <Txt size="caption" tone="muted">
                    Location updated{' '}
                    {Math.round((Date.now() - ping.lastPingAt.getTime()) / 1000)}s ago
                  </Txt>
                ) : null}
              </Stack>
            </Card>
          ) : null}

          {/* ------------------------------------------------ nav */}

          <Pressable onPress={() => router.push('/wallet')}>
            <Card>
              <Row justify="space-between">
                <Stack gap={0.5}>
                  <Txt weight="600">Earnings & wallet</Txt>
                  <Txt size="small" tone="muted">
                    {driver && driver.wallet_balance_centavos < 0
                      ? `${formatPeso(Math.abs(driver.wallet_balance_centavos))} commission owed`
                      : 'Up to date'}
                  </Txt>
                </Stack>
                <Txt tone="primary" weight="600">
                  →
                </Txt>
              </Row>
            </Card>
          </Pressable>

          <Row justify="center">
            <Txt size="caption" tone="muted">
              {driver?.completed_jobs ?? 0} completed ·{' '}
              {driver && driver.rating_count > 0
                ? `★ ${(driver.rating_sum / driver.rating_count).toFixed(1)}`
                : 'no rating yet'}
            </Txt>
          </Row>

          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
