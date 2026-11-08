/**
 * The rider app's Supabase client.
 *
 * `react-native-url-polyfill` must be imported before supabase-js: the
 * client builds request URLs with the WHATWG URL API, which Hermes does not
 * ship. Without it, every request fails with a confusing "URL.protocol is
 * not implemented".
 */
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { type Api, createApi, createDemoApi, createFetchClient } from '@fetch/api';

/**
 * `EXPO_PUBLIC_DEMO=1` builds the app against an in-memory fake with sample
 * data and no sign-in, so every screen can be seen without a backend. See
 * packages/api/src/demo.ts. Never set it for a build you hand to real users.
 */
export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!DEMO && (!url || !anonKey)) {
  // Thrown at import time on purpose. A half-configured app that renders a
  // sign-in screen and then fails silently on submit is far harder to
  // diagnose than a crash that names the missing variable.
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.\n' +
      'Copy .env.example to apps/rider/.env and fill them in, then restart the dev server.',
  );
}

function realApi(): Api {
  const supabase = createFetchClient({
    url,
    anonKey,
    // On web the browser has real localStorage; AsyncStorage on web works but
    // adds a layer for nothing.
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    detectSessionInUrl: Platform.OS === 'web',
    appName: 'rider',
  });
  return createApi(supabase);
}

export const api: Api = DEMO ? createDemoApi({ app: 'rider' }) : realApi();
