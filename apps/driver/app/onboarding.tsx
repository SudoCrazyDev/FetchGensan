/**
 * Driver onboarding.
 *
 * Two steps only: motorcycle details, then documents. Anything longer and
 * people abandon halfway — and this is filled in on a phone, standing in
 * the dispatch office, probably with someone helping them.
 *
 * The documents list reflects what a Philippine motorcycle-taxi operator
 * actually needs to see. Which of them you legally must collect depends on
 * how the operation is registered, so treat this list as the starting point
 * for a conversation with whoever handles your compliance, not as advice.
 */

import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi, useDriverDocuments, useProfile } from '@fetch/api/react';
import { driverProfileSchema } from '@fetch/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import { api } from '@/lib/supabase';
import { errorFeedback, successFeedback } from '@/lib/alerts';

const DOCUMENTS = [
  {
    type: 'drivers_license',
    label: "Driver's licence",
    hint: 'Front side, all four corners visible.',
    required: true,
  },
  {
    type: 'or_cr',
    label: 'OR / CR',
    hint: 'Official Receipt and Certificate of Registration for the motorcycle.',
    required: true,
  },
  {
    type: 'selfie_with_license',
    label: 'Selfie holding your licence',
    hint: 'So dispatch can confirm the licence is yours.',
    required: true,
  },
  {
    type: 'vehicle_photo',
    label: 'Photo of your motorcycle',
    hint: 'Side view with the plate readable.',
    required: true,
  },
  {
    type: 'nbi_clearance',
    label: 'NBI clearance',
    hint: 'Customers ride with you alone. Optional at sign-up, required before approval.',
    required: false,
  },
  {
    type: 'barangay_clearance',
    label: 'Barangay clearance',
    hint: 'Optional.',
    required: false,
  },
] as const;

