/**
 * Centre-pin map for choosing a spot. Native implementation (MapLibre).
 *
 * See PinMap.web.tsx for the web build, which uses maplibre-gl directly:
 * the React Native binding has no web target.
 */

import { Camera, type CameraRef, Map, UserLocation } from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

import { type LatLng, MAP_STYLE, isPlausibleFix, zoomForDelta } from '@fetch/core';
import { Txt, useTheme } from '@fetch/ui';

/** Close enough to read house numbers and gates. */
const LOCATE_ZOOM = 17;

export interface PinMapProps {
  /** Where the map opens. Read once on mount, like an initial region. */
  region: LatLng & { longitudeDelta?: number };
  onPinChange: (p: LatLng) => void;
  showsUserLocation?: boolean;
}

export function PinMap({ region, onPinChange, showsUserLocation = true }: PinMapProps) {
  const t = useTheme();
  const camera = useRef<CameraRef>(null);
  const [locating, setLocating] = useState(false);

  /**
   * Moves the map, and so the pin, to the phone's position. Asked for on
   * tap rather than on open: a fix is often 50 m out, so the customer still
   * nudges the pin afterwards, and the map should not jump under them.
   */
  async function locate() {
    if (locating) return;
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location is off',
          'Allow location for FetchGensan in your phone settings, or drag the map to your spot.',
        );
        return;
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const here = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      if (!isPlausibleFix(here)) throw new Error('no fix');
      camera.current?.flyTo({
        center: [here.longitude, here.latitude],
        zoom: LOCATE_ZOOM,
        duration: 800,
      });
    } catch {
      Alert.alert(
        'Could not find you',
        'Your phone has no GPS fix yet. Try again outside, or drag the map to your spot.',
      );
    } finally {
      setLocating(false);
    }
  }

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
          ref={camera}
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

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to my current location"
        onPress={() => void locate()}
        hitSlop={8}
        style={({ pressed }) => ({
          position: 'absolute',
          right: 12,
          // Above the attribution button in the bottom-right corner.
          bottom: 48,
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? t.color.border : t.color.surface,
          borderWidth: 1,
          borderColor: t.color.border,
          elevation: 3,
          shadowColor: '#000',
          shadowOpacity: 0.15,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
        })}
      >
        {locating ? (
          <ActivityIndicator color={t.color.primary} />
        ) : (
          <Crosshair color={t.color.primary} />
        )}
      </Pressable>
    </View>
  );
}

/**
 * The usual "my location" mark: a ring, a centre dot and four ticks. Drawn
 * with views because the app ships no icon font.
 */
function Crosshair({ color, size = 22 }: { color: string; size?: number }) {
  const ring = size * 0.64;
  const tick = (size - ring) / 2 + 1;
  const stroke = 2;
  const half = size / 2;

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: (size - ring) / 2,
          top: (size - ring) / 2,
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: half - 3,
          top: half - 3,
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
      {/* top, bottom, left, right */}
      <View
        style={{
          position: 'absolute',
          left: half - stroke / 2,
          top: 0,
          width: stroke,
          height: tick,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: half - stroke / 2,
          bottom: 0,
          width: stroke,
          height: tick,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: half - stroke / 2,
          left: 0,
          height: stroke,
          width: tick,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: half - stroke / 2,
          right: 0,
          height: stroke,
          width: tick,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export const MAP_AVAILABLE = true;
