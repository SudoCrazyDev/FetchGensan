/**
 * Customer sign-up, step 2 of 2: photos of an ID and of the customer.
 *
 * Four photos: the ID front and back, a selfie, and a selfie holding the
 * ID. Approval is automatic -- record_customer_document() verifies the
 * account the moment the fourth is on file -- and the root layout then
 * moves them on to the home screen. Until then they cannot book; the
 * database refuses it, not just this screen.
 */

import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import {
  useApi,
  useCustomerDocuments,
  useProfile,
  useRecordCustomerDocument,
} from '@fetch/api/react';
import type { CustomerDocType } from '@fetch/api';
import { Badge, Button, Card, Row, Screen, Stack, Txt, useTheme } from '@fetch/ui';

const PHOTOS: {
  type: CustomerDocType;
  label: string;
  hint: string;
  /** Selfies open the front camera. */
  selfie: boolean;
}[] = [
  {
    type: 'id_front',
    label: 'Front of your ID',
    hint: 'Any government ID. All four corners in the photo, no glare on the name.',
    selfie: false,
  },
  {
    type: 'id_back',
    label: 'Back of your ID',
    hint: 'The same ID, turned over.',
    selfie: false,
  },
  {
    type: 'selfie',
    label: 'Selfie',
    hint: 'Your face, straight on, in good light. No sunglasses or cap.',
    selfie: true,
  },
  {
    type: 'selfie_with_id',
    label: 'Selfie holding your ID',
    hint: 'Hold the ID next to your face so both are clear.',
    selfie: true,
  },
];

/** Returns a local URI, or null if they backed out. */
async function takePhoto(selfie: boolean): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = {
    // Uploaded over prepaid data; an ID only has to be legible.
    quality: 0.6,
    allowsEditing: false,
    mediaTypes: ['images'],
    cameraType: selfie ? ImagePicker.CameraType.front : ImagePicker.CameraType.back,
  };

  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.granted) {
      const shot = await ImagePicker.launchCameraAsync(options);
      return shot.canceled ? null : (shot.assets?.[0]?.uri ?? null);
    }
    if (selfie) {
      // A selfie from the gallery could be anyone's.
      Alert.alert('Camera needed', 'Allow the camera in Settings to take your selfie.');
      return null;
    }
    const useGallery = await new Promise<boolean>((resolve) =>
      Alert.alert(
        'Camera is off',
        'Allow the camera in Settings, or pick a photo of your ID you already took.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Choose from gallery', onPress: () => resolve(true) },
        ],
      ),
    );
    if (!useGallery) return null;
  }

  const picked = await ImagePicker.launchImageLibraryAsync(options);
  return picked.canceled ? null : (picked.assets?.[0]?.uri ?? null);
}

export default function VerifyId() {
  const t = useTheme();
  const api = useApi();
  const { data: profile } = useProfile();
  const { data: documents } = useCustomerDocuments();
  const record = useRecordCustomerDocument();
  const [uploading, setUploading] = useState<CustomerDocType | null>(null);

  const done = new Set((documents ?? []).map((d) => d.doc_type));
  const remaining = PHOTOS.filter((p) => !done.has(p.type)).length;

  async function capture(type: CustomerDocType, selfie: boolean) {
    const userId = profile?.id;
    if (!userId || uploading) return;

    const uri = await takePhoto(selfie);
    if (!uri) return;

    setUploading(type);
    try {
      // The storage policy only accepts paths under the uploader's own id.
      const path = await api.files.uploadFromUri(
        'customer-ids',
        `${userId}/${type}-${Date.now()}.jpg`,
        uri,
        'image/jpeg',
      );
      const verifiedAt = await record.mutateAsync({ docType: type, path });
      if (verifiedAt) {
        // The layout moves them to the home screen on its own.
        Alert.alert("You're all set", 'Your account is verified. You can book a ride now.');
      }
    } catch (e) {
      Alert.alert('Upload failed', humanizeError(e));
    } finally {
      setUploading(null);
    }
  }

  return (
    <Screen scroll edges={['bottom']}>
      <Stack gap={5}>
        <Row gap={2}>
          <Badge label="1 Your details" tone="success" />
          <Badge label="2 Your ID" tone="attention" />
        </Row>

        <Stack gap={1}>
          <Txt size="heading" weight="700">
            Verify your ID
          </Txt>
          <Txt tone="muted">
            Riders pick up strangers, so we ask everyone for an ID once. Four photos and you are
            approved straight away.
          </Txt>
        </Stack>

        <Stack gap={3}>
          {PHOTOS.map((photo) => {
            const have = done.has(photo.type);
            return (
              <Card key={photo.type}>
                <Stack gap={2}>
                  <Row justify="space-between" align="flex-start">
                    <View style={{ flex: 1, paddingRight: t.space(2) }}>
                      <Txt weight="700">{photo.label}</Txt>
                      <Txt size="small" tone="muted">
                        {photo.hint}
                      </Txt>
                    </View>
                    {have ? <Badge label="Done" tone="success" /> : null}
                  </Row>
                  <Button
                    label={have ? 'Retake' : photo.selfie ? 'Take selfie' : 'Take photo'}
                    variant={have ? 'ghost' : 'secondary'}
                    loading={uploading === photo.type}
                    disabled={uploading !== null && uploading !== photo.type}
                    onPress={() => void capture(photo.type, photo.selfie)}
                  />
                </Stack>
              </Card>
            );
          })}
        </Stack>

        <Txt size="small" tone="muted" align="center">
          {remaining > 0
            ? `${remaining} photo${remaining === 1 ? '' : 's'} to go.`
            : 'All four photos are in.'}{' '}
          Only FetchGensan staff can see them.
        </Txt>

        <Button label="Sign out" variant="ghost" onPress={() => void api.auth.signOut()} />
      </Stack>
    </Screen>
  );
}
