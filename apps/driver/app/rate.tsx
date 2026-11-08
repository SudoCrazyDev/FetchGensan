/**
 * The rider rates the customer, straight after completing.
 *
 * rate_job() has always supported both directions; nothing in the driver
 * app called it. A dispatcher deciding whether to block a repeat no-show
 * needs the riders' side of the story, and this is where it comes from.
 * Skippable -- the next booking matters more than the paperwork.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useJob, useMyRating, useRateJob } from '@fetch/api/react';
import { formatPeso } from '@fetch/core';
import { Button, Card, Field, Loading, Row, Screen, Spacer, Stack, Txt } from '@fetch/ui';

import { successFeedback } from '@/lib/alerts';

export default function RateCustomer() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const router = useRouter();
  const { data: job, isLoading } = useJob(jobId);
  const { data: existing } = useMyRating(jobId);
  const rate = useRateJob();

  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');

  if (isLoading) return <Loading />;

  const done = () => router.dismissTo('/');

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Stack gap={4}>
          <Stack gap={1}>
            <Txt size="heading" weight="700">
              Booking complete
            </Txt>
            {job ? (
              <Txt tone="muted">
                {job.reference} ·{' '}
                {job.payment_method === 'cash'
                  ? `collect ${formatPeso(job.final_total_centavos)} in cash`
                  : 'already paid'}
              </Txt>
            ) : null}
          </Stack>

          {existing ? (
            <Card>
              <Txt align="center">You rated this customer {'★'.repeat(existing.stars)}.</Txt>
            </Card>
          ) : (
            <Card>
              <Stack gap={3}>
                <Txt weight="600">How was the customer?</Txt>
                <Row gap={3} justify="center">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Pressable
                      key={n}
                      onPress={() => setStars(n)}
                      hitSlop={10}
                      accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`}
                    >
                      <Txt size="display">{n <= stars ? '★' : '☆'}</Txt>
                    </Pressable>
                  ))}
                </Row>
                {stars > 0 && stars <= 3 ? (
                  <Field
                    value={comment}
                    onChangeText={setComment}
                    placeholder="What happened? Late, not at the pin, rude…"
                    multiline
                  />
                ) : null}
                <Button
                  label="Submit"
                  size="lg"
                  disabled={stars === 0 || !jobId}
                  loading={rate.isPending}
                  onPress={() =>
                    rate.mutate(
                      { jobId: jobId!, stars, comment: comment.trim() },
                      {
                        onSuccess: () => {
                          successFeedback();
                          done();
                        },
                        onError: (e) => Alert.alert('Could not rate', humanizeError(e)),
                      },
                    )
                  }
                />
              </Stack>
            </Card>
          )}

          <Button label={existing ? 'Back to work' : 'Skip'} variant="ghost" onPress={done} />
          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
