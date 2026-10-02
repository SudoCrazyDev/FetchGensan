/**
 * Picking a place in General Santos.
 *
 * The design decision that matters: this is landmark-first, map-second, and
 * has no street-address search at all. Gensan addressing is landmark-based
 * and a geocoder mostly returns nothing useful for it, so a search box
 * wired to Places autocomplete would fail in front of the customer on
 * their first booking. Instead:
 *
 *   1. Saved places and popular landmarks, as tappable rows.
 *   2. Fuzzy landmark search against our own table.
 *   3. Drop a pin on the map.
 *
 * And in every case a free-text `landmark` note, because that note is what
 * the driver actually reads when they arrive at the gate.
 */

import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, View } from 'react-native';

import { useApi, useLandmarkSearch, useSavePlace, useSavedPlaces } from '@fetch/api/react';
import { GENSAN_REGION, type LatLng, formatDistance } from '@fetch/core';
import {
  Button,
  Card,
  Divider,
  Field,
  Row,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import { MAP_AVAILABLE, PinMap } from './PinMap';

export interface PickedPlace {
  location: LatLng;
  label: string;
  landmark: string;
}

interface Props {
  visible: boolean;
  title: string;
  /** Centres the map and orders landmark results by nearness. */
  near?: LatLng;
  initial?: PickedPlace | null;
  /**
   * Start with the pin on `near`. Right for a pick-up taken from a real GPS
   * fix ("I'm here, by the blue gate"); wrong for a drop-off, where `near`
   * is the pick-up and confirming it would book a ride to where you are.
   */
  startAtNear?: boolean;
  onCancel: () => void;
  onPick: (place: PickedPlace) => void;
}

export function PlacePicker({
  visible,
  title,
  near,
  initial,
  startAtNear = false,
  onCancel,
  onPick,
}: Props) {
  const t = useTheme();

  const [query, setQuery] = useState('');
  const [pin, setPin] = useState<LatLng | null>(
    initial?.location ?? (startAtNear ? (near ?? null) : null),
  );
  const [label, setLabel] = useState(
    initial?.label ?? (startAtNear && near ? 'Your current location' : ''),
  );
  const [landmark, setLandmark] = useState(initial?.landmark ?? '');
  const [mapOpen, setMapOpen] = useState(false);
  // Which landmark row the pin came from, so its popularity can be bumped.
  const [landmarkId, setLandmarkId] = useState<string | null>(null);
  const [fromSaved, setFromSaved] = useState(false);
  const [saveAs, setSaveAs] = useState('');

  const api = useApi();
  const savePlace = useSavePlace();
  const { data: saved } = useSavedPlaces();
  const { data: landmarks, isFetching } = useLandmarkSearch(query, near);

  const region = useMemo(
    () => ({
      latitude: pin?.latitude ?? near?.latitude ?? GENSAN_REGION.latitude,
      longitude: pin?.longitude ?? near?.longitude ?? GENSAN_REGION.longitude,
      latitudeDelta: 0.02,
      longitudeDelta: 0.02,
    }),
    [pin, near],
  );

  const canConfirm = pin !== null && (label.trim().length > 0 || landmark.trim().length > 0);

  function reset() {
    setQuery('');
    setMapOpen(false);
    setSaveAs('');
  }

  function confirm() {
    if (!pin) return;
    const picked = {
      location: pin,
      label: label.trim() || landmark.trim(),
      landmark: landmark.trim(),
    };

    // Both are best-effort and must never hold up the booking.
    if (landmarkId) void api.places.bumpLandmark(landmarkId).catch(() => undefined);
    if (saveAs.trim() && !fromSaved) {
      savePlace.mutate({
        label: saveAs.trim(),
        landmarkNote: picked.landmark,
        addressLine: picked.label,
        location: pin,
      });
    }

    onPick(picked);
    reset();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: t.color.background, padding: t.space(4) }}>
        <Row justify="space-between" style={{ marginBottom: t.space(3) }}>
          <Txt size="title" weight="700">
            {title}
          </Txt>
          <Button label="Close" variant="ghost" onPress={onCancel} />
        </Row>

        {mapOpen ? (
          <Stack gap={3} style={{ flex: 1 }}>
            <Txt size="small" tone="muted">
              Drag the map so the pin sits exactly where the rider should stop.
            </Txt>
            <PinMap
              region={region}
              onPinChange={(p) => {
                setPin(p);
                // A dragged pin is no longer the landmark it started from.
                setLandmarkId(null);
                setFromSaved(false);
              }}
            />
            <Button label="Use this spot" size="lg" onPress={() => setMapOpen(false)} />
          </Stack>
        ) : (
          <Stack gap={4} style={{ flex: 1 }}>
            <Field
              label="Search a landmark"
              value={query}
              onChangeText={setQuery}
              placeholder="KCC, Bulaong, city hall…"
              autoCorrect={false}
              returnKeyType="search"
            />

            <View style={{ flex: 1 }}>
              <FlatList
                keyboardShouldPersistTaps="handled"
                data={landmarks ?? []}
                keyExtractor={(item) => item.id}
                ItemSeparatorComponent={Divider}
                ListHeaderComponent={
                  query.length === 0 && saved && saved.length > 0 ? (
                    <View style={{ marginBottom: t.space(2) }}>
                      <Txt size="small" weight="600" tone="muted">
                        YOUR PLACES
                      </Txt>
                      {saved.map((place) => (
                        <Pressable
                          key={place.id}
                          onPress={() => {
                            setPin({ latitude: place.lat, longitude: place.lng });
                            setLabel(place.address_line || place.label);
                            setLandmark(place.landmark_note);
                            setLandmarkId(null);
                            setFromSaved(true);
                          }}
                          style={{ paddingVertical: t.space(3) }}
                        >
                          <Txt weight="600">⭐ {place.label}</Txt>
                          {place.landmark_note ? (
                            <Txt size="small" tone="muted">
                              {place.landmark_note}
                            </Txt>
                          ) : null}
                        </Pressable>
                      ))}
                      <Divider />
                      <View style={{ height: t.space(3) }} />
                      <Txt size="small" weight="600" tone="muted">
                        POPULAR IN GENSAN
                      </Txt>
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      setPin({ latitude: item.lat, longitude: item.lng });
                      setLabel(item.name);
                      setLandmarkId(item.id);
                      setFromSaved(false);
                      setQuery('');
                    }}
                    style={({ pressed }) => ({
                      paddingVertical: t.space(3.5),
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Row justify="space-between">
                      <Stack gap={0.5} style={{ flex: 1 }}>
                        <Txt weight="600" numberOfLines={1}>
                          {item.name}
                        </Txt>
                        <Txt size="small" tone="muted">
                          {item.category}
                        </Txt>
                      </Stack>
                      {item.distance_m !== null ? (
                        <Txt size="small" tone="muted">
                          {formatDistance(item.distance_m)}
                        </Txt>
                      ) : null}
                    </Row>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <View style={{ paddingVertical: t.space(6) }}>
                    <Txt tone="muted" align="center">
                      {isFetching ? 'Searching…' : 'No landmark matched. Drop a pin instead.'}
                    </Txt>
                  </View>
                }
              />
            </View>

            {pin ? (
              <Card>
                <Stack gap={3}>
                  <Row justify="space-between">
                    <Txt weight="600" numberOfLines={1} style={{ flex: 1 }}>
                      {label || 'Pin dropped'}
                    </Txt>
                    <Button label="Adjust pin" variant="ghost" onPress={() => setMapOpen(true)} />
                  </Row>
                  <Field
                    label="Landmark or note for the rider"
                    value={landmark}
                    onChangeText={setLandmark}
                    placeholder="Tabi sa bakery, blue gate"
                    hint="This is what your rider reads when they arrive. Be specific."
                    multiline
                  />
                  {!fromSaved ? (
                    <Field
                      label="Save this place as (optional)"
                      value={saveAs}
                      onChangeText={setSaveAs}
                      placeholder="Home, Work, Lola's house"
                    />
                  ) : null}
                </Stack>
              </Card>
            ) : null}

            <Row gap={3}>
              {/* Hidden on web, where PinMap cannot actually place a pin. */}
              {MAP_AVAILABLE ? (
                <Button
                  label="Drop a pin"
                  variant="secondary"
                  onPress={() => {
                    // The map opens centred on `region`; if the customer
                    // taps "Use this spot" without moving it, that centre is
                    // the spot -- onRegionChangeComplete never fires.
                    if (!pin) setPin({ latitude: region.latitude, longitude: region.longitude });
                    setMapOpen(true);
                  }}
                  style={{ flex: 1 }}
                />
              ) : null}
              <Button
                label="Confirm"
                onPress={confirm}
                disabled={!canConfirm}
                style={{ flex: 1 }}
              />
            </Row>
          </Stack>
        )}
      </View>
    </Modal>
  );
}
