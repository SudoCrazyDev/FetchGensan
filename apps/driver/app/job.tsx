import { useRouter } from 'expo-router';
import { Alert, Linking, Platform, Pressable, ScrollView, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import {
  useAdvanceJob,
  useCancelJob,
  useCompleteJob,
  useDriverActiveJob,
  useErrandItems,
  useJob,
} from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  customerStatusLabel,
  driverActionLabel,
  driverNextStatus,
  formatDistance,
  formatPeso,
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
  useTheme,
} from '@fetch/ui';

import { errorFeedback, successFeedback, tapFeedback } from '@/lib/alerts';

/**
 * Hands the leg off to the phone's own navigation app.
 *
 * Deliberately not an in-app turn-by-turn: drivers already have Google Maps
 * or Waze muscle-memory, their voice guidance works with a helmet, and
 * rebuilding that badly would be worse than not having it.
 */
function openNavigation(lat: number, lng: number, label: string) {
  const url = Platform.select({
    ios: `maps://app?daddr=${lat},${lng}&dirflg=d`,
    android: `google.navigation:q=${lat},${lng}&mode=d`,
    default: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
  });

  void Linking.openURL(url!).catch(() => {
    // Waze installed but not Maps, or a stripped ROM with neither.
    void Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    ).catch(() => Alert.alert('No maps app', `Head to ${label}`));
  });
}

