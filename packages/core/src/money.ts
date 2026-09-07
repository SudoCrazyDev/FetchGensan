/**
 * Money in FetchGensan is always an integer count of centavos.
 *
 * There is no `number` of pesos anywhere in this codebase. Floating point
 * pesos produce 0.30000000000000004 in a fare, which becomes a driver
 * arguing with a customer over a coin, which becomes a support ticket.
 * The database columns are `int`/`bigint` centavos and these helpers are
 * the only sanctioned way to move between that and something a human reads.
 */

/** Integer centavos. 100 centavos = PHP 1.00. */
export type Centavos = number;

export const CENTAVOS_PER_PESO = 100;

export function pesos(amount: number): Centavos {
  return Math.round(amount * CENTAVOS_PER_PESO);
}

export function toPesos(centavos: Centavos): number {
  return centavos / CENTAVOS_PER_PESO;
}

/**
 * Formats for display. Drops the decimals when the amount is whole pesos,
 * because "₱45" reads faster than "₱45.00" on a phone at night and whole
 * pesos are the overwhelmingly common case once fares are rounded.
 */
export function formatPeso(centavos: Centavos, opts?: { decimals?: boolean }): string {
  const showDecimals = opts?.decimals ?? centavos % CENTAVOS_PER_PESO !== 0;
  const value = toPesos(Math.abs(centavos));
  const body = showDecimals
    ? value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : Math.round(value).toLocaleString('en-PH');
  return `${centavos < 0 ? '-' : ''}₱${body}`;
}

/** Rounds to whole pesos so no coin change is ever needed. */
export function roundToPeso(centavos: Centavos): Centavos {
  return Math.round(centavos / CENTAVOS_PER_PESO) * CENTAVOS_PER_PESO;
}

/**
 * Basis points, matching `fare_config.commission_bps`. 1500 bps = 15%.
 * Integer maths throughout: commission on ₱45 at 15% is 675 centavos, not
 * 674.9999.
 */
export function applyBps(centavos: Centavos, bps: number): Centavos {
  return Math.round((centavos * bps) / 10_000);
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}
