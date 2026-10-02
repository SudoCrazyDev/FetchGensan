/**
 * The sign-in and password-reset forms both mobile apps use.
 *
 * Presentational: they validate, hold their own field state and show
 * errors, and hand the actual calls to the screen through props. That keeps
 * this package free of @fetch/api, and lets each app wrap the forms in its
 * own header and copy (the customer app and the rider app speak to
 * different people).
 */

import { useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';

import { PASSWORD_MIN_LENGTH, parseLoginIdentifier, passwordProblem } from '@fetch/core';

import { Button, Field, PasswordField, Row, Stack, Txt } from './primitives';
import { useTheme } from './ThemeProvider';

const IDENTIFIER_ERROR = 'Enter your mobile number (09xx xxx xxxx) or email address.';

// ---------------------------------------------------------------- sign in

export interface SignInFormProps {
  onSignIn(identifier: string, password: string): Promise<void>;
  /** Receives whatever was typed, so the reset screen can start filled in. */
  onForgotPassword(identifier: string): void;
  /** Turns a thrown error into a sentence -- pass humanizeError. */
  describeError(error: unknown): string;
  initialIdentifier?: string;
}

export function SignInForm({
  onSignIn,
  onForgotPassword,
  describeError,
  initialIdentifier = '',
}: SignInFormProps) {
  const passwordRef = useRef<TextInput>(null);

  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [password, setPassword] = useState('');
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const id = parseLoginIdentifier(identifier);
    if (!id) {
      setIdentifierError(IDENTIFIER_ERROR);
      return;
    }
    if (!password) {
      setError('Enter your password.');
      passwordRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSignIn(id.value, password);
      // The screen's auth gate sees the new session and navigates away.
    } catch (e) {
      setError(describeError(e));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={4}>
      <Field
        label="Mobile number or email"
        value={identifier}
        onChangeText={(v) => {
          setIdentifier(v);
          setIdentifierError(null);
          setError(null);
        }}
        placeholder="0917 123 4567"
        // email-address: phone keypads have no @, and staff sign in by email.
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        autoFocus={!initialIdentifier}
        error={identifierError}
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        editable={!busy}
      />
      <PasswordField
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setError(null);
        }}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!busy}
      />

      {error ? (
        <Txt tone="danger" size="small" live>
          {error}
        </Txt>
      ) : null}

      <Button label="Sign in" size="lg" loading={busy} onPress={() => void submit()} />

      <Stack gap={1}>
        <Button
          label="Forgot password?"
          variant="ghost"
          onPress={() => onForgotPassword(identifier.trim())}
          disabled={busy}
        />
        <Txt size="small" tone="muted" align="center">
          Signed in with a text code before? Tap Forgot password to set one.
        </Txt>
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------- reset

export interface ResetPasswordFormProps {
  onRequestCode(identifier: string): Promise<void>;
  onReset(identifier: string, code: string, password: string): Promise<void>;
  onBack(): void;
  describeError(error: unknown): string;
  initialIdentifier?: string;
}

const RESEND_SECONDS = 30;

export function ResetPasswordForm({
  onRequestCode,
  onReset,
  onBack,
  describeError,
  initialIdentifier = '',
}: ResetPasswordFormProps) {
  const t = useTheme();
  const codeRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const [step, setStep] = useState<'identify' | 'reset'>('identify');
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [target, setTarget] = useState<{ value: string; kind: 'phone' | 'email' } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function clearErrors() {
    setFieldError(null);
    setError(null);
  }

  async function requestCode() {
    if (busy) return;
    const id = parseLoginIdentifier(identifier);
    if (!id) {
      setFieldError({ field: 'identifier', message: IDENTIFIER_ERROR });
      return;
    }

    setBusy(true);
    clearErrors();
    try {
      await onRequestCode(id.value);
      setTarget(id);
      setStep('reset');
      setCooldown(RESEND_SECONDS);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy || !target) return;
    if (!/^\d{6}$/.test(code)) {
      setFieldError({ field: 'code', message: 'Enter the 6-digit code.' });
      codeRef.current?.focus();
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setFieldError({ field: 'password', message: problem });
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setFieldError({ field: 'confirm', message: 'The two passwords do not match.' });
      confirmRef.current?.focus();
      return;
    }

    setBusy(true);
    clearErrors();
    try {
      await onReset(target.value, code, password);
      // Signed in; the auth gate takes it from here.
    } catch (e) {
      setError(describeError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  if (step === 'identify') {
    return (
      <Stack gap={4}>
        <Stack gap={1}>
          <Txt size="heading" weight="700">
            Reset your password
          </Txt>
          <Txt tone="muted">
            We will send a 6-digit code to your mobile number, or to your email if you sign in with
            one.
          </Txt>
        </Stack>
        <Field
          label="Mobile number or email"
          value={identifier}
          onChangeText={(v) => {
            setIdentifier(v);
            clearErrors();
          }}
          placeholder="0917 123 4567"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          autoFocus
          error={errorFor('identifier')}
          returnKeyType="send"
          onSubmitEditing={() => void requestCode()}
          editable={!busy}
        />
        {error ? (
          <Txt tone="danger" size="small">
            {error}
          </Txt>
        ) : null}
        <Button label="Send code" size="lg" loading={busy} onPress={() => void requestCode()} />
        <Button label="Back to sign in" variant="ghost" onPress={onBack} disabled={busy} />
      </Stack>
    );
  }

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <Txt size="heading" weight="700">
          Choose a new password
        </Txt>
        <Txt tone="muted">
          {target?.kind === 'email'
            ? `If ${target.value} has an account, we emailed it a code.`
            : 'If that number has an account, we texted it a code.'}
        </Txt>
      </Stack>

      <Field
        ref={codeRef}
        label="6-digit code"
        value={code}
        onChangeText={(v) => {
          setCode(v.replace(/\D/g, '').slice(0, 6));
          clearErrors();
        }}
        placeholder="123456"
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={6}
        error={errorFor('code')}
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        editable={!busy}
        style={{ fontSize: t.font.heading, letterSpacing: 8, textAlign: 'center' }}
      />
      <PasswordField
        ref={passwordRef}
        label="New password"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          clearErrors();
        }}
        autoComplete="new-password"
        textContentType="newPassword"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters, not only numbers.`}
        error={errorFor('password')}
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        editable={!busy}
      />
      <PasswordField
        ref={confirmRef}
        label="Type it again"
        value={confirm}
        onChangeText={(v) => {
          setConfirm(v);
          clearErrors();
        }}
        autoComplete="new-password"
        textContentType="newPassword"
        error={errorFor('confirm')}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!busy}
      />

      {error ? (
        <Txt tone="danger" size="small" live>
          {error}
        </Txt>
      ) : null}

      <Button label="Save and sign in" size="lg" loading={busy} onPress={() => void submit()} />

      <Row justify="space-between">
        <Button
          label="Use a different number"
          variant="ghost"
          disabled={busy}
          onPress={() => {
            setStep('identify');
            setCode('');
            clearErrors();
          }}
        />
        <Button
          label={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          variant="ghost"
          disabled={busy || cooldown > 0}
          onPress={() => void requestCode()}
        />
      </Row>
    </Stack>
  );
}
