import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import {
  useApproveErrandTotal,
  useAssignedDriver,
  useCancelJob,
  useDriverPosition,
  useErrandItems,
  useJob,
  useRateJob,
} from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  customerStatusLabel,
  formatPeso,
  isLive,
  isTerminal,
} from '@fetch/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Loading,
  Money,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  statusTone,
  useTheme,
} from '@fetch/ui';

import { TrackMap } from '@/components/TrackMap';

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();

  const { data: job, isLoading } = useJob(id);
  const { data: driver } = useAssignedDriver(job?.driver_id);
  const { data: items } = useErrandItems(job?.job_type === 'errand' ? id : null);
  const { data: position } = useDriverPosition(id, !!job && isLive(job.status));

  const approve = useApproveErrandTotal();
  const cancel = useCancelJob();
  const rate = useRateJob();

  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);

  if (isLoading) return <Loading label="Loading your booking" />;

  if (!job) {
    return (
      <Screen>
        <EmptyState
          title="Booking not found"
          body="It may have been removed."
          actionLabel="Back home"
          onAction={() => router.replace('/')}
        />
      </Screen>
    );
  }

  const live = isLive(job.status);
  const needsApproval = job.status === 'awaiting_approval';
  const isErrand = job.job_type === 'errand';

  const availableItems = (items ?? []).filter((i) => i.is_available !== false);
  const unavailableItems = (items ?? []).filter((i) => i.is_available === false);

  function confirmCancel() {
    Alert.alert(
      'Cancel this booking?',
      job?.driver_id
        ? 'Your rider is already on the way. Cancelling now may affect your account.'
        : 'We will stop looking for a rider.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel booking',
          style: 'destructive',
          onPress: () => {
            cancel.mutate(
              { jobId: job!.id, reason: 'Cancelled by customer' },
              { onError: (e) => Alert.alert('Could not cancel', humanizeError(e)) },
            );
          },
        },
      ],
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          {/* ------------------------------------------------ status */}

          <Stack gap={2}>
            <Row justify="space-between">
              <Badge label={JOB_TYPE_LABELS[job.job_type]} tone="neutral" />
              <Badge label={job.status.replace(/_/g, ' ')} tone={statusTone(job.status)} />
            </Row>
            <Txt size="heading" weight="700">
              {customerStatusLabel(job.job_type, job.status)}
            </Txt>
            <Txt size="small" tone="muted">
              {job.reference}
            </Txt>
          </Stack>

          {job.status === 'searching' ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Stack gap={1}>
                <Txt size="small" weight="600">
                  Contacting riders near you
                </Txt>
                <Txt size="small" tone="muted">
                  We widen the search every few seconds. This usually takes under a minute.
                </Txt>
              </Stack>
            </Card>
          ) : null}

          {job.status === 'expired' ? (
            <Card style={{ backgroundColor: t.color.dangerSoft, borderColor: 'transparent' }}>
              <Stack gap={2}>
                <Txt size="small" weight="600">
                  We could not find a rider
                </Txt>
                <Txt size="small" tone="muted">
                  Nobody was free nearby. Please try again in a few minutes.
                </Txt>
                <Button label="Book again" onPress={() => router.replace('/')} />
              </Stack>
            </Card>
          ) : null}

          {/* ------------------------------------------------ errand approval
              The single most important interaction in the errand product:
              the customer agreed to a fee, and is now being shown the real
              receipt. Nothing else on this screen competes with it. */}

          {needsApproval ? (
            <Card style={{ borderColor: t.color.primary, borderWidth: 2 }}>
              <Stack gap={4}>
                <Stack gap={1}>
                  <Txt size="title" weight="700">
                    Review your total
                  </Txt>
                  <Txt size="small" tone="muted">
                    Your rider has bought your items. Approve the total and they will head over.
                  </Txt>
                </Stack>

                <Stack gap={2}>
                  {availableItems.map((item) => (
                    <Row key={item.id} justify="space-between" align="flex-start">
                      <Stack gap={0.5} style={{ flex: 1 }}>
                        <Txt size="small">
                          {item.quantity} {item.unit} · {item.name}
                        </Txt>
                        {item.substitute_note ? (
                          <Txt size="caption" tone="muted">
                            Substituted: {item.substitute_note}
                          </Txt>
                        ) : null}
                      </Stack>
                      <Txt size="small" weight="600">
                        {formatPeso(item.actual_price_centavos ?? 0)}
                      </Txt>
                    </Row>
                  ))}

                  {unavailableItems.length > 0 ? (
                    <Stack gap={1}>
                      <Divider />
                      <Txt size="caption" tone="muted" weight="600">
                        NOT AVAILABLE
                      </Txt>
                      {unavailableItems.map((item) => (
                        <Txt key={item.id} size="small" tone="muted">
                          {item.name}
                        </Txt>
                      ))}
                    </Stack>
                  ) : null}
                </Stack>

                <Divider />

                <Stack gap={1.5}>
                  <Row justify="space-between">
                    <Txt size="small" tone="muted">
                      Items
                    </Txt>
                    <Txt size="small">{formatPeso(job.items_cost_centavos)}</Txt>
                  </Row>
                  <Row justify="space-between">
                    <Txt size="small" tone="muted">
                      Errand service
                    </Txt>
                    <Txt size="small">{formatPeso(job.quoted_fare_centavos)}</Txt>
                  </Row>
                  <Row justify="space-between">
                    <Txt weight="700">Pay your rider in cash</Txt>
                    <Money centavos={job.final_total_centavos} size="title" />
                  </Row>
                </Stack>

                {job.items_budget_centavos > 0 &&
                job.items_cost_centavos > job.items_budget_centavos ? (
                  <Txt size="small" tone="danger">
                    This is {formatPeso(job.items_cost_centavos - job.items_budget_centavos)} over
                    the budget you set. Approve only if you are happy with it.
                  </Txt>
                ) : null}

                <Button
                  label={`Approve ${formatPeso(job.final_total_centavos)}`}
                  size="lg"
                  loading={approve.isPending}
                  onPress={() =>
                    approve.mutate(job.id, {
                      onError: (e) => Alert.alert('Could not approve', humanizeError(e)),
                    })
                  }
                />
                <Button
                  label="Something is wrong — call dispatch"
                  variant="ghost"
                  onPress={() => void Linking.openURL('tel:+639170000004')}
                />
              </Stack>
            </Card>
          ) : null}

          {/* ------------------------------------------------ map */}

          {live && job.status !== 'searching' ? (
            <TrackMap
              driver={position ? { latitude: position.lat, longitude: position.lng } : null}
              pickup={{ latitude: job.pickup_lat, longitude: job.pickup_lng }}
              dropoff={{ latitude: job.dropoff_lat, longitude: job.dropoff_lng }}
            />
          ) : null}

          {/* ------------------------------------------------ driver */}

          {driver ? (
            <Card>
              <Stack gap={3}>
                <Row gap={3}>
                  <View
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 26,
                      backgroundColor: t.color.background,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Txt size="title">{driver.full_name?.[0]?.toUpperCase() ?? '🛵'}</Txt>
                  </View>
                  <Stack gap={0.5} style={{ flex: 1 }}>
                    <Txt weight="700">{driver.full_name}</Txt>
                    <Txt size="small" tone="muted">
                      {driver.vehicle_color} {driver.vehicle_make} {driver.vehicle_model}
                    </Txt>
                    <Txt size="small" weight="600">
                      {driver.plate_number}
                    </Txt>
                  </Stack>
                  <Stack gap={0.5} style={{ alignItems: 'flex-end' }}>
                    <Txt weight="600">
                      {driver.rating !== null ? `★ ${driver.rating.toFixed(1)}` : 'New'}
                    </Txt>
                    <Txt size="caption" tone="muted">
                      {driver.completed_jobs} trips
                    </Txt>
                  </Stack>
                </Row>
              </Stack>
            </Card>
          ) : null}

          {/* ------------------------------------------------ route */}

          <Card>
            <Stack gap={3}>
              <Row gap={3} align="flex-start">
                <Txt>{isErrand ? '🏪' : '🟢'}</Txt>
                <Stack gap={0.5} style={{ flex: 1 }}>
                  <Txt size="caption" tone="muted" weight="600">
                    {isErrand ? 'STORE' : 'PICK-UP'}
                  </Txt>
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

              <Divider />

              <Row gap={3} align="flex-start">
                <Txt>🔴</Txt>
                <Stack gap={0.5} style={{ flex: 1 }}>
                  <Txt size="caption" tone="muted" weight="600">
                    {isErrand ? 'DELIVER TO' : 'DROP-OFF'}
                  </Txt>
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

              {job.notes ? (
                <>
                  <Divider />
                  <Stack gap={0.5}>
                    <Txt size="caption" tone="muted" weight="600">
                      YOUR NOTE
                    </Txt>
                    <Txt size="small">{job.notes}</Txt>
                  </Stack>
                </>
              ) : null}
            </Stack>
          </Card>

          {/* ------------------------------------------------ fare */}

          <Card>
            <Stack gap={2}>
              <Row justify="space-between">
                <Txt weight="600">
                  {job.status === 'completed' ? 'You paid' : 'To pay in cash'}
                </Txt>
                <Money
                  centavos={
                    job.status === 'completed'
                      ? job.final_total_centavos
                      : isErrand && job.items_cost_centavos === 0
                        ? job.quoted_fare_centavos
                        : job.final_total_centavos
                  }
                  size="title"
                />
              </Row>
              {isErrand && job.items_cost_centavos === 0 ? (
                <Txt size="small" tone="muted">
                  Service fee only. Your items are added once your rider sends the receipt.
                </Txt>
              ) : null}
            </Stack>
          </Card>

          {/* ------------------------------------------------ rating */}

          {job.status === 'completed' && !rated ? (
            <Card>
              <Stack gap={3}>
                <Txt weight="600">How was your {JOB_TYPE_LABELS[job.job_type].toLowerCase()}?</Txt>
                <Row gap={2} justify="center">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Pressable key={n} onPress={() => setStars(n)} hitSlop={8}>
                      <Txt size="heading">{n <= stars ? '★' : '☆'}</Txt>
                    </Pressable>
                  ))}
                </Row>
                <Button
                  label="Submit rating"
                  disabled={stars === 0}
                  loading={rate.isPending}
                  onPress={() =>
                    rate.mutate(
                      { jobId: job.id, stars },
                      {
                        onSuccess: () => setRated(true),
                        onError: (e) => Alert.alert('Could not rate', humanizeError(e)),
                      },
                    )
                  }
                />
              </Stack>
            </Card>
          ) : null}

          {rated ? (
            <Card style={{ backgroundColor: t.color.successSoft, borderColor: 'transparent' }}>
              <Txt size="small" align="center">
                Thanks for the feedback.
              </Txt>
            </Card>
          ) : null}

          {/* ------------------------------------------------ actions */}

          {live && !needsApproval ? (
            <Button
              label="Cancel booking"
              variant="danger"
              loading={cancel.isPending}
              onPress={confirmCancel}
            />
          ) : null}

          {isTerminal(job.status) ? (
            <Button label="Back home" variant="secondary" onPress={() => router.replace('/')} />
          ) : null}

          <Spacer size={8} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
