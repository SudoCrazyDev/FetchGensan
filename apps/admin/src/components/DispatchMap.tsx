'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { DispatchBoardRow } from '@fetch/api';
import { GENSAN_CENTER, MAP_STYLE } from '@fetch/core';

// Served from public/ -- see scripts/copy-maplibre-worker.mjs.
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

interface Props {
  jobs: DispatchBoardRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function pickupColor(job: DispatchBoardRow): string {
  if (job.status !== 'searching') return '#3b82f6';
  return job.age_seconds > 180 ? '#ef4444' : '#fba338';
}

function pickupPin(job: DispatchBoardRow, selected: boolean, onClick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.title = `${job.reference} · ${job.pickup_label || 'pickup'}`;
  el.setAttribute('aria-label', el.title);
  const size = selected ? 26 : 18;
  Object.assign(el.style, {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50% 50% 50% 0',
    transform: 'rotate(-45deg)',
    background: pickupColor(job),
    border: '2px solid #020617',
    cursor: 'pointer',
    padding: '0',
  });
  el.addEventListener('click', onClick);
  return el;
}

function driverPin(job: DispatchBoardRow, onClick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.title = `${job.driver_name} · ${job.plate_number}`;
  el.setAttribute('aria-label', el.title);
  el.textContent = '🛵';
  Object.assign(el.style, {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: '#22c55e',
    border: '2px solid #020617',
    fontSize: '13px',
    lineHeight: '24px',
    cursor: 'pointer',
    padding: '0',
  });
  el.addEventListener('click', onClick);
  return el;
}

/**
 * The spatial view of the board, on MapLibre with OpenStreetMap tiles.
 *
 * Shows the pickup of every in-flight job, and the live position of drivers
 * who are on one. What it deliberately does not show is every idle online
 * driver: with a fleet of tens that turns the map into confetti and the
 * dispatcher stops using it. The roster page is where you go to see who is
 * free.
 */
export function DispatchMap({ jobs, selectedId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const select = useRef(onSelect);

  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!container.current) return;
    map.current = new maplibregl.Map({
      container: container.current,
      // The console is dark all shift; so is its map.
      style: MAP_STYLE.dark,
      center: [GENSAN_CENTER.longitude, GENSAN_CENTER.latitude],
      zoom: 13,
    });
    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const marker of markers.current) marker.remove();

    const next: maplibregl.Marker[] = [];
    for (const job of jobs) {
      next.push(
        new maplibregl.Marker({
          element: pickupPin(job, job.id === selectedId, () => select.current(job.id)),
        })
          .setLngLat([job.pickup_lng, job.pickup_lat])
          .addTo(m),
      );
      if (job.driver_lat !== null && job.driver_lng !== null) {
        next.push(
          new maplibregl.Marker({ element: driverPin(job, () => select.current(job.id)) })
            .setLngLat([job.driver_lng, job.driver_lat])
            .addTo(m),
        );
      }
    }
    markers.current = next;
  }, [jobs, selectedId]);

  return (
    <div className="relative h-full min-h-[300px] overflow-hidden rounded-xl border border-line">
      {/* Inline, not a class: maplibre-gl.css sets `position: relative` on the
          map container, which beats Tailwind's `absolute` and collapses it
          to zero height. */}
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
