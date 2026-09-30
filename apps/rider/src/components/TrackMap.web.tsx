/**
 * Web build of the tracking map, on maplibre-gl. Same contract as
 * TrackMap.tsx.
 */

import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { GENSAN_REGION, type LatLng, MAP_STYLE, boundsOf } from '@fetch/core';
import { useTheme } from '@fetch/ui';

// Served from public/ -- see scripts/copy-maplibre-worker.mjs.
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

export interface TrackMapProps {
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  height?: number;
}

function dot(color: string, size: number, ring: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  Object.assign(el.style, {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    background: color,
    border: `3px solid ${ring}`,
    boxSizing: 'border-box',
  });
  return el;
}

export function TrackMap({ driver, pickup, dropoff, height = 240 }: TrackMapProps) {
  const t = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    if (!container.current) return;
    const start = pickup ?? GENSAN_REGION;
    map.current = new maplibregl.Map({
      container: container.current,
      style: t.dark ? MAP_STYLE.dark : MAP_STYLE.light,
      center: [start.longitude, start.latitude],
      zoom: 14,
    });
    return () => {
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;

    for (const marker of markers.current) marker.remove();
    const spec: [LatLng | null | undefined, string, number, string][] = [
      [pickup, '#16A34A', 22, 'Pick-up'],
      [dropoff, '#DC2626', 22, 'Drop-off'],
      [driver, t.color.primary, 34, 'Your rider'],
    ];
    markers.current = spec
      .filter((s): s is [LatLng, string, number, string] => !!s[0])
      .map(([p, color, size, label]) =>
        new maplibregl.Marker({ element: dot(color, size, t.color.surface, label) })
          .setLngLat([p.longitude, p.latitude])
          .addTo(m),
      );

    const points = [driver, pickup, dropoff].filter((p): p is LatLng => !!p);
    const bounds = boundsOf(points);
    if (points.length >= 2 && bounds) {
      m.fitBounds(bounds, { padding: { top: 60, right: 60, bottom: 90, left: 60 }, duration: 600 });
    }
  }, [
    driver?.latitude,
    driver?.longitude,
    pickup?.latitude,
    pickup?.longitude,
    dropoff?.latitude,
    dropoff?.longitude,
    t,
  ]);

  return (
    <View
      style={{
        height,
        borderRadius: t.radius.lg,
        overflow: 'hidden',
        backgroundColor: t.color.surfaceRaised,
      }}
    >
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
    </View>
  );
}
