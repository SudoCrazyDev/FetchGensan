'use client';

import { useMemo, useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { FareConfigRow, FareUpdateInput } from '@fetch/api';
import { useFareHistory, useUpdateFare } from '@fetch/api/admin';
import { useProfile } from '@fetch/api/react';
import {
  JOB_TYPES,
  JOB_TYPE_LABELS,
  type JobType,
  fareConfigFromRow,
  formatBps,
  formatPeso,
  pesos,
  quoteFare,
} from '@fetch/core';

import { Shell } from '@/components/Shell';
import { Card, ErrorNote, FieldRow, PageHeader, SubmitButton, Td, Th, inputClass, manilaTime } from '@/components/ui';

/** Form state is strings in display units (pesos, km, %), converted on save. */
interface Draft {
  base: string;
  includedKm: string;
  perKm: string;
  perMinute: string;
  minFare: string;
  serviceFee: string;
  night: string;
  nightStarts: string;
  nightEnds: string;
  commissionPct: string;
  maxFloat: string;
}

function draftFrom(row: FareRow): Draft {
  return {
    base: String(row.base_fare_centavos / 100),
    includedKm: String(row.included_meters / 1000),
    perKm: String(row.per_km_centavos / 100),
    perMinute: String(row.per_minute_centavos / 100),
    minFare: String(row.min_fare_centavos / 100),
    serviceFee: String(row.service_fee_centavos / 100),
    night: String(row.night_surcharge_centavos / 100),
    nightStarts: String(row.night_starts_hour),
    nightEnds: String(row.night_ends_hour),
    commissionPct: String(row.commission_bps / 100),
    maxFloat: String(row.max_item_float_centavos / 100),
  };
}

const FIELD_NAMES: Record<keyof Draft, string> = {
  base: 'Base fare',
  includedKm: 'Included distance',
  perKm: 'Per km',
  perMinute: 'Per minute',
  minFare: 'Minimum fare',
  serviceFee: 'Service fee',
  night: 'Night surcharge',
  nightStarts: 'Night starts',
  nightEnds: 'Night ends',
  commissionPct: 'Commission',
  maxFloat: 'Max item float',
};

type FareRow = FareConfigRow & { effective_from: string };

function toInput(d: Draft): FareUpdateInput | string {
  const n = (v: string) => Number(v.trim());
  for (const key of Object.keys(d) as (keyof Draft)[]) {
    const value = d[key];
    if (value.trim() === '' || !Number.isFinite(n(value)) || n(value) < 0) {
      return `${FIELD_NAMES[key]} must be a number, zero or more.`;
    }
  }
  const hours = [n(d.nightStarts), n(d.nightEnds)];
  if (hours.some((h) => !Number.isInteger(h) || h > 23)) {
    return 'Night hours must be whole hours between 0 and 23.';
  }
  if (n(d.commissionPct) > 50) return 'Commission is capped at 50%.';

  return {
    base_fare_centavos: pesos(n(d.base)),
    included_meters: Math.round(n(d.includedKm) * 1000),
    per_km_centavos: pesos(n(d.perKm)),
    per_minute_centavos: pesos(n(d.perMinute)),
    min_fare_centavos: pesos(n(d.minFare)),
    service_fee_centavos: pesos(n(d.serviceFee)),
    night_surcharge_centavos: pesos(n(d.night)),
    night_starts_hour: n(d.nightStarts),
    night_ends_hour: n(d.nightEnds),
    commission_bps: Math.round(n(d.commissionPct) * 100),
    max_item_float_centavos: pesos(n(d.maxFloat)),
  };
}

const SAMPLE_KM = [1, 3, 5, 10];

function FareCard({ row, editable }: { row: FareRow; editable: boolean }) {
  const update = useUpdateFare();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(row));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = toInput(draft);
  const preview = useMemo(() => {
    if (typeof parsed === 'string') return null;
    const cfg = fareConfigFromRow({ ...parsed, job_type: row.job_type });
    // A fixed weekday noon and a fixed 1am, so the preview does not depend
    // on when somebody happens to open the page.
    const day = new Date('2026-01-07T04:00:00Z');
    const night = new Date('2026-01-07T17:00:00Z');
    return SAMPLE_KM.map((km) => {
      const m = km * 1000;
      const secs = Math.round((m / 1000 / 22) * 3600);
      return {
        km,
        day: quoteFare(cfg, m, secs, day).totalCentavos,
        night: quoteFare(cfg, m, secs, night).totalCentavos,
      };
    });
  }, [parsed, row.job_type]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(row));

  function field(key: keyof Draft, label: string, hint?: string) {
    return (
      <FieldRow label={label} hint={hint}>
        <input
          className={inputClass}
          inputMode="decimal"
          value={draft[key]}
          disabled={!editable}
          onChange={(e) => {
            setSaved(false);
            setDraft({ ...draft, [key]: e.target.value });
          }}
        />
      </FieldRow>
    );
  }

  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const input = toInput(draft);
          if (typeof input === 'string') {
            setProblem(input);
            return;
          }
          setProblem(null);
          if (!window.confirm(`Change ${JOB_TYPE_LABELS[row.job_type]} pricing for every new booking?`)) {
            return;
          }
          update.mutate(
            { jobType: row.job_type, input },
            { onSuccess: () => setSaved(true) },
          );
        }}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">{JOB_TYPE_LABELS[row.job_type]}</h2>
          <span className="text-xs text-muted">
            commission {formatBps(row.commission_bps)} · live since {manilaTime(row.effective_from)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {field('base', 'Base fare (₱)')}
          {field('includedKm', 'Included distance (km)', 'Covered by the base fare')}
          {field('perKm', 'Per km after that (₱)')}
          {field('perMinute', 'Per minute (₱)', 'Usually 0')}
          {field('minFare', 'Minimum fare (₱)')}
          {field('serviceFee', 'Service fee (₱)', row.job_type === 'ride' ? 'Usually 0 for rides' : 'Handling fee')}
          {field('night', 'Night surcharge (₱)')}
          {field('nightStarts', 'Night starts (hour)', '24h, Manila time')}
          {field('nightEnds', 'Night ends (hour)')}
          {field('commissionPct', 'Our commission (%)', 'On the fare, never on errand goods')}
          {row.job_type === 'errand'
            ? field('maxFloat', 'Max item float (₱)', 'Most a rider fronts before dispatch must approve')
            : null}
        </div>

        {preview ? (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <Th>Trip</Th>
                  {preview.map((p) => (
                    <Th key={p.km} right>
                      {p.km} km
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <Td className="text-muted">Daytime</Td>
                  {preview.map((p) => (
                    <Td key={p.km} right>
                      {formatPeso(p.day)}
                    </Td>
                  ))}
                </tr>
                <tr>
                  <Td className="text-muted">Night</Td>
                  {preview.map((p) => (
                    <Td key={p.km} right>
                      {formatPeso(p.night)}
                    </Td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {problem ? <p className="text-sm text-bad">{problem}</p> : null}
        <ErrorNote error={update.error} />
        {saved && !dirty ? <p className="text-sm text-ok">Saved. New bookings use this price now.</p> : null}

        {editable ? (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink disabled:opacity-40"
              disabled={!dirty}
              onClick={() => setDraft(draftFrom(row))}
            >
              Reset
            </button>
            <SubmitButton disabled={!dirty || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save new price'}
            </SubmitButton>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

export default function FaresPage() {
  const { data: history, isLoading, error } = useFareHistory();
  const { data: me } = useProfile();
  const editable = me?.role === 'admin';

  const active = (history ?? []).filter((r) => r.is_active);
  const retired = (history ?? []).filter((r) => !r.is_active).slice(0, 30);

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Fares"
          subtitle={
            editable
              ? 'Changes apply to new bookings immediately. Bookings already made keep the price they were quoted.'
              : 'Read only. Only an admin can change prices.'
          }
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
          JOB_TYPES.map((type: JobType) => {
            const row = active.find((r) => r.job_type === type);
            return row ? (
              // Keyed on the row id so a save remounts the form on the new row.
              <FareCard key={row.id} row={row} editable={editable} />
            ) : (
              <Card key={type}>
                <p className="text-sm text-bad">No active fare for {JOB_TYPE_LABELS[type]}.</p>
              </Card>
            );
          })
        )}

        {retired.length > 0 ? (
          <Card>
            <h2 className="mb-3 font-semibold">Previous prices</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <Th>Live from</Th>
                    <Th>Service</Th>
                    <Th right>Base</Th>
                    <Th right>Per km</Th>
                    <Th right>Minimum</Th>
                    <Th right>Service fee</Th>
                    <Th right>Night</Th>
                    <Th right>Commission</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {retired.map((r) => (
                    <tr key={r.id}>
                      <Td className="text-muted">{manilaTime(r.effective_from)}</Td>
                      <Td>{JOB_TYPE_LABELS[r.job_type]}</Td>
                      <Td right>{formatPeso(r.base_fare_centavos)}</Td>
                      <Td right>{formatPeso(r.per_km_centavos)}</Td>
                      <Td right>{formatPeso(r.min_fare_centavos)}</Td>
                      <Td right>{formatPeso(r.service_fee_centavos)}</Td>
                      <Td right>{formatPeso(r.night_surcharge_centavos)}</Td>
                      <Td right>{formatBps(r.commission_bps)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </div>
    </Shell>
  );
}