export default function DriverJobScreen() {
  const t = useTheme();
  const router = useRouter();

  const { data: activeJob, isLoading } = useDriverActiveJob();
  const { data: job } = useJob(activeJob?.id);
  const current = job ?? activeJob;

  const { data: items } = useErrandItems(
    current?.job_type === 'errand' ? current.id : null,
  );

  const advance = useAdvanceJob();
  const complete = useCompleteJob();
  const cancel = useCancelJob();

  if (isLoading) return <Loading />;

  if (!current) {
    return (
      <Screen>
        <EmptyState
          title="No booking in progress"
          body="Head back and wait for the next one."
          actionLabel="Back"
          onAction={() => router.replace('/')}
        />
      </Screen>
    );
  }

  const isErrand = current.job_type === 'errand';

  // Before pickup the driver navigates to the pickup; after, to the drop-off.
  const beforePickup =
    current.status === 'assigned' ||
    current.status === 'arriving' ||
    current.status === 'arrived_pickup';

  const navTarget = beforePickup
    ? {
        lat: current.pickup_lat,
        lng: current.pickup_lng,
        label: current.pickup_label || 'pick-up',
      }
    : {
        lat: current.dropoff_lat,
        lng: current.dropoff_lng,
        label: current.dropoff_label || 'drop-off',
      };

  const nextStatus = driverNextStatus(current.job_type, current.status);
  const actionLabel = driverActionLabel(current.job_type, current.status);

  // `shopping -> awaiting_approval` happens by submitting a receipt, not by
  // a plain status change, so that button routes to the receipt screen.
  const actionGoesToReceipt = current.status === 'shopping';

  function runPrimaryAction() {
    tapFeedback();

    if (actionGoesToReceipt) {
      router.push('/receipt');
      return;
    }

    if (current!.status === 'in_progress') {
      complete.mutate(current!.id, {
        onSuccess: () => {
          successFeedback();
          Alert.alert(
            'Booking complete',
            current!.payment_method === 'cash'
              ? `Collect ${formatPeso(current!.final_total_centavos)} in cash.`
              : 'Payment already settled.',
            [{ text: 'Done', onPress: () => router.replace('/') }],
          );
        },
        onError: (e) => {
          errorFeedback();
          Alert.alert('Could not complete', humanizeError(e));
        },
      });
      return;
    }

    if (!nextStatus) return;

    advance.mutate(
      { jobId: current!.id, to: nextStatus },
      {
        onError: (e) => {
          errorFeedback();
          Alert.alert('Could not update', humanizeError(e));
        },
      },
    );
  }

  const busy = advance.isPending || complete.isPending;

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          <Row justify="space-between">
            <Badge label={JOB_TYPE_LABELS[current.job_type]} tone="attention" />
            <Txt size="small" tone="muted">
              {current.reference}
            </Txt>
          </Row>

          <Stack gap={1}>
            <Txt size="heading" weight="700">
              {customerStatusLabel(current.job_type, current.status)}
            </Txt>
            {current.status === 'awaiting_approval' ? (
              <Txt size="small" tone="muted">
                Waiting for the customer to approve the total. You cannot move on until they do.
              </Txt>
            ) : null}
          </Stack>

          {/* ---------------------------------------------- money up front
              A driver decides what to do next based on what they will be
              paid and what they must hand over. That goes at the top. */}

          <Card>
            <Stack gap={3}>
              <Row justify="space-between">
                <Txt weight="600">
                  {current.payment_method === 'cash' ? 'Collect in cash' : 'Already paid'}
                </Txt>
                <Money
                  centavos={
                    isErrand && current.items_cost_centavos === 0
                      ? current.quoted_fare_centavos
                      : current.final_total_centavos
                  }
                  size="heading"
                />
              </Row>

              {isErrand ? (
                <>
                  <Divider />
                  <Row justify="space-between">
                    <Txt size="small" tone="muted">
                      Customer's item budget
                    </Txt>
                    <Txt size="small" weight="600">
                      {formatPeso(current.items_budget_centavos)}
                    </Txt>
                  </Row>
                  {current.items_cost_centavos > 0 ? (
                    <Row justify="space-between">
                      <Txt size="small" tone="muted">
                        Receipt total
                      </Txt>
                      <Txt size="small" weight="600">
                        {formatPeso(current.items_cost_centavos)}
                      </Txt>
                    </Row>
                  ) : null}
                  <Txt size="caption" tone="muted">
                    You pay for the items, then collect the full total from the customer. Our
                    commission is charged on the service fee only, never on the goods.
                  </Txt>
                </>
              ) : null}
            </Stack>
          </Card>

          {/* ---------------------------------------------- navigation */}

          <Card>
            <Stack gap={3}>
              <Row justify="space-between">
                <Txt size="caption" tone="muted" weight="600">
                  {beforePickup
                    ? isErrand
                      ? 'GO TO STORE'
                      : 'GO TO PICK-UP'
                    : isErrand
                      ? 'DELIVER TO'
                      : 'GO TO DROP-OFF'}
                </Txt>
                <Txt size="caption" tone="muted">
                  {formatDistance(current.distance_meters)} total
                </Txt>
              </Row>

              <Stack gap={1}>
                <Txt size="title" weight="700">
                  {navTarget.label}
                </Txt>
                {(beforePickup ? current.pickup_landmark : current.dropoff_landmark) ? (
                  <Txt tone="primary" weight="600">
                    {beforePickup ? current.pickup_landmark : current.dropoff_landmark}
                  </Txt>
                ) : (
                  <Txt size="small" tone="muted">
                    No landmark given — call the customer if you cannot find it.
                  </Txt>
                )}
              </Stack>

              <Button
                label="Open in Maps"
                variant="secondary"
                size="lg"
                onPress={() => openNavigation(navTarget.lat, navTarget.lng, navTarget.label)}
              />
            </Stack>
          </Card>

          {/* ---------------------------------------------- shopping list */}

          {isErrand && items && items.length > 0 ? (
            <Card>
              <Stack gap={3}>
                <Txt weight="600">Shopping list</Txt>
                {items.map((item) => (
                  <Stack key={item.id} gap={0.5}>
                    <Txt size="small" weight="600">
                      {item.quantity} {item.unit} · {item.name}
                    </Txt>
                    {item.notes ? (
                      <Txt size="small" tone="muted">
                        {item.notes}
                      </Txt>
                    ) : null}
                  </Stack>
                ))}
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- customer note */}

          {current.notes ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Stack gap={1}>
                <Txt size="caption" weight="600">
                  FROM THE CUSTOMER
                </Txt>
                <Txt size="small">{current.notes}</Txt>
              </Stack>
            </Card>
          ) : null}

          {current.recipient_name ? (
            <Card>
              <Stack gap={2}>
                <Txt size="caption" tone="muted" weight="600">
                  RECIPIENT
                </Txt>
                <Txt weight="600">{current.recipient_name}</Txt>
                <Button
                  label="Call recipient"
                  variant="secondary"
                  onPress={() => void Linking.openURL(`tel:${current.recipient_phone}`)}
                />
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- primary action */}

          {actionLabel ? (
            <Button
              label={actionLabel}
              size="lg"
              loading={busy}
              onPress={runPrimaryAction}
            />
          ) : (
            <Card>
              <Txt size="small" tone="muted" align="center">
                Nothing to do right now — waiting on the customer.
              </Txt>
            </Card>
          )}

          <Button
            label="I have a problem with this booking"
            variant="danger"
            onPress={() =>
              Alert.alert('Report a problem', 'What do you need?', [
                { text: 'Never mind', style: 'cancel' },
                {
                  text: 'Call dispatch',
                  onPress: () => void Linking.openURL('tel:+639170000004'),
                },
                {
                  text: 'Cancel booking',
                  style: 'destructive',
                  onPress: () =>
                    cancel.mutate(
                      { jobId: current.id, reason: 'Cancelled by driver' },
                      {
                        onSuccess: () => router.replace('/'),
                        onError: (e) => Alert.alert('Could not cancel', humanizeError(e)),
                      },
                    ),
                },
              ])
            }
          />

          <Spacer size={8} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
