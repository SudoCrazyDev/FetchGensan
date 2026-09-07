'use client';

import { useMemo, useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { DispatchBoardRow } from '@fetch/api';
import { useApi, useDispatchBoard, useRedispatch } from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  formatDistance,
  formatPeso,
  formatPhPhone,
} from '@fetch/core';

import { DispatchMap } from '@/components/DispatchMap';
import { Shell } from '@/components/Shell';
import { Badge, Button, Card, Stat } from '@/components/ui';

/**
 * How long a booking may sit unassigned before the row starts shouting.
 * Chosen to be shorter than the auto-dispatch give-up point, so a
 * dispatcher gets a chance to intervene by phone before the customer is
 * told nobody is available.
 */
const WARN_AFTER_SECONDS = 90;
const URGENT_AFTER_SECONDS = 180;

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function statusTone(status: string) {
  if (status === 'searching') return 'attention' as const;
  if (status === 'awaiting_approval') return 'attention' as const;
  if (status === 'expired') return 'danger' as const;
  if (status === 'draft') return 'neutral' as const;
  return 'progress' as const;
}

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: DispatchBoardRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const api = useApi();
  const redispatch = useRedispatch();
  const [busy, setBusy] = useState(false);

  const unassigned = job.driver_id === null;
  const urgent = unassigned && job.age_seconds > URGENT_AFTER_SECONDS;
  const warn = unassigned && job.age_seconds > WARN_AFTER_SECONDS;

  async function cancel() {
    const reason = window.prompt('Reason for cancelling?');
    if (reason === null) return;

    setBusy(true);
    try {
      await api.dispatch.cancel(job.id, reason || 'Cancelled by dispatch');
    } catch (e) {
      window.alert(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      urgent={urgent}
      className={`cursor-pointer transition ${
        selected ? 'ring-2 ring-brand' : 'hover:border-muted'
      }`}
    >
      <div onClick={onSelect} className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{JOB_TYPE_LABELS[job.job_type]}</Badge>
          <Badge tone={statusTone(job.status)}>{job.status.replace(/_/g, ' ')}</Badge>
          <span className="font-mono text-xs text-muted">{job.reference}</span>

          <span
            className={`ml-auto tabular-nums text-sm font-bold ${
              urgent ? 'text-bad' : warn ? 'text-brand' : 'text-muted'
            }`}
          >
            {age(job.age_seconds)}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
              {job.job_type === 'errand' ? 'Store' : 'Pick-up'}
            </div>
            <div className="truncate text-sm font-medium">
              {job.pickup_label || 'Pinned'}
            </div>
            {job.pickup_landmark ? (
              <div className="truncate text-xs text-muted">{job.pickup_landmark}</div>
            ) : null}
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Drop-off
            </div>
            <div className="truncate text-sm font-medium">
              {job.dropoff_label || 'Pinned'}
            </div>
            {job.dropoff_landmark ? (
              <div className="truncate text-xs text-muted">{job.dropoff_landmark}</div>
            ) : null}
          </div>

          <div className="text-right">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Fare</div>
            <div className="text-sm font-bold tabular-nums">
              {formatPeso(job.final_total_centavos || job.quoted_fare_centavos)}
            </div>
            <div className="text-xs text-muted">{formatDistance(job.distance_meters)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs">
          <span className="text-muted">
            {job.customer_name}{' '}
            <a
              className="text-info hover:underline"
              href={`tel:${job.customer_phone}`}
              onClick={(e) => e.stopPropagation()}
            >
              {formatPhPhone(job.customer_phone)}
            </a>
          </span>

          {job.driver_name ? (
            <span className="text-muted">
              🛵 {job.driver_name} · {job.plate_number}{' '}
              <a
                className="text-info hover:underline"
                href={`tel:${job.driver_phone}`}
                onClick={(e) => e.stopPropagation()}
              >
                {job.driver_phone ? formatPhPhone(job.driver_phone) : ''}
              </a>
            </span>
          ) : (
            <span className="font-semibold text-brand">
              No rider yet · {job.pending_offers} offer
              {job.pending_offers === 1 ? '' : 's'} out · round {job.dispatch_attempts} ·{' '}
              {formatDistance(job.dispatch_radius_m)} radius
            </span>
          )}
        </div>
      </div>

      {selected ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {(job.status === 'searching' || job.status === 'expired') && (
            <>
              <Button
                variant="secondary"
                disabled={redispatch.isPending}
                onClick={() => redispatch.mutate({ jobId: job.id })}
              >
                Re-broadcast
              </Button>
              <Button
                variant="secondary"
                disabled={redispatch.isPending}
                onClick={() => redispatch.mutate({ jobId: job.id, radiusM: 7000 })}
              >
                Widen to 7 km
              </Button>
            </>
          )}
          <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
            Cancel booking
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export default function DispatchBoardPage() {
  const { data: jobs, isLoading, error } = useDispatchBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const rows = jobs ?? [];
    const waiting = rows.filter((j) => j.status === 'searching');
    const stuck = waiting.filter((j) => j.age_seconds > URGENT_AFTER_SECONDS);
    const needsCustomer = rows.filter((j) => j.status === 'awaiting_approval');

    return {
      live: rows.length,
      waiting: waiting.length,
      stuck: stuck.length,
      needsCustomer: needsCustomer.length,
    };
  }, [jobs]);

  // Waiting jobs first, oldest at the top: that is the queue a dispatcher
  // works down. Everything already assigned is reference material.
  const ordered = useMemo(() => {
    const rows = [...(jobs ?? [])];
    return rows.sort((a, b) => {
      const aWaiting = a.driver_id === null ? 0 : 1;
      const bWaiting = b.driver_id === null ? 0 : 1;
      if (aWaiting !== bWaiting) return aWaiting - bWaiting;
      return b.age_seconds - a.age_seconds;
    });
  }, [jobs]);

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Live bookings" value={String(stats.live)} />
          <Stat
            label="Waiting for a rider"
            value={String(stats.waiting)}
            tone={stats.waiting > 0 ? 'text-brand' : undefined}
          />
          <Stat
            label="Waiting over 3 min"
            value={String(stats.stuck)}
            tone={stats.stuck > 0 ? 'text-bad' : undefined}
          />
          <Stat label="Awaiting customer OK" value={String(stats.needsCustomer)} />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
          <div className="flex flex-col gap-3">
            {isLoading ? (
              <Card>
                <p className="text-sm text-muted">Loading the board…</p>
              </Card>
            ) : error ? (
              <Card>
                <p className="text-sm text-bad">{humanizeError(error)}</p>
              </Card>
            ) : ordered.length === 0 ? (
              <Card>
                <div className="py-8 text-center">
                  <p className="font-semibold">Nothing in flight</p>
                  <p className="mt-1 text-sm text-muted">
                    New bookings appear here the moment a customer books.
                  </p>
                </div>
              </Card>
            ) : (
              ordered.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={selectedId === job.id}
                  onSelect={() => setSelectedId(selectedId === job.id ? null : job.id)}
                />
              ))
            )}
          </div>

          <div className="lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)]">
            <DispatchMap
              jobs={ordered}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId(id)}
            />
          </div>
        </div>
      </div>
    </Shell>
  );
}
