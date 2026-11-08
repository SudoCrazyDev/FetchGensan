/**
 * The whole server surface the apps are allowed to touch, in one place.
 *
 * Note what is missing: there is no `updateJob`, no `setDriverOnline` that
 * writes a column, no wallet write. Those are impossible by design -- RLS
 * grants clients SELECT and almost nothing else, and every state change
 * goes through a security-definer RPC. If you find yourself wanting to add
 * a raw `.update()` here, that is the signal to add an RPC instead.
 */

import type { JobStatus, JobType, LatLng } from '@fetch/core';
import { toPoint } from '@fetch/core';

import { ApiError, type FetchClient } from './client';
import type {
  AdminCustomerRow,
  AdminJobRow,
  AdminLandmarkRow,
  DailyStatsRow,
  CredentialsPatch,
  DirectoryUser,
  DispatchBoardRow,
  Driver,
  DriverDocument,
  DriverPosition,
  DriverRosterRow,
  DriverStatus,
  ErrandItem,
  ErrandReceipt,
  FareConfigRow,
  FareUpdateInput,
  FareQuoteRow,
  Job,
  JobEvent,
  JobOffer,
  LandmarkResult,
  NewUserInput,
  PaymentMethod,
  Permission,
  PermissionKey,
  Profile,
  PublicDriverInfo,
  RoleSummary,
  SavedPlace,
  SignInResult,
  WalletTransaction,
} from './types';

/** Statuses that mean "this job is on someone's screen right now". */
export const LIVE_STATUSES: JobStatus[] = [
  'searching',
  'assigned',
  'arriving',
  'arrived_pickup',
  'shopping',
  'awaiting_approval',
  'in_progress',
];

/**
 * Returns a brand-new realtime channel, discarding any existing one with the
 * same name.
 *
 * supabase-js caches channels by name: `client.channel(name)` hands back the
 * EXISTING channel if one is registered, and calling `.on()` on a channel
 * that has already subscribed throws
 *
 *   cannot add `postgres_changes` callbacks ... after `subscribe()`
 *
 * which is exactly what happens when a React effect re-runs before its
 * cleanup has torn the old channel down -- a dev double-mount, or simply
 * `userId` transitioning from null to a real id on sign-in. Removing first
 * makes every subscribe idempotent.
 */
function freshChannel(client: FetchClient, name: string) {
  for (const existing of client.getChannels()) {
    if (existing.topic === name || existing.topic === `realtime:${name}`) {
      void client.removeChannel(existing);
    }
  }
  return client.channel(name);
}

async function currentUserId(client: FetchClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error('Not signed in');
  return userId;
}

function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw result.error;
  if (result.data === null) {
    throw new Error('No data returned');
  }
  return result.data;
}

export interface CreateJobInput {
  jobType: JobType;
  pickup: LatLng;
  dropoff: LatLng;
  pickupLabel?: string;
  pickupLandmark?: string;
  dropoffLabel?: string;
  dropoffLandmark?: string;
  notes?: string;
  recipientName?: string;
  recipientPhone?: string;
  /** From the routing provider. The server clamps this; see sanitize_distance(). */
  distanceMeters?: number;
  durationSeconds?: number;
  items?: { name: string; quantity: number; unit: string; notes: string }[];
  itemsBudgetCentavos?: number;
  paymentMethod?: PaymentMethod;
  scheduledFor?: Date | null;
}

interface SessionPayload extends SignInResult {
  session: { access_token: string; refresh_token: string };
}

