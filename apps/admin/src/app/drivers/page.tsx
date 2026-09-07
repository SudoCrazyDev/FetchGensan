'use client';

import { useMemo, useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useApi, useRecordTopup, useRoster } from '@fetch/api/react';
import { formatPeso, formatPhPhone, pesos } from '@fetch/core';

import { Shell } from '@/components/Shell';
import { Badge, Button, Card, Stat } from '@/components/ui';

function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}

export default function DriversPage() {
  const api = useApi();
  const { data: roster, isLoading, refetch } = useRoster();
  const topup = useRecordTopup();

  const [filter, setFilter] = useState<'all' | 'online' | 'pending' | 'owing'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

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
    const rows = roster ?? [];
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
  }, [roster, filter]);

  async function setStatus(driverId: string, status: string) {
    setBusyId(driverId);
    try {
      await api.dispatch.setDriverStatus(driverId, status);
      await refetch();
    } catch (e) {
      window.alert(humanizeError(e));
    } finally {
      setBusyId(null);
    }
  }

  function recordTopup(driverId: string, owed: number) {
    const input = window.prompt(
      `How much cash did they hand over? (pesos)\nThey currently owe ${formatPeso(owed)}.`,
      String(Math.ceil(owed / 100)),
    );
    if (input === null) return;

    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert('Enter a positive amount in pesos.');
      return;
    }

    topup.mutate({
      driverId,
      amountCentavos: pesos(amount),
      note: 'Cash top-up at dispatch office',
    });
  }

  const FILTERS = [
    { key: 'all' as const, label: `All (${stats.total})` },
    { key: 'online' as const, label: `Online (${stats.online})` },
    { key: 'pending' as const, label: `Pending approval (${stats.pending})` },
    { key: 'owing' as const, label: `Owing commission (${stats.owing})` },
  ];

  return (
    <Shell>
      <div className="flex flex-col gap-5">
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

        <div className="flex flex-wrap gap-2">
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
        ) : visible.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-muted">No drivers match that filter.</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((driver) => {
              const owed = Math.abs(Math.min(0, driver.wallet_balance_centavos));
              const blocked =
                driver.wallet_balance_centavos <= driver.credit_floor_centavos;
              const staleMinutes = minutesSince(driver.location_updated_at);

              return (
                <Card key={driver.id}>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{driver.full_name || 'Unnamed'}</span>
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
                          ? `★ ${driver.rating.toFixed(1)} (${driver.rating_count})`
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
                        <div className="text-xs text-muted">
                          {driver.cancelled_jobs} cancelled
                        </div>
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
                            disabled={busyId === driver.id}
                            onClick={() => void setStatus(driver.id, 'approved')}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busyId === driver.id}
                            onClick={() => void setStatus(driver.id, 'rejected')}
                          >
                            Reject
                          </Button>
                        </>
                      ) : driver.status === 'approved' ? (
                        <Button
                          variant="danger"
                          disabled={busyId === driver.id}
                          onClick={() => void setStatus(driver.id, 'suspended')}
                        >
                          Suspend
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={busyId === driver.id}
                          onClick={() => void setStatus(driver.id, 'approved')}
                        >
                          Reinstate
                        </Button>
                      )}

                      {owed > 0 ? (
                        <Button
                          variant="secondary"
                          disabled={topup.isPending}
                          onClick={() => recordTopup(driver.id, owed)}
                        >
                          Record cash top-up
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}
