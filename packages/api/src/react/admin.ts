/**
 * Hooks for the dispatch console only.
 *
 * Kept apart from hooks.ts so the two mobile apps never pull in screens'
 * worth of staff-only queries they cannot run anyway -- every one of these
 * reads a view or RPC gated on is_staff().
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { JobStatus, JobType } from '@fetch/core';

import type { DriverStatus, FareUpdateInput } from '../types';
import { qk } from './hooks';
import { useApi } from './provider';

export interface AdminJobFilters {
  search?: string;
  status?: JobStatus | 'all';
  jobType?: JobType | 'all';
  driverId?: string;
  customerId?: string;
}

export function useAdminJobs(filters: AdminJobFilters, limit = 100) {
  const api = useApi();
  return useQuery({
    queryKey: qk.adminJobs(JSON.stringify({ ...filters, limit })),
    queryFn: () => api.dispatch.jobs({ ...filters, limit }),
    refetchInterval: 20_000,
  });
}

/** One job with everything the detail page shows, in parallel. */
export function useAdminJob(jobId: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.adminJob(jobId),
    queryFn: async () => {
      const [rows, events, items, receipts] = await Promise.all([
        api.client.from('admin_jobs').select('*').eq('id', jobId).maybeSingle(),
        api.dispatch.jobEvents(jobId),
        api.dispatch.jobItems(jobId),
        api.dispatch.jobReceipts(jobId),
      ]);
      if (rows.error) throw rows.error;
      const withUrls = await Promise.all(
        receipts.map(async (r) => ({
          ...r,
          url: await api.files.signedUrl('receipts', r.storage_path).catch(() => null),
        })),
      );
      return {
        job: rows.data as import('../types').AdminJobRow | null,
        events,
        items,
        receipts: withUrls,
      };
    },
    refetchInterval: 10_000,
  });
}

export function useAdminDriver(driverId: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.adminDriver(driverId),
    queryFn: async () => {
      const [roster, driver, documents, wallet] = await Promise.all([
        api.client.from('driver_roster').select('*').eq('id', driverId).maybeSingle(),
        api.dispatch.driverDetail(driverId),
        api.dispatch.driverDocuments(driverId),
        api.dispatch.driverWallet(driverId),
      ]);
      if (roster.error) throw roster.error;
      const docs = await Promise.all(
        documents.map(async (d) => ({
          ...d,
          url: await api.files.signedUrl('driver-docs', d.storage_path).catch(() => null),
        })),
      );
      return {
        roster: roster.data as import('../types').DriverRosterRow | null,
        driver,
        documents: docs,
        wallet,
      };
    },
  });
}

/** Invalidate everything that shows a driver after a staff action on one. */
function useInvalidateDriver() {
  const queryClient = useQueryClient();
  return (driverId: string) => {
    void queryClient.invalidateQueries({ queryKey: qk.adminDriver(driverId) });
    void queryClient.invalidateQueries({ queryKey: qk.roster });
  };
}

export function useSetDriverStatus() {
  const api = useApi();
  const invalidate = useInvalidateDriver();
  return useMutation({
    mutationFn: (v: { driverId: string; status: DriverStatus; reason?: string }) =>
      api.dispatch.setDriverStatus(v.driverId, v.status, v.reason ?? ''),
    onSuccess: (_d, v) => invalidate(v.driverId),
  });
}

export function useReviewDocument() {
  const api = useApi();
  const invalidate = useInvalidateDriver();
  return useMutation({
    mutationFn: (v: {
      driverId: string;
      docId: string;
      status: 'approved' | 'rejected';
      reason?: string;
    }) => api.dispatch.reviewDocument(v.docId, v.status, v.reason ?? ''),
    onSuccess: (_d, v) => invalidate(v.driverId),
  });
}

export function useWalletAdjustment() {
  const api = useApi();
  const invalidate = useInvalidateDriver();
  return useMutation({
    mutationFn: (v: { driverId: string; amountCentavos: number; note: string }) =>
      api.dispatch.walletAdjustment(v.driverId, v.amountCentavos, v.note),
    onSuccess: (_d, v) => invalidate(v.driverId),
  });
}

export function useAdminTopup() {
  const api = useApi();
  const invalidate = useInvalidateDriver();
  return useMutation({
    mutationFn: (v: { driverId: string; amountCentavos: number; note: string }) =>
      api.dispatch.recordTopup(v.driverId, v.amountCentavos, v.note),
    onSuccess: (_d, v) => invalidate(v.driverId),
  });
}

