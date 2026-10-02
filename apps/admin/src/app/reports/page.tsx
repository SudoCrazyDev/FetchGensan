'use client';

import { useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { DailyStatsRow } from '@fetch/api';
import { useDailyStats } from '@fetch/api/admin';
import { formatPeso } from '@fetch/core';

import { Shell } from '@/components/Shell';
import { Button, Card, PageHeader, Stat, Td, Th } from '@/components/ui';

const DAY = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('en-PH', { weekday: 'short', timeZone: 'UTC' });

function dayLabel(iso: string) {
  // `day` is a plain date already in Manila time; format it without shifting.
  const d = new Date(`${iso}T00:00:00Z`);
  return { short: DAY.format(d), weekday: WEEKDAY.format(d) };
}

/**
 * Completed trips per day. One series, so no legend: the heading names it.
 * Bars are thin, anchored to the baseline with rounded tops, and each one
 * carries a hover tooltip; the table below is the accessible view of the
 * same numbers.
 */
function TripsChart({ rows }: { rows: DailyStatsRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ordered = [...rows].reverse(); // oldest on the left
  const max = Math.max(1, ...ordered.map((r) => r.completed));
  const H = 160;

  return (
    <div className="relative">
      <div className="flex h-[180px] items-end gap-[2px] border-b border-line" role="img"
        aria-label="Completed trips per day; the table below lists the same numbers.">
        {ordered.map((r, i) => {
          const h = r.completed === 0 ? 0 : Math.max(3, Math.round((r.completed / max) * H));
          return (
            <div
              key={r.day}
              className="group relative flex h-full flex-1 cursor-default items-end justify-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-full max-w-[28px] rounded-t-[4px] bg-brand-strong transition-opacity"
                style={{ height: h, opacity: hover === null || hover === i ? 1 : 0.45 }}
              />
              {hover === i ? (
                <div className="pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap rounded-lg border border-line bg-raised px-3 py-2 text-xs shadow-lg">
                  <div className="font-semibold text-ink">
                    {dayLabel(r.day).weekday} {dayLabel(r.day).short}
                  </div>
                  <div className="text-muted">
                    {r.completed} completed · {r.cancelled} cancelled · {r.expired} no rider
                  </div>
                  <div className="text-muted">
                    Commission {formatPeso(r.commission_centavos)}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-muted">
        {ordered.map((r, i) => (
          <div key={r.day} className="flex-1 text-center">
            {/* Every other label on long ranges, so they never collide. */}
            {ordered.length <= 14 || i % 2 === ordered.length % 2 ? dayLabel(r.day).short : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [days, setDays] = useState(14);
  const { data: rows, isLoading, error } = useDailyStats(days);

  const totals = (rows ?? []).reduce(
    (a, r) => ({
      completed: a.completed + r.completed,
      cancelled: a.cancelled + r.cancelled,
      expired: a.expired + r.expired,
      gross: a.gross + r.gross_centavos,
      items: a.items + r.items_centavos,
      commission: a.commission + r.commission_centavos,
    }),
    { completed: 0, cancelled: 0, expired: 0, gross: 0, items: 0, commission: 0 },
  );
  const booked = totals.completed + totals.cancelled + totals.expired;
  const unfilled = booked > 0 ? Math.round((totals.expired / booked) * 100) : 0;

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Reports"
          subtitle="Days are Manila time. Gross is what customers paid, goods included; commission is ours."
          actions={[7, 14, 30, 90].map((d) => (
            <Button key={d} variant={days === d ? 'primary' : 'secondary'} onClick={() => setDays(d)}>
              {d} days
            </Button>
          ))}
        />

        {isLoading ? (
          <Card>
            <p className="text-sm text-muted">Loading…</p>
          </Card>
        ) : error ? (
          <Card>
            <p className="text-sm text-bad">{humanizeError(error)}</p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Completed trips" value={String(totals.completed)} />
              <Stat label="Commission earned" value={formatPeso(totals.commission)} tone="text-ok" />
              <Stat label="Service revenue (gross − goods)" value={formatPeso(totals.gross - totals.items)} />
              <Stat
                label="Bookings with no rider"
                value={`${totals.expired} (${unfilled}%)`}
                tone={unfilled >= 10 ? 'text-bad' : undefined}
              />
            </div>

            <Card>
              <h2 className="mb-4 font-semibold">Completed trips per day</h2>
              <TripsChart rows={rows ?? []} />
            </Card>

            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-line">
                    <tr>
                      <Th>Day</Th>
                      <Th right>Completed</Th>
                      <Th right>Cancelled</Th>
                      <Th right>No rider</Th>
                      <Th right>Gross</Th>
                      <Th right>Goods (errands)</Th>
                      <Th right>Commission</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(rows ?? []).map((r) => (
                      <tr key={r.day}>
                        <Td>
                          {dayLabel(r.day).weekday} {dayLabel(r.day).short}
                        </Td>
                        <Td right>{r.completed}</Td>
                        <Td right>{r.cancelled}</Td>
                        <Td right className={r.expired > 0 ? 'text-bad' : ''}>
                          {r.expired}
                        </Td>
                        <Td right>{formatPeso(r.gross_centavos)}</Td>
                        <Td right className="text-muted">
                          {formatPeso(r.items_centavos)}
                        </Td>
                        <Td right>{formatPeso(r.commission_centavos)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </Shell>
  );
}
