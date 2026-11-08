/**
 * Customer sign-up, step 1 of 2: details, then the code we email.
 *
 * Name, email, mobile number (always +63, so only the ten digits are
 * typed) and a password. The account is created when they tap Continue,
 * but it cannot sign in until the emailed code is entered -- see the
 * `register` routes in supabase/functions/auth. Entering the code signs
 * them in, and the root layout then sends them to step 2, the ID photos
 * (verify-id.tsx).
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, type TextInput } from 'react-native';

import { ApiError, humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { parseLoginIdentifier, passwordProblem } from '@fetch/core';
import { Badge, Button, Field, PasswordField, Row, Screen, Stack, Txt } from '@fetch/ui';

/** Seconds before "Send a new code" is offered again. */
const RESEND_AFTER = 60;

type Errors = Partial<Record<'fullName' | 'email' | 'phone' | 'password' | 'code', string>>;

/** The ten digits after +63, from whatever was typed or pasted. */
function nationalDigits(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 10);
}

export default function Register() {
  const api = useApi();
  const router = useRouter();

  const [step, setStep] = useState<'details' | 'code'>('details');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  function validate(): Errors {
    const next: Errors = {};
    if (fullName.trim().length < 2) next.fullName = 'Enter your full name.';
    const id = parseLoginIdentifier(email);
    if (!id || id.kind !== 'email') next.email = 'Enter a valid email address.';
    if (!/^9\d{9}$/.test(phone)) next.phone = 'Ten digits starting with 9, e.g. 917 123 4567.';
    const problem = passwordProblem(password);
    if (problem) next.password = problem;
    return next;
  }

  /** Puts a server error under the field it is about, when there is one. */
  function showError(e: unknown) {
    const message = humanizeError(e);
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'email_taken' || code === 'invalid_email') setErrors({ email: message });
    else if (code === 'phone_taken' || code === 'invalid_phone') setErrors({ phone: message });
    else if (code === 'weak_password') setErrors({ password: message });
    else if (code === 'invalid_name') setErrors({ fullName: message });
    else if (code === 'invalid_code') setErrors({ code: message });
    else setFormError(message);
  }

  async function submitDetails() {
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await api.auth.registerStart({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: `+63${phone}`,
        password,
      });
      setCode('');
      setStep('code');
      setResendIn(RESEND_AFTER);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setFormError(null);
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) {
      setErrors({ code: 'Enter the 6-digit code from the email.' });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.auth.registerVerify(email.trim(), digits);
      // Signed in. The root layout sees the session and an unverified
      // profile, and moves on to the ID photos.
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setFormError(null);
    try {
      await api.auth.registerResend(email.trim());
      setResendIn(RESEND_AFTER);
    } catch (e) {
      showError(e);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll edges={['bottom']}>
        <Stack gap={5}>
          <Row gap={2}>
            <Badge label="1 Your details" tone="attention" />
            <Badge label="2 Your ID" tone="neutral" />
          </Row>

          {step === 'details' ? (
            <>
              <Stack gap={1}>
                <Txt size="heading" weight="700">
                  Create your account
                </Txt>
                <Txt tone="muted">
                  We will email you a code to confirm it is you. Your rider sees your name and
                  number when they accept a booking.
                </Txt>
              </Stack>

              <Stack gap={3}>
                <Field
                  label="Full name"
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Juan Dela Cruz"
                  autoCapitalize="words"
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                  error={errors.fullName}
                />
                <Field
                  ref={emailRef}
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="next"
                  onSubmitEditing={() => phoneRef.current?.focus()}
                  error={errors.email}
                />
                <Field
                  ref={phoneRef}
                  label="Mobile number"
                  prefix="+63"
                  value={phone}
                  onChangeText={(v) => setPhone(nationalDigits(v))}
                  placeholder="917 123 4567"
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  maxLength={13}
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  error={errors.phone}
                />
                <PasswordField
                  ref={passwordRef}
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  textContentType="newPassword"
                  returnKeyType="go"
                  onSubmitEditing={() => void submitDetails()}
                  hint="At least 8 characters, not only numbers."
                  error={errors.password}
                />
              </Stack>

              {formError ? <Txt tone="danger">{formError}</Txt> : null}

              <Button
                label="Continue"
                size="lg"
                loading={busy}
                onPress={() => void submitDetails()}
              />
              <Button
                label="I already have an account"
                variant="ghost"
                onPress={() => router.replace('/sign-in')}
              />
            </>
          ) : (
            <>
              <Stack gap={1}>
                <Txt size="heading" weight="700">
                  Check your email
                </Txt>
                <Txt tone="muted">
                  We sent a 6-digit code to {email.trim()}. It can take a minute to arrive, and may
                  land in spam.
                </Txt>
              </Stack>

              <Field
                label="Code"
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={6}
                autoFocus
                returnKeyType="go"
                onSubmitEditing={() => void submitCode()}
                error={errors.code}
                style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center' }}
              />

              {formError ? <Txt tone="danger">{formError}</Txt> : null}

              <Button label="Confirm" size="lg" loading={busy} onPress={() => void submitCode()} />
              <Button
                label={resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                variant="secondary"
                disabled={resendIn > 0}
                onPress={() => void resend()}
              />
              <Button
                label="Change my details"
                variant="ghost"
                onPress={() => {
                  setErrors({});
                  setFormError(null);
                  setStep('details');
                }}
              />
            </>
          )}
        </Stack>
      </Screen>
    </KeyboardAvoidingView>
  );
}
