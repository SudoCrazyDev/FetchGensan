'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { DocumentType, DriverStatus } from '@fetch/api';
import {
  useAdminDriver,
  useAdminJobs,
  useReviewDocument,
  useSetBlocked,
  useSetCreditFloor,
  useSetDriverStatus,
  useWalletAdjustment,
} from '@fetch/api/admin';
import { useProfile } from '@fetch/api/react';
import { formatPeso, formatPhPhone, pesos } from '@fetch/core';

import { JobsTable } from '@/components/JobsTable';
import { Shell } from '@/components/Shell';
import { TopupDialog } from '@/components/TopupDialog';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  PageHeader,
  PromptDialog,
  Stat,
  Td,
  Th,
  manilaTime,
} from '@/components/ui';

const DOC_LABELS: Record<DocumentType, string> = {
  drivers_license: "Driver's licence",
  or_cr: 'OR / CR',
  selfie_with_license: 'Selfie with licence',
  vehicle_photo: 'Motorcycle photo',
  nbi_clearance: 'NBI clearance',
  barangay_clearance: 'Barangay clearance',
};

/** Mirrors the required list in apps/driver/app/onboarding.tsx. */
const REQUIRED_DOCS: DocumentType[] = [
  'drivers_license',
  'or_cr',
  'selfie_with_license',
  'vehicle_photo',
];

const TXN_LABELS: Record<string, string> = {
  commission: 'Commission',
  topup: 'Top-up',
  payout: 'Payout',
  adjustment: 'Adjustment',
  errand_float: 'Errand float',
};

type Dialog =
  | { kind: 'reject-doc'; docId: string; label: string }
  | { kind: 'status'; status: DriverStatus }
  | { kind: 'block' }
  | { kind: 'adjust' }
  | { kind: 'adjust-note'; amountCentavos: number }
  | { kind: 'floor' }
  | { kind: 'topup' }
  | null;

