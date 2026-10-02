'use client';

import { useMemo, useState } from 'react';

import { humanizeError } from '@fetch/api';
import type { AdminLandmarkRow } from '@fetch/api';
import { useAdminLandmarks, useSaveLandmark } from '@fetch/api/admin';
import { looksInServiceArea } from '@fetch/core';

import { Shell } from '@/components/Shell';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  FieldRow,
  Modal,
  PageHeader,
  SubmitButton,
  Td,
  Th,
  inputClass,
} from '@/components/ui';

const CATEGORIES = [
  'mall',
  'market',
  'terminal',
  'transport',
  'hospital',
  'school',
  'government',
  'church',
  'landmark',
  'general',
];

/**
 * Reads a coordinate the way people actually copy one: "6.1128, 125.1719"
 * from a long-press in Google Maps, or a whole maps URL with @lat,lng or
 * ?q=lat,lng in it.
 */
function parseCoordinate(text: string): { latitude: number; longitude: number } | null {
  const match =
    text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ??
    text.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ??
    text.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function mapsLink(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function LandmarkForm({
  landmark,
  onDone,
}: {
  landmark: AdminLandmarkRow | null;
  onDone: () => void;
}) {
  const save = useSaveLandmark();
  const [name, setName] = useState(landmark?.name ?? '');
  const [category, setCategory] = useState(landmark?.category ?? 'landmark');
  const [coords, setCoords] = useState(
    landmark ? `${landmark.lat.toFixed(6)}, ${landmark.lng.toFixed(6)}` : '',
  );
  const [active, setActive] = useState(landmark?.is_active ?? true);

  const parsed = parseCoordinate(coords);
  const outside = parsed ? !looksInServiceArea(parsed) : false;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed || !name.trim()) return;
        save.mutate(
          {
            id: landmark?.id ?? null,
            name: name.trim(),
            category,
            location: parsed,
            isActive: active,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <FieldRow label="Name" hint="What customers search for. Use the name people say out loud.">
        <input
          autoFocus
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bulaong Terminal"
        />
      </FieldRow>

      <FieldRow label="Category">
        <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
          {Array.from(new Set([...CATEGORIES, category])).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow
        label="Coordinates"
        hint="Long-press the exact gate in Google Maps and paste the numbers, or paste the whole link."
      >
        <input
          className={`${inputClass} font-mono`}
          value={coords}
          onChange={(e) => setCoords(e.target.value)}
          placeholder="6.112800, 125.171900"
        />
      </FieldRow>

      {coords && !parsed ? (
        <p className="text-sm text-bad">That does not look like a coordinate.</p>
      ) : parsed ? (
        <p className="text-sm text-muted">
          {parsed.latitude.toFixed(6)}, {parsed.longitude.toFixed(6)} ·{' '}
          <a
            className="text-info hover:underline"
            href={mapsLink(parsed.latitude, parsed.longitude)}
            target="_blank"
            rel="noreferrer"
          >
            check on Google Maps ↗
          </a>
          {outside ? <span className="ml-2 text-bad">Outside the service area.</span> : null}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Offer this landmark to customers
      </label>

      <ErrorNote error={save.error} />

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton disabled={!parsed || !name.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : landmark ? 'Save changes' : 'Add landmark'}
        </SubmitButton>
      </div>
    </form>
  );
}

export default function LandmarksPage() {
  const { data: landmarks, isLoading, error } = useAdminLandmarks();
  const [editing, setEditing] = useState<AdminLandmarkRow | 'new' | null>(null);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (landmarks ?? []).filter(
      (l) => !term || l.name.toLowerCase().includes(term) || l.category.includes(term),
    );
  }, [landmarks, search]);

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Landmarks"
          subtitle="What customers pick from when booking. A landmark 400 m off sends a rider to the wrong gate — verify each one on the ground."
          actions={<Button onClick={() => setEditing('new')}>Add landmark</Button>}
        />

        <input
          className={`${inputClass} max-w-sm`}
          placeholder="Search landmarks"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <Card>
          {isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : error ? (
            <p className="text-sm text-bad">{humanizeError(error)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <Th>Name</Th>
                    <Th>Category</Th>
                    <Th>Coordinates</Th>
                    <Th right>Times used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visible.map((l) => (
                    <tr key={l.id} className={l.is_active ? '' : 'opacity-50'}>
                      <Td>
                        <span className="font-semibold">{l.name}</span>
                        {!l.is_active ? (
                          <span className="ml-2">
                            <Badge>hidden</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="text-muted">{l.category}</Td>
                      <Td>
                        <a
                          className="font-mono text-xs text-info hover:underline"
                          href={mapsLink(l.lat, l.lng)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {l.lat.toFixed(5)}, {l.lng.toFixed(5)} ↗
                        </a>
                      </Td>
                      <Td right>{l.use_count}</Td>
                      <Td right>
                        <Button variant="secondary" onClick={() => setEditing(l)}>
                          Edit
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Add a landmark' : 'Edit landmark'}
        onClose={() => setEditing(null)}
      >
        {editing !== null ? (
          <LandmarkForm
            key={editing === 'new' ? 'new' : editing.id}
            landmark={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Modal>
    </Shell>
  );
}
