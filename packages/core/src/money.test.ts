import { describe, expect, it } from 'vitest';

import { applyBps, formatBps, formatPeso, pesos, roundToPeso, toPesos } from './money';
import { formatPhPhone, maskPhPhone, normalizePhPhone } from './phone';

describe('money', () => {
  it('converts pesos to integer centavos', () => {
    expect(pesos(25)).toBe(2500);
    expect(pesos(25.5)).toBe(2550);
    // The classic float trap: 45.15 * 100 is 4514.999... in IEEE 754.
    expect(pesos(45.15)).toBe(4515);
    expect(Number.isInteger(pesos(0.1 + 0.2))).toBe(true);
  });

  it('round-trips through pesos without drift', () => {
    for (const c of [0, 1, 99, 100, 2500, 4515, 999_999]) {
      expect(pesos(toPesos(c))).toBe(c);
    }
  });

  it('drops decimals for whole pesos and keeps them otherwise', () => {
    expect(formatPeso(2500)).toBe('₱25');
    expect(formatPeso(2550)).toBe('₱25.50');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('formats a negative balance as owed, not as a mystery', () => {
    // Drivers see this on the wallet screen when they owe commission.
    expect(formatPeso(-12_500)).toBe('-₱125');
    expect(formatPeso(-12_550)).toBe('-₱125.50');
  });

  it('groups thousands', () => {
    expect(formatPeso(500_000)).toBe('₱5,000');
    expect(formatPeso(500_050)).toBe('₱5,000.50');
  });

  it('rounds half a peso up', () => {
    expect(roundToPeso(3850)).toBe(3900);
    expect(roundToPeso(3849)).toBe(3800);
    expect(roundToPeso(3800)).toBe(3800);
  });

  it('applies basis points with integer maths', () => {
    expect(applyBps(10_000, 1500)).toBe(1500); // 15% of ₱100
    expect(applyBps(3900, 1500)).toBe(585); // 15% of ₱39
    expect(applyBps(0, 1500)).toBe(0);
    expect(Number.isInteger(applyBps(3333, 1234))).toBe(true);
  });

  it('shows a commission rate the way a driver would read it', () => {
    expect(formatBps(1500)).toBe('15%');
    expect(formatBps(2000)).toBe('20%');
    expect(formatBps(1250)).toBe('12.50%');
  });
});

describe('PH phone numbers', () => {
  it('accepts every shape a customer might type', () => {
    const expected = '+639171234567';
    for (const input of [
      '09171234567',
      '0917 123 4567',
      '0917-123-4567',
      '9171234567',
      '639171234567',
      '+639171234567',
      '+63 917 123 4567',
      '(0917) 123 4567',
    ]) {
      expect(normalizePhPhone(input), input).toBe(expected);
    }
  });

  it('rejects things that are not PH mobile numbers', () => {
    for (const input of [
      '',
      '0817123456', // wrong length
      '083 552 1234', // Gensan landline, not a mobile
      '08171234567', // does not start 9 after the trunk 0
      '+15551234567', // US
      'not a phone',
      '091712345678', // too long
    ]) {
      expect(normalizePhPhone(input), input).toBeNull();
    }
  });

  it('displays a number the way people recognise it', () => {
    expect(formatPhPhone('+639171234567')).toBe('0917 123 4567');
    expect(formatPhPhone('09171234567')).toBe('0917 123 4567');
  });

  it('masks enough to confirm but not to harvest', () => {
    expect(maskPhPhone('+639171234567')).toBe('0917 •••• 567');
  });

  it('leaves an unparseable number alone rather than mangling it', () => {
    expect(formatPhPhone('garbage')).toBe('garbage');
    expect(maskPhPhone('garbage')).toBe('•••••');
  });
});
