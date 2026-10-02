/**
 * Sign-in identifiers and password rules.
 *
 * supabase/functions/_shared/identifier.ts is a copy of this logic for the
 * edge functions, which cannot import workspace packages. auth.test.ts runs
 * the same cases through both, so change them together.
 *
 * As with schemas.ts, this is the UX layer: the edge function applies the
 * same rules again, and Supabase Auth enforces its own minimum length.
 */

import { normalizePhPhone } from './phone';

export type LoginIdentifier = { kind: 'phone'; value: string } | { kind: 'email'; value: string };

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt, which Supabase Auth uses, ignores everything past 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A PH mobile number in any common shape, or an email address. */
export function parseLoginIdentifier(input: string): LoginIdentifier | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;

  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    return EMAIL_RE.test(email) ? { kind: 'email', value: email } : null;
  }

  const phone = normalizePhPhone(trimmed);
  return phone ? { kind: 'phone', value: phone } : null;
}

/** Why a new password is not acceptable, or null when it is. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (password.trim().length === 0) {
    return 'A password cannot be only spaces.';
  }
  if (/^\d+$/.test(password)) {
    // A phone keypad PIN of any length falls to a guessing script quickly,
    // and the most common choice here is the account's own number.
    return 'Mix in some letters, not only numbers.';
  }
  return null;
}
