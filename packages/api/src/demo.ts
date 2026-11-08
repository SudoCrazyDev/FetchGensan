/**
 * Demo mode: an in-memory stand-in for the whole server surface.
 *
 * Built so the mobile apps can be installed and clicked through before a
 * Supabase project exists. It is switched on only by building with
 * `EXPO_PUBLIC_DEMO=1` (see apps/*\/src/lib/supabase.ts); a normal build never
 * constructs it.
 *
 * Nothing here is authoritative. There is no RLS, no state machine guard
 * trigger, no first-accept-wins: it implements just enough of each call for
 * every screen to have something believable to show. The fare maths does
 * come from @fetch/core, so the numbers match what the real server charges.
 *
 * The driver app opens signed in as an approved driver; the rider app opens
 * signed in as a customer. Signing out shows the sign-in screen, where any
 * number and password signs back in.
 *
 * Jobs move on their own. A customer booking is "accepted" a few seconds
 * after it is made and then driven to completion on a timer; a driver
 * accepting an offer moves only when the driver presses the button, except
 * for the customer's receipt approval, which is simulated.
 */

import {
  type JobStatus,
  type JobType,
  type LatLng,
  estimateRoadMeters,
  estimateSeconds,
  fareConfigFromRow,
  quoteFare,
} from '@fetch/core';

import type { Api, CreateJobInput } from './api';
import type { FetchClient } from './client';
import type {
  Driver,
  DriverDocument,
  DriverPosition,
  ErrandItem,
  FareConfigRow,
  FareQuoteRow,
  Job,
  JobOffer,
  LandmarkResult,
  Profile,
  PublicDriverInfo,
  SavedPlace,
  SignInResult,
  WalletTransaction,
} from './types';

export interface DemoOptions {
  /** Which app is asking; decides whose account the demo is signed in as. */
  app: 'rider' | 'driver';
}

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001';
const DRIVER_ID = '00000000-0000-4000-8000-000000000002';

const LANDMARKS: Omit<LandmarkResult, 'distance_m'>[] = [
  { id: 'lm-01', name: 'Gaisano Mall of Gensan', category: 'mall', lng: 125.1719, lat: 6.1128 },
  { id: 'lm-02', name: 'KCC Mall of Gensan', category: 'mall', lng: 125.1783, lat: 6.1155 },
  { id: 'lm-03', name: 'Robinsons Place Gensan', category: 'mall', lng: 125.169, lat: 6.1093 },
  { id: 'lm-04', name: 'SM City General Santos', category: 'mall', lng: 125.166, lat: 6.121 },
  { id: 'lm-05', name: 'General Santos City Hall', category: 'government', lng: 125.1717, lat: 6.1128 },
  { id: 'lm-06', name: 'Gensan Public Market', category: 'market', lng: 125.1745, lat: 6.1108 },
  { id: 'lm-07', name: 'Bulaong Terminal', category: 'terminal', lng: 125.183, lat: 6.1176 },
  { id: 'lm-08', name: 'General Santos City Airport', category: 'transport', lng: 125.0965, lat: 6.1075 },
  { id: 'lm-09', name: 'Makar Wharf', category: 'transport', lng: 125.13, lat: 6.105 },
  { id: 'lm-10', name: 'Dr. Jorge P. Royeca Hospital', category: 'hospital', lng: 125.1741, lat: 6.1163 },
  { id: 'lm-11', name: 'Mindanao State University Gensan', category: 'school', lng: 125.1508, lat: 6.1093 },
  { id: 'lm-12', name: 'Notre Dame of Dadiangas University', category: 'school', lng: 125.1723, lat: 6.1141 },
  { id: 'lm-13', name: 'Plaza Heneral Santos', category: 'landmark', lng: 125.1713, lat: 6.112 },
  { id: 'lm-14', name: 'Queen Tuna Park', category: 'landmark', lng: 125.1638, lat: 6.1063 },
];

