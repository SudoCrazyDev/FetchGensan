/**
 * Drives the dispatch sweepers.
 *
 * `dispatch_tick()` in the database expires stale offers, releases
 * scheduled bookings, widens the search for jobs nobody accepted, and marks
 * silent drivers offline. Something has to call it on a short interval.
 *
 * Preferred: pg_cron, scheduled in 20260907001200_maintenance.sql. That
 * runs inside the database with no network hop and no cold start.
 *
 * This function is the fallback for projects where pg_cron is unavailable.
 * Point an external scheduler at it (cron-job.org, GitHub Actions, an
 * uptime pinger) every 10-15 seconds and pass the shared secret.
 *
 * Why a shared secret rather than JWT verification: the caller is a dumb
 * scheduler with no Supabase session. `verify_jwt = false` is set for this
 * function in config.toml, so this header check is the only thing standing
 * between the open internet and a function that mutates dispatch state.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TICK_SECRET = Deno.env.get('DISPATCH_TICK_SECRET') ?? '';

/** Constant-time compare, so a wrong secret cannot be guessed byte by byte. */
function secretMatches(provided: string): boolean {
  if (TICK_SECRET.length === 0) return false;
  if (provided.length !== TICK_SECRET.length) return false;

  let diff = 0;
  for (let i = 0; i < TICK_SECRET.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ TICK_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (TICK_SECRET.length === 0) {
    // Failing closed rather than open. An unset secret in production would
    // otherwise leave dispatch mutation callable by anyone.
    return new Response(
      JSON.stringify({ error: 'DISPATCH_TICK_SECRET is not configured' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  const provided =
    req.headers.get('x-dispatch-secret') ??
    new URL(req.url).searchParams.get('secret') ??
    '';

  if (!secretMatches(provided)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc('dispatch_tick');

  if (error) {
    console.error('dispatch_tick failed', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  });
});
