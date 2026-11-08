/**
 * Row and RPC shapes for the FetchGensan schema.
 *
 * These are hand-maintained and deliberately narrow -- they cover the
 * columns the three apps actually read. Once you have a database running,
 *
 *   pnpm db:types
 *
 * writes the full generated `Database` type to src/database.types.ts from
 * the live schema, and you should prefer that for anything new. This file
 * stays because it gives the apps meaningful domain names (`Job`,
 * `DriverOffer`) rather than `Tables<'jobs'>` everywhere, and because it
 * lets the workspace typecheck before anyone has run a migration.
 */

import type { JobStatus, JobType } from '@fetch/core';

export type UserRole = 'customer' | 'driver' | 'dispatcher' | 'admin';
export type DriverStatus = 'pending' | 'approved' | 'suspended' | 'rejected';
export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'card';
export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'failed' | 'refunded';
export type OfferResponse = 'pending' | 'accepted' | 'declined' | 'timeout' | 'withdrawn';
export type WalletTxnKind = 'commission' | 'topup' | 'payout' | 'adjustment' | 'errand_float';
export type DocumentType =
  | 'drivers_license'
  | 'or_cr'
  | 'selfie_with_license'
  | 'nbi_clearance'
  | 'barangay_clearance'
  | 'vehicle_photo';
export type DocumentStatus = 'pending' | 'approved' | 'rejected';

export interface Profile {
  id: string;
  phone: string;
  full_name: string;
  avatar_path: string | null;
  role: UserRole;
  is_blocked: boolean;
  created_at: string;
}

export interface Driver {
  id: string;
  status: DriverStatus;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  license_number: string;
  is_online: boolean;
  rating_sum: number;
  rating_count: number;
  wallet_balance_centavos: number;
  credit_floor_centavos: number;
  active_job_id: string | null;
  completed_jobs: number;
  cancelled_jobs: number;
  location_updated_at: string | null;
}

/** The safe subset a customer may read, from the `public_driver_info` view. */
export interface PublicDriverInfo {
  id: string;
  full_name: string;
  avatar_path: string | null;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  rating: number | null;
  rating_count: number;
  completed_jobs: number;
}

export interface Job {
  id: string;
  reference: string;
  customer_id: string;
  driver_id: string | null;
  job_type: JobType;
  status: JobStatus;

  pickup_label: string;
  pickup_landmark: string;
  dropoff_label: string;
  dropoff_landmark: string;
  /** Generated columns on `jobs` -- see 20260907000400_jobs.sql. */
  pickup_lng: number;
  pickup_lat: number;
  dropoff_lng: number;
  dropoff_lat: number;
  recipient_name: string;
  recipient_phone: string;
  notes: string;

  distance_meters: number;
  duration_seconds: number;

  base_fare_centavos: number;
  distance_fare_centavos: number;
  time_fare_centavos: number;
  service_fee_centavos: number;
  night_surcharge_centavos: number;
  quoted_fare_centavos: number;
  items_cost_centavos: number;
  items_budget_centavos: number;
  final_total_centavos: number;
  commission_bps: number;
  commission_centavos: number;

  payment_method: PaymentMethod;
  payment_status: PaymentStatus;

  scheduled_for: string | null;
  dispatch_attempts: number;
  dispatch_radius_m: number;

  created_at: string;
  assigned_at: string | null;
  arrived_pickup_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}

export interface ErrandItem {
  id: string;
  job_id: string;
  position: number;
  name: string;
  quantity: number;
  unit: string;
  notes: string;
  actual_price_centavos: number | null;
  is_available: boolean | null;
  substitute_note: string;
}

export interface ErrandReceipt {
  id: string;
  job_id: string;
  storage_path: string;
  total_centavos: number;
  uploaded_by: string | null;
  created_at: string;
}

export interface JobOffer {
  id: string;
  job_id: string;
  driver_id: string;
  distance_m: number;
  response: OfferResponse;
  offered_at: string;
  expires_at: string;
  round: number;
}

export interface WalletTransaction {
  id: number;
  driver_id: string;
  job_id: string | null;
  kind: WalletTxnKind;
  amount_centavos: number;
  balance_after_centavos: number;
  note: string;
  created_at: string;
}

export interface DriverDocument {
  id: string;
  driver_id: string;
  doc_type: DocumentType;
  storage_path: string;
  status: DocumentStatus;
  expires_on: string | null;
  reject_reason: string | null;
  created_at: string;
}

export interface SavedPlace {
  id: string;
  profile_id: string;
  label: string;
  landmark_note: string;
  address_line: string;
  use_count: number;
  /** Generated from `location`; see 20261002000200_app_flow_fixes.sql. */
  lng: number;
  lat: number;
}

export interface JobEvent {
  id: number;
  job_id: string;
  actor_id: string | null;
  event_type: string;
  from_status: JobStatus | null;
  to_status: JobStatus | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface FareConfigRow {
  id: string;
  job_type: JobType;
  base_fare_centavos: number;
  included_meters: number;
  per_km_centavos: number;
  per_minute_centavos: number;
  min_fare_centavos: number;
  service_fee_centavos: number;
  night_surcharge_centavos: number;
  night_starts_hour: number;
  night_ends_hour: number;
  commission_bps: number;
  max_item_float_centavos: number;
  is_active: boolean;
}

/** A row of the `dispatch_board` view -- everything the console needs. */
export interface DispatchBoardRow {
  id: string;
  reference: string;
  job_type: JobType;
  status: JobStatus;
  created_at: string;
  assigned_at: string | null;
  scheduled_for: string | null;
  notes: string;
  dispatch_attempts: number;
  dispatch_radius_m: number;