export function useSetCreditFloor() {
  const api = useApi();
  const invalidate = useInvalidateDriver();
  return useMutation({
    mutationFn: (v: { driverId: string; floorCentavos: number }) =>
      api.dispatch.setCreditFloor(v.driverId, v.floorCentavos),
    onSuccess: (_d, v) => invalidate(v.driverId),
  });
}

export function useAssignJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { jobId: string; driverId: string }) =>
      api.dispatch.assign(v.jobId, v.driverId),
    onSuccess: (_d, v) => {
      void queryClient.invalidateQueries({ queryKey: qk.board });
      void queryClient.invalidateQueries({ queryKey: qk.roster });
      void queryClient.invalidateQueries({ queryKey: qk.adminJob(v.jobId) });
    },
  });
}

export function useAdminCancelJob() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { jobId: string; reason: string }) => api.dispatch.cancel(v.jobId, v.reason),
    onSuccess: (_d, v) => {
      void queryClient.invalidateQueries({ queryKey: qk.board });
      void queryClient.invalidateQueries({ queryKey: qk.adminJob(v.jobId) });
      void queryClient.invalidateQueries({ queryKey: ['admin-jobs'] });
    },
  });
}

export function useCustomers(search: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.customers(search),
    queryFn: () => api.dispatch.customers(search),
  });
}

/**
 * Deactivate or reactivate an account. RBAC's path: needs users.manage, and
 * the admin-users edge function also bans the login so a session stops
 * refreshing.
 */
export function useSetBlocked() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (v: { profileId: string; blocked: boolean; note?: string }) => {
      // set_user_blocked() keeps no reason, so a note goes on the profile
      // first through RBAC's own update_user_profile() -- same permission.
      const note = v.note?.trim();
      if (note) {
        const { data, error } = await api.client
          .from('admin_customers')
          .select('full_name, notes')
          .eq('id', v.profileId)
          .single();
        if (error) throw error;
        const row = data as { full_name: string; notes: string | null };
        const stamp = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Manila',
          dateStyle: 'short',
        }).format(new Date());
        const line = `[${stamp}] ${v.blocked ? 'deactivated' : 'reactivated'}: ${note}`;
        await api.access.updateProfile(v.profileId, {
          fullName: row.full_name,
          notes: row.notes ? `${row.notes}
${line}` : line,
        });
      }
      await api.access.setBlocked(v.profileId, v.blocked);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      void queryClient.invalidateQueries({ queryKey: qk.roster });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useFareHistory() {
  const api = useApi();
  return useQuery({ queryKey: qk.fareHistory, queryFn: () => api.dispatch.fareHistory() });
}

export function useUpdateFare() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { jobType: JobType; input: FareUpdateInput }) =>
      api.dispatch.updateFare(v.jobType, v.input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.fareHistory });
      void queryClient.invalidateQueries({ queryKey: qk.fareConfigs });
    },
  });
}

export function useAdminLandmarks() {
  const api = useApi();
  return useQuery({ queryKey: qk.adminLandmarks, queryFn: () => api.dispatch.landmarks() });
}

export function useSaveLandmark() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: Parameters<typeof api.dispatch.saveLandmark>[0]) =>
      api.dispatch.saveLandmark(v),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.adminLandmarks });
      void queryClient.invalidateQueries({ queryKey: ['landmarks'] });
    },
  });
}

export function useDailyStats(days: number) {
  const api = useApi();
  return useQuery({
    queryKey: qk.dailyStats(days),
    queryFn: () => api.dispatch.dailyStats(days),
    refetchInterval: 60_000,
  });
}

export function useNearbyDrivers(jobId: string | null, radiusM = 7000) {
  const api = useApi();
  return useQuery({
    queryKey: ['nearby-drivers', jobId, radiusM],
    queryFn: () => api.dispatch.nearbyDrivers(jobId!, radiusM),
    enabled: !!jobId,
    refetchInterval: 10_000,
  });
}

export function useAdminCustomer(profileId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['admin-customers', 'one', profileId],
    queryFn: async () => {
      const { data, error } = await api.client
        .from('admin_customers')
        .select('*')
        .eq('id', profileId)
        .maybeSingle();
      if (error) throw error;
      return data as import('../types').AdminCustomerRow | null;
    },
  });
}
