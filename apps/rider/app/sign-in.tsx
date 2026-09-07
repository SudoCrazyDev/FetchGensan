import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { PHONE_HINT, formatPhPhone, normalizePhPhone } from '@fetch/core';
import { Button, Field, Row, Screen, Stack, Txt, useTheme } from '@fetch/ui';

type Step = 'phone' | 'code';

export default function SignIn() {
  const api = useApi();
  const t = useTheme();
  const codeRef = useRef<TextInput>(null);

  const [step, setStep] = useState<Step>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [e164, setE164] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    const normalized = normalizePhPhone(phoneInput);
    if (!normalized) {
      setError(`Enter a PH mobile number (${PHONE_HINT})`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.auth.requestOtp(normalized);
      setE164(normalized);
      setStep('code');
      // Focus after the state flush so the OTP keyboard is up immediately.
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Takes the code as an argument rather than reading `code` from state.
   *
   * This is not a style preference. When auto-submitting from
   * onChangeText, a closure created during that render still sees the
   * PREVIOUS value of `code` -- so the six-digit check failed and showed
   * "Enter the 6-digit code" even though the field was full. Android SMS
   * autofill made it worse: it delivers all six digits in one change
   * event, when `code` is still empty, so autofill never worked at all.
   */
  async function verify(value: string) {
    if (value.length !== 6) {
      setError('Enter the 6-digit code');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.auth.verifyOtp(e164, value);
      // The AuthGate in _layout.tsx picks up the session and redirects.
    } catch (e) {
      setError(humanizeError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Stack gap={6}>
            <Stack gap={2}>
              <Txt size="display" weight="700">
                FetchGensan
              </Txt>
              <Txt tone="muted" size="title">
                Rides, errands and deliveries. Any hour.
              </Txt>
            </Stack>

            {step === 'phone' ? (
              <Stack gap={4}>
                <Field
                  label="Mobile number"
                  value={phoneInput}
                  onChangeText={(v) => {
                    setPhoneInput(v);
                    setError(null);
                  }}
                  placeholder="0917 123 4567"
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  autoFocus
                  error={error}
                  hint="We will text you a 6-digit code."
                  onSubmitEditing={() => void sendCode()}
                  returnKeyType="send"
                  editable={!busy}
                />
                <Button
                  label="Send code"
                  size="lg"
                  loading={busy}
                  onPress={() => void sendCode()}
                />
              </Stack>
            ) : (
              <Stack gap={4}>
                <Field
                  ref={codeRef}
                  label={`Code sent to ${formatPhPhone(e164)}`}
                  value={code}
                  onChangeText={(v) => {
                    const digits = v.replace(/\D/g, '').slice(0, 6);
                    setCode(digits);
                    setError(null);
                    // Auto-submit on the sixth digit: nobody wants to reach
                    // for a button after typing a code they just read. The
                    // digits are passed in, not read back from state, which
                    // has not flushed yet at this point.
                    if (digits.length === 6) void verify(digits);
                  }}
                  placeholder="123456"
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  error={error}
                  editable={!busy}
                  style={{ fontSize: t.font.heading, letterSpacing: 8, textAlign: 'center' }}
                />
                <Button
                  label="Verify"
                  size="lg"
                  loading={busy}
                  onPress={() => void verify(code)}
                />
                <Row justify="space-between">
                  <Button
                    label="Change number"
                    variant="ghost"
                    onPress={() => {
                      setStep('phone');
                      setCode('');
                      setError(null);
                    }}
                  />
                  <Button label="Resend" variant="ghost" onPress={() => void sendCode()} />
                </Row>
              </Stack>
            )}
          </Stack>
        </View>

        <Txt size="small" tone="muted" align="center">
          By continuing you agree to our terms of service.
        </Txt>
      </KeyboardAvoidingView>
    </Screen>
  );
}
