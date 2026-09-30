/**
 * Web build of the pin map, on maplibre-gl.
 *
 * Same contract as PinMap.tsx (the native MapLibre binding has no web
 * target), so PlacePicker needs no platform checks.
 */

import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { type LatLng, MAP_STYLE, zoomForDelta } from '@fetch/core';
import { Txt, useTheme } from '@fetch/ui';

// Served from public/ -- see scripts/copy-maplibre-worker.mjs.
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

export interface PinMapProps {
  /** Where the map opens. Read once on mount, like an initial region. */
  region: LatLng & { longitudeDelta?: number };
  onPinChange: (p: LatLng) => void;
  showsUserLocation?: boolean;
}

export function PinMap({ region, onPinChange, showsUserLocation = true }: PinMapProps) {
  const t = useTheme();
  const container = useRef<HTMLDivElement>(null);
  // Held in a ref so the map, created once, always calls the latest one.
  const onChange = useRef(onPinChange);

  useEffect(() => {
    onChange.current = onPinChange;
  }, [onPinChange]);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: t.dark ? MAP_STYLE.dark : MAP_STYLE.light,
      center: [region.longitude, region.latitude],
      zoom: zoomForDelta(region.longitudeDelta ?? 0.02),
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    if (showsUserLocation) {
      map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
    }
    map.on('moveend', () => {
      const c = map.getCenter();
      onChange.current({ latitude: c.lat, longitude: c.lng });
    });
    return () => map.remove();
    // Mount-only: region is the initial view, and the style follows the
    // theme the picker opened in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, minHeight: 240, borderRadius: t.radius.lg, overflow: 'hidden' }}>
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Txt size="display">📍</Txt>
      </View>
    </View>
  );
}

export const MAP_AVAILABLE = true;
