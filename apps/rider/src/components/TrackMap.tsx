/**
 * Live tracking map. Native implementation (MapLibre).
 *
 * Shows the driver, the pickup and the drop-off, and keeps all three in
 * frame. See TrackMap.web.tsx for the web build.
 */

import { Camera, type CameraRef, Map, Marker } from '@maplibre/maplibre-react-native';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { GENSAN_REGION, type LatLng, MAP_STYLE, boundsOf } from '@fetch/core';
import { useTheme } from '@fetch/ui';

export interface TrackMapProps {
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  height?: number;
}

const PICKUP_COLOR = '#16A34A';
const DROPOFF_COLOR = '#DC2626';

function Dot({ color, size, ring }: { color: string; size: number; ring: string }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: 3,
        borderColor: ring,
      }}
    />
  );
}

export function TrackMap({ driver, pickup, dropoff, height = 240 }: TrackMapProps) {
  const t = useTheme();
  const camera = useRef<CameraRef>(null);

  const points = [driver, pickup, dropoff].filter((p): p is LatLng => !!p);

  useEffect(() => {
    const bounds = boundsOf(points);
    if (points.length < 2 || !bounds || !camera.current) return;

    camera.current.fitBounds(bounds, {
      // Generous bottom padding: the status sheet overlaps the map, and a
      // marker hidden behind it is the same as no marker at all.
      padding: { top: 60, right: 60, bottom: 90, left: 60 },
      duration: 600,
    });
    // Refit whenever the driver moves, which is every poll while on a job.
  }, [driver?.latitude, driver?.longitude, pickup?.latitude, dropoff?.latitude, points.length]);

  const start = pickup ?? GENSAN_REGION;

  return (
    <View
      style={{
        height,
        borderRadius: t.radius.lg,
        overflow: 'hidden',
        backgroundColor: t.color.surfaceRaised,
      }}
    >
      <Map
        style={{ flex: 1 }}
        mapStyle={t.dark ? MAP_STYLE.dark : MAP_STYLE.light}
        logo={false}
        compass={false}
        attributionPosition={{ bottom: 8, right: 8 }}
      >
        <Camera
          ref={camera}
          initialViewState={{ center: [start.longitude, start.latitude], zoom: 14 }}
        />
        {pickup ? (
          <Marker id="pickup" lngLat={[pickup.longitude, pickup.latitude]} anchor="center">
            <Dot color={PICKUP_COLOR} size={22} ring={t.color.surface} />
          </Marker>
        ) : null}
        {dropoff ? (
          <Marker id="dropoff" lngLat={[dropoff.longitude, dropoff.latitude]} anchor="center">
            <Dot color={DROPOFF_COLOR} size={22} ring={t.color.surface} />
          </Marker>
        ) : null}
        {driver ? (
          <Marker id="driver" lngLat={[driver.longitude, driver.latitude]} anchor="center">
            <Dot color={t.color.primary} size={34} ring={t.color.surface} />
          </Marker>
        ) : null}
      </Map>
    </View>
  );
}
