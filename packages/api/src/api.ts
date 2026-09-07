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

import type { FetchClient } from './client';
import type {
  DispatchBoardRow,
  Driver,
  DriverDocument,
  DriverPosition,
  DriverRosterRow,
  ErrandItem,
  FareConfigRow,
  FareQuoteRow,
  Job,
  JobEvent,
  JobOffer,
  LandmarkResult,
  PaymentMethod,
  Profile,
  PublicDriverInfo,
  SavedPlace,
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

export function createApi(client: FetchClient) {
  // ------------------------------------------------------------- auth

  const auth = {
    /** Sends the OTP. `phone` must already be E.164 -- use normalizePhPhone. */
    async requestOtp(phone: string): Promise<void> {
      const { error } = await client.auth.signInWithOtp({ phone });
      if (error) throw error;
    },

    async verifyOtp(phone: string, token: string) {
      const { data, error } = await client.auth.verifyOtp({
        phone,
        token,
        type: 'sms',
      });
      if (error) throw error;
      return data;
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
    onJobChange(jobId: string, cb: (job: Job) => void) {
      const channel = freshChannel(client, `job:${jobId}`)
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

    /** Creates the driver row on first launch of the driver app. */
    async register(input: {
      vehicle_make: string;
      vehicle_model: string;
      vehicle_color: string;
      plate_number: string;
      license_number: string;
    }): Promise<Driver> {
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error('Not signed in');

      return unwrap(
        await client
          .from('drivers')
          .upsert({ id: userId, ...input }, { onConflict: 'id' })
          .select('*')
          .single(),
      ) as Driver;
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
      const { data, error } = await client
        .from('jobs')
        .select('*')
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
      const { data, error } = await client
        .from('jobs')
        .select('final_total_centavos, commission_centavos, items_cost_centavos')
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
    async assign(jobId: string, driverId: string): Promise<void> {
      const { error } = await client
        .from('jobs')
        .update({ driver_id: driverId, status: 'assigned' })
        .eq('id', jobId);
      if (error) throw error;
    },

    async setDriverStatus(driverId: string, status: string): Promise<void> {
      const { error } = await client.from('drivers').update({ status }).eq('id', driverId);
      if (error) throw error;
    },

    async reviewDocument(
      docId: string,
      status: 'approved' | 'rejected',
      rejectReason = '',
    ): Promise<void> {
      const { data: session } = await client.auth.getSession();
      const { error } = await client
        .from('driver_documents')
        .update({
          status,
          reject_reason: rejectReason,
          reviewed_by: session.session?.user.id ?? null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', docId);
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

  return { client, auth, profile, pricing, places, jobs, driver, dispatch };
}

export type Api = ReturnType<typeof createApi>;

export interface NearbyDriverRow {
  driver_id: string;
  distance_m: number;
  full_name: string;
  rating: number | null;
}