/** Same numbers as the seed rows in 20260907000300_pricing.sql. */
const FARE_CONFIGS: FareConfigRow[] = (
  [
    ['ride', 2500, 2000, 900, 2500, 0, 1500, 1500],
    ['delivery', 3000, 2000, 1000, 3000, 1000, 1500, 1500],
    ['errand', 3000, 2000, 1000, 5000, 5000, 1500, 2000],
  ] as const
).map(([job_type, base, included, perKm, min, fee, night, bps]) => ({
  id: `fare-${job_type}`,
  job_type,
  base_fare_centavos: base,
  included_meters: included,
  per_km_centavos: perKm,
  per_minute_centavos: 0,
  min_fare_centavos: min,
  service_fee_centavos: fee,
  night_surcharge_centavos: night,
  night_starts_hour: 22,
  night_ends_hour: 5,
  commission_bps: bps,
  max_item_float_centavos: 100000,
  is_active: true,
}));

const DEMO_DRIVER_PUBLIC: PublicDriverInfo = {
  id: DRIVER_ID,
  full_name: 'Ramon Dela Cruz',
  avatar_path: null,
  vehicle_make: 'Honda',
  vehicle_model: 'TMX 125',
  vehicle_color: 'Red',
  plate_number: '123 ABC',
  rating: 4.8,
  rating_count: 212,
  completed_jobs: 640,
};

// ---------------------------------------------------------------- helpers

