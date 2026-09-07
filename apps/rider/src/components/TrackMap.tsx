/**
 * Live tracking map. Native implementation.
 *
 * Shows the driver, the pickup and the drop-off, and keeps all three in
 * frame. See TrackMap.web.tsx for the web build.
 */

import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

import { GENSAN_REGION, type LatLng } from '@fetch/core';
import { useTheme } from '@fetch/ui';

export interface TrackMapProps {
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  height?: number;
}

export function TrackMap({ driver, pickup, dropoff, height = 240 }: TrackMapProps) {
  const t = useTheme();
  const mapRef = useRef<MapView>(null);

  const points = [driver, pickup, dropoff].filter((p): p is LatLng => !!p);

  useEffect(() => {
    if (points.length < 2 || !mapRef.current) return;

    mapRef.current.fitToCoordinates(points, {
      // Generous bottom padding: the status sheet overlaps the map, and a
      // marker hidden behind it is the same as no marker at all.
      edgePadding: { top: 60, right: 60, bottom: 90, left: 60 },
      animated: true,
    });
    // Refit whenever the driver moves, which is every poll while on a job.
  }, [driver?.latitude, driver?.longitude, pickup?.latitude, dropoff?.latitude, points.length]);

  return (
    <View
      style={{
        height,
        borderRadius: t.radius.lg,
        overflow: 'hidden',
        backgroundColor: t.color.surfaceRaised,
      }}
    >
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        initialRegion={{
          latitude: pickup?.latitude ?? GENSAN_REGION.latitude,
          longitude: pickup?.longitude ?? GENSAN_REGION.longitude,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        }}
        toolbarEnabled={false}
      >
        {pickup ? (
          <Marker coordinate={pickup} title="Pick-up" pinColor="green" />
        ) : null}
        {dropoff ? <Marker coordinate={dropoff} title="Drop-off" pinColor="red" /> : null}
        {driver ? (
          <Marker coordinate={driver} title="Your rider" anchor={{ x: 0.5, y: 0.5 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: t.color.primary,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 3,
                borderColor: t.color.surface,
              }}
            />
          </Marker>
        ) : null}
      </MapView>
    </View>
  );
}
