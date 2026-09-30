'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useApi } from '@fetch/api/react';
import { formatPhPhone, normalizePhPhone } from '@fetch/core';

import { Logo } from '@/components/Logo';
import { Button, Card } from '@/components/ui';

export default function LoginPage() {
  const api = useApi();
  const router = useRouter();

  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [e164, setE164] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const normalized = normalizePhPhone(phone);
    if (!normalized) {
      setError('Enter a PH mobile number (09xx or +639xx)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.requestOtp(normalized);
      setE164(normalized);
      setStep('code');
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api.auth.verifyOtp(e164, code);
      router.replace('/');
    } catch (e) {
      setError(humanizeError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-ink outline-none focus:border-brand';

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1>
            <Logo size="lg" label="Dispatch console" />
          </h1>
        </div>

        <Card>
          {step === 'phone' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wide text-muted">
                  Mobile number
                </span>
                <input
                  className={inputClass}
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setError(null);
                  }}
                  placeholder="0917 123 4567"
                  autoComplete="tel"
                  autoFocus
                />
              </label>

              {error ? <p className="text-sm text-bad">{error}</p> : null}

              <Button onClick={() => void send()} disabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wide text-muted">
                  Code sent to {formatPhPhone(e164)}
                </span>
                <input
                  className={`${inputClass} text-center text-xl tracking-[0.5em]`}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                    setError(null);
                  }}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </label>

              {error ? <p className="text-sm text-bad">{error}</p> : null}

              <Button onClick={() => void verify()} disabled={busy || code.length !== 6}>
                {busy ? 'Checking…' : 'Sign in'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setError(null);
                }}
              >
                Change number
              </Button>
            </form>
          )}
        </Card>

        <p className="mt-4 text-xs text-muted">
          Dispatcher and admin accounts only. Customer and driver numbers will sign in but see
          nothing.
        </p>
      </div>
    </div>
  );
}