export default function DriverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useAdminDriver(id);
  const { data: jobs } = useAdminJobs({ driverId: id }, 25);
  const { data: me } = useProfile();
  const isAdmin = me?.role === 'admin';

  const review = useReviewDocument();
  const setStatus = useSetDriverStatus();
  const setBlocked = useSetBlocked();
  const adjust = useWalletAdjustment();
  const setFloor = useSetCreditFloor();

  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  if (isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading rider…</p>
      </Shell>
    );
  }

  const roster = data?.roster;
  const driver = data?.driver;

  if (error || !roster || !driver) {
    return (
      <Shell>
        <Card>
          <p className="text-sm text-bad">{error ? humanizeError(error) : 'Rider not found.'}</p>
          <Link href="/drivers" className="mt-2 inline-block text-sm text-info hover:underline">
            ← Back to riders
          </Link>
        </Card>
      </Shell>
    );
  }

  const documents = data.documents;
  const byType = new Map(documents.map((d) => [d.doc_type, d]));
  const missingRequired = REQUIRED_DOCS.filter((t) => !byType.has(t));
  const unapprovedRequired = REQUIRED_DOCS.filter((t) => byType.get(t)?.status !== 'approved');
  const blocked = roster.wallet_balance_centavos <= roster.credit_floor_centavos;

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <Link href="/drivers" className="text-sm text-muted hover:text-ink">
          ← All riders
        </Link>

        <PageHeader
          title={roster.full_name || 'Unnamed rider'}
          subtitle={
            <span className="flex flex-wrap items-center gap-2">
              <a className="text-info hover:underline" href={`tel:${roster.phone}`}>
                {formatPhPhone(roster.phone)}
              </a>
              <Badge
                tone={
                  roster.status === 'approved'
                    ? 'success'
                    : roster.status === 'pending'
                      ? 'attention'
                      : 'danger'
                }
              >
                {roster.status}
              </Badge>
              {roster.is_online ? (
                <Badge tone={roster.is_dispatchable ? 'success' : 'danger'}>
                  {roster.is_dispatchable ? 'online · dispatchable' : 'online · unavailable'}
                </Badge>
              ) : (
                <Badge>offline</Badge>
              )}
              {roster.is_blocked ? <Badge tone="danger">blocked</Badge> : null}
            </span>
          }
          actions={
            <>
              {roster.status === 'approved' ? (
                <Button
                  variant="danger"
                  onClick={() => setDialog({ kind: 'status', status: 'suspended' })}
                >
                  Suspend
                </Button>
              ) : (
                <Button
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ driverId: id, status: 'approved' })}
                >
                  {roster.status === 'pending' ? 'Approve rider' : 'Reinstate'}
                </Button>
              )}
              {roster.status === 'pending' ? (
                <Button
                  variant="danger"
                  onClick={() => setDialog({ kind: 'status', status: 'rejected' })}
                >
                  Reject
                </Button>
              ) : null}
              {roster.is_blocked ? (
                <Button
                  variant="secondary"
                  disabled={setBlocked.isPending}
                  onClick={() => setBlocked.mutate({ profileId: id, blocked: false })}
                >
                  Unblock account
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setDialog({ kind: 'block' })}>
                  Block account
                </Button>
              )}
            </>
          }
        />

        <ErrorNote error={setStatus.error && dialog === null ? setStatus.error : null} />

        {roster.status === 'pending' && unapprovedRequired.length > 0 ? (
          <Card className="border-brand/50 bg-brand/5">
            <p className="text-sm">
              {missingRequired.length > 0
                ? `Still missing: ${missingRequired.map((t) => DOC_LABELS[t]).join(', ')}.`
                : `Approve each required document before approving the rider: ${unapprovedRequired
                    .map((t) => DOC_LABELS[t])
                    .join(', ')}.`}
            </p>
          </Card>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Wallet"
            value={formatPeso(roster.wallet_balance_centavos)}
            tone={blocked ? 'text-bad' : roster.wallet_balance_centavos < 0 ? 'text-brand' : 'text-ok'}
          />
          <Stat label="Credit limit" value={formatPeso(roster.credit_floor_centavos)} />
          <Stat label="Completed" value={String(roster.completed_jobs)} />
          <Stat
            label="Rating"
            value={
              roster.rating !== null
                ? `★ ${Number(roster.rating).toFixed(1)} (${roster.rating_count})`
                : '—'
            }
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          {/* ------------------------------------------------ vehicle */}
          <Card>
            <h2 className="mb-3 font-semibold">Motorcycle</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">Make & model</dt>
                <dd>
                  {driver.vehicle_make} {driver.vehicle_model}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">Colour</dt>
                <dd>{driver.vehicle_color || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">Plate</dt>
                <dd className="font-mono">{driver.plate_number || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">Licence no.</dt>
                <dd className="font-mono">{driver.license_number || '—'}</dd>
              </div>
            </dl>
          </Card>

          {/* ------------------------------------------------ wallet actions */}
          <Card>
            <h2 className="mb-1 font-semibold">Wallet</h2>
            <p className="mb-3 text-sm text-muted">
              {blocked
                ? 'Over the credit limit: they cannot go online until they top up.'
                : roster.wallet_balance_centavos < 0
                  ? `Owes ${formatPeso(Math.abs(roster.wallet_balance_centavos))} in commission.`
                  : 'Nothing owed.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setDialog({ kind: 'topup' })}>Record cash top-up</Button>
              {isAdmin ? (
                <>
                  <Button variant="secondary" onClick={() => setDialog({ kind: 'adjust' })}>
                    Adjustment…
                  </Button>
                  <Button variant="secondary" onClick={() => setDialog({ kind: 'floor' })}>
                    Change credit limit
                  </Button>
                </>
              ) : (
                <span className="self-center text-xs text-muted">
                  Adjustments and credit limits need an admin.
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------ documents */}
        <Card>
          <h2 className="mb-3 font-semibold">Documents</h2>
          {documents.length === 0 ? (
            <p className="text-sm text-muted">Nothing uploaded yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {documents.map((doc) => {
                const isPdf = doc.storage_path.toLowerCase().endsWith('.pdf');
                return (
                  <div key={doc.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{DOC_LABELS[doc.doc_type]}</span>
                      <Badge
                        tone={
                          doc.status === 'approved'
                            ? 'success'
                            : doc.status === 'rejected'
                              ? 'danger'
                              : 'attention'
                        }
                      >
                        {doc.status}
                      </Badge>
                    </div>
                    {doc.url ? (
                      isPdf ? (
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded bg-raised p-6 text-center text-sm text-info hover:underline"
                        >
                          Open PDF
                        </a>
                      ) : (
                        <a href={doc.url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element -- signed, expiring URL */}
                          <img
                            src={doc.url}
                            alt={DOC_LABELS[doc.doc_type]}
                            className="h-44 w-full rounded bg-raised object-contain"
                          />
                        </a>
                      )
                    ) : (
                      <div className="rounded bg-raised p-6 text-center text-xs text-muted">
                        File unavailable
                      </div>
                    )}
                    <div className="text-xs text-muted">Uploaded {manilaTime(doc.created_at)}</div>
                    {doc.status === 'rejected' && doc.reject_reason ? (
                      <div className="text-xs text-bad">Rejected: {doc.reject_reason}</div>
                    ) : null}
                    <div className="flex gap-2">
                      <Button
                        disabled={doc.status === 'approved' || review.isPending}
                        onClick={() =>
                          review.mutate({ driverId: id, docId: doc.id, status: 'approved' })
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={doc.status === 'rejected' || review.isPending}
                        onClick={() =>
                          setDialog({
                            kind: 'reject-doc',
                            docId: doc.id,
                            label: DOC_LABELS[doc.doc_type],
                          })
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <ErrorNote error={dialog === null ? review.error : null} />
        </Card>

        {/* ------------------------------------------------ ledger */}
        <Card>
          <h2 className="mb-3 font-semibold">Ledger</h2>
          {data.wallet.length === 0 ? (
            <p className="text-sm text-muted">No wallet activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <Th>When</Th>
                    <Th>Type</Th>
                    <Th>Note</Th>
                    <Th right>Amount</Th>
                    <Th right>Balance after</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.wallet.map((t) => (
                    <tr key={t.id}>
                      <Td className="whitespace-nowrap text-muted">{manilaTime(t.created_at)}</Td>
                      <Td>{TXN_LABELS[t.kind] ?? t.kind}</Td>
                      <Td className="text-muted">{t.note}</Td>
                      <Td right className={t.amount_centavos < 0 ? 'text-bad' : 'text-ok'}>
                        {t.amount_centavos > 0 ? '+' : ''}
                        {formatPeso(t.amount_centavos)}
                      </Td>
                      <Td right>{formatPeso(t.balance_after_centavos)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ------------------------------------------------ trips */}
        <Card>
          <h2 className="mb-3 font-semibold">Recent bookings</h2>
          <JobsTable jobs={jobs ?? []} hide={['driver']} />
        </Card>
      </div>

      {/* ------------------------------------------------ dialogs */}

      <TopupDialog
        driver={dialog?.kind === 'topup' ? roster : null}
        onClose={close}
      />

      <PromptDialog
        open={dialog?.kind === 'reject-doc'}
        title={`Reject ${dialog?.kind === 'reject-doc' ? dialog.label : ''}?`}
        description="The rider sees this reason and can upload a new photo."
        label="Reason"
        placeholder="Blurry — retake in daylight with all four corners visible"
        confirmLabel="Reject document"
        danger
        required
        busy={review.isPending}
        error={review.error ? humanizeError(review.error) : null}
        onCancel={close}
        onConfirm={(reason) => {
          if (dialog?.kind !== 'reject-doc') return;
          review.mutate(
            { driverId: id, docId: dialog.docId, status: 'rejected', reason: reason.trim() },
            { onSuccess: close },
          );
        }}
      />

      <PromptDialog
        open={dialog?.kind === 'status'}
        title={
          dialog?.kind === 'status' && dialog.status === 'rejected'
            ? 'Reject this rider?'
            : 'Suspend this rider?'
        }
        description="They are taken offline immediately. The reason is kept on their record."
        label="Reason"
        confirmLabel={dialog?.kind === 'status' && dialog.status === 'rejected' ? 'Reject' : 'Suspend'}
        danger
        required
        busy={setStatus.isPending}
        error={setStatus.error ? humanizeError(setStatus.error) : null}
        onCancel={close}
        onConfirm={(reason) => {
          if (dialog?.kind !== 'status') return;
          setStatus.mutate(
            { driverId: id, status: dialog.status, reason: reason.trim() },
            { onSuccess: close },
          );
        }}
      />

      <PromptDialog
        open={dialog?.kind === 'block'}
        title="Block this account?"
        description="A blocked rider is taken offline and cannot receive bookings. Use Suspend for a temporary stop."
        label="Reason"
        confirmLabel="Block"
        danger
        required
        busy={setBlocked.isPending}
        error={setBlocked.error ? humanizeError(setBlocked.error) : null}
        onCancel={close}
        onConfirm={(note) =>
          setBlocked.mutate({ profileId: id, blocked: true, note: note.trim() }, { onSuccess: close })
        }
      />

      <PromptDialog
        open={dialog?.kind === 'adjust'}
        title="Wallet adjustment"
        description="Positive credits the rider (a refund of commission, a payout correction). Negative debits them. Cash top-ups have their own button."
        label="Amount (₱, e.g. 50 or -50)"
        inputMode="decimal"
        confirmLabel="Next"
        required
        onCancel={close}
        onConfirm={(value) => {
          const amount = Number(value);
          if (!Number.isFinite(amount) || amount === 0) return;
          setDialog({ kind: 'adjust-note', amountCentavos: pesos(amount) });
        }}
      />

      <PromptDialog
        open={dialog?.kind === 'adjust-note'}
        title={`Adjust by ${dialog?.kind === 'adjust-note' ? formatPeso(dialog.amountCentavos) : ''}`}
        description="This goes in the ledger the rider sees. Say exactly why."
        label="Note"
        placeholder="Refund of commission on FG-ABC123 (customer no-show)"
        confirmLabel="Post adjustment"
        required
        busy={adjust.isPending}
        error={adjust.error ? humanizeError(adjust.error) : null}
        onCancel={close}
        onConfirm={(note) => {
          if (dialog?.kind !== 'adjust-note') return;
          adjust.mutate(
            { driverId: id, amountCentavos: dialog.amountCentavos, note: note.trim() },
            { onSuccess: close },
          );
        }}
      />

      <PromptDialog
        open={dialog?.kind === 'floor'}
        title="Credit limit"
        description="How much commission this rider may owe before they are stopped from going online."
        label="Maximum owed (₱)"
        inputMode="decimal"
        initialValue={String(Math.abs(roster.credit_floor_centavos) / 100)}
        confirmLabel="Save limit"
        required
        busy={setFloor.isPending}
        error={setFloor.error ? humanizeError(setFloor.error) : null}
        onCancel={close}
        onConfirm={(value) => {
          const amount = Number(value);
          if (!Number.isFinite(amount) || amount < 0) return;
          setFloor.mutate(
            { driverId: id, floorCentavos: -pesos(amount) },
            { onSuccess: close },
          );
        }}
      />
    </Shell>
  );
}
