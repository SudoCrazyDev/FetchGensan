/**
 * Web build of the pin map.
 *
 * react-native-maps is native-only -- importing it in a web bundle throws
 * at module load. Rather than ship a broken map, the web build says so and
 * steers the customer to landmark search, which is the primary path anyway.
 *
 * If web becomes a real booking surface rather than a convenience, replace
 * this with @vis.gl/react-google-maps (already a dependency of the admin
 * app) and keep the same PinMapProps contract so PlacePicker needs no
 * changes.
 */

import { View } from 'react-native';

import type { LatLng } from '@fetch/core';
import { Txt, useTheme } from '@fetch/ui';

export interface PinMapProps {
  region: { latitude: number; longitude: number };
  onPinChange: (p: LatLng) => void;
  showsUserLocation?: boolean;
}

export function PinMap({ region }: PinMapProps) {
  const t = useTheme();

  return (
    <View
      style={{
        flex: 1,
        minHeight: 200,
        borderRadius: t.radius.lg,
        backgroundColor: t.color.surfaceRaised,
        borderWidth: 1,
        borderColor: t.color.border,
        alignItems: 'center',
        justifyContent: 'center',
        padding: t.space(6),
        gap: t.space(2),
      }}
    >
      <Txt size="heading">🗺️</Txt>
      <Txt weight="600" align="center">
        Map pinning is not available on the web yet
      </Txt>
      <Txt size="small" tone="muted" align="center">
        Search for a landmark instead, then add a note for your rider. For pin-drop accuracy,
        use the FetchGensan app on your phone.
      </Txt>
      <Txt size="caption" tone="muted">
        {region.latitude.toFixed(4)}, {region.longitude.toFixed(4)}
      </Txt>
    </View>
  );
}

export const MAP_AVAILABLE = false;
