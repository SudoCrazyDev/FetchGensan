'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { DriverRosterRow, DriverStatus } from '@fetch/api';
import { useSetDriverStatus } from '@fetch/api/admin';
import { useRoster } from '@fetch/api/react';
import { formatPeso, formatPhPhone } from '@fetch/core';

import { Shell } from '@/components/Shell';
import { TopupDialog } from '@/components/TopupDialog';
import { Badge, Button, Card, PageHeader, PromptDialog, Stat, inputClass } from '@/components/ui';

function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}

const linkButton =
  'rounded-lg border border-line bg-raised px-3 py-2 text-sm font-semibold hover:bg-line';

export default function DriversPage() {
  const { data: roster, isLoading, error } = useRoster();
  const setDriverStatus = useSetDriverStatus();

  const [filter, setFilter] = useState<'all' | 'online' | 'pending' | 'owing'>('all');
  const [search, setSearch] = useState('');
  const [topupFor, setTopupFor] = useState<DriverRosterRow | null>(null);
  const [statusFor, setStatusFor] = useState<{
    driver: DriverRosterRow;
    status: DriverStatus;
  } | null>(null);

  const stats = useMemo(() => {
    const rows = roster ?? [];
    return {
      total: rows.length,
      online: rows.filter((d) => d.is_online).length,
      dispatchable: rows.filter((d) => d.is_dispatchable).length,
      pending: rows.filter((d) => d.status === 'pending').length,
      owing: rows.filter((d) => d.wallet_balance_centavos < 0).length,
    };
  }, [roster]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = (roster ?? []).filter(
      (d) =>
        !term ||
        d.full_name.toLowerCase().includes(term) ||
        d.phone.includes(term) ||
        d.plate_number.toLowerCase().includes(term),
    );
    switch (filter) {
      case 'online':
        return rows.filter((d) => d.is_online);
      case 'pending':
        return rows.filter((d) => d.status === 'pending');
      case 'owing':
        return rows.filter((d) => d.wallet_balance_centavos < 0);
      default:
        return rows;
    }
  }, [roster, filter, search]);

  function changeStatus(driverId: string, status: DriverStatus, reason = '') {
    setDriverStatus.mutate(
      { driverId, status, reason },
      {
        onSuccess: () => setStatusFor(null),
        onError: (e) => {
          // Reject/suspend errors show inside their dialog; approve has none.
          if (!statusFor) window.alert(humanizeError(e));
        },
      },
    );
  }

  const FILTERS = [
    { key: 'all' as const, label: `All (${stats.total})` },
    { key: 'online' as const, label: `Online (${stats.online})` },
    { key: 'pending' as const, label: `Pending approval (${stats.pending})` },
    { key: 'owing' as const, label: `Owing commission (${stats.owing})` },
  ];

  const busy = (id: string) => setDriverStatus.isPending && setDriverStatus.variables?.driverId === id;

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Riders"
          subtitle="Approve sign-ups, review documents, and settle commission."
        />

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Registered" value={String(stats.total)} />
          <Stat label="Online now" value={String(stats.online)} tone="text-ok" />
          {/*
            `dispatchable` is the number that matters, and it is often lower
            than `online`: a driver can be toggled on but stale, over their
            credit limit, or already on a job. A dispatcher who only sees
            "online" will wonder why bookings are not being taken.
          */}
          <Stat
            label="Actually dispatchable"
            value={String(stats.dispatchable)}
            tone={stats.dispatchable < stats.online ? 'text-brand' : 'text-ok'}
          />
          <Stat
            label="Awaiting approval"
            value={String(stats.pending)}
            tone={stats.pending > 0 ? 'text-brand' : undefined}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Search name, phone or plate"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              variant={filter === f.key ? 'primary' : 'secondary'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <Card>
            <p className="text-sm text-muted">Loading roster…</p>
          </Card>
        ) : error ? (
          <Card>
            <p className="text-sm text-bad">{humanizeError(error)}</p>
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-muted">No riders match that filter.</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((driver) => {
              const owed = Math.abs(Math.min(0, driver.wallet_balance_centavos));
              const blocked = driver.wallet_balance_centavos <= driver.credit_floor_centavos;
              const staleMinutes = minutesSince(driver.location_updated_at);

              return (
                <Card key={driver.id}>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/drivers/${driver.id}`}
                        className="font-semibold hover:text-brand hover:underline"
                      >
                        {driver.full_name || 'Unnamed'}
                      </Link>
                      <a className="text-sm text-info hover:underline" href={`tel:${driver.phone}`}>
                        {formatPhPhone(driver.phone)}
                      </a>

                      <Badge
                        tone={
                          driver.status === 'approved'
                            ? 'success'
                            : driver.status === 'pending'
                              ? 'attention'
                              : 'danger'
                        }
                      >
                        {driver.status}
                      </Badge>

                      {driver.is_online ? (
                        <Badge tone={driver.is_dispatchable ? 'success' : 'danger'}>
                          {driver.is_dispatchable ? 'dispatchable' : 'online but unavailable'}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">offline</Badge>
                      )}

                      {driver.pending_documents > 0 ? (
                        <Badge tone="attention">{driver.pending_documents} docs to review</Badge>
                      ) : null}

                      {driver.is_blocked ? <Badge tone="danger">blocked</Badge> : null}

                      <span className="ml-auto text-sm text-muted">
                        {driver.rating !== null
                          ? `★ ${Number(driver.rating).toFixed(1)} (${driver.rating_count})`
                          : 'no rating'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                          Motorcycle
                        </div>
                        <div>
                          {driver.vehicle_make} {driver.vehicle_model}
                        </div>
                        <div className="font-mono text-xs text-muted">
                          {driver.plate_number || '—'}
                        </div>
                      </div>

                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                          Completed
                        </div>
                        <div className="tabular-nums">{driver.completed_jobs}</div>
                        <div className="text-xs text-muted">{driver.cancelled_jobs} cancelled</div>
                      </div>

                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                          Wallet
                        </div>
                        <div
                          className={`tabular-nums font-semibold ${
                            blocked ? 'text-bad' : owed > 0 ? 'text-brand' : 'text-ok'
                          }`}
                        >
                          {formatPeso(driver.wallet_balance_centavos)}
                        </div>
                        {blocked ? (
                          <div className="text-xs text-bad">over limit — cannot work</div>
                        ) : null}
                      </div>

                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                          Last seen
                        </div>
                        <div className="tabular-nums">
                          {staleMinutes === null
                            ? 'never'
                            : staleMinutes < 2
                              ? 'just now'
                              : `${staleMinutes}m ago`}
                        </div>
                      </div>

                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">
                          On a job
                        </div>
                        <div>{driver.active_job_id ? 'yes' : 'no'}</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                      {driver.status === 'pending' ? (
                        <>
                          <Button
                            disabled={busy(driver.id)}
                            onClick={() => changeStatus(driver.id, 'approved')}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busy(driver.id)}
                            onClick={() => setStatusFor({ driver, status: 'rejected' })}
                          >
                            Reject
                          </Button>
                        </>
                      ) : driver.status === 'approved' ? (
                        <Button
                          variant="danger"
                          disabled={busy(driver.id)}
                          onClick={() => setStatusFor({ driver, status: 'suspended' })}
                        >
                          Suspend
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={busy(driver.id)}
                          onClick={() => changeStatus(driver.id, 'approved')}
                        >
                          Reinstate
                        </Button>
                      )}

                      <Button
                        variant="secondary"
                        onClick={() => setTopupFor(driver)}
                      >
                        Record cash top-up
                      </Button>

                      <Link href={`/drivers/${driver.id}`} className={linkButton}>
                        {driver.pending_documents > 0 ? 'Review documents' : 'Details & wallet'}
                      </Link>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <TopupDialog driver={topupFor} onClose={() => setTopupFor(null)} />

      <PromptDialog
        open={statusFor !== null}
        title={
          statusFor?.status === 'rejected'
            ? `Reject ${statusFor.driver.full_name || 'this rider'}?`
            : `Suspend ${statusFor?.driver.full_name || 'this rider'}?`
        }
        description="They are taken offline immediately. The reason is kept on their record."
        label="Reason"
        placeholder={
          statusFor?.status === 'rejected' ? 'Licence expired' : 'Customer complaint, under review'
        }
        confirmLabel={statusFor?.status === 'rejected' ? 'Reject' : 'Suspend'}
        danger
        required
        busy={setDriverStatus.isPending}
        error={setDriverStatus.error ? humanizeError(setDriverStatus.error) : null}
        onCancel={() => setStatusFor(null)}
        onConfirm={(reason) => {
          if (statusFor) changeStatus(statusFor.driver.id, statusFor.status, reason.trim());
        }}
      />
    </Shell>
  );
}