let seq = 0;
/** UUID-shaped, because some screens validate ids with z.string().uuid(). */
function uid(_kind: string): string {
  seq += 1;
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function wait(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lm(id: string) {
  const found = LANDMARKS.find((l) => l.id === id);
  if (!found) throw new Error(`unknown demo landmark ${id}`);
  return found;
}

function quote(jobType: JobType, meters: number): FareQuoteRow {
  const row = FARE_CONFIGS.find((c) => c.job_type === jobType)!;
  const q = quoteFare(fareConfigFromRow(row), meters, 0);
  return {
    base_fare_centavos: q.baseFareCentavos,
    distance_fare_centavos: q.distanceFareCentavos,
    time_fare_centavos: q.timeFareCentavos,
    service_fee_centavos: q.serviceFeeCentavos,
    night_surcharge_centavos: q.nightSurchargeCentavos,
    total_centavos: q.totalCentavos,
    commission_bps: q.commissionBps,
  };
}

function makeJob(input: {
  jobType: JobType;
  status: JobStatus;
  from: { label: string; lng: number; lat: number; landmark?: string };
  to: { label: string; lng: number; lat: number; landmark?: string };
  createdMinutesAgo?: number;
  driverId?: string | null;
  notes?: string;
  itemsBudgetCentavos?: number;
  itemsCostCentavos?: number;
}): Job {
  const a: LatLng = { latitude: input.from.lat, longitude: input.from.lng };
  const b: LatLng = { latitude: input.to.lat, longitude: input.to.lng };
  const meters = Math.round(estimateRoadMeters(a, b));
  const q = quote(input.jobType, meters);
  const created = minutesAgo(input.createdMinutesAgo ?? 0);
  const done = input.status === 'completed';
  const itemsCost = input.itemsCostCentavos ?? 0;
  // create_job() sets this to the quote up front; a receipt adds the items.
  const finalTotal = q.total_centavos + itemsCost;

  seq += 1;
  return {
    id: uid('job'),
    reference: `FG-${(4800 + seq).toString()}`,
    customer_id: CUSTOMER_ID,
    driver_id: input.driverId ?? null,
    job_type: input.jobType,
    status: input.status,
    pickup_label: input.from.label,
    pickup_landmark: input.from.landmark ?? '',
    dropoff_label: input.to.label,
    dropoff_landmark: input.to.landmark ?? '',
    pickup_lng: input.from.lng,
    pickup_lat: input.from.lat,
    dropoff_lng: input.to.lng,
    dropoff_lat: input.to.lat,
    recipient_name: '',
    recipient_phone: '',
    notes: input.notes ?? '',
    distance_meters: meters,
    duration_seconds: estimateSeconds(meters),
    base_fare_centavos: q.base_fare_centavos,
    distance_fare_centavos: q.distance_fare_centavos,
    time_fare_centavos: q.time_fare_centavos,
    service_fee_centavos: q.service_fee_centavos,
    night_surcharge_centavos: q.night_surcharge_centavos,
    quoted_fare_centavos: q.total_centavos,
    items_cost_centavos: itemsCost,
    items_budget_centavos: input.itemsBudgetCentavos ?? 0,
    final_total_centavos: finalTotal,
    commission_bps: q.commission_bps,
    commission_centavos: done ? Math.round((q.total_centavos * q.commission_bps) / 10000) : 0,
    payment_method: 'cash',
    payment_status: done ? 'paid' : 'pending',
    scheduled_for: null,
    dispatch_attempts: 1,
    dispatch_radius_m: 3000,
    created_at: created,
    assigned_at: input.driverId ? created : null,
    arrived_pickup_at: null,
    started_at: null,
    completed_at: done ? created : null,
    cancelled_at: input.status === 'cancelled' ? created : null,
    cancelled_by: null,
    cancel_reason: input.status === 'cancelled' ? 'Changed my plans' : null,
  };
}

const LIVE: JobStatus[] = [
  'searching',
  'assigned',
  'arriving',
  'arrived_pickup',
  'shopping',
  'awaiting_approval',
  'in_progress',
];

// ---------------------------------------------------------------- the api

export function createDemoApi(opts: DemoOptions): Api {
  const isDriverApp = opts.app === 'driver';
  const userId = isDriverApp ? DRIVER_ID : CUSTOMER_ID;

  // ---- state

  let signedIn = true;
  const authListeners = new Set<(id: string | null) => void>();

  let profile: Profile = isDriverApp
    ? {
        id: DRIVER_ID,
        phone: '+639170000002',
        full_name: 'Ramon Dela Cruz',
        avatar_path: null,
        role: 'driver',
        is_blocked: false,
        created_at: minutesAgo(60 * 24 * 90),
      }
    : {
        id: CUSTOMER_ID,
        phone: '+639170000001',
        full_name: 'Maria Santos',
        avatar_path: null,
        role: 'customer',
        is_blocked: false,
        created_at: minutesAgo(60 * 24 * 30),
      };

  let walletBalance = -3750;

  // The driver starts registered and approved, so the app opens on the main
  // screen rather than onboarding.
  let driver: Driver | null = isDriverApp
    ? {
        id: DRIVER_ID,
        status: 'approved',
        vehicle_make: 'Honda',
        vehicle_model: 'TMX 125',
        vehicle_color: 'Red',
        plate_number: '123 ABC',
        license_number: 'N01-23-456789',
        is_online: false,
        rating_sum: 1018,
        rating_count: 212,
        wallet_balance_centavos: walletBalance,
        credit_floor_centavos: -50000,
        active_job_id: null,
        completed_jobs: 640,
        cancelled_jobs: 9,
        location_updated_at: null,
      }
    : null;
  let documents: DriverDocument[] = (
    ['drivers_license', 'or_cr', 'selfie_with_license', 'vehicle_photo'] as const
  ).map((doc_type) => ({
    id: uid('doc'),
    driver_id: DRIVER_ID,
    doc_type,
    storage_path: `${DRIVER_ID}/${doc_type}.jpg`,
    status: 'approved',
    expires_on: null,
    reject_reason: null,
    created_at: minutesAgo(60 * 24 * 60),
  }));

  const savedPlaces: SavedPlace[] = [
    {
      id: 'sp-home',
      profile_id: CUSTOMER_ID,
      label: 'Home',
      landmark_note: 'Green gate beside the sari-sari store, Purok Malakas',
      address_line: 'Brgy. Lagao',
      use_count: 12,
    },
    {
      id: 'sp-work',
      profile_id: CUSTOMER_ID,
      label: 'Work',
      landmark_note: 'KCC Mall, staff entrance at the back',
      address_line: 'Brgy. Lagao',
      use_count: 7,
    },
  ];

  const jobs: Job[] = [
    makeJob({
      jobType: 'ride',
      status: 'completed',
      from: { label: 'Home', lng: 125.1765, lat: 6.1201 },
      to: { label: lm('lm-02').name, lng: lm('lm-02').lng, lat: lm('lm-02').lat },
      createdMinutesAgo: 60 * 26,
      driverId: DRIVER_ID,
    }),
    // Rides only: the rider app currently hides errands and deliveries.
    makeJob({
      jobType: 'ride',
      status: 'completed',
      from: { label: lm('lm-06').name, lng: lm('lm-06').lng, lat: lm('lm-06').lat },
      to: { label: 'Home', lng: 125.1765, lat: 6.1201 },
      createdMinutesAgo: 60 * 24 * 3,
      driverId: DRIVER_ID,
    }),
    makeJob({
      jobType: 'ride',
      status: 'cancelled',
      from: { label: 'Home', lng: 125.1765, lat: 6.1201 },
      to: { label: lm('lm-10').name, lng: lm('lm-10').lng, lat: lm('lm-10').lat },
      createdMinutesAgo: 60 * 24 * 6,
    }),
  ];
  const items = new Map<string, ErrandItem[]>();

  const wallet: WalletTransaction[] = [
    {
      id: 3,
      driver_id: DRIVER_ID,
      job_id: null,
      kind: 'commission',
      amount_centavos: -1250,
      balance_after_centavos: -3750,
      note: 'Commission FG-4790',
      created_at: minutesAgo(90),
    },
    {
      id: 2,
      driver_id: DRIVER_ID,
      job_id: null,
      kind: 'commission',
      amount_centavos: -2500,
      balance_after_centavos: -2500,
      note: 'Commission FG-4788',
      created_at: minutesAgo(60 * 5),
    },
    {
      id: 1,
      driver_id: DRIVER_ID,
      job_id: null,
      kind: 'topup',
      amount_centavos: 50000,
      balance_after_centavos: 0,
      note: 'Cash top-up at the office',
      created_at: minutesAgo(60 * 24 * 2),
    },
  ];

  // An offer waiting for the driver whenever they are online and free.
  let offer: (JobOffer & { job: Job }) | null = null;

  const jobListeners = new Map<string, Set<(job: Job) => void>>();
  const myJobsListeners = new Set<(job: Job) => void>();
  const offerListeners = new Set<(offer: JobOffer) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  function findJob(id: string): Job {
    const job = jobs.find((j) => j.id === id) ?? (offer?.job.id === id ? offer.job : undefined);
    if (!job) throw new Error('booking not found');
    return job;
  }

  function update(job: Job, patch: Partial<Job>): Job {
    Object.assign(job, patch);
    const copy = { ...job };
    jobListeners.get(job.id)?.forEach((cb) => cb(copy));
    if (job.customer_id === CUSTOMER_ID) myJobsListeners.forEach((cb) => cb(copy));
    return copy;
  }

  function setStatus(job: Job, status: JobStatus): Job {
    const now = new Date().toISOString();
    const patch: Partial<Job> = { status };
    if (status === 'assigned') patch.assigned_at = now;
    if (status === 'arrived_pickup') patch.arrived_pickup_at = now;
    if (status === 'in_progress') patch.started_at = now;
    if (status === 'completed') {
      const total = job.quoted_fare_centavos + job.items_cost_centavos;
      patch.completed_at = now;
      patch.final_total_centavos = total;
      patch.commission_centavos = Math.round((job.quoted_fare_centavos * job.commission_bps) / 10000);
      patch.payment_status = 'paid';
    }
    if (status === 'cancelled') patch.cancelled_at = now;
    return update(job, patch);
  }

  /** Fills in plausible shop prices, as a driver's receipt would. */
  function priceItems(jobId: string): number {
    const list = items.get(jobId) ?? [];
    let total = 0;
    for (const item of list) {
      const price = (item.actual_price_centavos ?? 0) || (4500 + ((item.position * 3700) % 12000)) * item.quantity;
      item.actual_price_centavos = price;
      item.is_available = true;
      total += price;
    }
    return total;
  }

  /**
   * The customer side of a booking, simulated: a rider accepts, comes over,
   * and finishes. Errands stop at the receipt until the customer approves.
   */
  function runCustomerJob(job: Job) {
    const step = (ms: number, fn: () => void) =>
      later(ms, () => {
        if (job.status !== 'cancelled') fn();
      });

    step(5000, () => {
      update(job, { driver_id: DRIVER_ID });
      setStatus(job, 'assigned');
    });
    step(10000, () => setStatus(job, 'arriving'));
    step(22000, () => setStatus(job, 'arrived_pickup'));
    if (job.job_type === 'errand') {
      step(28000, () => setStatus(job, 'shopping'));
      step(38000, () => {
        const cost = priceItems(job.id);
        update(job, { items_cost_centavos: cost, final_total_centavos: job.quoted_fare_centavos + cost });
        setStatus(job, 'awaiting_approval');
      });
      // Resumes in approveErrandTotal().
    } else {
      step(28000, () => setStatus(job, 'in_progress'));
      step(48000, () => setStatus(job, 'completed'));
    }
  }

  function makeOffer(): JobOffer & { job: Job } {
    const kinds: JobType[] = ['ride', 'delivery', 'errand'];
    const jobType = kinds[(seq + 1) % kinds.length]!;
    const pairs: [string, string][] = [
      ['lm-01', 'lm-11'],
      ['lm-07', 'lm-04'],
      ['lm-06', 'lm-12'],
    ];
    const [fromId, toId] = pairs[(seq + 1) % pairs.length]!;
    const from = lm(fromId);
    const to = lm(toId);
    const job = makeJob({
      jobType,
      status: 'searching',
      from: { label: from.name, lng: from.lng, lat: from.lat, landmark: 'Main entrance, near the guard' },
      to: { label: to.name, lng: to.lng, lat: to.lat, landmark: 'Waiting by the gate' },
      notes: jobType === 'delivery' ? 'Small box of documents, please keep dry' : '',
      itemsBudgetCentavos: jobType === 'errand' ? 100000 : 0,
    });
    job.customer_id = 'demo-other-customer';
    if (jobType === 'errand') {
      items.set(job.id, [
        { name: 'Rice, 5 kg', quantity: 1, unit: 'sack' },
        { name: 'Eggs', quantity: 1, unit: 'tray' },
        { name: 'Cooking oil, 1 L', quantity: 2, unit: 'bottle' },
      ].map((it, i) => ({
        id: uid('item'),
        job_id: job.id,
        position: i,
        name: it.name,
        quantity: it.quantity,
        unit: it.unit,
        notes: '',
        actual_price_centavos: null,
        is_available: null,
        substitute_note: '',
      })));
    }
    const now = Date.now();
    return {
      id: uid('offer'),
      job_id: job.id,
      driver_id: DRIVER_ID,
      distance_m: 650 + ((seq * 137) % 1500),
      response: 'pending',
      offered_at: new Date(now).toISOString(),
      // Real offers last 25 seconds; this is long enough to read one. A new
      // offer replaces it when it runs out.
      expires_at: new Date(now + 90_000).toISOString(),
      round: 1,
      job,
    };
  }

  function refreshOffer() {
    const free = driver?.is_online && !driver.active_job_id && driver.status === 'approved';
    if (free && (!offer || new Date(offer.expires_at).getTime() < Date.now())) {
      offer = makeOffer();
      const o = offer;
      offerListeners.forEach((cb) => cb(o));
    }
    if (!free) offer = null;
  }

  function requireDriver(): Driver {
    if (!driver) throw new Error('Finish setting up your account first');
    return driver;
  }

  function session() {
    return signedIn ? ({ user: { id: userId } } as never) : null;
  }

  function signInResult(): SignInResult {
    return {
      user: {
        id: userId,
        phone: profile.phone,
        email: null,
        full_name: profile.full_name,
        account_type: profile.role,
      },
      permissions: [],
    };
  }

  function setSignedIn(next: boolean) {
    signedIn = next;
    authListeners.forEach((cb) => cb(next ? userId : null));
  }

  // The few direct client calls the apps make: photo uploads and push
  // registration. Everything else goes through the methods below.
  const client = {
    storage: {
      from: () => ({
        upload: async () => {
          await wait(600);
          return { data: { path: 'demo' }, error: null };
        },
      }),
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: session() }, error: null }) },
  } as unknown as FetchClient;

  // ---------------------------------------------------------------- surface

  const auth: Api['auth'] = {
    async signInWithPassword() {
      await wait(500);
      setSignedIn(true);
      return signInResult();
    },
    async requestPasswordReset(identifier) {
      await wait(500);
      return { channel: identifier.includes('@') ? 'email' : 'sms' };
    },
    async resetPassword() {
      await wait(500);
      setSignedIn(true);
      return signInResult();
    },
    async signOut() {
      setSignedIn(false);
    },
    async getSession() {
      return session();
    },
    onAuthStateChange(cb) {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
  };

  const profileApi: Api['profile'] = {
    async me() {
      return signedIn ? { ...profile } : null;
    },
    async update(patch) {
      await wait();
      profile = { ...profile, ...patch };
      return { ...profile };
    },
  };

  const pricing: Api['pricing'] = {
    async configs() {
      return FARE_CONFIGS;
    },
    async quote(jobType, distanceMeters) {
      await wait(200);
      return quote(jobType, distanceMeters);
    },
  };

  const places: Api['places'] = {
    async searchLandmarks(query, near) {
      await wait(150);
      const q = query.trim().toLowerCase();
      return LANDMARKS.filter((l) => !q || l.name.toLowerCase().includes(q) || l.category.includes(q)).map(
        (l) => ({
          ...l,
          distance_m: near
            ? Math.round(estimateRoadMeters(near, { latitude: l.lat, longitude: l.lng }))
            : null,
        }),
      );
    },
    async bumpLandmark() {},
    async saved() {
      return [...savedPlaces];
    },
    async save(input) {
      await wait();
      const place: SavedPlace = {
        id: uid('sp'),
        profile_id: CUSTOMER_ID,
        label: input.label,
        landmark_note: input.landmarkNote,
        address_line: input.addressLine ?? '',
        use_count: 0,
      };
      savedPlaces.push(place);
      return place;
    },
    async remove(id) {
      const i = savedPlaces.findIndex((p) => p.id === id);
      if (i >= 0) savedPlaces.splice(i, 1);
    },
  };

  const jobsApi: Api['jobs'] = {
    async create(input: CreateJobInput) {
      await wait(700);
      if (jobs.some((j) => j.customer_id === CUSTOMER_ID && LIVE.includes(j.status))) {
        throw new Error('You already have a booking in progress');
      }
      const job = makeJob({
        jobType: input.jobType,
        status: 'searching',
        from: {
          label: input.pickupLabel || 'Pinned location',
          landmark: input.pickupLandmark,
          lng: input.pickup.longitude,
          lat: input.pickup.latitude,
        },
        to: {
          label: input.dropoffLabel || 'Pinned location',
          landmark: input.dropoffLandmark,
          lng: input.dropoff.longitude,
          lat: input.dropoff.latitude,
        },
        notes: input.notes,
        itemsBudgetCentavos: input.itemsBudgetCentavos,
      });
      job.recipient_name = input.recipientName ?? '';
      job.recipient_phone = input.recipientPhone ?? '';
      job.payment_method = input.paymentMethod ?? 'cash';
      jobs.unshift(job);

      if (input.items?.length) {
        items.set(
          job.id,
          input.items.map((it, i) => ({
            id: uid('item'),
            job_id: job.id,
            position: i,
            name: it.name,
            quantity: it.quantity ?? 1,
            unit: it.unit ?? '',
            notes: it.notes ?? '',
            actual_price_centavos: null,
            is_available: null,
            substitute_note: '',
          })),
        );
      }

      runCustomerJob(job);
      return { ...job };
    },
    async byId(id) {
      const job = jobs.find((j) => j.id === id) ?? (offer?.job.id === id ? offer.job : null);
      return job ? { ...job } : null;
    },
    async active() {
      const job = jobs.find((j) => j.customer_id === CUSTOMER_ID && LIVE.includes(j.status));
      return job ? { ...job } : null;
    },
    async history() {
      return jobs
        .filter((j) => ['completed', 'cancelled', 'expired'].includes(j.status))
        .map((j) => ({ ...j }));
    },
    async items(jobId) {
      return (items.get(jobId) ?? []).map((i) => ({ ...i }));
    },
    async assignedDriver() {
      return DEMO_DRIVER_PUBLIC;
    },
    async driverPosition(jobId): Promise<DriverPosition | null> {
      const job = jobs.find((j) => j.id === jobId);
      if (!job || !job.driver_id) return null;

      // Approach the pickup while arriving, then move toward the drop-off.
      const goingToDropoff = job.status === 'in_progress';
      const startedAt = new Date(
        (goingToDropoff ? job.started_at : job.assigned_at) ?? job.created_at,
      ).getTime();
      const legMs = goingToDropoff ? 20000 : 12000;
      const t = Math.min(1, (Date.now() - startedAt) / legMs);

      const target = goingToDropoff
        ? { lng: job.dropoff_lng, lat: job.dropoff_lat }
        : { lng: job.pickup_lng, lat: job.pickup_lat };
      const origin = goingToDropoff
        ? { lng: job.pickup_lng, lat: job.pickup_lat }
        : { lng: job.pickup_lng + 0.006, lat: job.pickup_lat + 0.004 };
      const atPickup = job.status === 'arrived_pickup' || job.status === 'shopping' || job.status === 'awaiting_approval';

      return {
        lng: atPickup ? job.pickup_lng : origin.lng + (target.lng - origin.lng) * t,
        lat: atPickup ? job.pickup_lat : origin.lat + (target.lat - origin.lat) * t,
        heading: null,
        updated_at: new Date().toISOString(),
      };
    },
    async approveErrandTotal(jobId) {
      await wait();
      const job = findJob(jobId);
      if (job.status !== 'awaiting_approval') throw new Error('Nothing to approve');
      const copy = setStatus(job, 'in_progress');
      // setStatus moved it on already; the timer only finishes the trip.
      later(20000, () => setStatus(job, 'completed'));
      return copy;
    },
    async cancel(jobId, reason) {
      await wait();
      const job = findJob(jobId);
      update(job, { cancel_reason: reason || null, cancelled_by: userId });
      return setStatus(job, 'cancelled');
    },
    async rate() {
      await wait();
    },
    async events() {
      return [];
    },
    onJobChange(jobId, cb) {
      const set = jobListeners.get(jobId) ?? new Set();
      set.add(cb);
      jobListeners.set(jobId, set);
      return () => {
        set.delete(cb);
      };
    },
    onMyJobsChange(_customerId, cb) {
      myJobsListeners.add(cb);
      return () => {
        myJobsListeners.delete(cb);
      };
    },
  };

  const driverApi: Api['driver'] = {
    async me() {
      return signedIn && driver ? { ...driver } : null;
    },
    async register(input) {
      await wait(500);
      // A real registration waits for dispatch to approve it. The demo
      // approves straight away so the rest of the app is reachable.
      driver = {
        id: DRIVER_ID,
        status: 'approved',
        ...input,
        is_online: false,
        rating_sum: 1018,
        rating_count: 212,
        wallet_balance_centavos: walletBalance,
        credit_floor_centavos: -50000,
        active_job_id: null,
        completed_jobs: 640,
        cancelled_jobs: 9,
        location_updated_at: null,
      };
      return { ...driver };
    },
    async setOnline(online) {
      await wait(300);
      const d = requireDriver();
      d.is_online = online;
      refreshOffer();
      return { ...d };
    },
    async ping() {
      if (driver) driver.location_updated_at = new Date().toISOString();
    },
    async pendingOffers() {
      refreshOffer();
      return offer ? [{ ...offer, job: { ...offer.job } }] : [];
    },
    async claim(jobId) {
      await wait(400);
      const d = requireDriver();
      if (!offer || offer.job_id !== jobId) throw new Error('job already taken');
      const job = offer.job;
      offer = null;
      jobs.unshift(job);
      update(job, { driver_id: DRIVER_ID });
      d.active_job_id = job.id;
      return setStatus(job, 'assigned');
    },
    async decline() {
      await wait(200);
      offer = null;
      // Another one turns up shortly, as it would on a busy afternoon.
      later(8000, refreshOffer);
    },
    async activeJob() {
      const id = driver?.active_job_id;
      const job = id ? jobs.find((j) => j.id === id) : undefined;
      return job ? { ...job } : null;
    },
    async advance(jobId, to) {
      await wait(300);
      return setStatus(findJob(jobId), to);
    },
    async submitReceipt(jobId, submitted) {
      await wait(500);
      const job = findJob(jobId);
      const list = items.get(jobId) ?? [];
      let total = 0;
      for (const s of submitted) {
        const item = list.find((i) => i.id === s.id);
        if (!item) continue;
        item.actual_price_centavos = s.actual_price_centavos;
        item.is_available = s.is_available;
        item.substitute_note = s.substitute_note;
        if (s.is_available) total += s.actual_price_centavos;
      }
      update(job, { items_cost_centavos: total, final_total_centavos: job.quoted_fare_centavos + total });
      const copy = setStatus(job, 'awaiting_approval');
      // The customer approves a few seconds later.
      later(5000, () => setStatus(job, 'in_progress'));
      return copy;
    },
    async complete(jobId) {
      await wait(400);
      const d = requireDriver();
      const job = setStatus(findJob(jobId), 'completed');
      d.active_job_id = null;
      d.completed_jobs += 1;
      if (job.payment_method === 'cash') {
        walletBalance -= job.commission_centavos;
        d.wallet_balance_centavos = walletBalance;
        wallet.unshift({
          id: wallet.length + 1,
          driver_id: DRIVER_ID,
          job_id: job.id,
          kind: 'commission',
          amount_centavos: -job.commission_centavos,
          balance_after_centavos: walletBalance,
          note: `Commission ${job.reference}`,
          created_at: new Date().toISOString(),
        });
      }
      later(6000, refreshOffer);
      return job;
    },
    async wallet() {
      return wallet.map((w) => ({ ...w }));
    },
    async earnings(since) {
      const done = jobs.filter(
        (j) => j.driver_id === DRIVER_ID && j.status === 'completed' && j.completed_at && new Date(j.completed_at) >= since,
      );
      // A few earlier trips so today's card is not empty on first open.
      const base = { jobs: 4, grossCentavos: 31000, commissionCentavos: 4650 };
      return done.reduce(
        (acc, j) => ({
          jobs: acc.jobs + 1,
          grossCentavos: acc.grossCentavos + j.final_total_centavos - j.items_cost_centavos,
          commissionCentavos: acc.commissionCentavos + j.commission_centavos,
        }),
        base,
      );
    },
    async documents() {
      return documents.map((d) => ({ ...d }));
    },
    async recordDocument(docType, storagePath) {
      documents = documents.filter((d) => d.doc_type !== docType);
      documents.push({
        id: uid('doc'),
        driver_id: DRIVER_ID,
        doc_type: docType as DriverDocument['doc_type'],
        storage_path: storagePath,
        status: 'pending',
        expires_on: null,
        reject_reason: null,
        created_at: new Date().toISOString(),
      });
    },
    onOffer(_driverId, cb) {
      offerListeners.add(cb);
      return () => {
        offerListeners.delete(cb);
      };
    },
  };

  const notInDemo = async (): Promise<never> => {
    throw new Error('Not available in the demo build');
  };

  // The console is a separate web app and never runs in demo mode; these
  // exist only so the object satisfies the Api type.
  const dispatch: Api['dispatch'] = {
    board: async () => [],
    roster: async () => [],
    redispatch: notInDemo,
    nearbyDrivers: async () => [],
    assign: notInDemo,
    setDriverStatus: notInDemo,
    reviewDocument: notInDemo,
    recordTopup: notInDemo,
    cancel: notInDemo,
    onAnyJobChange: () => () => {},
  };

  const access: Api['access'] = {
    mine: async () => [],
    catalogue: async () => [],
    roles: async () => [],
    createRole: notInDemo,
    updateRole: notInDemo,
    deleteRole: notInDemo,
    users: async () => [],
    createUser: notInDemo,
    updateCredentials: notInDemo,
    updateProfile: notInDemo,
    setRoles: notInDemo,
    setBlocked: notInDemo,
    deleteUser: notInDemo,
  };

  return {
    client,
    auth,
    profile: profileApi,
    pricing,
    places,
    jobs: jobsApi,
    driver: driverApi,
    dispatch,
    access,
  };
}
