'use client';

import { useEffect, useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useAdminJobs } from '@fetch/api/admin';
import { JOB_TYPE_LABELS, type JobStatus, type JobType } from '@fetch/core';

import { JobsTable } from '@/components/JobsTable';
import { Shell } from '@/components/Shell';
import { Card, PageHeader, inputClass } from '@/components/ui';

const STATUSES: (JobStatus | 'all')[] = [
  'all',
  'searching',
  'assigned',
  'arriving',
  'arrived_pickup',
  'shopping',
  'awaiting_approval',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
  'draft',
];

/**
 * Every booking, any status. The live board only shows work in flight; this
 * is where a dispatcher goes when a customer phones about yesterday.
 */
export default function JobsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<JobStatus | 'all'>('all');
  const [jobType, setJobType] = useState<JobType | 'all'>('all');
  const [limit, setLimit] = useState(50);

  // Debounced, so typing a phone number is one query rather than eleven.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: jobs, isLoading, error, isFetching } = useAdminJobs(
    { search, status, jobType },
    limit,
  );

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Bookings"
          subtitle="Search by reference, customer or rider name, phone, or plate."
        />

        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} max-w-sm`}
            placeholder="FG-ABC123, Maria, 0917…, GS 1234"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className={`${inputClass} max-w-[200px]`}
            value={status}
            onChange={(e) => setStatus(e.target.value as JobStatus | 'all')}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'Any status' : s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select
            className={`${inputClass} max-w-[180px]`}
            value={jobType}
            onChange={(e) => setJobType(e.target.value as JobType | 'all')}
          >
            <option value="all">Any service</option>
            {(Object.keys(JOB_TYPE_LABELS) as JobType[]).map((t) => (
              <option key={t} value={t}>
                {JOB_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {isFetching && !isLoading ? (
            <span className="self-center text-xs text-muted">Refreshing…</span>
          ) : null}
        </div>

        <Card>
          {isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : error ? (
            <p className="text-sm text-bad">{humanizeError(error)}</p>
          ) : (
            <>
              <JobsTable jobs={jobs ?? []} />
              {(jobs ?? []).length >= limit ? (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    className="text-sm text-info hover:underline"
                    onClick={() => setLimit(limit + 50)}
                  >
                    Show more
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </Shell>
  );
}