  pickup_label: string;
  pickup_landmark: string;
  pickup_lng: number;
  pickup_lat: number;
  dropoff_label: string;
  dropoff_landmark: string;
  dropoff_lng: number;
  dropoff_lat: number;

  distance_meters: number;
  quoted_fare_centavos: number;
  items_cost_centavos: number;
  final_total_centavos: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;

  customer_name: string;
  customer_phone: string;
  driver_id: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  plate_number: string | null;
  driver_lng: number | null;
  driver_lat: number | null;
  driver_location_updated_at: string | null;

  age_seconds: number;
  pending_offers: number;
}

/** A row of the `driver_roster` view. */
export interface DriverRosterRow {
  id: string;
  full_name: string;
  phone: string;
  is_blocked: boolean;
  status: DriverStatus;
  is_online: boolean;
  plate_number: string;
  vehicle_make: string;
  vehicle_model: string;
  rating: number | null;
  rating_count: number;
  completed_jobs: number;
  cancelled_jobs: number;
  wallet_balance_centavos: number;
  credit_floor_centavos: number;
  active_job_id: string | null;
  location_updated_at: string | null;
  is_dispatchable: boolean;
  pending_documents: number;
}

export interface LandmarkResult {
  id: string;
  name: string;
  category: string;
  lng: number;
  lat: number;
  distance_m: number | null;
}

export interface DriverPosition {
  lng: number;
  lat: number;
  heading: number | null;
  updated_at: string;
}

export interface NearbyDriver {
  driver_id: string;
  distance_m: number;
  full_name: string;
  rating: number | null;
}

export interface FareQuoteRow {
  base_fare_centavos: number;
  distance_fare_centavos: number;
  time_fare_centavos: number;
  service_fee_centavos: number;
  night_surcharge_centavos: number;
  total_centavos: number;
  commission_bps: number;
}

/** A job with the extras the tracking and detail screens need. */
export interface JobWithDetails extends Job {
  driver?: PublicDriverInfo | null;
  items?: ErrandItem[];
}

/** A row of the `admin_jobs` view: every job, any status, with names. */
export interface AdminJobRow {
  id: string;
  reference: string;
  job_type: JobType;
  status: JobStatus;
  created_at: string;
  assigned_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  scheduled_for: string | null;
  notes: string;
  pickup_label: string;
  pickup_landmark: string;
  pickup_lng: number;
  pickup_lat: number;
  dropoff_label: string;
  dropoff_landmark: string;
  dropoff_lng: number;
  dropoff_lat: number;
  recipient_name: string;
  recipient_phone: string;
  distance_meters: number;
  quoted_fare_centavos: number;
  items_cost_centavos: number;
  items_budget_centavos: number;
  final_total_centavos: number;
  commission_centavos: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  dispatch_attempts: number;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  driver_id: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  plate_number: string | null;
}

/** A row of the `admin_customers` view. */
export interface AdminCustomerRow {
  id: string;
  phone: string;
  full_name: string;
  role: UserRole;
  is_blocked: boolean;
  notes: string | null;
  created_at: string;
  completed_jobs: number;
  cancelled_jobs: number;
  last_booking_at: string | null;
}

/** A row of the `admin_landmarks` view. */
export interface AdminLandmarkRow {
  id: string;
  name: string;
  category: string;
  use_count: number;
  is_active: boolean;
  created_at: string;
  lng: number;
  lat: number;
}

/** One day from `admin_daily_stats()`, in Manila time. */
export interface DailyStatsRow {
  day: string;
  completed: number;
  cancelled: number;
  expired: number;
  gross_centavos: number;
  items_centavos: number;
  commission_centavos: number;
}

export interface FareUpdateInput {
  base_fare_centavos: number;
  included_meters: number;
  per_km_centavos: number;
  per_minute_centavos: number;
  min_fare_centavos: number;
  service_fee_centavos: number;
  night_surcharge_centavos: number;
  night_starts_hour: number;
  night_ends_hour: number;
  commission_bps: number;
  max_item_float_centavos: number;
}

// ---------------------------------------------------------------- access control

/**
 * Every permission the database knows about -- the `permissions` table in
 * 20260930000100_rbac.sql. A key missing from that table is false for
 * everyone, so keep this list in step with it.
 */
export type PermissionKey =
  | 'console.access'
  | 'drivers.manage'
  | 'wallet.topup'
  | 'wallet.adjust'
  | 'pricing.manage'
  | 'users.view'
  | 'users.manage'
  | 'roles.manage';

export interface Permission {
  key: PermissionKey;
  category: string;
  label: string;
  description: string;
  sort_order: number;
}

/** A row of `list_roles()`. */
export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: PermissionKey[];
  user_count: number;
  created_at: string;
}

export interface RoleRef {
  id: string;
  key: string;
  name: string;
}

/** A row of `list_users()`. */
export interface DirectoryUser {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  account_type: UserRole;
  is_blocked: boolean;
  is_driver: boolean;
  notes: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  roles: RoleRef[];
}

/** What the `auth` edge function answers with after sign-in or reset. */
export interface SignInResult {
  user: {
    id: string;
    phone: string | null;
    email: string | null;
    full_name: string;
    account_type: UserRole;
  };
  permissions: PermissionKey[];
}

export interface NewUserInput {
  fullName: string;
  phone: string;
  email?: string;
  password: string;
  roleIds: string[];
}

export interface CredentialsPatch {
  phone?: string;
  /** An empty string removes the email login. */
  email?: string;
  password?: string;
}
