/**
 * Puts something on the console for a demo or a manual check:
 *
 *   pnpm --filter @fetch/api demo:data
 *
 * Books one ride that nobody has accepted (so it sits on the live board)
 * and gives the pending rider a document to review. Local stack only.
 */

import { createFetchClient } from '../src/client';
import { createApi } from '../src/api';

const URL_ = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

if (!URL_.includes('127.0.0.1') && !URL_.includes('localhost')) {
  console.error(`Refusing to write demo data to a non-local URL: ${URL_}`);
  process.exit(1);
}

// A 1x1 JPEG.
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////' +
  '//////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP' +
  '/aAAgBAQABPxA=';

async function as(phone: string) {
  const store = new Map<string, string>();
  const api = createApi(
    createFetchClient({
      url: URL_,
      anonKey: ANON,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    }),
  );
  await api.auth.requestOtp(phone);
  const { user } = await api.auth.verifyOtp(phone, '123456');
  return Object.assign(api, { userId: user!.id });
}

async function main() {
  const maria = await as('+639170000001');
  const boy = await as('+639170000003');

  if (!(await maria.jobs.active())) {
    const job = await maria.jobs.create({
      jobType: 'ride',
      pickup: { latitude: 6.1176, longitude: 125.183 },
      dropoff: { latitude: 6.1075, longitude: 125.0965 },
      pickupLabel: 'Bulaong Terminal',
      pickupLandmark: 'Beside the Yellow Bus ticket booth',
      dropoffLabel: 'General Santos City Airport',
      notes: 'Flight at 6am, one carry-on bag',
    });
    console.log(`booked ${job.reference} (searching)`);
  }

  const docs = await boy.driver.documents();
  if (!docs.some((d) => d.doc_type === 'drivers_license')) {
    const path = `${boy.userId}/drivers_license-${Date.now()}.jpg`;
    await boy.files.uploadFromUri('driver-docs', path, TINY_JPEG);
    await boy.driver.recordDocument('drivers_license', path);
    console.log('uploaded a licence for Boy Reyes to review');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
