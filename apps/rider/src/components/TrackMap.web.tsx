/**
 * Web build of the tracking map.
 *
 * react-native-maps is native-only. Rather than a broken map, the web build
 * shows the distance between rider and pickup, which is the one fact the
 * map was there to convey.
 */

import { View } from 'react-native';

import { type LatLng, formatDistance, haversineMeters } from '@fetch/core';
import { Stack, Txt, useTheme } from '@fetch/ui';

export interface TrackMapProps {
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  height?: number;
}

export function TrackMap({ driver, pickup, dropoff, height = 240 }: TrackMapProps) {
  const t = useTheme();

  const target = pickup ?? dropoff ?? null;
  const away = driver && target ? haversineMeters(driver, target) : null;

  return (
    <View
      style={{
        height,
        borderRadius: t.radius.lg,
        backgroundColor: t.color.surfaceRaised,
        borderWidth: 1,
        borderColor: t.color.border,
        alignItems: 'center',
        justifyContent: 'center',
        padding: t.space(5),
      }}
    >
      <Stack gap={2}>
        <Txt size="heading" align="center">
          🛵
        </Txt>
        {away !== null ? (
          <>
            <Txt size="title" weight="700" align="center">
              {formatDistance(away)} away
            </Txt>
            <Txt size="small" tone="muted" align="center">
              Open the app on your phone for the live map.
            </Txt>
          </>
        ) : (
          <Txt tone="muted" align="center">
            Waiting for your rider's location…
          </Txt>
        )}
      </Stack>
    </View>
  );
}
