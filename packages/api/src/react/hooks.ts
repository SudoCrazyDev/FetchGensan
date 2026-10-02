/**
 * Query hooks shared by the three apps.
 *
 * Pattern throughout: react-query owns the cache, a realtime subscription
 * invalidates it. Polling intervals exist as a safety net for when the
 * websocket has quietly died -- which on a budget Android phone with a
 * flaky connection is often, and is exactly the moment a customer is
 * staring at the screen wondering where their ride is.
 */

import { useEffect, useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { JobStatus, JobType } from '@fetch/core';

import { LIVE_STATUSES, type CreateJobInput } from '../api';
import { useApi, useSessionUser } from './provider';

export const qk = {
  profile: ['profile'] as const,
  fareConfigs: ['fare-configs'] as const,
  savedPlaces: ['saved-places'] as const,
  landmarks: (q: string) => ['landmarks', q] as const,
  activeJob: ['active-job'] as const,
  job: (id: string) => ['job', id] as const,
  jobItems: (id: string) => ['job-items', id] as const,
  jobEvents: (id: string) => ['job-events', id] as const,
  driverInfo: (id: string) => ['driver-info', id] as const,
  driverPosition: (id: string) => ['driver-position', id] as const,
  jobHistory: ['job-history'] as const,
  me: ['driver-me'] as const,
  offers: ['driver-offers'] as const,
  driverActiveJob: ['driver-active-job'] as const,
  wallet: ['driver-wallet'] as const,
  earnings: (key: string) => ['driver-earnings', key] as const,
  documents: ['driver-documents'] as const,
  board: ['dispatch-board'] as const,
  roster: ['dispatch-roster'] as const,
  receipts: (id: string) => ['job-receipts', id] as const,
  myRating: (id: string) => ['my-rating', id] as const,
  customerContact: (id: string) => ['customer-contact', id] as const,
  adminJobs: (key: string) => ['admin-jobs', key] as const,
  adminJob: (id: string) => ['admin-job', id] as const,
  adminDriver: (id: string) => ['admin-driver', id] as const,
  customers: (q: string) => ['admin-customers', q] as const,
  fareHistory: ['admin-fare-history'] as const,
  adminLandmarks: ['admin-landmarks'] as const,
  dailyStats: (days: number) => ['admin-daily-stats', days] as const,
};

// ---------------------------------------------------------------- shared

export function useProfile() {
  const api = useApi();
  const { userId } = useSessionUser();

  return useQuery({
    queryKey: qk.profile,
    queryFn: () => api.profile.me(),
    enabled: !!userId,
  });
}

export function useFareConfigs() {
  const api = useApi();
  return useQuery({
    queryKey: qk.fareConfigs,
    queryFn: () => api.pricing.configs(),
    // Pricing changes when a dispatcher edits it, which is rare.
    staleTime: 10 * 60_000,
  });
}

// ---------------------------------------------------------------- customer

export function useSavedPlaces() {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.savedPlaces,
    queryFn: () => api.places.saved(),
    enabled: !!userId,
  });
}

export function useLandmarkSearch(query: string, near?: { latitude: number; longitude: number }) {
  const api = useApi();
  return useQuery({
    queryKey: qk.landmarks(query),
    queryFn: () => api.places.searchLandmarks(query, near),
    // An empty query returns the popular list, which is worth showing.
    staleTime: 60_000,
  });
}

/**
 * The customer's in-flight booking, kept fresh by realtime with a slow
 * poll behind it. This is the single most important query in the rider app:
 * it decides whether the home screen shows a booking form or a tracking
 * card.
 */
