/**
 * Centre-pin map for choosing a spot. Native implementation.
 *
 * See PinMap.web.tsx for the web build -- react-native-maps has no web
 * support at all, so the two platforms genuinely need different code here
 * rather than a shared component with a flag.
 */

import { View } from 'react-native';
import MapView, { PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import type { LatLng } from '@fetch/core';
import { Txt, useTheme } from '@fetch/ui';

export interface PinMapProps {
  region: Region;
  onPinChange: (p: LatLng) => void;
  showsUserLocation?: boolean;
}

export function PinMap({ region, onPinChange, showsUserLocation = true }: PinMapProps) {
  const t = useTheme();

  return (
    <View style={{ flex: 1, borderRadius: t.radius.lg, overflow: 'hidden' }}>
      <MapView
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        initialRegion={region}
        onRegionChangeComplete={(r) =>
          onPinChange({ latitude: r.latitude, longitude: r.longitude })
        }
        showsUserLocation={showsUserLocation}
        showsMyLocationButton
        toolbarEnabled={false}
      />
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
