/**
 * Supabase client factory.
 *
 * Deliberately takes its storage adapter as an argument rather than
 * importing AsyncStorage: this package is imported by two React Native apps
 * and one Next.js app, and importing AsyncStorage here would break the
 * server build. Each app supplies the right adapter -- see
 * apps/*\/src/lib/supabase.ts.
 */

import { type SupabaseClient, createClient } from '@supabase/supabase-js';

export interface SessionStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface ClientOptions {
  url: string;
  anonKey: string;
  storage?: SessionStorage;
  /**
   * React Native has no URL bar to parse a magic link out of, and leaving
   * this on makes the client try to read `window.location`.
   */
  detectSessionInUrl?: boolean;
  /** Extra header so you can spot which app made a request in the logs. */
  appName?: string;
}

export type FetchClient = SupabaseClient;

export function createFetchClient(opts: ClientOptions): FetchClient {
  if (!opts.url || !opts.anonKey) {
    throw new Error(
      'Supabase URL and anon key are required. Copy .env.example to .env and fill them in.',
    );
  }

  return createClient(opts.url, opts.anonKey, {
    auth: {
      ...(opts.storage ? { storage: opts.storage as never } : {}),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: opts.detectSessionInUrl ?? false,
      flowType: 'pkce',
    },
    global: {
      headers: opts.appName ? { 'x-fetch-app': opts.appName } : {},
    },
    realtime: {
      params: {
        // Location pings are frequent. Ten a second is plenty and keeps a
        // flaky connection from queueing up a backlog it never drains.
        eventsPerSecond: 10,
      },
    },
  });
}

/**
 * Turns a PostgREST/Postgres error into something worth showing a customer.
 *
 * The RPCs raise with real messages ("you already have a booking in
 * progress"), and those are written to be read by a person. Anything that
 * looks like a raw database error gets a generic message instead -- a
 * customer should never see the words "violates check constraint".
 */
export function humanizeError(error: unknown): string {
  if (!error) return 'Something went wrong. Please try again.';

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';

  // Two drivers hit Accept at once; the loser sees this.
  if (code === '55P03' || message.includes('already taken')) {
    return 'Another rider took that booking first.';
  }
  if (code === 'PGRST301' || message.includes('JWT')) {
    return 'Your session expired. Please sign in again.';
  }
  if (message.includes('Failed to fetch') || message.includes('Network request failed')) {
    return 'No connection. Check your signal and try again.';
  }

  // Our own raised exceptions are lower-case sentences meant for humans.
  // Postgres internals are not.
  const looksInternal =
    /violates|constraint|relation |column |function |syntax error|permission denied for/i.test(
      message,
    );

  if (looksInternal) return 'Something went wrong. Please try again.';

  return message.replace(/^ERROR:\s*/i, '');
}