export function useActiveJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { userId } = useSessionUser();

  const query = useQuery({
    queryKey: qk.activeJob,
    queryFn: () => api.jobs.active(),
    enabled: !!userId,
    refetchInterval: (q) => (q.state.data ? 15_000 : false),
  });

  useEffect(() => {
    if (!userId) return;
    return api.jobs.onMyJobsChange(userId, (job) => {
      const previous = queryClient.getQueryData<{ status?: string }>(qk.job(job.id));
      queryClient.setQueryData(qk.job(job.id), job);
      // Same reason as useJob(): whichever channel sees the status change
      // first must refresh the priced shopping list and receipt photo.
      if (previous?.status !== job.status) {
        void queryClient.invalidateQueries({ queryKey: qk.jobItems(job.id) });
        void queryClient.invalidateQueries({ queryKey: qk.receipts(job.id) });
      }
      void queryClient.invalidateQueries({ queryKey: qk.activeJob });
      void queryClient.invalidateQueries({ queryKey: qk.jobHistory });
    });
  }, [api, queryClient, userId]);

  return query;
}

export function useJob(jobId: string | null | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.job(jobId ?? 'none'),
    queryFn: () => api.jobs.byId(jobId!),
    enabled: !!jobId,
  });

  useEffect(() => {
    if (!jobId) return;
    return api.jobs.onJobChange(
      jobId,
      (job) => {
        const previous = queryClient.getQueryData<{ status?: string }>(qk.job(jobId));
        queryClient.setQueryData(qk.job(jobId), job);
        // A status change is when the shopping list gets its real prices
        // (receipt submitted) and when a receipt photo appears. Without
        // this the approval screen showed every item at PHP 0 beside a
        // correct total.
        if (previous?.status !== job.status) {
          void queryClient.invalidateQueries({ queryKey: qk.jobItems(jobId) });
          void queryClient.invalidateQueries({ queryKey: qk.receipts(jobId) });
        }
      },
      'detail',
    );
  }, [api, jobId, queryClient]);

  return query;
}

export function useErrandItems(jobId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.jobItems(jobId ?? 'none'),
    queryFn: () => api.jobs.items(jobId!),
    enabled: !!jobId,
  });
}

export function useAssignedDriver(driverId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.driverInfo(driverId ?? 'none'),
    queryFn: () => api.jobs.assignedDriver(driverId!),
    enabled: !!driverId,
    staleTime: 5 * 60_000,
  });
}

/**
 * Driver position for the tracking map.
 *
 * Polled rather than subscribed on purpose. The driver row updates every
 * few seconds while on a job; a realtime subscription to `drivers` would
 * either need a policy exposing driver rows to customers, or would deliver
 * nothing. A 6-second poll of a narrow RPC is simpler and leaks less.
 */
export function useDriverPosition(jobId: string | null | undefined, active: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: qk.driverPosition(jobId ?? 'none'),
    queryFn: () => api.jobs.driverPosition(jobId!),
    enabled: !!jobId && active,
    refetchInterval: active ? 6_000 : false,
    staleTime: 0,
  });
}

export function useJobHistory() {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.jobHistory,
    queryFn: () => api.jobs.history(),
    enabled: !!userId,
  });
}

export function useCreateJob() {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateJobInput) => api.jobs.create(input),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.job(job.id), job);
      queryClient.setQueryData(qk.activeJob, job);
      void queryClient.invalidateQueries({ queryKey: qk.savedPlaces });
    },
  });
}

export function useRejectErrandTotal() {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, reason }: { jobId: string; reason?: string }) =>
      api.jobs.rejectErrandTotal(jobId, reason ?? ''),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: qk.activeJob });
    },
  });
}

/** Receipt photos for an errand, with signed links ready to show. */
export function useJobReceipts(jobId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.receipts(jobId ?? 'none'),
    queryFn: async () => {
      const rows = await api.jobs.receipts(jobId!);
      return Promise.all(
        rows.map(async (row) => ({
          ...row,
          url: await api.files.signedUrl('receipts', row.storage_path).catch(() => null),
        })),
      );
    },
    enabled: !!jobId,
    // Signed links last ten minutes; refresh well inside that.
    staleTime: 5 * 60_000,
  });
}

export function useMyRating(jobId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.myRating(jobId ?? 'none'),
    queryFn: () => api.jobs.myRating(jobId!),
    enabled: !!jobId,
  });
}

export function useSavePlace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.places.save>[0]) => api.places.save(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.savedPlaces }),
  });
}

