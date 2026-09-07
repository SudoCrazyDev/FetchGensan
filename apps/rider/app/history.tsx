import { useRouter } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';

import { useJobHistory } from '@fetch/api/react';
import { JOB_TYPE_LABELS, formatDistance, formatPeso } from '@fetch/core';
import {
  Badge,
  Card,
  EmptyState,
  Loading,
  Row,
  Screen,
  Stack,
  Txt,
  statusTone,
  useTheme,
} from '@fetch/ui';

const DATE = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export default function History() {
  const { data: jobs, isLoading } = useJobHistory();
  const router = useRouter();
  const t = useTheme();

  if (isLoading) return <Loading />;

  if (!jobs || jobs.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="No bookings yet"
          body="Your rides, errands and deliveries will show up here."
          actionLabel="Book something"
          onAction={() => router.replace('/')}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <FlatList
        data={jobs}
        keyExtractor={(job) => job.id}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ height: t.space(3) }} />}
        renderItem={({ item: job }) => (
          <Pressable onPress={() => router.push(`/job/${job.id}`)}>
            <Card>
              <Stack gap={2}>
                <Row justify="space-between">
                  <Badge label={JOB_TYPE_LABELS[job.job_type]} tone="neutral" />
                  <Badge label={job.status} tone={statusTone(job.status)} />
                </Row>

                <Stack gap={0.5}>
                  <Txt weight="600" numberOfLines={1}>
                    {job.dropoff_landmark || job.dropoff_label || 'Drop-off'}
                  </Txt>
                  <Txt size="small" tone="muted" numberOfLines={1}>
                    from {job.pickup_landmark || job.pickup_label || 'pick-up'}
                  </Txt>
                </Stack>

                <Row justify="space-between">
                  <Txt size="small" tone="muted">
                    {DATE.format(new Date(job.created_at))} ·{' '}
                    {formatDistance(job.distance_meters)}
                  </Txt>
                  <Txt weight="600">
                    {job.status === 'completed'
                      ? formatPeso(job.final_total_centavos)
                      : job.status}
                  </Txt>
                </Row>
              </Stack>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}
