/**
 * Taking a photo of a document or a receipt, then uploading it.
 *
 * Camera first, because that is what a rider standing at a till does. Falls
 * back to the gallery when there is no camera (web, an emulator) or the
 * rider refused camera access but still has the photo saved.
 */

import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';

import type { Api } from '@fetch/api';

/** Returns a local URI, or null if the rider backed out. */
export async function takePhoto(purpose: string): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = {
    // Compressed on purpose: uploaded over prepaid mobile data, and a
    // licence or receipt only has to be legible.
    quality: 0.6,
    allowsEditing: false,
    mediaTypes: ['images'],
  };

  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.granted) {
      const shot = await ImagePicker.launchCameraAsync(options);
      return shot.canceled ? null : (shot.assets?.[0]?.uri ?? null);
    }

    const useGallery = await new Promise<boolean>((resolve) =>
      Alert.alert(
        'Camera is off',
        `Allow the camera in Settings to photograph ${purpose}, or pick a photo you already took.`,
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

/** Photograph and upload in one go. Returns the storage path. */
export async function captureAndUpload(
  api: Api,
  bucket: 'driver-docs' | 'receipts',
  path: string,
  purpose: string,
): Promise<string | null> {
  const uri = await takePhoto(purpose);
  if (!uri) return null;
  return api.files.uploadFromUri(bucket, path, uri, 'image/jpeg');
}