export function useRemovePlace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.places.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.savedPlaces }),
  });
}

export function useCancelJob() {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, reason }: { jobId: string; reason?: string }) =>
      api.jobs.cancel(jobId, reason ?? ''),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: qk.activeJob });
      void queryClient.invalidateQueries({ queryKey: qk.jobHistory });
      void queryClient.invalidateQueries({ queryKey: qk.driverActiveJob });
      void queryClient.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useApproveErrandTotal() {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => api.jobs.approveErrandTotal(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: qk.activeJob });
    },
  });
}

export function useRateJob() {
  const api = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, stars, comment }: { jobId: string; stars: number; comment?: string }) =>
      api.jobs.rate(jobId, stars, comment ?? ''),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: qk.jobHistory });
      void queryClient.invalidateQueries({ queryKey: qk.myRating(vars.jobId) });
    },
  });
}

export function useFareQuote(
  jobType: JobType,
  distanceMeters: number | null,
  durationSeconds = 0,
) {
  const api = useApi();
  return useQuery({
    queryKey: ['fare-quote', jobType, distanceMeters, durationSeconds],
    queryFn: () => api.pricing.quote(jobType, distanceMeters!, durationSeconds),
    enabled: distanceMeters !== null && distanceMeters > 0,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- driver

export function useDriverMe() {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.me,
    queryFn: () => api.driver.me(),
    enabled: !!userId,
    refetchInterval: 60_000,
  });
}

export function useRegisterDriver() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.driver.register>[0]) => api.driver.register(input),
    onSuccess: (driver) => {
      queryClient.setQueryData(qk.me, driver);
      void queryClient.invalidateQueries({ queryKey: qk.profile });
    },
  });
}

export function useSetOnline() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (online: boolean) => api.driver.setOnline(online),
    onSuccess: (driver) => queryClient.setQueryData(qk.me, driver),
  });
}

/**
 * Pending ride offers.
 *
 * Polls every 5 seconds *in addition* to the realtime subscription. That
 * redundancy is deliberate and it is the single most important reliability
 * decision in the driver app: on Xiaomi, Oppo, Realme and Vivo ROMs the
 * system aggressively suspends background sockets, so the subscription
 * silently stops delivering while the app still looks connected. A driver
 * who misses offers stops trusting the app within a day.
 */
export function useOffers() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { userId } = useSessionUser();

  const query = useQuery({
    queryKey: qk.offers,
    queryFn: () => api.driver.pendingOffers(),
    enabled: !!userId,
    refetchInterval: 5_000,
    staleTime: 0,
  });

  useEffect(() => {
    if (!userId) return;
    return api.driver.onOffer(userId, () => {
      void queryClient.invalidateQueries({ queryKey: qk.offers });
    });
  }, [api, queryClient, userId]);

  return query;
}

export function useDriverActiveJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { userId } = useSessionUser();

  // Home, job and receipt screens each mount this hook at once. Channel
  // names must differ per mount: freshChannel() evicts a same-named
  // channel, so a shared name meant opening /job killed home's realtime.
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '');

  const query = useQuery({
    queryKey: qk.driverActiveJob,
    queryFn: () => api.driver.activeJob(),
    enabled: !!userId,
    // Polled even with no job: a dispatcher can assign one by hand, which
    // never produces an offer, and the realtime channel below is not to be
    // trusted on a budget phone.
    refetchInterval: (q) => (q.state.data ? 10_000 : 15_000),
  });

  const jobId = query.data?.id;

  useEffect(() => {
    if (!userId) return;
    return api.driver.onAssignedJobChange(
      userId,
      (job) => {
        queryClient.setQueryData(qk.job(job.id), job);
        void queryClient.invalidateQueries({ queryKey: qk.driverActiveJob });
        void queryClient.invalidateQueries({ queryKey: qk.me });
      },
      instance,
    );
  }, [api, queryClient, userId, instance]);

  useEffect(() => {
    if (!jobId) return;
    return api.jobs.onJobChange(
      jobId,
      (job) => {
        // A late cancelled/completed update must not resurrect the job as
        // "current" after useCompleteJob() cleared it.
        queryClient.setQueryData(
          qk.driverActiveJob,
          LIVE_STATUSES.includes(job.status) ? job : null,
        );
        queryClient.setQueryData(qk.job(job.id), job);
      },
      `driver-${instance}`,
    );
  }, [api, jobId, queryClient, instance]);

  return query;
}

