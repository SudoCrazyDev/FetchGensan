/**
 * Driver onboarding, and later the place to fix it.
 *
 * Two steps only: you and your motorcycle, then documents. Anything longer
 * and people abandon halfway — and this is filled in on a phone, standing
 * in the dispatch office, probably with someone helping them.
 *
 * It is re-enterable on purpose. A rejected licence photo, a new plate, a
 * driver who closed the app between steps: all come back here, with what
 * they already entered filled in. `?step=documents` opens the second step
 * directly, which is where the home screen sends a pending rider.
 *
 * The documents list reflects what a Philippine motorcycle-taxi operator
 * actually needs to see. Which of them you legally must collect depends on
 * how the operation is registered, so treat this list as the starting point
 * for a conversation with whoever handles your compliance, not as advice.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import {
  useApi,
  useDriverDocuments,
  useDriverMe,
  useProfile,
  useRegisterDriver,
} from '@fetch/api/react';
import { driverProfileSchema } from '@fetch/core';
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Loading,
  Row,
  Screen,
  Spacer,
  Stack,
  Txt,
  useTheme,
} from '@fetch/ui';

import { errorFeedback, successFeedback } from '@/lib/alerts';
import { DOCUMENTS } from '@/lib/documents';
import { captureAndUpload } from '@/lib/photo';


type Form = {
  full_name: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  license_number: string;
};

export default function Onboarding() {
  const t = useTheme();
  const router = useRouter();
  const api = useApi();
  const params = useLocalSearchParams<{ step?: string }>();

  const { data: profile, isLoading: profileLoading } = useProfile();
  const { data: driver, isLoading: driverLoading } = useDriverMe();
  const { data: documents, refetch: refetchDocuments } = useDriverDocuments();
  const register = useRegisterDriver();

  const [step, setStep] = useState<'vehicle' | 'documents'>(
    params.step === 'documents' ? 'documents' : 'vehicle',
  );
  const [uploading, setUploading] = useState<string | null>(null);

  const [form, setForm] = useState<Form>({
    full_name: '',
    vehicle_make: '',
    vehicle_model: '',
    vehicle_color: '',
    plate_number: '',
    license_number: '',
  });
  const [prefilled, setPrefilled] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Fill in whatever is already on file, once, so coming back here to fix
  // one field does not mean retyping five.
  useEffect(() => {
    if (prefilled || profileLoading || driverLoading) return;
    setForm({
      full_name: profile?.full_name ?? '',
      vehicle_make: driver?.vehicle_make ?? '',
      vehicle_model: driver?.vehicle_model ?? '',
      vehicle_color: driver?.vehicle_color ?? '',
      plate_number: driver?.plate_number ?? '',
      license_number: driver?.license_number ?? '',
    });
    setPrefilled(true);
  }, [prefilled, profileLoading, driverLoading, profile, driver]);

  if (profileLoading || driverLoading) return <Loading />;

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
    register.mutate(parsed.data, {
      onSuccess: () => {
        successFeedback();
        setStep('documents');
      },
      onError: (e) => {
        errorFeedback();
        Alert.alert('Could not save', humanizeError(e));
      },
    });
  }

  async function uploadDocument(docType: string, label: string) {
    const userId = profile?.id;
    if (!userId) return;

    setUploading(docType);
    try {
      // The storage policy requires the first path segment to be the
      // uploader's own uuid, so this path shape is not a convention -- it
      // is what makes the upload authorised at all.
      const path = await captureAndUpload(
        api,
        'driver-docs',
        `${userId}/${docType}-${Date.now()}.jpg`,
        `your ${label.toLowerCase()}`,
      );
      if (!path) return;

      await api.driver.recordDocument(docType, path);
      await refetchDocuments();
      successFeedback();
    } catch (e) {
      errorFeedback();
      Alert.alert('Upload failed', humanizeError(e));
    } finally {
      setUploading(null);
    }
  }

  const byType = new Map((documents ?? []).map((d) => [d.doc_type, d]));
  const requiredDone = DOCUMENTS.filter((d) => d.required).every((d) => byType.has(d.type));
  const approved = driver?.status === 'approved';

  function field(key: keyof Form, label: string, placeholder: string, caps = false) {
    return (
      <Field
        label={label}
        value={form[key]}
        onChangeText={(v) => setForm({ ...form, [key]: v })}
        placeholder={placeholder}
        autoCapitalize={caps ? 'characters' : key === 'full_name' ? 'words' : 'sentences'}
        error={errors[key]}
      />
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Stack gap={4}>
          <Row gap={2}>
            <Badge
              label="1 You & your motorcycle"
              tone={step === 'vehicle' ? 'attention' : driver ? 'success' : 'neutral'}
            />
            <Badge
              label="2 Documents"
              tone={step === 'documents' ? 'attention' : requiredDone ? 'success' : 'neutral'}
            />
          </Row>

          {step === 'vehicle' ? (
            <>
              <Stack gap={1}>
                <Txt size="heading" weight="700">
                  You and your motorcycle
                </Txt>
                <Txt size="small" tone="muted">
                  Customers see your name, and the make, colour and plate, so they know which
                  rider is theirs.
                </Txt>
              </Stack>

              <Card>
                <Stack gap={3}>
                  {field('full_name', 'Your full name', 'Juan Dela Cruz')}
                  <Divider />
                  {field('vehicle_make', 'Make', 'Honda')}
                  {field('vehicle_model', 'Model', 'Click 125i')}
                  {field('vehicle_color', 'Colour', 'Black')}
                  {field('plate_number', 'Plate number', 'GS 1234', true)}
                  {field('license_number', "Driver's licence number", 'D01-23-456789', true)}
                </Stack>
              </Card>

              {approved ? (
                <Txt size="small" tone="muted">
                  You are approved. Changing your plate here updates what customers see straight
                  away — tell dispatch if you have changed motorcycles.
                </Txt>
              ) : null}

              <Button
                label={driver ? 'Save and continue' : 'Continue'}
                size="lg"
                loading={register.isPending}
                onPress={() => void saveVehicle()}
              />

              {driver ? (
                <Button
                  label="Skip to documents"
                  variant="ghost"
                  onPress={() => setStep('documents')}
                />
              ) : null}
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
                    const record = byType.get(doc.type);

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

                          {record?.status !== 'approved' ? (
                            <Button
                              label={
                                record?.status === 'rejected'
                                  ? 'Take a new photo'
                                  : record
                                    ? 'Replace photo'
                                    : 'Take photo'
                              }
                              variant={record?.status === 'rejected' ? 'primary' : 'secondary'}
                              loading={uploading === doc.type}
                              disabled={uploading !== null && uploading !== doc.type}
                              onPress={() => void uploadDocument(doc.type, doc.label)}
                            />
                          ) : null}
                        </Stack>
                      </View>
                    );
                  })}
                </Stack>
              </Card>

              <Button
                label={
                  approved
                    ? 'Done'
                    : requiredDone
                      ? 'Done — submit for review'
                      : 'Upload the required documents'
                }
                size="lg"
                disabled={!approved && !requiredDone}
                onPress={() => {
                  if (approved) {
                    router.dismissTo('/');
                    return;
                  }
                  Alert.alert(
                    'Submitted',
                    'Dispatch will review your documents and approve your account. You will be able to go online once approved.',
                    [{ text: 'OK', onPress: () => router.dismissTo('/') }],
                  );
                }}
              />

              <Button
                label="Back to your details"
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
