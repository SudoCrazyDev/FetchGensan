'use client';

import Link from 'next/link';

import type { AdminJobRow } from '@fetch/api';
import { JOB_TYPE_LABELS, formatPeso, formatPhPhone } from '@fetch/core';

import { Badge, Td, Th, manilaTime } from './ui';

export function jobStatusTone(status: string) {
  switch (status) {
    case 'completed':
      return 'success' as const;
    case 'cancelled':
    case 'expired':
      return 'danger' as const;
    case 'searching':
    case 'awaiting_approval':
      return 'attention' as const;
    case 'draft':
      return 'neutral' as const;
    default:
      return 'progress' as const;
  }
}

export function JobsTable({
  jobs,
  hide = [],
}: {
  jobs: AdminJobRow[];
  /** Columns that would only repeat the page they sit on. */
  hide?: ('customer' | 'driver')[];
}) {
  if (jobs.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No bookings.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="border-b border-line">
          <tr>
            <Th>Booked</Th>
            <Th>Reference</Th>
            <Th>Status</Th>
            <Th>Route</Th>
            {hide.includes('customer') ? null : <Th>Customer</Th>}
            {hide.includes('driver') ? null : <Th>Rider</Th>}
            <Th right>Total</Th>
            <Th right>Commission</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {jobs.map((job) => (
            <tr key={job.id} className="hover:bg-raised/40">
              <Td className="whitespace-nowrap text-muted">{manilaTime(job.created_at)}</Td>
              <Td>
                <Link
                  href={`/jobs/${job.id}`}
                  className="font-mono text-xs font-semibold hover:text-brand hover:underline"
                >
                  {job.reference}
                </Link>
                <div className="text-xs text-muted">{JOB_TYPE_LABELS[job.job_type]}</div>
              </Td>
              <Td>
                <Badge tone={jobStatusTone(job.status)}>{job.status.replace(/_/g, ' ')}</Badge>
              </Td>
              <Td className="max-w-[260px]">
                <div className="truncate">{job.pickup_label || 'Pinned'}</div>
                <div className="truncate text-xs text-muted">→ {job.dropoff_label || 'Pinned'}</div>
              </Td>
              {hide.includes('customer') ? null : (
                <Td>
                  <Link href={`/customers/${job.customer_id}`} className="hover:underline">
                    {job.customer_name || 'Unnamed'}
                  </Link>
                  <div className="text-xs text-muted">{formatPhPhone(job.customer_phone)}</div>
                </Td>
              )}
              {hide.includes('driver') ? null : (
                <Td>
                  {job.driver_id ? (
                    <>
                      <Link href={`/drivers/${job.driver_id}`} className="hover:underline">
                        {job.driver_name || 'Unnamed'}
                      </Link>
                      <div className="font-mono text-xs text-muted">{job.plate_number}</div>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
              )}
              <Td right>{formatPeso(job.final_total_centavos || job.quoted_fare_centavos)}</Td>
              <Td right className="text-muted">
                {job.status === 'completed' ? formatPeso(job.commission_centavos) : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
