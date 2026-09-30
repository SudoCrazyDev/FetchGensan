/**
 * Parsing a sign-in identifier and checking a new password.
 *
 * A copy of packages/core/src/auth.ts, because edge functions are bundled
 * from supabase/functions alone and cannot import workspace packages.
 * packages/core/src/auth.test.ts runs the same cases through both files,
 * so they cannot drift apart.
 *
 * Keep this file free of Deno APIs and imports, or that test cannot load it.
 */

export type LoginIdentifier = { kind: 'phone'; value: string } | { kind: 'email'; value: string };

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt, which Supabase Auth uses, ignores everything past 72 bytes.
export const PASSWORD_MAX_LENGTH = 72;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePhPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '').replace(/^\+/, '');

  let national: string | null = null;
  if (digits.startsWith('63') && digits.length === 12) national = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) national = digits.slice(1);
  else if (digits.length === 10 && digits.startsWith('9')) national = digits;

  if (!national || !/^9\d{9}$/.test(national)) return null;
  return `+63${national}`;
}

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
