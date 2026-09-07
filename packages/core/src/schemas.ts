/**
 * Input validation shared by all three apps.
 *
 * These are a UX layer, not a security layer -- the database RPCs validate
 * everything again, because a client can always be bypassed. What these buy
 * is an error message next to the field instead of a Postgres exception in
 * a toast.
 */

import { z } from 'zod';
import { JOB_TYPES } from './job-state';
import { isValidPhPhone, normalizePhPhone } from './phone';
import { SERVICE_BOUNDS } from './geo';

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Enter your mobile number')
  .refine(isValidPhPhone, 'That does not look like a PH mobile number (09xx or +639xx)')
  .transform((v) => normalizePhPhone(v)!);

export const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const latLngSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * A location the customer picked. `landmark` is the field that matters most
 * and is required for pins that came from dragging the map, because a bare
 * coordinate with no description is what makes a driver phone the customer.
 */
export const placeSchema = z.object({
  location: latLngSchema,
  label: z.string().trim().max(120).default(''),
  landmark: z.string().trim().max(200).default(''),
});

export type Place = z.infer<typeof placeSchema>;

export const errandItemSchema = z.object({
  name: z.string().trim().min(1, 'What should we buy?').max(120),
  quantity: z.number().positive('Quantity must be more than zero').max(999),
  unit: z.string().trim().max(20).default('pc'),
  notes: z.string().trim().max(200).default(''),
});

export type ErrandItemInput = z.infer<typeof errandItemSchema>;

export const paymentMethodSchema = z.enum(['cash', 'gcash', 'maya', 'card']);

const bookingBase = z.object({
  pickup: placeSchema,
  dropoff: placeSchema,
  notes: z.string().trim().max(500).default(''),
  paymentMethod: paymentMethodSchema.default('cash'),
  scheduledFor: z.date().nullable().default(null),
});

export const rideBookingSchema = bookingBase.extend({
  jobType: z.literal('ride'),
});

export const deliveryBookingSchema = bookingBase.extend({
  jobType: z.literal('delivery'),
  // Parcels usually go to someone who is not the account holder, and the
  // driver needs a number they can actually ring on arrival.
  recipientName: z.string().trim().min(1, "Who is receiving this?").max(120),
  recipientPhone: phoneSchema,
});

export const errandBookingSchema = bookingBase.extend({
  jobType: z.literal('errand'),
  items: z.array(errandItemSchema).min(1, 'Add at least one item').max(40),
  /**
   * The customer's spending cap in centavos. Not a hard block -- the driver
   * still submits a real receipt for approval -- but it tells the shopper
   * when to stop and ask.
   */
  itemsBudgetCentavos: z
    .number()
    .int()
    .min(0)
    .max(2_000_000, 'For orders above ₱20,000 please call dispatch'),
});

export const bookingSchema = z.discriminatedUnion('jobType', [
  rideBookingSchema,
  deliveryBookingSchema,
  errandBookingSchema,
]);

export type BookingInput = z.infer<typeof bookingSchema>;

/** Rejects a pin dropped in the sea before it becomes a failed RPC. */
export const inServiceAreaSchema = latLngSchema.refine(
  (p) =>
    p.latitude >= SERVICE_BOUNDS.minLat &&
    p.latitude <= SERVICE_BOUNDS.maxLat &&
    p.longitude >= SERVICE_BOUNDS.minLng &&
    p.longitude <= SERVICE_BOUNDS.maxLng,
  'We do not serve that area yet',
);

export const profileUpdateSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your name').max(120),
  avatar_path: z.string().nullable().optional(),
});

export const driverProfileSchema = z.object({
  vehicle_make: z.string().trim().min(1, 'Motorcycle make').max(60),
  vehicle_model: z.string().trim().min(1, 'Motorcycle model').max(60),
  vehicle_color: z.string().trim().max(40).default(''),
  plate_number: z
    .string()
    .trim()
    .min(3, 'Plate number is required')
    .max(12)
    .transform((v) => v.toUpperCase().replace(/\s+/g, ' ')),
  license_number: z.string().trim().min(5, "Driver's licence number is required").max(30),
});

export const receiptLineSchema = z.object({
  id: z.string().uuid(),
  actual_price_centavos: z.number().int().min(0).max(1_000_000),
  is_available: z.boolean(),
  substitute_note: z.string().trim().max(200).default(''),
});

export const receiptSchema = z.object({
  items: z.array(receiptLineSchema).min(1),
  receiptPath: z.string().nullable().default(null),
});

export const ratingSchema = z.object({
  stars: z.number().int().min(1, 'Pick a rating').max(5),
  comment: z.string().trim().max(500).default(''),
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(300).default(''),
});

export const JOB_TYPE_VALUES = JOB_TYPES;
