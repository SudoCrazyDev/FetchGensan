/**
 * Receipt entry — the errand product's hinge.
 *
 * The driver has just paid for the customer's items out of their own
 * pocket. What they type here becomes the number the customer is asked to
 * approve, and the number the driver gets reimbursed. So the screen is
 * built around two things: a running total that is always visible, and an
 * explicit "not available" per line so a missing item does not get quietly
 * priced at zero.
 */

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi, useDriverActiveJob, useErrandItems, useSubmitReceipt } from '@fetch/api/react';
import { formatPeso, pesos } from '@fetch/core';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Field,
  Loading,
  Money,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import { errorFeedback, successFeedback } from '@/lib/alerts';
import { captureAndUpload } from '@/lib/photo';

interface LineState {
  price: string;
  available: boolean;
  substitute: string;
}

export default function ReceiptScreen() {
  const t = useTheme();
  const router = useRouter();
  const api = useApi();

  const { data: job, isLoading } = useDriverActiveJob();
  const { data: items } = useErrandItems(job?.job_type === 'errand' ? job.id : null);
  const submit = useSubmitReceipt();

  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function lineFor(id: string): LineState {
    return lines[id] ?? { price: '', available: true, substitute: '' };
  }

  function setLine(id: string, patch: Partial<LineState>) {
    setLines((prev) => ({ ...prev, [id]: { ...lineFor(id), ...patch } }));
  }

  const itemsTotal = useMemo(() => {
    return (items ?? []).reduce((sum, item) => {
      const line = lineFor(item.id);
      if (!line.available) return sum;
      return sum + pesos(Number(line.price) || 0);
    }, 0);
  }, [items, lines]);

  const overBudget = job ? itemsTotal > job.items_budget_centavos : false;

  // Every line marked out of stock. Sending that is how the customer finds
  // out -- and a zero-cost receipt is the one case either side may cancel.
  const nothingAvailable =
    (items ?? []).length > 0 && (items ?? []).every((item) => !lineFor(item.id).available);

  const missingPrices = (items ?? []).filter((item) => {
    const line = lineFor(item.id);
    return line.available && (line.price.trim() === '' || Number(line.price) <= 0);
  });

  if (isLoading) return <Loading />;

  if (!job || job.job_type !== 'errand') {
    return (
      <Screen>
        <EmptyState
          title="No errand in progress"
          body="This screen is only for errands."
          actionLabel="Back"
          onAction={() => router.dismissTo('/')}
        />
      </Screen>
    );
  }

  /**
   * Photograph the receipt. Optional, but strongly encouraged: it is the
   * only evidence in a dispute, and the storage policy only accepts a path
   * beginning with this job's id.
   */
  async function attachPhoto() {
    setUploading(true);
    try {
      const path = await captureAndUpload(
        api,
        'receipts',
        `${job!.id}/receipt-${Date.now()}.jpg`,
        'the receipt',
      );
      if (!path) return;
      setReceiptPath(path);
      successFeedback();
    } catch (e) {
      errorFeedback();
      Alert.alert('Upload failed', humanizeError(e));
    } finally {
      setUploading(false);
    }
  }

  function send() {
    if (missingPrices.length > 0) {
      Alert.alert(
        'Missing prices',
        'Enter a price for every item you bought, or mark it as not available.',
      );
      return;
    }

    submit.mutate(
      {
        jobId: job!.id,
        items: (items ?? []).map((item) => {
          const line = lineFor(item.id);
          return {
            id: item.id,
            actual_price_centavos: line.available ? pesos(Number(line.price) || 0) : 0,
            is_available: line.available,
            substitute_note: line.substitute.trim(),
          };
        }),
        receiptPath,
      },
      {
        onSuccess: () => {
          successFeedback();
          Alert.alert(
            'Sent to the customer',
            nothingAvailable
              ? 'They will choose whether to cancel or send you for something else.'
              : 'They will approve the total, then you can deliver.',
            // back(), not replace('/job'): the job screen is already underneath.
            [{ text: 'OK', onPress: () => router.back() }],
          );
        },
        onError: (e) => {
          errorFeedback();
          Alert.alert('Could not send', humanizeError(e));
        },
      },
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Stack gap={4}>
          <Stack gap={1}>
            <Txt size="heading" weight="700">
              What did it cost?
            </Txt>
            <Txt size="small" tone="muted">
              Enter what you actually paid. The customer approves this total before you deliver.
            </Txt>
          </Stack>

          {(items ?? []).map((item) => {
            const line = lineFor(item.id);

            return (
              <Card key={item.id}>
                <Stack gap={3}>
                  <Stack gap={0.5}>
                    <Txt weight="600">
                      {item.quantity} {item.unit} · {item.name}
                    </Txt>
                    {item.notes ? (
                      <Txt size="small" tone="muted">
                        {item.notes}
                      </Txt>
                    ) : null}
                  </Stack>

                  <Row justify="space-between">
                    <Txt size="small">Available?</Txt>
                    <Switch
                      value={line.available}
                      onValueChange={(v) => setLine(item.id, { available: v })}
                      trackColor={{ true: t.color.success, false: t.color.border }}
                      thumbColor={t.color.surface}
                    />
                  </Row>

                  {line.available ? (
                    <Stack gap={3}>
                      <Field
                        label="Price you paid (₱)"
                        value={line.price}
                        onChangeText={(v) => setLine(item.id, { price: v })}
                        keyboardType="decimal-pad"
                        placeholder="0"
                      />
                      <Field
                        label="Bought something different? (optional)"
                        value={line.substitute}
                        onChangeText={(v) => setLine(item.id, { substitute: v })}
                        placeholder="Different brand, larger size…"
                      />
                    </Stack>
                  ) : (
                    <Txt size="small" tone="muted">
                      Marked as not available. The customer will not be charged for it.
                    </Txt>
                  )}
                </Stack>
              </Card>
            );
          })}

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Photo of the receipt</Txt>
              <Txt size="small" tone="muted">
                Strongly recommended. It is your proof if the customer disputes the total.
              </Txt>
              {receiptPath ? (
                <Row justify="space-between">
                  <Txt size="small" tone="success" weight="600">
                    ✓ Photo attached
                  </Txt>
                  <Pressable onPress={() => setReceiptPath(null)} hitSlop={10}>
                    <Txt size="small" tone="danger">
                      Remove
                    </Txt>
                  </Pressable>
                </Row>
              ) : (
                <Button
                  label="Take a photo"
                  variant="secondary"
                  loading={uploading}
                  onPress={() => void attachPhoto()}
                />
              )}
            </Stack>
          </Card>

          {/* ---------------------------------------------- total */}

          <Card style={{ borderColor: t.color.primary, borderWidth: 2 }}>
            <Stack gap={3}>
              <Row justify="space-between">
                <Txt size="small" tone="muted">
                  Items
                </Txt>
                <Txt weight="600">{formatPeso(itemsTotal)}</Txt>
              </Row>
              <Row justify="space-between">
                <Txt size="small" tone="muted">
                  Errand fee
                </Txt>
                <Txt weight="600">{formatPeso(job.quoted_fare_centavos)}</Txt>
              </Row>
              <Divider />
              <Row justify="space-between">
                <Txt weight="700">Customer pays you</Txt>
                <Money centavos={itemsTotal + job.quoted_fare_centavos} size="title" />
              </Row>

              {overBudget ? (
                <Card
                  style={{
                    backgroundColor: t.color.dangerSoft,
                    borderColor: 'transparent',
                    padding: t.space(3),
                  }}
                >
                  <Txt size="small">
                    This is {formatPeso(itemsTotal - job.items_budget_centavos)} over the
                    customer's {formatPeso(job.items_budget_centavos)} budget. They can refuse
                    it, so call them before you send this.
                  </Txt>
                </Card>
              ) : null}
            </Stack>
          </Card>

          <Button
            label={
              nothingAvailable
                ? 'Tell the customer nothing was available'
                : 'Send to customer for approval'
            }
            size="lg"
            loading={submit.isPending}
            disabled={itemsTotal === 0 && !nothingAvailable}
            onPress={send}
          />

          <Spacer size={8} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
