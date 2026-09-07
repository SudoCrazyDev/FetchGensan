/**
 * Philippine mobile number handling.
 *
 * Sign-in is phone OTP, so this is the very first thing a new customer
 * touches. People type their number every way imaginable -- 0917 123 4567,
 * 9171234567, +63 917 123 4567, 63917-123-4567 -- and Supabase Auth needs
 * E.164 (+639171234567). Normalising loosely and displaying prettily is the
 * difference between signing up and giving up.
 */

const PH_MOBILE_PREFIXES_HINT = '09xx / +639xx';

/**
 * Reduces any of the common input shapes to E.164, or returns null when it
 * cannot be read as a PH mobile number.
 *
 * Accepts: 09171234567, 9171234567, 639171234567, +639171234567, and any
 * of those with spaces, dashes or parentheses.
 */
export function normalizePhPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '').replace(/^\+/, '');

  let national: string | null = null;

  if (digits.startsWith('63') && digits.length === 12) {
    // 639171234567
    national = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    // 09171234567
    national = digits.slice(1);
  } else if (digits.length === 10 && digits.startsWith('9')) {
    // 9171234567
    national = digits;
  }

  if (!national || !/^9\d{9}$/.test(national)) return null;

  return `+63${national}`;
}

export function isValidPhPhone(input: string): boolean {
  return normalizePhPhone(input) !== null;
}

/** `+639171234567` -> `0917 123 4567`, the form people recognise. */
export function formatPhPhone(e164: string): string {
  const normalized = normalizePhPhone(e164);
  if (!normalized) return e164;
  const n = normalized.slice(3); // drop +63
  return `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
}

/** For a driver card: `0917 •••• 567`. Enough to confirm, not to harvest. */
export function maskPhPhone(e164: string): string {
  const normalized = normalizePhPhone(e164);
  if (!normalized) return '•••••';
  const n = normalized.slice(3);
  return `0${n.slice(0, 3)} •••• ${n.slice(7)}`;
}

export const PHONE_HINT = PH_MOBILE_PREFIXES_HINT;