export default function Onboarding() {
  const t = useTheme();
  const router = useRouter();
  const apiHooks = useApi();

  const { data: profile } = useProfile();
  const { data: documents, refetch: refetchDocuments } = useDriverDocuments();

  const [step, setStep] = useState<'vehicle' | 'documents'>('vehicle');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  const [form, setForm] = useState({
    vehicle_make: '',
    vehicle_model: '',
    vehicle_color: '',
    plate_number: '',
    license_number: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function saveVehicle() {
    const parsed = driverProfileSchema.safeParse(form);

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      await apiHooks.driver.register(parsed.data);
      successFeedback();
      setStep('documents');
    } catch (e) {
      errorFeedback();
      Alert.alert('Could not save', humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  async function uploadDocument(docType: string) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera needed', 'Allow the camera to photograph your documents.');
      return;
    }

    const shot = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    const asset = shot.assets?.[0];
    if (shot.canceled || !asset) return;

    setUploading(docType);
    try {
      const userId = profile?.id;
      if (!userId) throw new Error('Not signed in');

      // The storage policy requires the first path segment to be the
      // uploader's own uuid, so this path shape is not a convention -- it
      // is what makes the upload authorised at all.
      const path = `${userId}/${docType}-${Date.now()}.jpg`;
      const blob = await fetch(asset.uri).then((r) => r.blob());

      const { error } = await api.client.storage
        .from('driver-docs')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;

      await apiHooks.driver.recordDocument(docType, path);
      await refetchDocuments();
      successFeedback();
    } catch (e) {
      errorFeedback();
      Alert.alert('Upload failed', humanizeError(e));
    } finally {
      setUploading(null);
    }
  }

  const uploaded = new Set((documents ?? []).map((d) => d.doc_type));
  const requiredDone = DOCUMENTS.filter((d) => d.required).every((d) => uploaded.has(d.type));

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Stack gap={4}>
          <Row gap={2}>
            <Badge label="1 Motorcycle" tone={step === 'vehicle' ? 'attention' : 'success'} />
            <Badge label="2 Documents" tone={step === 'documents' ? 'attention' : 'neutral'} />
          </Row>

          {step === 'vehicle' ? (
            <>
              <Stack gap={1}>
                <Txt size="heading" weight="700">
                  Your motorcycle
                </Txt>
                <Txt size="small" tone="muted">
                  Customers see the make, colour and plate so they know which rider is theirs.
                </Txt>
              </Stack>

              <Card>
                <Stack gap={3}>
                  <Field
                    label="Make"
                    value={form.vehicle_make}
                    onChangeText={(v) => setForm({ ...form, vehicle_make: v })}
                    placeholder="Honda"
                    error={errors.vehicle_make}
                  />
                  <Field
                    label="Model"
                    value={form.vehicle_model}
                    onChangeText={(v) => setForm({ ...form, vehicle_model: v })}
                    placeholder="Click 125i"
                    error={errors.vehicle_model}
                  />
                  <Field
                    label="Colour"
                    value={form.vehicle_color}
                    onChangeText={(v) => setForm({ ...form, vehicle_color: v })}
                    placeholder="Black"
                    error={errors.vehicle_color}
                  />
                  <Field
                    label="Plate number"
                    value={form.plate_number}
                    onChangeText={(v) => setForm({ ...form, plate_number: v })}
                    placeholder="GS 1234"
                    autoCapitalize="characters"
                    error={errors.plate_number}
                  />
                  <Field
                    label="Driver's licence number"
                    value={form.license_number}
                    onChangeText={(v) => setForm({ ...form, license_number: v })}
                    placeholder="D01-23-456789"
                    autoCapitalize="characters"
                    error={errors.license_number}
                  />
                </Stack>
              </Card>

              <Button
                label="Continue"
                size="lg"
                loading={saving}
                onPress={() => void saveVehicle()}
              />
            </>
          ) : (
            <>
              <Stack gap={1}>
                <Txt size="heading" weight="700">
                  Your documents
                </Txt>
                <Txt size="small" tone="muted">
                  Photograph each one. Dispatch reviews them and approves your account, usually
                  the same day.
                </Txt>
              </Stack>

              <Card>
                <Stack gap={0}>
                  {DOCUMENTS.map((doc, index) => {
                    const record = (documents ?? []).find((d) => d.doc_type === doc.type);

                    return (
                      <View key={doc.type}>
                        {index > 0 ? <Divider /> : null}
                        <Stack gap={2} style={{ paddingVertical: t.space(3.5) }}>
                          <Row justify="space-between">
                            <Stack gap={0.5} style={{ flex: 1 }}>
                              <Row gap={2}>
                                <Txt weight="600">{doc.label}</Txt>
                                {!doc.required ? (
                                  <Txt size="caption" tone="muted">
                                    optional
                                  </Txt>
                                ) : null}
                              </Row>
                              <Txt size="small" tone="muted">
                                {doc.hint}
                              </Txt>
                              {record?.status === 'rejected' && record.reject_reason ? (
                                <Txt size="small" tone="danger">
                                  Rejected: {record.reject_reason}
                                </Txt>
                              ) : null}
                            </Stack>
                            {record ? (
                              <Badge
                                label={record.status}
                                tone={
                                  record.status === 'approved'
                                    ? 'success'
                                    : record.status === 'rejected'
                                      ? 'danger'
                                      : 'progress'
                                }
                              />
                            ) : null}
                          </Row>

                          <Button
                            label={record ? 'Replace photo' : 'Take photo'}
                            variant="secondary"
                            loading={uploading === doc.type}
                            disabled={record?.status === 'approved'}
                            onPress={() => void uploadDocument(doc.type)}
                          />
                        </Stack>
                      </View>
                    );
                  })}
                </Stack>
              </Card>

              <Button
                label={requiredDone ? 'Done — submit for review' : 'Upload the required documents'}
                size="lg"
                disabled={!requiredDone}
                onPress={() => {
                  Alert.alert(
                    'Submitted',
                    'Dispatch will review your documents and approve your account. You will be able to go online once approved.',
                    [{ text: 'OK', onPress: () => router.replace('/') }],
                  );
                }}
              />

              <Button
                label="Back to motorcycle details"
                variant="ghost"
                onPress={() => setStep('vehicle')}
              />
            </>
          )}

          <Spacer size={8} />
        </Stack>
      </ScrollView>
    </Screen>
  );
}
