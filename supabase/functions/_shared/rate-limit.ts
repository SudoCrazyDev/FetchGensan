/**
 * Sliding-window rate limits, stored in Postgres.
 *
 * See 20260930000200_auth_rate_limit.sql for the table and the reasoning.
 * Keys are hashed here, before they reach the database.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { HttpError } from './http.ts';

export interface Limit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function waitPhrase(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Counts one attempt against `limit` for `key`, or throws a 429 when the
 * window is already full. Fails CLOSED: if the limiter itself is down, the
 * attempt is refused rather than waved through.
 */
export async function hit(
  admin: SupabaseClient,
  limit: Limit,
  key: string,
  message = 'Too many attempts.',
): Promise<void> {
  const { data, error } = await admin.rpc('auth_rate_limit_hit', {
    p_bucket: limit.bucket,
    p_key_hash: await sha256Hex(key),
    p_max: limit.max,
    p_window_seconds: limit.windowSeconds,
  });

  if (error) {
    console.error('rate limiter unavailable', error);
    throw new HttpError(503, 'Sign-in is briefly unavailable. Please try again.', 'unavailable');
  }

  const retryAfter = Number(data) || 0;
  if (retryAfter > 0) {
    throw new HttpError(
      429,
      `${message} Try again in ${waitPhrase(retryAfter)}.`,
      'rate_limited',
      { retry_after: retryAfter },
      { 'Retry-After': String(retryAfter) },
    );
  }
}

export async function clear(admin: SupabaseClient, limit: Limit, key: string): Promise<void> {
  const { error } = await admin.rpc('auth_rate_limit_clear', {
    p_bucket: limit.bucket,
    p_key_hash: await sha256Hex(key),
  });
  // Not fatal: the worst case is a stale count that ages out on its own.
  if (error) console.error('rate limit clear failed', error);
}
