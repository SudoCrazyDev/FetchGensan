/**
 * The dispatch office line every "Call dispatch" button dials.
 *
 * Set EXPO_PUBLIC_DISPATCH_PHONE in .env. The fallback is the seeded local
 * test dispatcher, which rings nobody -- fine in development, wrong in a
 * store build.
 */
export const DISPATCH_PHONE = process.env.EXPO_PUBLIC_DISPATCH_PHONE || '+639170000004';
