/**
 * End-to-end flow test over the real API, as real signed-in users.
 *
 *   pnpm test:e2e
 *
 * The SQL suite (supabase/tests) runs as superuser, which bypasses RLS --
 * so it proves the logic but not the policies. This script signs in as the
 * seeded customer, riders, dispatcher and admin through Supabase Auth and
 * drives every flow the three apps depend on, through the same `createApi`
 * the apps use. A permission the apps need but RLS refuses fails here.
 *
 * Needs the local stack running and seeded:
 *
 *   npx supabase db reset
 *   SUPABASE_SERVICE_ROLE_KEY=... pnpm seed:users
 *
 * Refuses to run against anything but a local stack: it books, completes
 * and cancels jobs and moves wallet balances.
 */

import { createFetchClient } from '../src/client';
import { createApi, type Api } from '../src/api';
import type { Job } from '../src/types';

const URL_ = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  // The fixed demo key every local Supabase stack ships with.
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

if (!URL_.includes('127.0.0.1') && !URL_.includes('localhost')) {
  console.error(`Refusing to run the e2e flow against a non-local URL: ${URL_}`);
  process.exit(1);
}

const OTP = '123456';

// A 1x1 JPEG, so uploads carry real bytes.
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////' +
  '//////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP' +
  '/aAAgBAQABPxA=';

// Gaisano Mall -> KCC Mall, about 750 m apart.
const GAISANO = { latitude: 6.1128, longitude: 125.1719 };
const KCC = { latitude: 6.1155, longitude: 125.1783 };
const NEAR_GAISANO = { latitude: 6.1131, longitude: 125.1722 };

let passed = 0;

