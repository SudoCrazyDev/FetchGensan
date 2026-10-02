/**
 * Centre-pin map for choosing a spot. Native implementation (MapLibre).
 *
 * See PinMap.web.tsx for the web build, which uses maplibre-gl directly:
 * the React Native binding has no web target.
 */

import { Camera, Map, UserLocation } from '@maplibre/maplibre-react-native';
import { View } from 'react-native';

import { type LatLng, MAP_STYLE, zoomForDelta } from '@fetch/core';
import { Txt, useTheme } from '@fetch/ui';

export interface PinMapProps {
  /** Where the map opens. Read once on mount, like an initial region. */
  region: LatLng & { longitudeDelta?: number };
  onPinChange: (p: LatLng) => void;
  showsUserLocation?: boolean;
}

export function PinMap({ region, onPinChange, showsUserLocation = true }: PinMapProps) {
  const t = useTheme();

  return (
    <View style={{ flex: 1, borderRadius: t.radius.lg, overflow: 'hidden' }}>
      <Map
        style={{ flex: 1 }}
        mapStyle={t.dark ? MAP_STYLE.dark : MAP_STYLE.light}
        logo={false}
        compass={false}
        touchRotate={false}
        touchPitch={false}
        attributionPosition={{ bottom: 8, right: 8 }}
        onRegionDidChange={(e) => {
          const [longitude, latitude] = e.nativeEvent.center;
          onPinChange({ latitude, longitude });
        }}
      >
        <Camera
          initialViewState={{
            center: [region.longitude, region.latitude],
            zoom: zoomForDelta(region.longitudeDelta ?? 0.02),
          }}
        />
        {showsUserLocation ? <UserLocation /> : null}
      </Map>
      {/*
        A fixed pin over a moving map, not a draggable marker. Dragging a
        marker puts the customer's thumb directly over the thing they are
        trying to place, which is precisely when they need to see it.
      */}
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
