'use client';

import { AdvancedMarker, APIProvider, Map, Pin } from '@vis.gl/react-google-maps';
import { useMemo } from 'react';

import type { DispatchBoardRow } from '@fetch/api';
import { GENSAN_CENTER } from '@fetch/core';

import { Card } from './ui';

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

interface Props {
  jobs: DispatchBoardRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * The spatial view of the board.
 *
 * Shows the pickup of every in-flight job, and the live position of drivers
 * who are on one. What it deliberately does not show is every idle online
 * driver: with a fleet of tens that turns the map into confetti and the
 * dispatcher stops using it. The roster page is where you go to see who is
 * free.
 */
export function DispatchMap({ jobs, selectedId, onSelect }: Props) {
  const withDrivers = useMemo(
    () => jobs.filter((j) => j.driver_lat !== null && j.driver_lng !== null),
    [jobs],
  );

  if (!API_KEY) {
    return (
      <Card className="flex h-full min-h-[300px] items-center justify-center">
        <div className="max-w-xs text-center text-sm text-muted">
          <p className="font-semibold text-ink">Map not configured</p>
          <p className="mt-1">
            Set <code className="rounded bg-raised px-1">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>{' '}
            to see jobs and riders on a map. The board below works without it.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="h-full min-h-[300px] overflow-hidden rounded-xl border border-line">
      <APIProvider apiKey={API_KEY}>
        <Map
          // The Google Maps JS API uses {lat, lng}; our LatLng is
          // {latitude, longitude}. Converted here rather than anywhere
          // deeper, so the mismatch lives in one place.
          defaultCenter={{ lat: GENSAN_CENTER.latitude, lng: GENSAN_CENTER.longitude }}
          defaultZoom={13}
          mapId="fetchgensan-dispatch"
          disableDefaultUI={false}
          gestureHandling="greedy"
          colorScheme="DARK"
          style={{ width: '100%', height: '100%' }}
        >
          {jobs.map((job) => (
            <AdvancedMarker
              key={`pickup-${job.id}`}
              position={{ lat: job.pickup_lat, lng: job.pickup_lng }}
              title={`${job.reference} · ${job.pickup_label || 'pickup'}`}
              onClick={() => onSelect(job.id)}
            >
              <Pin
                background={
                  job.status === 'searching'
                    ? job.age_seconds > 180
                      ? '#ef4444'
                      : '#fba338'
                    : '#3b82f6'
                }
                borderColor="#020617"
                glyphColor="#020617"
                scale={selectedId === job.id ? 1.4 : 1}
              />
            </AdvancedMarker>
          ))}

          {withDrivers.map((job) => (
            <AdvancedMarker
              key={`driver-${job.id}`}
              position={{ lat: job.driver_lat!, lng: job.driver_lng! }}
              title={`${job.driver_name} · ${job.plate_number}`}
              onClick={() => onSelect(job.id)}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg bg-ok text-xs">
                🛵
              </div>
            </AdvancedMarker>
          ))}
        </Map>
      </APIProvider>
    </div>
  );
}
