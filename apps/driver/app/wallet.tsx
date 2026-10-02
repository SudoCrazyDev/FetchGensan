/**
 * Earnings and the commission wallet.
 *
 * The screen has one job: make it completely unambiguous whether the driver
 * owes us money and what happens if they ignore it. On a cash fleet the
 * driver has already been paid in full by the customer, so a negative
 * balance is normal and must not read as a punishment -- but the
 * consequence (you stop getting bookings) has to be stated plainly, because
 * discovering it at 5am when the toggle refuses to flip is how you lose a
 * driver.
 */

import { Linking, ScrollView, View } from 'react-native';

import { useDriverMe, useEarnings, useFareConfigs, useWallet } from '@fetch/api/react';
import { JOB_TYPE_LABELS, formatBps, formatPeso } from '@fetch/core';
import {
  Badge,
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
  Button,
} from '@fetch/ui';

import { DISPATCH_PHONE } from '@/lib/config';

const TIME = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function startOfTodayManila(): Date {
  // Manila is UTC+8 with no DST, so a fixed offset is exact here.
  const now = new Date();
  const manila = new Date(now.getTime() + 8 * 3600_000);
  manila.setUTCHours(0, 0, 0, 0);
  return new Date(manila.getTime() - 8 * 3600_000);
}

function startOfWeek(): Date {
  const d = startOfTodayManila();
  return new Date(d.getTime() - 6 * 24 * 3600_000);
}

const TXN_LABELS: Record<string, string> = {
  commission: 'Commission',
  topup: 'Top-up',
  payout: 'Payout',
  adjustment: 'Adjustment',
  errand_float: 'Errand float',
};