export function useCustomerContact(jobId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.customerContact(jobId ?? 'none'),
    queryFn: () => api.driver.customerContact(jobId!),
    enabled: !!jobId,
    staleTime: 5 * 60_000,
  });
}

export function useClaimJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.driver.claim(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.driverActiveJob, job);
      void queryClient.invalidateQueries({ queryKey: qk.offers });
      void queryClient.invalidateQueries({ queryKey: qk.me });
    },
    onError: () => {
      // Lost the race, or the offer expired. Either way the offer list is
      // now wrong, so refresh it rather than leaving a dead card up.
      void queryClient.invalidateQueries({ queryKey: qk.offers });
    },
  });
}

export function useDeclineJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.driver.decline(jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.offers }),
  });
}

export function useAdvanceJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, to }: { jobId: string; to: JobStatus }) => api.driver.advance(jobId, to),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.driverActiveJob, job);
      queryClient.setQueryData(qk.job(job.id), job);
    },
  });
}

export function useCompleteJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.driver.complete(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.job(job.id), job);
      queryClient.setQueryData(qk.driverActiveJob, null);
      void queryClient.invalidateQueries({ queryKey: qk.me });
      void queryClient.invalidateQueries({ queryKey: qk.wallet });
      void queryClient.invalidateQueries({ queryKey: ['driver-earnings'] });
    },
  });
}

export function useSubmitReceipt() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      items,
      receiptPath,
    }: {
      jobId: string;
      items: {
        id: string;
        actual_price_centavos: number;
        is_available: boolean;
        substitute_note: string;
      }[];
      receiptPath?: string | null;
    }) => api.driver.submitReceipt(jobId, items, receiptPath ?? null),
    onSuccess: (job) => {
      queryClient.setQueryData(qk.driverActiveJob, job);
      void queryClient.invalidateQueries({ queryKey: qk.jobItems(job.id) });
    },
  });
}

export function useWallet() {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.wallet,
    queryFn: () => api.driver.wallet(),
    enabled: !!userId,
  });
}

export function useEarnings(since: Date, key: string) {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.earnings(key),
    queryFn: () => api.driver.earnings(since),
    enabled: !!userId,
  });
}

export function useDriverDocuments() {
  const api = useApi();
  const { userId } = useSessionUser();
  return useQuery({
    queryKey: qk.documents,
    queryFn: () => api.driver.documents(),
    enabled: !!userId,
  });
}

// ---------------------------------------------------------------- dispatch

export function useDispatchBoard() {
  const api = useApi();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.board,
    queryFn: () => api.dispatch.board(),
    // The dispatcher is watching this all shift. `age_seconds` is computed
    // server-side, so a short poll is also what keeps the wait timers
    // ticking honestly.
    refetchInterval: 5_000,
    staleTime: 0,
  });

  useEffect(() => {
    return api.dispatch.onAnyJobChange(() => {
      void queryClient.invalidateQueries({ queryKey: qk.board });
    });
  }, [api, queryClient]);

  return query;
}

export function useRoster() {
  const api = useApi();
  return useQuery({
    queryKey: qk.roster,
    queryFn: () => api.dispatch.roster(),
    refetchInterval: 15_000,
  });
}

export function useRedispatch() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, radiusM }: { jobId: string; radiusM?: number }) =>
      api.dispatch.redispatch(jobId, radiusM),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.board }),
  });
}

export function useRecordTopup() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      driverId,
      amountCentavos,
      note,
    }: {
      driverId: string;
      amountCentavos: number;
      note?: string;
    }) => api.dispatch.recordTopup(driverId, amountCentavos, note ?? ''),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.roster }),
  });
}
