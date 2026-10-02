import { Link, useRouter } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useActiveJob, useProfile } from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  type JobType,
  customerStatusLabel,
  formatPeso,
  isTerminal,
} from '@fetch/core';
import {
  Badge,
  Card,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  statusTone,
  useTheme,
} from '@fetch/ui';

const SERVICES: {
  type: JobType;
  emoji: string;
  title: string;
  blurb: string;
}[] = [
  {
    type: 'ride',
    emoji: '🛵',
    title: 'Book a ride',
    blurb: 'Door-to-door habal-habal for work, school or a night out.',
  },
  {
    type: 'errand',
    emoji: '🛍️',
    title: 'Send us on an errand',
    blurb: 'Food buys, groceries, pharmacy. We shop, you approve the receipt.',
  },
  {
    type: 'delivery',
    emoji: '📦',
    title: 'Send a package',
    blurb: 'Documents and parcels across the city, fast.',
  },
];

function ActiveJobCard() {
  const { data: job } = useActiveJob();
  const router = useRouter();
  const t = useTheme();

  // !isTerminal, not isLive: isLive excludes `searching`, and a customer
  // still waiting for a rider most needs to see their booking here.
  if (!job || isTerminal(job.status)) return null;

  const needsYou = job.status === 'awaiting_approval';

  return (
    <Pressable onPress={() => router.push(`/job/${job.id}`)}>
      <Card
        style={{
          borderColor: needsYou ? t.color.primary : t.color.border,
          borderWidth: needsYou ? 2 : undefined,
        }}
      >
        <Stack gap={3}>
          <Row justify="space-between">
            <Badge label={JOB_TYPE_LABELS[job.job_type]} tone="neutral" />
            <Badge
              label={needsYou ? 'Needs you' : job.status.replace(/_/g, ' ')}
              tone={statusTone(job.status)}
            />
          </Row>

          <Stack gap={1}>
            <Txt size="title" weight="600">
              {customerStatusLabel(job.job_type, job.status)}
            </Txt>
            <Txt tone="muted" size="small" numberOfLines={1}>
              To {job.dropoff_landmark || job.dropoff_label || 'your drop-off'}
            </Txt>
          </Stack>

          <Row justify="space-between">
            <Txt size="small" tone="muted">
              {job.reference}
            </Txt>
            <Txt weight="600" tone="primary">
              {needsYou ? 'Review the total →' : 'Track →'}
            </Txt>
          </Row>
        </Stack>
      </Card>
    </Pressable>
  );
}

export default function Home() {
  const t = useTheme();
  const router = useRouter();
  const { data: profile } = useProfile();
  const { data: activeJob } = useActiveJob();

  const hasActive = !!activeJob && !isTerminal(activeJob.status);
  const firstName = profile?.full_name?.split(' ')[0];

  return (
    <Screen edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={5}>
          <Row justify="space-between" align="flex-start">
            <Stack gap={1}>
              <Txt size="heading" weight="700">
                {firstName ? `Hi, ${firstName}` : 'FetchGensan'}
              </Txt>
              <Txt tone="muted">Where are we taking you?</Txt>
            </Stack>
            <Pressable
              onPress={() => router.push('/profile')}
              hitSlop={12}
              accessibilityLabel="Account"
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: t.color.surfaceRaised,
                borderWidth: 1,
                borderColor: t.color.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Txt size="title">{firstName?.[0]?.toUpperCase() ?? '👤'}</Txt>
            </Pressable>
          </Row>

          <ActiveJobCard />

          {hasActive ? (
            <Card style={{ backgroundColor: t.color.infoSoft, borderColor: 'transparent' }}>
              <Txt size="small">
                You have a booking in progress. Finish or cancel it before booking again.
              </Txt>
            </Card>
          ) : null}

          <Stack gap={3}>
            {SERVICES.map((service) => (
              <Pressable
                key={service.type}
                disabled={hasActive}
                onPress={() => router.push(`/book/${service.type}`)}
                style={({ pressed }) => ({
                  opacity: hasActive ? 0.45 : pressed ? 0.8 : 1,
                })}
              >
                <Card>
                  <Row gap={4} align="flex-start">
                    <View
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: t.radius.md,
                        backgroundColor: t.color.background,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Txt size="heading">{service.emoji}</Txt>
                    </View>
                    <Stack gap={1} style={{ flex: 1 }}>
                      <Txt size="title" weight="600">
                        {service.title}
                      </Txt>
                      <Txt tone="muted" size="small">
                        {service.blurb}
                      </Txt>
                    </Stack>
                  </Row>
                </Card>
              </Pressable>
            ))}
          </Stack>

          <Card>
            <Row justify="space-between">
              <Stack gap={1}>
                <Txt weight="600">Open 24 hours</Txt>
                <Txt size="small" tone="muted">
                  Early flights, late-night cravings. We never sleep.
                </Txt>
              </Stack>
              <Txt size="heading">🌙</Txt>
            </Row>
          </Card>

          <Link href="/history" asChild>
            <Pressable>
              <Card>
                <Row justify="space-between">
                  <Txt weight="600">Your past bookings</Txt>
                  <Txt tone="primary" weight="600">
                    →
                  </Txt>
                </Row>
              </Card>
            </Pressable>
          </Link>

          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
