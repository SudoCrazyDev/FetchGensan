'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useApi, useSessionUser } from '@fetch/api/react';
import { parseLoginIdentifier } from '@fetch/core';

import { Logo } from '@/components/Logo';
import { homeFor } from '@/components/Shell';
import { Button, Card, ErrorNote, TextField } from '@/components/ui';

export default function LoginPage() {
  const api = useApi();
  const router = useRouter();
  const { userId, loading } = useSessionUser();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in (another tab, or a reload): skip the form.
  useEffect(() => {
    if (!loading && userId && !busy) router.replace('/');
  }, [loading, userId, busy, router]);

  async function submit() {
    const id = parseLoginIdentifier(identifier);
    if (!id) {
      setIdentifierError('Enter your email or mobile number (09xx xxx xxxx).');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { permissions } = await api.auth.signInWithPassword(id.value, password);
      router.replace(homeFor(permissions));
    } catch (e) {
      setError(humanizeError(e));
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1>
            <Logo size="lg" label="Dispatch console" />
          </h1>
        </div>

        <Card>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <TextField
              label="Email or mobile number"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                setIdentifierError(null);
                setError(null);
              }}
              placeholder="you@fetchgensan.ph"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              error={identifierError}
              disabled={busy}
            />

            <TextField
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoComplete="current-password"
              disabled={busy}
              trailing={
                <button
                  type="button"
                  className="text-xs font-semibold text-brand hover:underline"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-pressed={showPassword}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              }
            />

            <ErrorNote>{error}</ErrorNote>

            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>

            <Link
              href={`/forgot-password${identifier.trim() ? `?identifier=${encodeURIComponent(identifier.trim())}` : ''}`}
              className="text-center text-sm font-medium text-brand hover:underline"
            >
              Forgot password?
            </Link>
          </form>
        </Card>

        <p className="mt-4 text-xs text-muted">
          Staff accounts only. Accounts are created by an admin under Users.
        </p>
      </div>
    </div>
  );
}