export default function WalletScreen() {
  const t = useTheme();

  const { data: driver, isLoading } = useDriverMe();
  const { data: today } = useEarnings(startOfTodayManila(), 'today');
  const { data: week } = useEarnings(startOfWeek(), 'week');
  const { data: transactions } = useWallet();
  const { data: fares } = useFareConfigs();

  if (isLoading || !driver) return <Loading />;

  const balance = driver.wallet_balance_centavos;
  const owes = balance < 0;
  const owed = Math.abs(Math.min(0, balance));
  const headroom = balance - driver.credit_floor_centavos;
  const blocked = balance <= driver.credit_floor_centavos;

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Stack gap={4}>
          {/* ---------------------------------------------- balance */}

          <Card
            style={{
              borderColor: blocked ? t.color.danger : owes ? t.color.primary : t.color.success,
              borderWidth: 2,
            }}
          >
            <Stack gap={3}>
              <Txt size="caption" tone="muted" weight="600">
                {owes ? 'COMMISSION YOU OWE' : 'WALLET BALANCE'}
              </Txt>

              <Money
                centavos={owes ? owed : balance}
                size="display"
                tone={blocked ? 'danger' : 'default'}
              />

              {blocked ? (
                <Card
                  style={{
                    backgroundColor: t.color.dangerSoft,
                    borderColor: 'transparent',
                    padding: t.space(3),
                  }}
                >
                  <Txt size="small" weight="600">
                    You cannot go online until you top up.
                  </Txt>
                </Card>
              ) : owes ? (
                <Txt size="small" tone="muted">
                  You can keep working until you owe{' '}
                  {formatPeso(Math.abs(driver.credit_floor_centavos))}. That is{' '}
                  {formatPeso(headroom)} of room left.
                </Txt>
              ) : (
                <Txt size="small" tone="muted">
                  All settled. Nothing to pay.
                </Txt>
              )}
            </Stack>
          </Card>

          {owes ? (
            <Card>
              <Stack gap={3}>
                <Txt weight="600">How to top up</Txt>
                <Txt size="small" tone="muted">
                  Drop by the dispatch office and hand over cash, and it is credited to your
                  wallet straight away.
                </Txt>
                <Button
                  label="Call dispatch"
                  variant="secondary"
                  onPress={() => void Linking.openURL(`tel:${DISPATCH_PHONE}`)}
                />
              </Stack>
            </Card>
          ) : null}

          {/* ---------------------------------------------- earnings */}

          <Card>
            <Stack gap={4}>
              <Txt weight="600">Your earnings</Txt>

              <Row justify="space-between">
                <Stack gap={0.5}>
                  <Txt size="caption" tone="muted" weight="600">
                    TODAY
                  </Txt>
                  <Money centavos={today?.grossCentavos ?? 0} size="title" />
                  <Txt size="caption" tone="muted">
                    {today?.jobs ?? 0} bookings
                  </Txt>
                </Stack>
                <Stack gap={0.5} style={{ alignItems: 'flex-end' }}>
                  <Txt size="caption" tone="muted" weight="600">
                    LAST 7 DAYS
                  </Txt>
                  <Money centavos={week?.grossCentavos ?? 0} size="title" />
                  <Txt size="caption" tone="muted">
                    {week?.jobs ?? 0} bookings
                  </Txt>
                </Stack>
              </Row>

              <Divider />

              <Stack gap={2}>
                <Row justify="space-between">
                  <Txt size="small" tone="muted">
                    Fares collected this week
                  </Txt>
                  <Txt size="small">{formatPeso(week?.grossCentavos ?? 0)}</Txt>
                </Row>
                <Row justify="space-between">
                  <Txt size="small" tone="muted">
                    Commission charged
                  </Txt>
                  <Txt size="small">-{formatPeso(week?.commissionCentavos ?? 0)}</Txt>
                </Row>
                <Row justify="space-between">
                  <Txt weight="600">You kept</Txt>
                  <Txt weight="700">
                    {formatPeso((week?.grossCentavos ?? 0) - (week?.commissionCentavos ?? 0))}
                  </Txt>
                </Row>
                <Txt size="caption" tone="muted">
                  Earnings exclude money you fronted for errand items — that is reimbursed to you
                  in full by the customer, and we take no commission on it.
                </Txt>
              </Stack>
            </Stack>
          </Card>

          {/* ---------------------------------------------- ledger */}

          <Card>
            <Stack gap={3}>
              <Txt weight="600">Wallet history</Txt>

              {transactions && transactions.length > 0 ? (
                transactions.map((txn, index) => (
                  <View key={txn.id}>
                    {index > 0 ? <Divider /> : null}
                    <Row justify="space-between" style={{ paddingVertical: t.space(2.5) }}>
                      <Stack gap={0.5} style={{ flex: 1 }}>
                        <Txt size="small" weight="600">
                          {TXN_LABELS[txn.kind] ?? txn.kind}
                        </Txt>
                        <Txt size="caption" tone="muted">
                          {TIME.format(new Date(txn.created_at))}
                          {txn.note ? ` · ${txn.note}` : ''}
                        </Txt>
                      </Stack>
                      <Stack gap={0.5} style={{ alignItems: 'flex-end' }}>
                        <Txt
                          size="small"
                          weight="700"
                          tone={txn.amount_centavos < 0 ? 'danger' : 'success'}
                        >
                          {txn.amount_centavos < 0 ? '' : '+'}
                          {formatPeso(txn.amount_centavos)}
                        </Txt>
                        <Txt size="caption" tone="muted">
                          bal {formatPeso(txn.balance_after_centavos)}
                        </Txt>
                      </Stack>
                    </Row>
                  </View>
                ))
              ) : (
                <Txt size="small" tone="muted">
                  Nothing here yet. Commission shows up after your first completed booking.
                </Txt>
              )}
            </Stack>
          </Card>

          {fares && fares.length > 0 ? (
            <Stack gap={1} style={{ alignItems: 'center' }}>
              <Row gap={2} justify="center">
                {fares.map((f) => (
                  <Badge
                    key={f.id}
                    label={`${JOB_TYPE_LABELS[f.job_type]} ${formatBps(f.commission_bps)}`}
                    tone="neutral"
                  />
                ))}
              </Row>
              <Txt size="caption" tone="muted" align="center">
                Commission is on the fare only, never on errand goods.
              </Txt>
            </Stack>
          ) : null}

          <Spacer size={6} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
