/**
 * Push notifications for booking offers.
 *
 * Why this exists, and why the driver app is not complete without it:
 *
 * The driver app's realtime subscription and its 5-second poll both stop
 * the moment Android suspends the process, which on Xiaomi, Oppo, Realme
 * and Vivo ROMs happens within minutes of the screen locking. A driver with
 * their phone in a pocket outside a terminal is asleep as far as the app is
 * concerned. A push notification is the only channel the OS itself will
 * wake, so this is what actually delivers a 2am booking.
 *
 * Call it from a database trigger or webhook on `job_offers` INSERT. It is
 * deliberately separate from dispatch_job() so a push provider outage
 * cannot roll back or block a dispatch transaction.
 *
 * Expo's push service is used rather than raw FCM/APNs so both platforms go
 * through one call and no native credentials live in this function.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUSH_SECRET = Deno.env.get('PUSH_NOTIFY_SECRET') ?? '';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface OfferPayload {
  /** `job_offers.id` */
  offer_id?: string;
  driver_id: string;
  job_id: string;
  title?: string;
  body?: string;
}

function secretMatches(provided: string): boolean {
  if (PUSH_SECRET.length === 0 || provided.length !== PUSH_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < PUSH_SECRET.length; i += 1) {
    diff |= PUSH_SECRET.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (PUSH_SECRET.length === 0) {
    return new Response(JSON.stringify({ error: 'PUSH_NOTIFY_SECRET is not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!secretMatches(req.headers.get('x-push-secret') ?? '')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let payload: OfferPayload;
  try {
    payload = (await req.json()) as OfferPayload;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 });
  }

  if (!payload.driver_id || !payload.job_id) {
    return new Response(JSON.stringify({ error: 'driver_id and job_id are required' }), {
      status: 400,
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Expo push tokens are stored per device, so one driver with a phone and
  // a spare gets the offer on both.
  const { data: tokens, error: tokenError } = await admin
    .from('driver_push_tokens')
    .select('token')
    .eq('driver_id', payload.driver_id);

  if (tokenError) {
    console.error('token lookup failed', tokenError);
    return new Response(JSON.stringify({ error: tokenError.message }), { status: 500 });
  }

  if (!tokens || tokens.length === 0) {
    // Not an error: a driver who has not granted notification permission
    // still gets offers through the in-app subscription while it is alive.
    return new Response(JSON.stringify({ sent: 0, reason: 'no registered devices' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const messages = tokens.map((row: { token: string }) => ({
    to: row.token,
    title: payload.title ?? 'New booking nearby',
    body: payload.body ?? 'Tap to see the details.',
    sound: 'default',
    // MAX priority and the dedicated channel, or Android will not heads-up
    // the notification and the offer expires unseen.
    priority: 'high',
    channelId: 'offers',
    // Offers expire in 25 seconds. A notification delivered after that is
    // worse than none -- it sends the driver to a job someone else took.
    ttl: 25,
    data: { jobId: payload.job_id, offerId: payload.offer_id ?? null },
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(messages),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('expo push failed', response.status, result);
    return new Response(JSON.stringify({ error: 'push provider rejected', detail: result }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ sent: messages.length, result }), {
    headers: { 'content-type': 'application/json' },
  });
});
