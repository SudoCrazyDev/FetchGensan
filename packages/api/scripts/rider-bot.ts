/**
 * A pretend rider for manual testing of the customer app.
 *
 *   pnpm --filter @fetch/api rider:bot [stepSeconds]
 *
 * Signs in as the seeded approved rider, goes online near Gaisano, accepts
 * the next offer, and walks the job through every status with a pause
 * between steps so you can watch the customer screen change. Errands get a
 * receipt with every item priced at PHP 50. Local stack only.
 */

import { createFetchClient } from '../src/client';
import { createApi } from '../src/api';

const URL_ = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

if (!URL_.includes('127.0.0.1') && !URL_.includes('localhost')) {
  console.error(`Refusing to run against a non-local URL: ${URL_}`);
  process.exit(1);
}

const STEP_MS = Number(process.argv[2] ?? 6) * 1000;
const HERE = { latitude: 6.1131, longitude: 125.1722 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
  await api.auth.requestOtp('+639170000002');
  await api.auth.verifyOtp('+639170000002', '123456');

  await api.driver.ping(HERE);
  await api.driver.setOnline(true);
  console.log('online near Gaisano, waiting for an offer…');

  let jobId: string | null = (await api.driver.activeJob())?.id ?? null;
  for (let i = 0; !jobId && i < 120; i += 1) {
    await api.driver.ping(HERE);
    const offers = await api.driver.pendingOffers();
    if (offers[0]) {
      const job = await api.driver.claim(offers[0].job_id);
      jobId = job.id;
      console.log(`accepted ${job.reference} (${job.job_type})`);
    } else {
      await sleep(2000);
    }
  }
  if (!jobId) throw new Error('no offer arrived in 4 minutes');

  const step = async (label: string, fn: () => Promise<unknown>) => {
    await sleep(STEP_MS);
    await api.driver.ping(HERE);
    await fn();
    console.log(label);
  };

  let job = (await api.jobs.byId(jobId))!;
  await step('arriving', () => api.driver.advance(jobId!, 'arriving'));
  await step('arrived at pickup', () => api.driver.advance(jobId!, 'arrived_pickup'));

  if (job.job_type === 'errand') {
    await step('shopping', () => api.driver.advance(jobId!, 'shopping'));
    const items = await api.jobs.items(jobId);
    await step('receipt sent', () =>
      api.driver.submitReceipt(
        jobId!,
        items.map((i) => ({
          id: i.id,
          actual_price_centavos: 5000,
          is_available: true,
          substitute_note: '',
        })),
      ),
    );
    console.log('waiting for the customer to approve…');
    for (;;) {
      await sleep(2000);
      job = (await api.jobs.byId(jobId))!;
      if (job.status === 'in_progress') break;
      if (job.status === 'shopping') {
        const latest = (await api.jobs.events(jobId)).filter((e) => e.event_type === 'total_rejected').pop();
        console.log(`customer sent it back: ${String(latest?.payload?.reason ?? '')}; resubmitting at PHP 40 each`);
        await api.driver.submitReceipt(
          jobId,
          items.map((i) => ({ id: i.id, actual_price_centavos: 4000, is_available: true, substitute_note: '' })),
        );
      }
      if (job.status === 'cancelled') {
        console.log('customer cancelled');
        await api.driver.setOnline(false);
        return;
      }
    }
    console.log('approved, delivering');
  } else {
    await step('trip started', () => api.driver.advance(jobId!, 'in_progress'));
  }

  await step('completed', () => api.driver.complete(jobId!));
  await api.driver.setOnline(false);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
