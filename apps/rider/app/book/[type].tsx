import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useCreateJob, useFareConfigs, useFareQuote } from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  type JobType,
  estimateRoadMeters,
  estimateSeconds,
  fareConfigFromRow,
  formatDistance,
  formatDuration,
  formatPeso,
  isValidPhPhone,
  normalizePhPhone,
  pesos,
  quoteFare,
} from '@fetch/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Money,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import { PlacePicker, type PickedPlace } from '@/components/PlacePicker';
import { useCurrentLocation } from '@/lib/useCurrentLocation';

interface DraftItem {
  key: string;
  name: string;
  quantity: string;
  unit: string;
  notes: string;
}

function newItem(): DraftItem {
  return {
    key: Math.random().toString(36).slice(2),
    name: '',
    quantity: '1',
    unit: 'pc',
    notes: '',
  };
}

export default function BookScreen() {
  const params = useLocalSearchParams<{ type: string }>();
  const router = useRouter();
  const t = useTheme();

  const jobType: JobType =
    params.type === 'errand' || params.type === 'delivery' ? params.type : 'ride';
  const isErrand = jobType === 'errand';
  const isDelivery = jobType === 'delivery';

  const { startingPoint, isRealFix, permission, retry } = useCurrentLocation();
  const { data: fareConfigs } = useFareConfigs();
  const createJob = useCreateJob();

  const [pickup, setPickup] = useState<PickedPlace | null>(null);
  const [dropoff, setDropoff] = useState<PickedPlace | null>(null);
  const [picking, setPicking] = useState<'pickup' | 'dropoff' | null>(null);

  const [notes, setNotes] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [budget, setBudget] = useState('');
  const [items, setItems] = useState<DraftItem[]>([newItem()]);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Local fare estimate, recomputed as soon as both points exist. The
   * server recomputes this in create_job() and its number is the one that
   * counts -- this is here so the customer sees a price before they commit,
   * not after.
   */
  const estimate = useMemo(() => {
    if (!pickup || !dropoff || !fareConfigs) return null;

    const row = fareConfigs.find((c) => c.job_type === jobType);
    if (!row) return null;

    const meters = estimateRoadMeters(pickup.location, dropoff.location);
    const seconds = estimateSeconds(meters);
    const fare = quoteFare(fareConfigFromRow(row), meters, seconds);

    return { meters, seconds, fare };
  }, [pickup, dropoff, fareConfigs, jobType]);

  /**
   * The server's own quote for the same distance. create_job() recomputes
   * with exactly this function, so once this arrives the number on the Book
   * button is the number that will be charged -- the local estimate above
   * only covers the moment before it does.
   */
  const { data: serverQuote } = useFareQuote(
    jobType,
    estimate?.meters ?? null,
    estimate?.seconds ?? 0,
  );
  const fareTotal = serverQuote?.total_centavos ?? estimate?.fare.totalCentavos ?? null;

  const filledItems = items.filter((i) => i.name.trim().length > 0);

  const problems = useMemo(() => {
    const list: string[] = [];
    if (!pickup) list.push(isErrand ? 'Choose the store' : 'Choose your pick-up point');
    if (!dropoff) list.push(isErrand ? 'Choose where to deliver' : 'Choose your drop-off');
    if (isErrand && filledItems.length === 0) list.push('Add at least one item to buy');
    if (isDelivery && recipientName.trim().length === 0) list.push("Add the recipient's name");
    if (isDelivery && !isValidPhPhone(recipientPhone))
      list.push("Add a valid recipient mobile number");
    return list;
  }, [pickup, dropoff, isErrand, isDelivery, filledItems.length, recipientName, recipientPhone]);

  async function submit() {
    if (problems.length > 0 || !pickup || !dropoff) return;

    setSubmitting(true);
    try {
      const job = await createJob.mutateAsync({
        jobType,
        pickup: pickup.location,
        dropoff: dropoff.location,
        pickupLabel: pickup.label,
        pickupLandmark: pickup.landmark,
        dropoffLabel: dropoff.label,
        dropoffLandmark: dropoff.landmark,
        notes: notes.trim(),
        recipientName: isDelivery ? recipientName.trim() : '',
        recipientPhone: isDelivery ? (normalizePhPhone(recipientPhone) ?? '') : '',
        distanceMeters: estimate?.meters,
        durationSeconds: estimate?.seconds,
        items: isErrand
          ? filledItems.map((i) => ({
              name: i.name.trim(),
              quantity: Number(i.quantity) || 1,
              unit: i.unit.trim() || 'pc',
              notes: i.notes.trim(),
            }))
          : [],
        itemsBudgetCentavos: isErrand ? pesos(Number(budget) || 0) : 0,
        paymentMethod: 'cash',
      });

      router.replace(`/job/${job.id}`);
    } catch (e) {
      Alert.alert('Could not book', humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Stack gap={4}>
          <Row justify="space-between">
            <Txt size="heading" weight="700">
              {JOB_TYPE_LABELS[jobType]}
            </Txt>
            <Badge label="Cash" tone="neutral" />
          </Row>

          {permission === 'denied' && !isRealFix ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Stack gap={2}>
                <Txt size="small">
                  Location is off, so the map starts at the city centre. You can still pick your
                  spot by hand.
                </Txt>
                <Button label="Turn on location" variant="ghost" onPress={() => void retry()} />
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- where */}

          <Card>
            <Stack gap={0}>
              <Pressable onPress={() => setPicking('pickup')} style={{ paddingVertical: t.space(3) }}>
                <Row gap={3}>
                  <Txt size="title">{isErrand ? '🏪' : '🟢'}</Txt>
                  <Stack gap={0.5} style={{ flex: 1 }}>
                    <Txt size="small" tone="muted" weight="600">
                      {isErrand ? 'STORE' : 'PICK-UP'}
                    </Txt>
                    <Txt weight="600" numberOfLines={1}>
                      {pickup?.label || (isErrand ? 'Which store?' : 'Where are you?')}
                    </Txt>
                    {pickup?.landmark ? (
                      <Txt size="small" tone="muted" numberOfLines={1}>
                        {pickup.landmark}
                      </Txt>
                    ) : null}
                  </Stack>
                  <Txt tone="muted">›</Txt>
                </Row>
              </Pressable>

              <Divider />

              <Pressable
                onPress={() => setPicking('dropoff')}
                style={{ paddingVertical: t.space(3) }}
              >
                <Row gap={3}>
                  <Txt size="title">🔴</Txt>
                  <Stack gap={0.5} style={{ flex: 1 }}>
                    <Txt size="small" tone="muted" weight="600">
                      {isErrand ? 'DELIVER TO' : 'DROP-OFF'}
                    </Txt>
                    <Txt weight="600" numberOfLines={1}>
                      {dropoff?.label || 'Where to?'}
                    </Txt>
                    {dropoff?.landmark ? (
                      <Txt size="small" tone="muted" numberOfLines={1}>
                        {dropoff.landmark}
                      </Txt>
                    ) : null}
                  </Stack>
                  <Txt tone="muted">›</Txt>
                </Row>
              </Pressable>
            </Stack>
          </Card>

          {/* ---------------------------------------------- errand list */}

          {isErrand ? (
            <Card>
              <Stack gap={4}>
                <Txt weight="600">What should we buy?</Txt>

                {items.map((item, index) => (
                  <Stack key={item.key} gap={2}>
                    <Row justify="space-between">
                      <Txt size="small" tone="muted" weight="600">
                        ITEM {index + 1}
                      </Txt>
                      {items.length > 1 ? (
                        <Pressable
                          onPress={() => setItems(items.filter((i) => i.key !== item.key))}
                          hitSlop={10}
                        >
                          <Txt size="small" tone="danger">
                            Remove
                          </Txt>
                        </Pressable>
                      ) : null}
                    </Row>
                    <Field
                      value={item.name}
                      placeholder="e.g. Lechon manok"
                      onChangeText={(v) =>
                        setItems(items.map((i) => (i.key === item.key ? { ...i, name: v } : i)))
                      }
                    />
                    <Row gap={2}>
                      <View style={{ flex: 1 }}>
                        <Field
                          value={item.quantity}
                          placeholder="1"
                          keyboardType="decimal-pad"
                          onChangeText={(v) =>
                            setItems(
                              items.map((i) => (i.key === item.key ? { ...i, quantity: v } : i)),
                            )
                          }
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Field
                          value={item.unit}
                          placeholder="pc / kg / pack"
                          onChangeText={(v) =>
                            setItems(items.map((i) => (i.key === item.key ? { ...i, unit: v } : i)))
                          }
                        />
                      </View>
                    </Row>
                    <Field
                      value={item.notes}
                      placeholder="Brand, size, or 'any is fine'"
                      onChangeText={(v) =>
                        setItems(items.map((i) => (i.key === item.key ? { ...i, notes: v } : i)))
                      }
                    />
                  </Stack>
                ))}

                <Button
                  label="Add another item"
                  variant="secondary"
                  onPress={() => setItems([...items, newItem()])}
                />

                <Divider />

                <Field
                  label="Your budget for the items (₱)"
                  value={budget}
                  onChangeText={setBudget}
                  keyboardType="number-pad"
                  placeholder="500"
                  hint="Your rider stops and asks if the receipt would go over this. You approve the real total before delivery."
                />
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- recipient */}

          {isDelivery ? (
            <Card>
              <Stack gap={3}>
                <Txt weight="600">Who is receiving it?</Txt>
                <Field
                  label="Name"
                  value={recipientName}
                  onChangeText={setRecipientName}
                  placeholder="Juan Dela Cruz"
                />
                <Field
                  label="Mobile number"
                  value={recipientPhone}
                  onChangeText={setRecipientPhone}
                  keyboardType="phone-pad"
                  placeholder="0917 123 4567"
                  hint="Your rider rings this on arrival."
                />
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- notes */}

          <Card>
            <Field
              label="Anything else your rider should know?"
              value={notes}
              onChangeText={setNotes}
              placeholder={
                isErrand
                  ? 'Ask for extra sauce. Call me when you get there.'
                  : 'I have one small bag. Please wait at the gate.'
              }
              multiline
              numberOfLines={3}
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
          </Card>

          {/* ---------------------------------------------- fare */}

          {estimate ? (
            <Card>
              <Stack gap={3}>
                <Row justify="space-between">
                  <Txt weight="600">{serverQuote ? 'Fare' : 'Estimated fare'}</Txt>
                  <Money centavos={fareTotal ?? estimate.fare.totalCentavos} size="title" />
                </Row>

                <Row justify="space-between">
                  <Txt size="small" tone="muted">
                    {formatDistance(estimate.meters)} · about{' '}
                    {formatDuration(estimate.seconds)}
                  </Txt>
                </Row>

                <Divider />

                <Stack gap={1.5}>
                  <Row justify="space-between">
                    <Txt size="small" tone="muted">
                      Base fare
                    </Txt>
                    <Txt size="small">{formatPeso(estimate.fare.baseFareCentavos)}</Txt>
                  </Row>
                  {estimate.fare.distanceFareCentavos > 0 ? (
                    <Row justify="space-between">
                      <Txt size="small" tone="muted">
                        Distance
                      </Txt>
                      <Txt size="small">{formatPeso(estimate.fare.distanceFareCentavos)}</Txt>
                    </Row>
                  ) : null}
                  {estimate.fare.serviceFeeCentavos > 0 ? (
                    <Row justify="space-between">
                      <Txt size="small" tone="muted">
                        Service fee
                      </Txt>
                      <Txt size="small">{formatPeso(estimate.fare.serviceFeeCentavos)}</Txt>
                    </Row>
                  ) : null}
                  {estimate.fare.nightSurchargeCentavos > 0 ? (
                    <Row justify="space-between">
                      <Txt size="small" tone="muted">
                        Late-night surcharge
                      </Txt>
                      <Txt size="small">{formatPeso(estimate.fare.nightSurchargeCentavos)}</Txt>
                    </Row>
                  ) : null}
                  {estimate.fare.minimumApplied ? (
                    <Txt size="caption" tone="muted">
                      Minimum fare applied.
                    </Txt>
                  ) : null}
                </Stack>

                {isErrand ? (
                  <>
                    <Divider />
                    <Txt size="small" tone="muted">
                      This is the service fee only. The cost of your items is added on top once
                      your rider sends the receipt, and you approve the total before delivery.
                    </Txt>
                  </>
                ) : null}

                <Txt size="caption" tone="muted">
                  {serverQuote
                    ? 'Confirmed price. Pay your rider in cash.'
                    : 'Checking the price… Pay your rider in cash.'}
                </Txt>
              </Stack>
            </Card>
          ) : (
            <Card>
              <Txt tone="muted" size="small">
                Pick both points to see your fare.
              </Txt>
            </Card>
          )}

          {problems.length > 0 ? (
            <Stack gap={1}>
              {problems.map((p) => (
                <Txt key={p} size="small" tone="muted">
                  • {p}
                </Txt>
              ))}
            </Stack>
          ) : null}

          <Button
            label={fareTotal !== null ? `Book for ${formatPeso(fareTotal)}` : 'Book now'}
            size="lg"
            loading={submitting}
            disabled={problems.length > 0}
            onPress={() => void submit()}
          />

          <Spacer size={8} />
        </Stack>
      </ScrollView>

      <PlacePicker
        // Remount per field: the picker keeps its own pin and text, and
        // without this the drop-off opened pre-filled with the pick-up,
        // one tap from booking a ride to where you already are.
        key={picking ?? 'closed'}
        visible={picking !== null}
        title={
          picking === 'pickup'
            ? isErrand
              ? 'Which store?'
              : 'Where should we pick you up?'
            : isErrand
              ? 'Where should we deliver?'
              : 'Where are you going?'
        }
        near={picking === 'dropoff' ? (pickup?.location ?? startingPoint) : startingPoint}
        initial={picking === 'pickup' ? pickup : dropoff}
        startAtNear={picking === 'pickup' && isRealFix}
        onCancel={() => setPicking(null)}
        onPick={(place) => {
          if (picking === 'pickup') setPickup(place);
          else setDropoff(place);
          setPicking(null);
        }}
      />
    </Screen>
  );
}
