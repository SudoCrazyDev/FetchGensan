/**
 * The driver app's Supabase client.
 *
 * `react-native-url-polyfill` must be imported before supabase-js: the
 * client builds request URLs with the WHATWG URL API, which Hermes does not
 * ship. Without it, every request fails with a confusing "URL.protocol is
 * not implemented".
 */
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { createApi, createFetchClient } from '@fetch/api';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!url || !anonKey) {
  // Thrown at import time on purpose. A half-configured app that renders a
  // sign-in screen and then fails silently on submit is far harder to
  // diagnose than a crash that names the missing variable.
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.\n' +
      'Copy .env.example to apps/driver/.env and fill them in, then restart the dev server.',
  );
}

export const supabase = createFetchClient({
  url,
  anonKey,
  // On web the browser has real localStorage; AsyncStorage on web works but
  // adds a layer for nothing.
  storage: Platform.OS === 'web' ? undefined : AsyncStorage,
  detectSessionInUrl: Platform.OS === 'web',
  appName: 'driver',
});

export const api = createApi(supabase);
