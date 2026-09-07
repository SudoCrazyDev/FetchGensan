'use client';

import { createApi, createFetchClient } from '@fetch/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!url || !anonKey) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to apps/admin/.env.local and fill them in.',
  );
}

/**
 * The console is a client-rendered app against the same anon key and the
 * same RLS as the mobile apps.
 *
 * That is a deliberate choice over a server-rendered admin with the service
 * role key: the dispatch views (`dispatch_board`, `driver_roster`) are
 * already gated on `is_staff()`, so a signed-in customer who opens this URL
 * sees empty tables rather than someone else's data. Holding a service-role
 * key in a Next.js server would mean every authorisation decision moves
 * into hand-written route handlers, and one forgotten check leaks the whole
 * fleet.
 */
export const supabase = createFetchClient({
  url,
  anonKey,
  // Browser: real localStorage, and magic links land in the URL bar.
  detectSessionInUrl: true,
  appName: 'admin',
});

export const api = createApi(supabase);