export function createApi(client: FetchClient) {
  /**
   * Calls one of our edge functions and turns its `{ error, code }` body
   * into an ApiError, so screens can show the server's own sentence (and
   * `retryAfter` on a 429) instead of "Edge Function returned a non-2xx".
   */
  async function callFunction<T>(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await client.functions.invoke(path, {
      method,
      ...(body ? { body } : {}),
    });
    if (!error) return data as T;

    const response = (error as { context?: unknown }).context;
    if (response instanceof Response) {
      let payload: { error?: string; code?: string; retry_after?: number } | null = null;
      try {
        payload = await response.json();
      } catch {
        // not JSON -- fall through to the raw error
      }
      if (payload?.error) {
        throw new ApiError(payload.error, payload.code ?? '', response.status, payload.retry_after);
      }
    }
    throw error;
  }

  /** Installs a session the auth function issued; supabase-js refreshes it from here. */
  async function adoptSession(payload: SessionPayload): Promise<SignInResult> {
    const { error } = await client.auth.setSession({
      access_token: payload.session.access_token,
      refresh_token: payload.session.refresh_token,
    });
    if (error) throw error;
    return { user: payload.user, permissions: payload.permissions };
  }

  // ------------------------------------------------------------- auth

  const auth = {
    /**
     * Mobile number (any common shape) or email, plus password. Goes through
     * the `auth` edge function rather than straight to Supabase Auth, because
     * that is where the per-account lockout and the deactivated-account
     * check live. Throws ApiError with code `invalid_credentials`,
     * `rate_limited` (see retryAfter) or `account_disabled`.
     */
    async signInWithPassword(identifier: string, password: string): Promise<SignInResult> {
      const payload = await callFunction<SessionPayload>('auth/login', 'POST', {
        identifier,
        password,
      });
      return adoptSession(payload);
    },

    /**
     * Texts (phone) or emails a 6-digit code. Answers the same whether or
     * not the account exists.
     */
    async requestPasswordReset(identifier: string): Promise<{ channel: 'sms' | 'email' }> {
      return callFunction('auth/password/forgot', 'POST', { identifier });
    },

    /** Checks the code, sets the new password, signs out every other device, and signs in here. */
    async resetPassword(identifier: string, code: string, password: string): Promise<SignInResult> {
      const payload = await callFunction<SessionPayload>('auth/password/reset', 'POST', {
        identifier,
        code,
        password,
      });
      return adoptSession(payload);
    },

    async signOut(): Promise<void> {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },

    async getSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },

    onAuthStateChange(cb: (userId: string | null) => void) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        cb(session?.user.id ?? null);
      });
      return () => data.subscription.unsubscribe();
    },
  };

  // ------------------------------------------------------------- profile

  const profile = {
    async me(): Promise<Profile | null> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) return null;

      const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data as Profile | null;
    },

    async update(patch: { full_name?: string; avatar_path?: string | null }): Promise<Profile> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error('Not signed in');

      return unwrap(
        await client.from('profiles').update(patch).eq('id', userId).select('*').single(),
      ) as Profile;
    },
  };

  // ------------------------------------------------------------- files

  const files = {
    /**
     * Uploads a local file (a camera or gallery URI) to a storage bucket.
     *
     * Reads the file as an ArrayBuffer, not a Blob. On React Native,
     * storage-js uploads a fetched Blob as a zero-byte object -- the upload
     * "succeeds" and dispatch is left reviewing an empty licence photo. The
     * ArrayBuffer route is the one Supabase's own Expo guide uses, and it
     * works unchanged on web.
     */
    async uploadFromUri(
      bucket: 'driver-docs' | 'receipts' | 'avatars',
      path: string,
      uri: string,
      contentType = 'image/jpeg',
    ): Promise<string> {
      const body = await fetch(uri).then((r) => r.arrayBuffer());
      if (body.byteLength === 0) throw new Error('That photo came through empty. Try again.');

      const { error } = await client.storage
        .from(bucket)
        .upload(path, body, { contentType, upsert: true });
      if (error) throw error;
      return path;
    },

    /** A short-lived link to a private file. Storage policies decide who may. */
    async signedUrl(bucket: 'driver-docs' | 'receipts', path: string, seconds = 600) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, seconds);
      if (error) throw error;
      return data.signedUrl;
    },
  };

  // ------------------------------------------------------------- pricing

  const pricing = {
    async configs(): Promise<FareConfigRow[]> {
      const { data, error } = await client.from('fare_config').select('*').eq('is_active', true);
      if (error) throw error;
      return (data ?? []) as FareConfigRow[];
    },

    /**
     * The authoritative quote. The booking screen shows a local estimate
     * from packages/core while the pin moves, then calls this once before
     * showing a confirm button, so the number the customer taps on is the
     * number the server will charge.
     */
    async quote(
      jobType: JobType,
      distanceMeters: number,
      durationSeconds = 0,
    ): Promise<FareQuoteRow> {
      const { data, error } = await client.rpc('quote_fare', {
        p_job_type: jobType,
        p_distance_m: Math.round(distanceMeters),
        p_duration_s: Math.round(durationSeconds),
      });
      if (error) throw error;
      const rows = data as FareQuoteRow[];
      const row = rows[0];
      if (!row) throw new Error('No fare configured for that service');
      return row;
    },
  };

  // ------------------------------------------------------------- places

  const places = {
    async searchLandmarks(query: string, near?: LatLng, limit = 12): Promise<LandmarkResult[]> {
      const { data, error } = await client.rpc('search_landmarks', {
        p_query: query,
        p_near_lng: near?.longitude ?? null,
        p_near_lat: near?.latitude ?? null,
        p_limit: limit,
      });
      if (error) throw error;
      return (data ?? []) as LandmarkResult[];
    },

    async bumpLandmark(id: string): Promise<void> {
      await client.rpc('bump_landmark', { p_id: id });
    },

    async saved(): Promise<SavedPlace[]> {
      const { data, error } = await client
        .from('saved_places')
        .select('*')
        .order('use_count', { ascending: false });
      if (error) throw error;
      return (data ?? []) as SavedPlace[];
    },

    async save(input: {
      label: string;
      landmarkNote: string;
      addressLine?: string;
      location: LatLng;
    }): Promise<SavedPlace> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error('Not signed in');

      const [lng, lat] = toPoint(input.location);
      return unwrap(
        await client
          .from('saved_places')
          .insert({
            profile_id: userId,
            label: input.label,
            landmark_note: input.landmarkNote,
            address_line: input.addressLine ?? '',
            location: `SRID=4326;POINT(${lng} ${lat})`,
          })
          .select('*')
          .single(),
      ) as SavedPlace;
    },

    async remove(id: string): Promise<void> {
      const { error } = await client.from('saved_places').delete().eq('id', id);
      if (error) throw error;
    },
  };

  // ------------------------------------------------------------- jobs (customer)

  const jobs = {
    async create(input: CreateJobInput): Promise<Job> {
      const [pickupLng, pickupLat] = toPoint(input.pickup);
      const [dropoffLng, dropoffLat] = toPoint(input.dropoff);

      const { data, error } = await client.rpc('create_job', {
        p_job_type: input.jobType,
        p_pickup_lng: pickupLng,
        p_pickup_lat: pickupLat,
        p_dropoff_lng: dropoffLng,
        p_dropoff_lat: dropoffLat,
        p_pickup_label: input.pickupLabel ?? '',
        p_pickup_landmark: input.pickupLandmark ?? '',
        p_dropoff_label: input.dropoffLabel ?? '',
        p_dropoff_landmark: input.dropoffLandmark ?? '',
        p_notes: input.notes ?? '',
        p_recipient_name: input.recipientName ?? '',
        p_recipient_phone: input.recipientPhone ?? '',
        p_reported_distance_m: input.distanceMeters ?? null,
        p_reported_duration_s: input.durationSeconds ?? null,
        p_items: input.items ?? [],
        p_items_budget_centavos: input.itemsBudgetCentavos ?? 0,
        p_payment_method: input.paymentMethod ?? 'cash',
        p_scheduled_for: input.scheduledFor?.toISOString() ?? null,
      });
      if (error) throw error;
      return data as Job;
    },

    async byId(id: string): Promise<Job | null> {
      const { data, error } = await client.from('jobs').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data as Job | null;
    },

    /** The customer's one in-flight booking, if they have one. */
    async active(): Promise<Job | null> {
      const { data, error } = await client
        .from('jobs')
        .select('*')
        .in('status', LIVE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Job | null;
    },

    async history(limit = 30, before?: string): Promise<Job[]> {
      let query = client
        .from('jobs')
        .select('*')
        .in('status', ['completed', 'cancelled', 'expired'])
        .order('created_at', { ascending: false })
        .limit(limit);

      if (before) query = query.lt('created_at', before);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Job[];
    },

    async items(jobId: string): Promise<ErrandItem[]> {
      const { data, error } = await client
        .from('errand_items')
        .select('*')
        .eq('job_id', jobId)
        .order('position');
      if (error) throw error;
      return (data ?? []) as ErrandItem[];
    },

    async assignedDriver(driverId: string): Promise<PublicDriverInfo | null> {
      const { data, error } = await client
        .from('public_driver_info')
        .select('*')
        .eq('id', driverId)
        .maybeSingle();
      if (error) throw error;
      return data as PublicDriverInfo | null;
    },

    /** Live driver position for the tracking map. */
    async driverPosition(jobId: string): Promise<DriverPosition | null> {
      const { data, error } = await client.rpc('job_driver_position', { p_job_id: jobId });
      if (error) throw error;
      const rows = (data ?? []) as DriverPosition[];
      return rows[0] ?? null;
    },

    async approveErrandTotal(jobId: string): Promise<Job> {
      const { data, error } = await client.rpc('approve_errand_total', { p_job_id: jobId });
      if (error) throw error;
      return data as Job;
    },

    /** Sends the receipt back to the driver: "not that brand", "too much". */
    async rejectErrandTotal(jobId: string, reason = ''): Promise<Job> {
      const { data, error } = await client.rpc('reject_errand_total', {
        p_job_id: jobId,
        p_reason: reason,
      });
      if (error) throw error;
      return data as Job;
    },

    async receipts(jobId: string): Promise<ErrandReceipt[]> {
      const { data, error } = await client
        .from('errand_receipts')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ErrandReceipt[];
    },

    /** The rating the caller already left on this job, if any. */
    async myRating(jobId: string): Promise<{ stars: number; comment: string } | null> {
      const userId = await currentUserId(client);
      const { data, error } = await client
        .from('ratings')
        .select('stars, comment')
        .eq('job_id', jobId)
        .eq('rater_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data as { stars: number; comment: string } | null;
    },

    async cancel(jobId: string, reason = ''): Promise<Job> {
      const { data, error } = await client.rpc('cancel_job', {
        p_job_id: jobId,
        p_reason: reason,
      });
      if (error) throw error;
      return data as Job;
    },

    async rate(jobId: string, stars: number, comment = ''): Promise<void> {
      const { error } = await client.rpc('rate_job', {
        p_job_id: jobId,
        p_stars: stars,
        p_comment: comment,
      });
      if (error) throw error;
    },

    async events(jobId: string): Promise<JobEvent[]> {
      const { data, error } = await client
        .from('job_events')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as JobEvent[];
    },

    /**
     * Realtime subscription to one job. RLS applies to realtime too, so
     * this only ever delivers rows the caller could have selected.
     */
    onJobChange(jobId: string, cb: (job: Job) => void, tag = 'detail') {
      // `tag` keeps two screens watching the same job from evicting each
      // other's channel: freshChannel() removes any channel with the same
      // name, so the driver's home and job screens must not share one.
      const channel = freshChannel(client, `job:${jobId}:${tag}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` },
          (payload) => cb(payload.new as Job),
        )
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },

    /** Fires when any of this customer's jobs change, e.g. a driver accepts. */
    onMyJobsChange(customerId: string, cb: (job: Job) => void) {
      const channel = freshChannel(client, `jobs:customer:${customerId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'jobs',
            filter: `customer_id=eq.${customerId}`,
          },
          (payload) => {
            if (payload.new && Object.keys(payload.new).length > 0) cb(payload.new as Job);
          },
        )
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };

  // ------------------------------------------------------------- driver

  const driver = {
    async me(): Promise<Driver | null> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) return null;

      const { data, error } = await client
        .from('drivers')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data as Driver | null;
    },

    /**
     * Creates the driver row on first launch, or edits the vehicle details
     * later. Also sets the rider's name, which is what a customer sees.
     */
    async register(input: {
      full_name: string;
      vehicle_make: string;
      vehicle_model: string;
      vehicle_color: string;
      plate_number: string;
      license_number: string;
    }): Promise<Driver> {
      const { data, error } = await client.rpc('register_driver', {
        p_full_name: input.full_name,
        p_vehicle_make: input.vehicle_make,
        p_vehicle_model: input.vehicle_model,
        p_vehicle_color: input.vehicle_color,
        p_plate_number: input.plate_number,
        p_license_number: input.license_number,
      });
      if (error) throw error;
      return data as Driver;
    },

    async setOnline(online: boolean): Promise<Driver> {
      const { data, error } = await client.rpc('set_online', { p_online: online });
      if (error) throw error;
      return data as Driver;
    },

    /**
     * Location ping. Called on a timer while online -- roughly every 8-10
     * seconds when on a job, every 25-30 when idle. Anything faster burns
     * a prepaid data plan for no dispatch benefit.
     */
    async ping(position: LatLng, heading?: number, speedKph?: number): Promise<void> {
      const [lng, lat] = toPoint(position);
      const { error } = await client.rpc('ping_location', {
        p_lng: lng,
        p_lat: lat,
        p_heading: heading ?? null,
        p_speed_kph: speedKph ?? null,
      });
      if (error) throw error;
    },

    /** Live offers waiting for this driver's answer. */
    async pendingOffers(): Promise<(JobOffer & { job: Job })[]> {
      const { data, error } = await client
        .from('job_offers')
        .select('*, job:jobs(*)')
        .eq('response', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('offered_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as (JobOffer & { job: Job })[];
    },

    /** First accept wins. Throws 'job already taken' when it does not. */
    async claim(jobId: string): Promise<Job> {
      const { data, error } = await client.rpc('claim_job', { p_job_id: jobId });
      if (error) throw error;
      return data as Job;
    },

    async decline(jobId: string): Promise<void> {
      const { error } = await client.rpc('decline_job', { p_job_id: jobId });
      if (error) throw error;
    },

    async activeJob(): Promise<Job | null> {
      // Filter on driver_id explicitly. RLS also lets a driver read any
      // `searching` job they hold an offer on, so a status filter alone
      // returned someone else's unclaimed booking as "your current job".
      const userId = await currentUserId(client);
      const { data, error } = await client
        .from('jobs')
        .select('*')
        .eq('driver_id', userId)
        .in('status', LIVE_STATUSES)
        .order('assigned_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Job | null;
    },

    async advance(jobId: string, to: JobStatus): Promise<Job> {
      const { data, error } = await client.rpc('advance_job', {
        p_job_id: jobId,
        p_to: to,
      });
      if (error) throw error;
      return data as Job;
    },

    async submitReceipt(
      jobId: string,
      items: {
        id: string;
        actual_price_centavos: number;
        is_available: boolean;
        substitute_note: string;
      }[],
      receiptPath: string | null = null,
    ): Promise<Job> {
      const { data, error } = await client.rpc('submit_errand_receipt', {
        p_job_id: jobId,
        p_items: items,
        p_receipt_path: receiptPath,
      });
      if (error) throw error;
      return data as Job;
    },

    async complete(jobId: string): Promise<Job> {
      const { data, error } = await client.rpc('complete_job', { p_job_id: jobId });
      if (error) throw error;
      return data as Job;
    },

    async wallet(limit = 50): Promise<WalletTransaction[]> {
      const { data, error } = await client
        .from('wallet_transactions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as WalletTransaction[];
    },

    async earnings(since: Date): Promise<{ jobs: number; grossCentavos: number; commissionCentavos: number }> {
      const userId = await currentUserId(client);
      const { data, error } = await client
        .from('jobs')
        .select('final_total_centavos, commission_centavos, items_cost_centavos')
        .eq('driver_id', userId)
        .eq('status', 'completed')
        .gte('completed_at', since.toISOString());
      if (error) throw error;

      const rows = (data ?? []) as {
        final_total_centavos: number;
        commission_centavos: number;
        items_cost_centavos: number;
      }[];

      return rows.reduce(
        (acc, r) => ({
          jobs: acc.jobs + 1,
          // Item cost is money the driver fronted and got back, not income.
          grossCentavos: acc.grossCentavos + r.final_total_centavos - r.items_cost_centavos,
          commissionCentavos: acc.commissionCentavos + r.commission_centavos,
        }),
        { jobs: 0, grossCentavos: 0, commissionCentavos: 0 },
      );
    },

    /** Name and number of the customer on the driver's live job. */
    async customerContact(jobId: string): Promise<{ full_name: string; phone: string } | null> {
      const { data, error } = await client.rpc('job_customer_contact', { p_job_id: jobId });
      if (error) throw error;
      const rows = (data ?? []) as { full_name: string; phone: string }[];
      return rows[0] ?? null;
    },

    /**
     * Any change to a job assigned to this driver -- including one a
     * dispatcher assigned by hand, which never passes through an offer.
     */
    onAssignedJobChange(driverId: string, cb: (job: Job) => void, tag = 'main') {
      const channel = freshChannel(client, `jobs:driver:${driverId}:${tag}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'jobs', filter: `driver_id=eq.${driverId}` },
          (payload) => {
            if (payload.new && Object.keys(payload.new).length > 0) cb(payload.new as Job);
          },
        )
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },

    async documents(): Promise<DriverDocument[]> {
      const { data, error } = await client.from('driver_documents').select('*');
      if (error) throw error;
      return (data ?? []) as DriverDocument[];
    },

    async recordDocument(docType: string, storagePath: string): Promise<void> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error('Not signed in');

      const { error } = await client.from('driver_documents').upsert(
        {
          driver_id: userId,
          doc_type: docType,
          storage_path: storagePath,
          status: 'pending',
        },
        { onConflict: 'driver_id,doc_type' },
      );
      if (error) throw error;
    },

    /**
     * New offers arriving. This is the channel the ride-offer screen lives
     * on -- and the reason the driver app also needs a push notification
     * path, because a websocket does not survive the phone sleeping.
     */
    onOffer(driverId: string, cb: (offer: JobOffer) => void) {
      const channel = freshChannel(client, `offers:${driverId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'job_offers',
            filter: `driver_id=eq.${driverId}`,
          },
          (payload) => cb(payload.new as JobOffer),
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'job_offers',
            filter: `driver_id=eq.${driverId}`,
          },
          (payload) => cb(payload.new as JobOffer),
        )
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };

  // ------------------------------------------------------------- dispatch console

  const dispatch = {
    async board(): Promise<DispatchBoardRow[]> {
      const { data, error } = await client
        .from('dispatch_board')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DispatchBoardRow[];
    },

    async roster(): Promise<DriverRosterRow[]> {
      const { data, error } = await client
        .from('driver_roster')
        .select('*')
        .order('is_online', { ascending: false })
        .order('full_name');
      if (error) throw error;
      return (data ?? []) as DriverRosterRow[];
    },

    /** Force a re-broadcast, optionally with a wider radius. */
    async redispatch(jobId: string, radiusM?: number): Promise<number> {
      const { data, error } = await client.rpc('dispatch_job', {
        p_job_id: jobId,
        p_radius_m: radiusM ?? null,
        p_limit: 8,
      });
      if (error) throw error;
      return data as number;
    },

    async nearbyDrivers(jobId: string, radiusM = 5000): Promise<NearbyDriverRow[]> {
      const { data, error } = await client.rpc('nearby_drivers', {
        p_job_id: jobId,
        p_radius_m: radiusM,
        p_limit: 15,
      });
      if (error) throw error;
      return (data ?? []) as NearbyDriverRow[];
    },

    /** Manual assignment. The dispatcher's escape hatch when auto-dispatch
     * has failed and they are on the phone to a driver they trust. */
    async assign(jobId: string, driverId: string): Promise<Job> {
      const { data, error } = await client.rpc('assign_job', {
        p_job_id: jobId,
        p_driver_id: driverId,
      });
      if (error) throw error;
      return data as Job;
    },

    /**
     * Approve, reject or suspend a rider. Needs drivers.manage. The reason
     * goes on their record, and is what they are told when it is not good news.
     */
    async setDriverStatus(driverId: string, status: DriverStatus, reason = ''): Promise<void> {
      const { error } = await client.rpc('set_driver_status', {
        p_driver_id: driverId,
        p_status: status,
        p_reason: reason,
      });
      if (error) throw error;
    },

    async driverDetail(driverId: string): Promise<Driver | null> {
      const { data, error } = await client
        .from('drivers')
        .select('*')
        .eq('id', driverId)
        .maybeSingle();
      if (error) throw error;
      return data as Driver | null;
    },

    async driverDocuments(driverId: string): Promise<DriverDocument[]> {
      const { data, error } = await client
        .from('driver_documents')
        .select('*')
        .eq('driver_id', driverId)
        .order('doc_type');
      if (error) throw error;
      return (data ?? []) as DriverDocument[];
    },

    /** A short-lived link to a private file, for staff review. */
    signedUrl(bucket: 'driver-docs' | 'receipts', path: string): Promise<string> {
      return files.signedUrl(bucket, path);
    },

    async driverWallet(driverId: string, limit = 100): Promise<WalletTransaction[]> {
      const { data, error } = await client
        .from('wallet_transactions')
        .select('*')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as WalletTransaction[];
    },

    async reviewDocument(
      docId: string,
      status: 'approved' | 'rejected',
      rejectReason = '',
    ): Promise<void> {
      const { error } = await client.rpc('admin_review_document', {
        p_doc_id: docId,
        p_status: status,
        p_reason: rejectReason,
      });
      if (error) throw error;
    },

    async setCreditFloor(driverId: string, floorCentavos: number): Promise<void> {
      const { error } = await client.rpc('admin_set_credit_floor', {
        p_driver_id: driverId,
        p_floor_centavos: floorCentavos,
      });
      if (error) throw error;
    },

    async walletAdjustment(driverId: string, amountCentavos: number, note: string): Promise<void> {
      const { error } = await client.rpc('admin_wallet_adjustment', {
        p_driver_id: driverId,
        p_amount: amountCentavos,
        p_note: note,
      });
      if (error) throw error;
    },

    async recordTopup(driverId: string, amountCentavos: number, note = ''): Promise<void> {
      const { error } = await client.rpc('record_topup', {
        p_driver_id: driverId,
        p_amount: amountCentavos,
        p_note: note,
      });
      if (error) throw error;
    },

    async cancel(jobId: string, reason: string): Promise<void> {
      const { error } = await client.rpc('cancel_job', { p_job_id: jobId, p_reason: reason });
      if (error) throw error;
    },

    /** Every job, any status. `search` matches reference, names, phones and plate. */
    async jobs(
      opts: {
        search?: string;
        status?: JobStatus | 'all';
        jobType?: JobType | 'all';
        limit?: number;
        before?: string;
        driverId?: string;
        customerId?: string;
      } = {},
    ): Promise<AdminJobRow[]> {
      let query = client
        .from('admin_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(opts.limit ?? 50);

      if (opts.status && opts.status !== 'all') query = query.eq('status', opts.status);
      if (opts.jobType && opts.jobType !== 'all') query = query.eq('job_type', opts.jobType);
      if (opts.before) query = query.lt('created_at', opts.before);
      if (opts.driverId) query = query.eq('driver_id', opts.driverId);
      if (opts.customerId) query = query.eq('customer_id', opts.customerId);

      // PostgREST's `or` syntax treats commas and parentheses as structure,
      // so strip them from free text rather than let a search break the query.
      const term = opts.search?.replace(/[,()*%]/g, ' ').trim();
      if (term) {
        const like = `%${term}%`;
        query = query.or(
          [
            `reference.ilike.${like}`,
            `customer_name.ilike.${like}`,
            `customer_phone.ilike.${like}`,
            `driver_name.ilike.${like}`,
            `plate_number.ilike.${like}`,
          ].join(','),
        );
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as AdminJobRow[];
    },

    async jobEvents(jobId: string): Promise<JobEvent[]> {
      const { data, error } = await client
        .from('job_events')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as JobEvent[];
    },

    async jobItems(jobId: string): Promise<ErrandItem[]> {
      const { data, error } = await client
        .from('errand_items')
        .select('*')
        .eq('job_id', jobId)
        .order('position');
      if (error) throw error;
      return (data ?? []) as ErrandItem[];
    },

    async jobReceipts(jobId: string): Promise<ErrandReceipt[]> {
      const { data, error } = await client
        .from('errand_receipts')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as ErrandReceipt[];
    },

    async customers(search = '', limit = 100): Promise<AdminCustomerRow[]> {
      let query = client
        .from('admin_customers')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      const term = search.replace(/[,()*%]/g, ' ').trim();
      if (term) {
        const like = `%${term}%`;
        query = query.or(`full_name.ilike.${like},phone.ilike.${like}`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as AdminCustomerRow[];
    },

    /** Every fare row including retired ones, newest first. */
    async fareHistory(): Promise<(FareConfigRow & { effective_from: string })[]> {
      const { data, error } = await client
        .from('fare_config')
        .select('*')
        .order('effective_from', { ascending: false });
      if (error) throw error;
      return (data ?? []) as (FareConfigRow & { effective_from: string })[];
    },

    async updateFare(jobType: JobType, input: FareUpdateInput): Promise<FareConfigRow> {
      const { data, error } = await client.rpc('admin_update_fare', {
        p_job_type: jobType,
        p_base_fare_centavos: input.base_fare_centavos,
        p_included_meters: input.included_meters,
        p_per_km_centavos: input.per_km_centavos,
        p_per_minute_centavos: input.per_minute_centavos,
        p_min_fare_centavos: input.min_fare_centavos,
        p_service_fee_centavos: input.service_fee_centavos,
        p_night_surcharge_centavos: input.night_surcharge_centavos,
        p_night_starts_hour: input.night_starts_hour,
        p_night_ends_hour: input.night_ends_hour,
        p_commission_bps: input.commission_bps,
        p_max_item_float_centavos: input.max_item_float_centavos,
      });
      if (error) throw error;
      return data as FareConfigRow;
    },

    async landmarks(): Promise<AdminLandmarkRow[]> {
      const { data, error } = await client
        .from('admin_landmarks')
        .select('*')
        .order('use_count', { ascending: false })
        .order('name');
      if (error) throw error;
      return (data ?? []) as AdminLandmarkRow[];
    },

    async saveLandmark(input: {
      id?: string | null;
      name: string;
      category: string;
      location: LatLng;
      isActive?: boolean;
    }): Promise<string> {
      const { data, error } = await client.rpc('admin_upsert_landmark', {
        p_id: input.id ?? null,
        p_name: input.name,
        p_category: input.category,
        p_lng: input.location.longitude,
        p_lat: input.location.latitude,
        p_is_active: input.isActive ?? true,
      });
      if (error) throw error;
      return data as string;
    },

    async dailyStats(days = 14): Promise<DailyStatsRow[]> {
      const { data, error } = await client.rpc('admin_daily_stats', { p_days: days });
      if (error) throw error;
      return (data ?? []) as DailyStatsRow[];
    },

    /** Any job change at all -- what keeps the live board live. */
    onAnyJobChange(cb: () => void) {
      const channel = freshChannel(client, 'dispatch:jobs')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => cb())
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };

  // ------------------------------------------------------------- access control

  const access = {
    /** The signed-in user's permissions. Drives what the console shows; the database still decides. */
    async mine(): Promise<PermissionKey[]> {
      const { data, error } = await client.rpc('my_permissions');
      if (error) throw error;
      return (data ?? []) as PermissionKey[];
    },

    async catalogue(): Promise<Permission[]> {
      const { data, error } = await client.from('permissions').select('*').order('sort_order');
      if (error) throw error;
      return (data ?? []) as Permission[];
    },

    async roles(): Promise<RoleSummary[]> {
      const { data, error } = await client.rpc('list_roles');
      if (error) throw error;
      return (data ?? []) as RoleSummary[];
    },

    async createRole(input: {
      key: string;
      name: string;
      description: string;
      permissions: PermissionKey[];
    }): Promise<void> {
      const { error } = await client.rpc('create_role', {
        p_key: input.key,
        p_name: input.name,
        p_description: input.description,
        p_permissions: input.permissions,
      });
      if (error) throw error;
    },

    async updateRole(
      roleId: string,
      input: { name: string; description: string; permissions: PermissionKey[] },
    ): Promise<void> {
      const { error } = await client.rpc('update_role', {
        p_role_id: roleId,
        p_name: input.name,
        p_description: input.description,
        p_permissions: input.permissions,
      });
      if (error) throw error;
    },

    async deleteRole(roleId: string): Promise<void> {
      const { error } = await client.rpc('delete_role', { p_role_id: roleId });
      if (error) throw error;
    },

    async users(search = '', limit = 100, offset = 0): Promise<DirectoryUser[]> {
      const { data, error } = await client.rpc('list_users', {
        p_search: search,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw error;
      return (data ?? []) as DirectoryUser[];
    },

    /** Needs the Admin API, so it goes through the admin-users edge function. */
    async createUser(input: NewUserInput): Promise<{ id: string }> {
      return callFunction('admin-users', 'POST', {
        full_name: input.fullName,
        phone: input.phone,
        email: input.email ?? '',
        password: input.password,
        role_ids: input.roleIds,
      });
    },

    async updateCredentials(userId: string, patch: CredentialsPatch): Promise<void> {
      await callFunction(`admin-users/${userId}`, 'PATCH', { ...patch });
    },

    async updateProfile(userId: string, input: { fullName: string; notes: string }): Promise<void> {
      const { error } = await client.rpc('update_user_profile', {
        p_user_id: userId,
        p_full_name: input.fullName,
        p_notes: input.notes,
      });
      if (error) throw error;
    },

    async setRoles(userId: string, roleIds: string[]): Promise<void> {
      const { error } = await client.rpc('set_user_roles', {
        p_user_id: userId,
        p_role_ids: roleIds,
      });
      if (error) throw error;
    },

    /** Deactivating also bans the login, so their session stops refreshing. */
    async setBlocked(userId: string, blocked: boolean): Promise<void> {
      await callFunction(`admin-users/${userId}/block`, 'POST', { blocked });
    },

    /** Refused for anyone with booking history; deactivate them instead. */
    async deleteUser(userId: string): Promise<void> {
      await callFunction(`admin-users/${userId}`, 'DELETE');
    },
  };

  return { client, auth, profile, files, pricing, places, jobs, driver, dispatch, access };
}

export type Api = ReturnType<typeof createApi>;

export interface NearbyDriverRow {
  driver_id: string;
  distance_m: number;
  full_name: string;
  rating: number | null;
}
