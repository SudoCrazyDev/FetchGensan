import { describe, expect, it } from 'vitest';

import * as edge from '../../../supabase/functions/_shared/identifier';
import * as core from './auth';

const IDENTIFIERS = [
  '09171234567',
  '0917 123 4567',
  '+63 917 123 4567',
  '639171234567',
  '9171234567',
  '(0917) 123-4567',
  '08171234567',
  '0917123456',
  'Maria@Example.COM ',
  'ops@fetchgensan.test',
  'no-at-sign',
  'a@b',
  'two@@example.com',
  'spa ce@example.com',
  '',
  '   ',
];

const PASSWORDS = [
  '',
  'short',
  '1234567',
  '12345678',
  '09171234567',
  '        ',
  'fetchgensan-dev',
  'Tuna Capital 2026',
  'x'.repeat(72),
  'x'.repeat(73),
  'ñ'.repeat(36),
  'ñ'.repeat(37),
];

describe('parseLoginIdentifier', () => {
  it('reads every common phone shape as E.164', () => {
    for (const input of ['09171234567', '0917 123 4567', '+63 917 123 4567', '9171234567']) {
      expect(core.parseLoginIdentifier(input)).toEqual({ kind: 'phone', value: '+639171234567' });
    }
  });

  it('lower-cases and trims emails', () => {
    expect(core.parseLoginIdentifier(' Maria@Example.COM ')).toEqual({
      kind: 'email',
      value: 'maria@example.com',
    });
  });

  it('rejects anything that is neither', () => {
    for (const input of ['08171234567', 'no-at-sign', 'a@b', '', '   ']) {
      expect(core.parseLoginIdentifier(input)).toBeNull();
    }
  });
});

describe('passwordProblem', () => {
  it('accepts a reasonable password', () => {
    expect(core.passwordProblem('fetchgensan-dev')).toBeNull();
  });

  it('refuses short, digits-only, blank and over-long passwords', () => {
    expect(core.passwordProblem('short')).toMatch(/at least 8/);
    expect(core.passwordProblem('09171234567')).toMatch(/letters/);
    expect(core.passwordProblem('        ')).toMatch(/spaces/);
    expect(core.passwordProblem('x'.repeat(73))).toMatch(/at most 72/);
  });

  it('counts the 72-character limit in bytes, as bcrypt does', () => {
    expect(core.passwordProblem('ñ'.repeat(36))).toBeNull();
    expect(core.passwordProblem('ñ'.repeat(37))).toMatch(/at most 72/);
  });
});

// The edge functions carry their own copy. If this fails, the app and the
// server disagree about what a valid login or password is.
describe('edge function copy', () => {
  it('parses identifiers identically', () => {
    for (const input of IDENTIFIERS) {
      expect(edge.parseLoginIdentifier(input), input).toEqual(core.parseLoginIdentifier(input));
    }
  });

  it('judges passwords identically', () => {
    for (const input of PASSWORDS) {
      expect(edge.passwordProblem(input), input).toEqual(core.passwordProblem(input));
    }
    expect(edge.PASSWORD_MIN_LENGTH).toBe(core.PASSWORD_MIN_LENGTH);
    expect(edge.PASSWORD_MAX_LENGTH).toBe(core.PASSWORD_MAX_LENGTH);
  });
});
