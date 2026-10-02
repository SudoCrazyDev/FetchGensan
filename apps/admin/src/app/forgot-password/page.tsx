'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { PASSWORD_MIN_LENGTH, parseLoginIdentifier, passwordProblem } from '@fetch/core';

import { Logo } from '@/components/Logo';
import { homeFor } from '@/components/Shell';
import { Button, Card, ErrorNote, TextField } from '@/components/ui';

const RESEND_SECONDS = 30;

function ResetFlow() {
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<'identify' | 'reset'>('identify');
  const [identifier, setIdentifier] = useState(params.get('identifier') ?? '');
  const [target, setTarget] = useState<{ kind: 'phone' | 'email'; value: string } | null>(null);
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

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  function clearErrors() {
    setFieldError(null);
    setError(null);
  }

  async function requestCode() {
    const id = parseLoginIdentifier(identifier);
    if (!id) {
      setFieldError({ field: 'identifier', message: 'Enter your email or mobile number.' });
      return;
    }
    setBusy(true);
    clearErrors();
    try {
      await api.auth.requestPasswordReset(id.value);
      setTarget(id);
      setStep('reset');
      setCooldown(RESEND_SECONDS);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!target) return;
    if (!/^\d{6}$/.test(code)) {
      setFieldError({ field: 'code', message: 'Enter the 6-digit code.' });
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setFieldError({ field: 'password', message: problem });
      return;
    }
    if (password !== confirm) {
      setFieldError({ field: 'confirm', message: 'The two passwords do not match.' });
      return;
    }
    setBusy(true);
    clearErrors();
    try {
      const { permissions } = await api.auth.resetPassword(target.value, code, password);
      router.replace(homeFor(permissions));
    } catch (e) {
      setError(humanizeError(e));
      setCode('');
      setBusy(false);
    }
  }

  if (step === 'identify') {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void requestCode();
        }}
      >
        <div>
          <h2 className="text-lg font-bold">Reset your password</h2>
          <p className="mt-1 text-sm text-muted">
            We will email you a 6-digit code, or text it if you use your mobile number.
          </p>
        </div>
        <TextField
          label="Email or mobile number"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            clearErrors();
          }}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          error={errorFor('identifier')}
          disabled={busy}
        />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send code'}
        </Button>
        <Link href="/login" className="text-center text-sm font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void reset();
      }}
    >
      <div>
        <h2 className="text-lg font-bold">Choose a new password</h2>
        <p className="mt-1 text-sm text-muted">
          {target?.kind === 'email'
            ? `If ${target.value} has an account, we emailed it a code.`
            : 'If that number has an account, we texted it a code.'}
        </p>
      </div>
      <TextField
        label="6-digit code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
          clearErrors();
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        className="[&_input]:text-center [&_input]:text-xl [&_input]:tracking-[0.5em]"
        error={errorFor('code')}
        disabled={busy}
      />
      <TextField
        label="New password"
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          clearErrors();
        }}
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters, not only numbers.`}
        error={errorFor('password')}
        disabled={busy}
      />
      <TextField
        label="Type it again"
        type="password"
        value={confirm}
        onChange={(e) => {
          setConfirm(e.target.value);
          clearErrors();
        }}
        autoComplete="new-password"
        error={errorFor('confirm')}
        disabled={busy}
      />
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save and sign in'}
      </Button>
      <div className="flex justify-between text-sm">
        <button
          type="button"
          className="font-medium text-brand hover:underline disabled:opacity-40"
          disabled={busy}
          onClick={() => {
            setStep('identify');
            setCode('');
            clearErrors();
          }}
        >
          Use a different account
        </button>
        <button
          type="button"
          className="font-medium text-brand hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
          disabled={busy || cooldown > 0}
          onClick={() => void requestCode()}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </button>
      </div>
    </form>
  );
}

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <Logo size="lg" label="Dispatch console" />
        </div>
        <Card>
          {/* useSearchParams needs a Suspense boundary for static export. */}
          <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
            <ResetFlow />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}
