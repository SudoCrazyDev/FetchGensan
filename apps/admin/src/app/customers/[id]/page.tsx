'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useAdminCustomer, useAdminJobs, useSetBlocked } from '@fetch/api/admin';
import { useCan } from '@fetch/api/react';
import { formatPhPhone } from '@fetch/core';

import { JobsTable } from '@/components/JobsTable';
import { Shell } from '@/components/Shell';
import {
  Badge,
  Button,
  Card,
  PageHeader,
  PromptDialog,
  Stat,
  manilaTime,
} from '@/components/ui';

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: customer, isLoading, error } = useAdminCustomer(id);
  const { data: jobs } = useAdminJobs({ customerId: id }, 50);
  const { allowed: canManageUsers } = useCan('users.manage');
  const { allowed: canViewUsers } = useCan('users.view');
  const setBlocked = useSetBlocked();

  const [blockOpen, setBlockOpen] = useState<'block' | 'unblock' | null>(null);

  if (isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading…</p>
      </Shell>
    );
  }

  if (error || !customer) {
    return (
      <Shell>
        <Card>
          <p className="text-sm text-bad">{error ? humanizeError(error) : 'Account not found.'}</p>
          <Link href="/customers" className="mt-2 inline-block text-sm text-info hover:underline">
            ← Back to customers
          </Link>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <Link href="/customers" className="text-sm text-muted hover:text-ink">
          ← All customers
        </Link>

        <PageHeader
          title={customer.full_name || 'Unnamed'}
          subtitle={
            <span className="flex flex-wrap items-center gap-2">
              <a className="text-info hover:underline" href={`tel:${customer.phone}`}>
                {formatPhPhone(customer.phone)}
              </a>
              <Badge tone={customer.role === 'customer' ? 'neutral' : 'progress'}>
                {customer.role}
              </Badge>
              {customer.is_blocked ? <Badge tone="danger">blocked</Badge> : null}
              <span>Joined {manilaTime(customer.created_at)}</span>
            </span>
          }
          actions={
            <>
              {customer.role === 'driver' ? (
                <Link
                  href={`/drivers/${customer.id}`}
                  className="rounded-lg border border-line bg-raised px-3 py-2 text-sm font-semibold hover:bg-line"
                >
                  Rider profile
                </Link>
              ) : null}
              {!canManageUsers ? null : customer.is_blocked ? (
                <Button variant="secondary" onClick={() => setBlockOpen('unblock')}>
                  Reactivate
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setBlockOpen('block')}>
                  Deactivate
                </Button>
              )}
            </>
          }
        />

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Completed" value={String(customer.completed_jobs)} />
          <Stat
            label="Cancelled"
            value={String(customer.cancelled_jobs)}
            tone={customer.cancelled_jobs > 2 ? 'text-bad' : undefined}
          />
          <Stat label="Last booking" value={manilaTime(customer.last_booking_at)} />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-2 font-semibold">Notes</h2>
            {customer.notes ? (
              <pre className="whitespace-pre-wrap font-sans text-sm text-muted">{customer.notes}</pre>
            ) : (
              <p className="text-sm text-muted">
                Nothing on record. Blocking and unblocking add a dated note here.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 font-semibold">Account and roles</h2>
            <p className="mb-3 text-sm text-muted">
              Roles, passwords and sign-in details are managed on the Users page.
            </p>
            {canViewUsers ? (
              <Link
                href={`/users?search=${encodeURIComponent(customer.phone)}`}
                className="inline-block rounded-lg border border-line bg-raised px-3 py-2 text-sm font-semibold hover:bg-line"
              >
                Open in Users
              </Link>
            ) : (
              <p className="text-sm text-muted">You do not have access to user accounts.</p>
            )}
          </Card>
        </div>

        <Card>
          <h2 className="mb-3 font-semibold">Bookings</h2>
          <JobsTable jobs={jobs ?? []} hide={['customer']} />
        </Card>
      </div>

      <PromptDialog
        open={blockOpen !== null}
        title={blockOpen === 'block' ? 'Deactivate this account?' : 'Reactivate this account?'}
        description={
          blockOpen === 'block'
            ? 'They are signed out everywhere and cannot book. The note is kept, dated, on their record.'
            : 'They can sign in and book again straight away.'
        }
        label="Note for the record"
        placeholder={blockOpen === 'block' ? 'Three no-shows in a week' : 'Spoke to them, resolved'}
        confirmLabel={blockOpen === 'block' ? 'Deactivate' : 'Reactivate'}
        danger={blockOpen === 'block'}
        required={blockOpen === 'block'}
        busy={setBlocked.isPending}
        error={setBlocked.error ? humanizeError(setBlocked.error) : null}
        onCancel={() => setBlockOpen(null)}
        onConfirm={(note) =>
          setBlocked.mutate(
            { profileId: customer.id, blocked: blockOpen === 'block', note },
            { onSuccess: () => setBlockOpen(null) },
          )
        }
      />
    </Shell>
  );
}