function ok(label: string) {
  passed += 1;
  console.log(`  ok   ${label}`);
}

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${label}`);
  ok(label);
}

async function rejects(p: Promise<unknown>, label: string, match?: RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    if (match && !match.test(msg)) throw new Error(`FAIL: ${label} -- wrong error: ${msg}`);
    ok(label);
    return;
  }
  throw new Error(`FAIL: ${label} -- expected an error, got success`);
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

async function signIn(phone: string): Promise<Api & { userId: string }> {
  const client = createFetchClient({ url: URL_, anonKey: ANON, storage: memoryStorage() });
  const api = createApi(client);
  // Phone OTP at the Auth level: the local stack's test codes accept it,
  // and it creates the unseeded numbers on first use.
  await api.client.auth.signInWithOtp({ phone });
  const {
    data: { user },
    error,
  } = await api.client.auth.verifyOtp({ phone, token: OTP, type: 'sms' });
  if (error) throw error;
  if (!user) throw new Error(`could not sign in ${phone}`);
  return Object.assign(api, { userId: user.id });
}

async function finishAnyLiveJob(customer: Api, staff: Api) {
  const live = await customer.jobs.active();
  if (live) await staff.dispatch.cancel(live.id, 'e2e cleanup');
}

async function goOnlineNear(driver: Api, at = NEAR_GAISANO) {
  await driver.driver.ping(at);
  await driver.driver.setOnline(true);
  await driver.driver.ping(at);
}

async function walkToPickup(driver: Api, job: Job) {
  await driver.driver.advance(job.id, 'arriving');
  await driver.driver.advance(job.id, 'arrived_pickup');
}

async function main() {
  console.log(`==> signing in against ${URL_}`);
  const maria = await signIn('+639170000001'); // customer
  const ramon = await signIn('+639170000002'); // approved rider
  const boy = await signIn('+639170000003'); // pending rider
  const ops = await signIn('+639170000004'); // dispatcher
  const owner = await signIn('+639170000005'); // admin
  ok('all five seeded accounts sign in by OTP');

  // Start from the seeded state even if a previous run died halfway.
  await finishAnyLiveJob(maria, ops);
  await ramon.driver.setOnline(false);
  await boy.driver.setOnline(false).catch(() => undefined);
  await ops.dispatch.setDriverStatus(boy.userId, 'pending');

  // ---------------------------------------------------------- driver approval
  console.log('==> driver approval');
  await rejects(
    maria.dispatch.setDriverStatus(boy.userId, 'approved'),
    'a customer cannot approve a driver',
    /permission/,
  );
  await rejects(boy.driver.setOnline(true), 'a pending driver cannot go online', /not approved/);
  await ops.dispatch.setDriverStatus(boy.userId, 'approved');
  const boyRow = await boy.driver.me();
  assert(boyRow?.status === 'approved', 'the dispatcher approves a pending driver');
  const boyProfile = await boy.profile.me();
  assert(boyProfile?.role === 'driver', 'approval promotes the profile role to driver');

  // ---------------------------------------------------------- new rider signup
  console.log('==> new rider signup');
  const newbie = await signIn('+639170000007');
  const plate = `E2E ${Date.now() % 10000}`;
  await newbie.driver.register({
    full_name: 'Test Rider',
    vehicle_make: 'Honda',
    vehicle_model: 'Beat',
    vehicle_color: 'Red',
    plate_number: plate,
    license_number: 'D00-00-000000',
  });
  const edited = await newbie.driver.register({
    full_name: 'Test Rider Jr',
    vehicle_make: 'Honda',
    vehicle_model: 'Beat',
    vehicle_color: 'White',
    plate_number: plate,
    license_number: 'D00-00-000000',
  });
  assert(edited.vehicle_color === 'White', 'a rider can save vehicle details twice (upsert fix)');
  assert(edited.status === 'pending', 'a new rider starts pending');
  assert(
    (await newbie.profile.me())?.full_name === 'Test Rider Jr',
    'registering sets the rider name customers will see',
  );
  await rejects(
    newbie.driver.register({
      full_name: 'Copycat',
      vehicle_make: 'x',
      vehicle_model: 'x',
      vehicle_color: 'x',
      plate_number: 'GS 1234',
      license_number: 'x',
    }),
    "a rider cannot register another rider's plate",
    /already registered/,
  );

  // An approved document is locked against replacement (RLS), so on a re-run
  // use a type this rider has not had approved yet.
  const approvedTypes = new Set(
    (await newbie.driver.documents()).filter((d) => d.status === 'approved').map((d) => d.doc_type),
  );
  const docType = (
    ['drivers_license', 'or_cr', 'selfie_with_license', 'vehicle_photo',
     'nbi_clearance', 'barangay_clearance'] as const
  ).find((t) => !approvedTypes.has(t));
  if (!docType) throw new Error('every document type is already approved -- run `supabase db reset`');

  const docPath = `${newbie.userId}/${docType}-${Date.now()}.jpg`;
  await newbie.files.uploadFromUri('driver-docs', docPath, TINY_JPEG);
  await newbie.driver.recordDocument(docType, docPath);
  const docs = (await ops.dispatch.driverDocuments(newbie.userId)).filter(
    (d) => d.doc_type === docType,
  );
  assert(docs.length === 1 && docs[0]!.status === 'pending', 'the dispatcher sees the upload');
  const docUrl = await ops.dispatch.signedUrl('driver-docs', docPath);
  const docBytes = await fetch(docUrl).then((r) => r.arrayBuffer());
  assert(docBytes.byteLength > 0, 'the uploaded document has real bytes and staff can open it');
  await rejects(
    ops.dispatch.reviewDocument(docs[0]!.id, 'rejected', ''),
    'rejecting a document needs a reason',
    /say why/,
  );
  await ops.dispatch.reviewDocument(docs[0]!.id, 'rejected', 'Blurry, retake it');
  const rejected = (await newbie.driver.documents()).find((d) => d.doc_type === docType)!;
  assert(
    rejected.status === 'rejected' && rejected.reject_reason === 'Blurry, retake it',
    'the rider sees why the document was rejected',
  );
  await newbie.driver.recordDocument(docType, docPath);
  assert(
    (await newbie.driver.documents()).find((d) => d.doc_type === docType)!.status === 'pending',
    'a rider can replace a rejected document',
  );
  await ops.dispatch.reviewDocument(docs[0]!.id, 'approved');
  ok('the dispatcher approves the replacement');

  // ---------------------------------------------------------- ride
  console.log('==> ride: book, offer, claim, track, complete, rate');
  await goOnlineNear(ramon);
  await boy.driver.setOnline(false);

  const before = (await ramon.driver.me())!.wallet_balance_centavos;

  const quote = await maria.pricing.quote('ride', 1000);
  assert(quote.total_centavos > 0, 'the customer can get the authoritative server quote');

  const ride = await maria.jobs.create({
    jobType: 'ride',
    pickup: GAISANO,
    dropoff: KCC,
    pickupLabel: 'Gaisano Mall of Gensan',
    pickupLandmark: 'Main entrance, by the guard',
    dropoffLabel: 'KCC Mall of Gensan',
  });
  assert(ride.status === 'searching', 'a ride books straight into searching');
  assert(ride.quoted_fare_centavos > 0, 'the server priced the ride');

  const offers = await ramon.driver.pendingOffers();
  assert(
    offers.some((o) => o.job_id === ride.id),
    'the nearby online rider receives the offer',
  );
  assert(
    (await ramon.driver.activeJob()) === null,
    'an unclaimed offer is not mistaken for the rider\'s active job',
  );
  await rejects(
    ramon.driver.customerContact(ride.id).then((c) => {
      if (c) throw new Error('leaked');
      throw new Error('none');
    }),
    'the customer number is hidden until the rider accepts',
    /none/,
  );

  const claimed = await ramon.driver.claim(ride.id);
  assert(claimed.status === 'assigned' && claimed.driver_id === ramon.userId, 'first accept wins');
  assert((await ramon.driver.activeJob())?.id === ride.id, 'the claimed job is the active job');

  const contact = await ramon.driver.customerContact(ride.id);
  assert(contact?.phone === '+639170000001', 'the rider can see who to call once assigned');
  const info = await maria.jobs.assignedDriver(ramon.userId);
  assert(info?.plate_number === 'GS 1234', 'the customer sees the rider and plate');

  await walkToPickup(ramon, ride);
  await ramon.driver.ping(GAISANO);
  const pos = await maria.jobs.driverPosition(ride.id);
  assert(pos !== null, 'the customer can track the rider on the map');
  await ramon.driver.advance(ride.id, 'in_progress');
  const done = await ramon.driver.complete(ride.id);
  assert(done.status === 'completed', 'the ride completes');

  const after = (await ramon.driver.me())!.wallet_balance_centavos;
  assert(after === before - done.commission_centavos, 'commission is debited from the wallet');
  assert((await ramon.driver.me())!.active_job_id === null, 'completing frees the rider');

  await maria.jobs.rate(ride.id, 5, 'Smooth');
  await ramon.jobs.rate(ride.id, 5, 'On time at the gate');
  assert((await maria.jobs.myRating(ride.id))?.stars === 5, 'the customer rating is remembered');
  assert((await ramon.jobs.myRating(ride.id))?.stars === 5, 'the rider can rate the customer');
  await rejects(maria.jobs.rate(ride.id, 1), 'a booking cannot be rated twice');

  const history = await maria.jobs.history();
  assert(history.some((j) => j.id === ride.id), 'the ride shows in the customer history');

  // ---------------------------------------------------------- errand
  console.log('==> errand: shop, receipt, reject, resubmit, approve, deliver');
  await ramon.driver.ping(NEAR_GAISANO);
  const errand = await maria.jobs.create({
    jobType: 'errand',
    pickup: GAISANO,
    dropoff: KCC,
    pickupLabel: 'Gaisano Mall of Gensan',
    dropoffLabel: 'KCC Mall of Gensan',
    items: [
      { name: 'Rice', quantity: 1, unit: 'kg', notes: '' },
      { name: 'Eggs', quantity: 12, unit: 'pc', notes: 'brown if possible' },
    ],
    itemsBudgetCentavos: 50_000,
  });
  await ramon.driver.claim(errand.id);
  await walkToPickup(ramon, errand);
  const items = await ramon.jobs.items(errand.id);
  assert(items.length === 2, 'the rider sees the shopping list');

  await rejects(
    ramon.driver.submitReceipt(errand.id, []),
    'a receipt cannot be sent before shopping starts',
    /start shopping/,
  );
  await ramon.driver.advance(errand.id, 'shopping');

  const receiptPath = `${errand.id}/receipt-${Date.now()}.jpg`;
  await ramon.files.uploadFromUri('receipts', receiptPath, TINY_JPEG);
  await ramon.driver.submitReceipt(
    errand.id,
    items.map((i) => ({
      id: i.id,
      actual_price_centavos: 15_000,
      is_available: true,
      substitute_note: '',
    })),
    receiptPath,
  );

  const receipts = await maria.jobs.receipts(errand.id);
  assert(receipts.length === 1, 'the customer can list the receipt photo');
  const receiptUrl = await maria.files.signedUrl('receipts', receipts[0]!.storage_path);
  assert(
    (await fetch(receiptUrl).then((r) => r.arrayBuffer())).byteLength > 0,
    'the customer can open the receipt photo',
  );
  await rejects(
    maria.jobs.cancel(errand.id),
    'the customer cannot cancel once items are bought',
    /already bought/,
  );

  const sentBack = await maria.jobs.rejectErrandTotal(errand.id, 'Only one dozen eggs please');
  assert(sentBack.status === 'shopping', 'the customer can send the total back');
  const events = await ramon.jobs.events(errand.id);
  assert(
    events.some((e) => e.event_type === 'total_rejected'),
    'the reason is logged for the rider',
  );

  await ramon.driver.submitReceipt(
    errand.id,
    items.map((i) => ({
      id: i.id,
      actual_price_centavos: 12_000,
      is_available: true,
      substitute_note: '',
    })),
  );
  const approved = await maria.jobs.approveErrandTotal(errand.id);
  assert(approved.status === 'in_progress', 'the customer approves the corrected total');
  const delivered = await ramon.driver.complete(errand.id);
  assert(delivered.final_total_centavos === delivered.quoted_fare_centavos + 24_000,
    'the errand total is fee plus receipt');
  assert(
    delivered.commission_centavos ===
      Math.round((delivered.quoted_fare_centavos * delivered.commission_bps) / 10_000),
    'errand commission is on the fee, not the groceries',
  );

  // ---------------------------------------------------------- nothing in stock
  console.log('==> errand where nothing was in stock');
  await ramon.driver.ping(NEAR_GAISANO);
  const empty = await maria.jobs.create({
    jobType: 'errand',
    pickup: GAISANO,
    dropoff: KCC,
    items: [{ name: 'Durian ice cream', quantity: 1, unit: 'tub', notes: '' }],
  });
  await ramon.driver.claim(empty.id);
  await walkToPickup(ramon, empty);
  await ramon.driver.advance(empty.id, 'shopping');
  const [only] = await ramon.jobs.items(empty.id);
  await ramon.driver.submitReceipt(empty.id, [
    { id: only!.id, actual_price_centavos: 0, is_available: false, substitute_note: '' },
  ]);
  const cancelled = await maria.jobs.cancel(empty.id, 'Nothing was available');
  assert(cancelled.status === 'cancelled', 'a zero-cost errand can be cancelled by the customer');
  assert((await ramon.driver.me())!.active_job_id === null, 'the rider is freed by that cancel');

  // ---------------------------------------------------------- manual assign
  console.log('==> manual assignment from the console');
  await ramon.driver.setOnline(false);
  const manual = await maria.jobs.create({ jobType: 'delivery', pickup: GAISANO, dropoff: KCC,
    recipientName: 'Lola', recipientPhone: '+639171234567' });
  await rejects(
    maria.dispatch.assign(manual.id, boy.userId),
    'a customer cannot assign a rider',
    /permission/,
  );
  await rejects(
    ops.dispatch.assign(manual.id, newbie.userId),
    'an unapproved rider cannot be assigned',
    /approved/,
  );
  await ops.dispatch.assign(manual.id, boy.userId);
  assert(
    (await boy.driver.activeJob())?.id === manual.id,
    'the hand-assigned job appears on that rider\'s phone',
  );
  const board = await ops.dispatch.board();
  assert(
    board.some((r) => r.id === manual.id && r.driver_id === boy.userId),
    'the live board shows the assignment',
  );
  await walkToPickup(boy, manual);
  await boy.driver.advance(manual.id, 'in_progress');
  await boy.driver.complete(manual.id);
  ok('the hand-assigned rider completes the delivery');

  // ---------------------------------------------------------- console reads
  console.log('==> console: search, customers, stats, wallet');
  const found = await ops.dispatch.jobs({ search: ride.reference });
  assert(found.length === 1 && found[0]!.id === ride.id, 'job search finds a booking by reference');
  const byPhone = await ops.dispatch.jobs({ search: '9170000001', status: 'completed' });
  assert(byPhone.length >= 3, 'job search finds bookings by customer phone');
  await rejects(
    maria.dispatch.jobs().then((rows) => {
      if (rows.length > 0) throw new Error('leaked');
      throw new Error('empty');
    }),
    'a customer reads nothing from admin_jobs',
    /empty/,
  );
  const customers = await ops.dispatch.customers('Maria');
  assert(customers[0]?.completed_jobs !== undefined && customers.length >= 1, 'customer search works');
  const stats = await ops.dispatch.dailyStats(7);
  assert(stats.length === 7 && stats[0]!.completed >= 3, 'daily stats count today\'s trips');
  const ledger = await ops.dispatch.driverWallet(ramon.userId);
  assert(ledger.some((t) => t.kind === 'commission'), 'staff can read a rider\'s ledger');

  await ops.dispatch.recordTopup(ramon.userId, 10_000, 'e2e top-up');
  await rejects(
    ops.dispatch.walletAdjustment(ramon.userId, 500, 'goodwill'),
    'a dispatcher cannot make wallet adjustments',
    /permission/,
  );
  await rejects(
    owner.dispatch.walletAdjustment(ramon.userId, 500, ''),
    'an adjustment needs a note',
    /say why/,
  );
  await owner.dispatch.walletAdjustment(ramon.userId, 500, 'Refund for disputed trip');
  ok('an admin can post a noted wallet adjustment');

  // ---------------------------------------------------------- blocking
  console.log('==> blocking a customer');
  const newCustomer = await signIn('+639170000006');
  const block = async (who: Api, blocked: boolean) => {
    const { error } = await who.client.rpc('set_user_blocked', {
      p_user_id: newCustomer.userId,
      p_blocked: blocked,
    });
    if (error) throw error;
  };
  await rejects(block(ops, true), 'a dispatcher cannot deactivate accounts (users.manage)', /permission/);
  await block(owner, true);
  await rejects(
    newCustomer.jobs.create({ jobType: 'ride', pickup: GAISANO, dropoff: KCC }),
    'a deactivated customer cannot book',
  );
  await block(owner, false);
  ok('unblocking works');

  // ---------------------------------------------------------- pricing
  console.log('==> pricing');
  const rideFare = (await owner.pricing.configs()).find((c) => c.job_type === 'ride')!;
  await rejects(
    ops.dispatch.updateFare('ride', { ...rideFare }),
    'a dispatcher cannot change fares',
    /permission/,
  );
  await owner.dispatch.updateFare('ride', { ...rideFare, base_fare_centavos: rideFare.base_fare_centavos + 100 });
  const newFare = (await maria.pricing.configs()).find((c) => c.job_type === 'ride')!;
  assert(
    newFare.base_fare_centavos === rideFare.base_fare_centavos + 100,
    'an admin fare change is live for customers immediately',
  );
  const fareHistory = await owner.dispatch.fareHistory();
  assert(fareHistory.filter((f) => f.job_type === 'ride').length >= 2, 'the old fare is kept as history');
  await owner.dispatch.updateFare('ride', { ...rideFare });
  ok('fare restored');

  // ---------------------------------------------------------- landmarks & places
  console.log('==> landmarks and saved places');
  const lmId = await ops.dispatch.saveLandmark({
    name: `E2E Landmark ${Date.now()}`,
    category: 'test',
    location: GAISANO,
  });
  await ops.dispatch.saveLandmark({
    id: lmId,
    name: `E2E Landmark moved ${Date.now()}`,
    category: 'test',
    location: KCC,
    isActive: false,
  });
  const lm = (await ops.dispatch.landmarks()).find((l) => l.id === lmId)!;
  assert(Math.abs(lm.lat - KCC.latitude) < 1e-6 && !lm.is_active, 'staff can move and hide a landmark');
  const nearby = await maria.places.searchLandmarks('gaisano', GAISANO);
  assert(nearby[0]?.distance_m !== null, 'landmark search works with the customer location');
  const anonApi = createApi(createFetchClient({ url: URL_, anonKey: ANON, storage: memoryStorage() }));
  assert((await anonApi.places.searchLandmarks('kcc', KCC)).length > 0,
    'landmark search works before sign-in');
  const search = await maria.places.searchLandmarks('E2E Landmark');
  assert(!search.some((l) => l.id === lmId), 'a hidden landmark is not offered to customers');

  const place = await maria.places.save({ label: 'Home', landmarkNote: 'Blue gate', location: KCC });
  const saved = (await maria.places.saved()).find((p) => p.id === place.id)!;
  assert(Math.abs(saved.lat - KCC.latitude) < 1e-6, 'saved places come back with coordinates');
  await maria.places.remove(place.id);
  ok('a saved place can be deleted');

  // ---------------------------------------------------------- roles
  console.log('==> roles');
  const roles = await owner.access.roles();
  const dispatcherRole = roles.find((r) => r.key === 'dispatcher')!;
  await rejects(ops.access.setRoles(newCustomer.userId, [dispatcherRole.id]),
    'a dispatcher cannot hand out roles', /permission/);
  await rejects(owner.access.setRoles(owner.userId, []),
    'the last admin cannot remove their own admin role');
  const perms = await owner.access.mine();
  assert(perms.includes('wallet.adjust'), 'admins hold the new wallet.adjust permission');
  assert(!(await ops.access.mine()).includes('wallet.adjust'), 'dispatchers do not');

  // Leave the fleet as the seed left it, so the apps start clean.
  await ramon.driver.setOnline(false);
  await boy.driver.setOnline(false);
  await ops.dispatch.setDriverStatus(boy.userId, 'pending');

  console.log(`\n==> all ${passed} end-to-end checks passed`);
}

main().catch((e) => {
  console.error('\n' + (e instanceof Error ? e.message : JSON.stringify(e)));
  process.exit(1);
});
