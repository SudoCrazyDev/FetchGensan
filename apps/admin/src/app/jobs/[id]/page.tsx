'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { JobEvent } from '@fetch/api';
import { useAdminCancelJob, useAdminJob, useAssignJob, useNearbyDrivers } from '@fetch/api/admin';
import { qk, useApi, useRoster } from '@fetch/api/react';
import {
  JOB_TYPE_LABELS,
  driverNextStatus,
  formatDistance,
  formatPeso,
  formatPhPhone,
  isTerminal,
} from '@fetch/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { jobStatusTone } from '@/components/JobsTable';
import { Shell } from '@/components/Shell';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  PageHeader,
  PromptDialog,
  inputClass,
  manilaTime,
} from '@/components/ui';

function mapsLink(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

const EVENT_LABELS: Record<string, string> = {
  status_changed: 'Status changed',
  dispatched: 'Offered to riders',
  offer_declined: 'A rider passed',
  receipt_submitted: 'Receipt sent to customer',
  total_approved: 'Customer approved the total',
  total_rejected: 'Customer sent the total back',
  manually_assigned: 'Assigned by dispatch',
};

function describeEvent(e: JobEvent): string {
  const base = EVENT_LABELS[e.event_type] ?? e.event_type.replace(/_/g, ' ');
  if (e.from_status || e.to_status) {
    return `${e.from_status ?? 'new'} → ${e.to_status}`;
  }
  const p = e.payload ?? {};
  if (e.event_type === 'dispatched') {
    return `${base}: round ${String(p.round ?? '?')}, ${String(p.notified ?? 0)} rider(s) within ${formatDistance(Number(p.radius_m ?? 0))}`;
  }
  if (e.event_type === 'receipt_submitted') {
    return `${base}: items ${formatPeso(Number(p.items_cost_centavos ?? 0))}, total ${formatPeso(Number(p.final_total_centavos ?? 0))}`;
  }
  if (e.event_type === 'total_rejected' && p.reason) {
    return `${base}: “${String(p.reason)}”`;
  }
  return base;
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useAdminJob(id);
  const cancel = useAdminCancelJob();
  const assign = useAssignJob();
  const { data: roster } = useRoster();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [driverId, setDriverId] = useState('');

  const job = data?.job ?? null;
  const awaitingRider = !!job && job.driver_id === null && ['searching', 'expired', 'draft'].includes(job.status);
  const { data: nearby } = useNearbyDrivers(awaitingRider ? id : null, 7000);

  // Staff may move a job forward through the same RPCs the rider app uses
  // (advance_job / complete_job / approve_errand_total all allow is_staff()).
  // This is for the phone-died-mid-trip case, not routine use.
  const override = useMutation({
    mutationFn: async (action: 'advance' | 'complete' | 'approve') => {
      if (!job) return;
      if (action === 'complete') return api.driver.complete(job.id);
      if (action === 'approve') return api.jobs.approveErrandTotal(job.id);
      const next = driverNextStatus(job.job_type, job.status);
      if (!next) return;
      return api.driver.advance(job.id, next);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.adminJob(id) });
      void queryClient.invalidateQueries({ queryKey: qk.board });
    },
  });

  if (isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading booking…</p>
      </Shell>
    );
  }

  if (error || !job || !data) {
    return (
      <Shell>
        <Card>
          <p className="text-sm text-bad">{error ? humanizeError(error) : 'Booking not found.'}</p>
          <Link href="/jobs" className="mt-2 inline-block text-sm text-info hover:underline">
            ← Back to bookings
          </Link>
        </Card>
      </Shell>
    );
  }

  const isErrand = job.job_type === 'errand';
  const next = driverNextStatus(job.job_type, job.status);
  const free = (roster ?? []).filter(
    (d) => d.status === 'approved' && !d.active_job_id && !d.is_blocked,
  );

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <Link href="/jobs" className="text-sm text-muted hover:text-ink">
          ← All bookings
        </Link>

        <PageHeader
          title={`${JOB_TYPE_LABELS[job.job_type]} ${job.reference}`}
          subtitle={
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={jobStatusTone(job.status)}>{job.status.replace(/_/g, ' ')}</Badge>
              <span>Booked {manilaTime(job.created_at)}</span>
              {job.scheduled_for ? <span>· scheduled for {manilaTime(job.scheduled_for)}</span> : null}
            </span>
          }
          actions={
            !isTerminal(job.status) ? (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                Cancel booking
              </Button>
            ) : null
          }
        />

        {job.status === 'cancelled' && job.cancel_reason ? (
          <Card className="border-bad/40">
            <p className="text-sm">
              <span className="font-semibold">Cancelled</span> {manilaTime(job.cancelled_at)}:{' '}
              {job.cancel_reason}
            </p>
          </Card>
        ) : null}

        {awaitingRider ? (
          <Card className="border-brand/50">
            <h2 className="mb-2 font-semibold">Assign a rider</h2>
            <div className="flex flex-wrap gap-2">
              {(nearby ?? []).map((n) => (
                <Button
                  key={n.driver_id}
                  variant="secondary"
                  disabled={assign.isPending}
                  onClick={() => assign.mutate({ jobId: job.id, driverId: n.driver_id })}
                >
                  {n.full_name || 'Unnamed'} · {formatDistance(n.distance_m)}
                </Button>
              ))}
              <select
                className={`${inputClass} max-w-xs`}
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
              >
                <option value="">Any free approved rider…</option>
                {free.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name || d.phone} · {d.plate_number}
                    {d.is_online ? ' · online' : ' · offline'}
                  </option>
                ))}
              </select>
              <Button
                disabled={!driverId || assign.isPending}
                onClick={() => assign.mutate({ jobId: job.id, driverId })}
              >
                Assign
              </Button>
            </div>
            <ErrorText error={assign.error} />
          </Card>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 font-semibold">People</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  Customer
                </div>
                <Link href={`/customers/${job.customer_id}`} className="font-semibold hover:underline">
                  {job.customer_name || 'Unnamed'}
                </Link>
                <div>
                  <a className="text-info hover:underline" href={`tel:${job.customer_phone}`}>
                    {formatPhPhone(job.customer_phone)}
                  </a>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Rider</div>
                {job.driver_id ? (
                  <>
                    <Link href={`/drivers/${job.driver_id}`} className="font-semibold hover:underline">
                      {job.driver_name || 'Unnamed'}
                    </Link>
                    <div className="font-mono text-xs text-muted">{job.plate_number}</div>
                    {job.driver_phone ? (
                      <a className="text-info hover:underline" href={`tel:${job.driver_phone}`}>
                        {formatPhPhone(job.driver_phone)}
                      </a>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted">Not assigned</span>
                )}
              </div>
              {job.recipient_name ? (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                    Recipient
                  </div>
                  <div className="font-semibold">{job.recipient_name}</div>
                  <a className="text-info hover:underline" href={`tel:${job.recipient_phone}`}>
                    {formatPhPhone(job.recipient_phone)}
                  </a>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Route · {formatDistance(job.distance_meters)}</h2>
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  {isErrand ? 'Store' : 'Pick-up'}
                </div>
                <a
                  className="font-semibold hover:underline"
                  href={mapsLink(job.pickup_lat, job.pickup_lng)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {job.pickup_label || 'Pinned location'} ↗
                </a>
                {job.pickup_landmark ? <div className="text-muted">{job.pickup_landmark}</div> : null}
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  {isErrand ? 'Deliver to' : 'Drop-off'}
                </div>
                <a
                  className="font-semibold hover:underline"
                  href={mapsLink(job.dropoff_lat, job.dropoff_lng)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {job.dropoff_label || 'Pinned location'} ↗
                </a>
                {job.dropoff_landmark ? (
                  <div className="text-muted">{job.dropoff_landmark}</div>
                ) : null}
              </div>
              {job.notes ? (
                <div className="rounded-lg bg-raised p-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
                    Customer note
                  </span>
                  <div>{job.notes}</div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Money</h2>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Quoted {isErrand ? 'service fee' : 'fare'}</dt>
                <dd className="tabular-nums">{formatPeso(job.quoted_fare_centavos)}</dd>
              </div>
              {isErrand ? (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted">Customer item budget</dt>
                    <dd className="tabular-nums">{formatPeso(job.items_budget_centavos)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Receipt total</dt>
                    <dd className="tabular-nums">{formatPeso(job.items_cost_centavos)}</dd>
                  </div>
                </>
              ) : null}
              <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
                <dt>Total ({job.payment_method})</dt>
                <dd className="tabular-nums">{formatPeso(job.final_total_centavos)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Our commission</dt>
                <dd className="tabular-nums">
                  {job.status === 'completed' ? formatPeso(job.commission_centavos) : 'on completion'}
                </dd>
              </div>
            </dl>
          </Card>

          {!isTerminal(job.status) && job.driver_id ? (
            <Card>
              <h2 className="mb-1 font-semibold">Override</h2>
              <p className="mb-3 text-sm text-muted">
                For when the rider cannot update the app themselves. Each step is logged under
                your name.
              </p>
              <div className="flex flex-wrap gap-2">
                {job.status === 'in_progress' ? (
                  <Button
                    variant="secondary"
                    disabled={override.isPending}
                    onClick={() => {
                      if (window.confirm('Mark this booking completed and charge commission?')) {
                        override.mutate('complete');
                      }
                    }}
                  >
                    Mark completed
                  </Button>
                ) : job.status === 'awaiting_approval' ? (
                  <Button
                    variant="secondary"
                    disabled={override.isPending}
                    onClick={() => {
                      if (window.confirm('Approve the receipt total on the customer’s behalf?')) {
                        override.mutate('approve');
                      }
                    }}
                  >
                    Approve total for the customer
                  </Button>
                ) : next && job.status !== 'shopping' ? (
                  <Button
                    variant="secondary"
                    disabled={override.isPending}
                    onClick={() => override.mutate('advance')}
                  >
                    Move to “{next.replace(/_/g, ' ')}”
                  </Button>
                ) : (
                  <span className="text-sm text-muted">
                    The rider must submit the receipt from their phone.
                  </span>
                )}
              </div>
              <ErrorText error={override.error} />
            </Card>
          ) : null}
        </div>

        {isErrand ? (
          <Card>
            <h2 className="mb-3 font-semibold">Shopping list</h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2">
                      <span className={item.is_available === false ? 'text-muted line-through' : ''}>
                        {item.quantity} {item.unit} · {item.name}
                      </span>
                      {item.notes ? <div className="text-xs text-muted">{item.notes}</div> : null}
                      {item.substitute_note ? (
                        <div className="text-xs text-brand">Substituted: {item.substitute_note}</div>
                      ) : null}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {item.is_available === false
                        ? 'not available'
                        : item.actual_price_centavos !== null
                          ? formatPeso(item.actual_price_centavos)
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.receipts.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-3">
                {data.receipts.map((r) =>
                  r.url ? (
                    <a key={r.id} href={r.url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed, expiring URL */}
                      <img
                        src={r.url}
                        alt="Receipt"
                        className="h-40 rounded border border-line bg-raised object-contain"
                      />
                    </a>
                  ) : null,
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted">No receipt photo uploaded.</p>
            )}
          </Card>
        ) : null}

        <Card>
          <h2 className="mb-3 font-semibold">Timeline</h2>
          <ol className="flex flex-col gap-2 text-sm">
            {data.events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-28 shrink-0 text-muted tabular-nums">{manilaTime(e.created_at)}</span>
                <span>{describeEvent(e)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <PromptDialog
        open={cancelOpen}
        title={`Cancel ${job.reference}?`}
        description="The customer and any assigned rider are told it was cancelled."
        label="Reason"
        placeholder="Customer asked by phone"
        confirmLabel="Cancel booking"
        danger
        required
        busy={cancel.isPending}
        error={cancel.error ? humanizeError(cancel.error) : null}
        onCancel={() => setCancelOpen(false)}
        onConfirm={(reason) =>
          cancel.mutate({ jobId: job.id, reason: reason.trim() }, { onSuccess: () => setCancelOpen(false) })
        }
      />
    </Shell>
  );
}
