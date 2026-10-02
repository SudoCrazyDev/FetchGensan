/**
 * The documents a rider uploads during onboarding. The first four are what
 * dispatch needs before approving; see apps/admin/src/app/drivers/[id] for
 * the matching review list.
 */

export const DOCUMENTS = [
  {
    type: 'drivers_license',
    label: "Driver's licence",
    hint: 'Front side, all four corners visible.',
    required: true,
  },
  {
    type: 'or_cr',
    label: 'OR / CR',
    hint: 'Official Receipt and Certificate of Registration for the motorcycle.',
    required: true,
  },
  {
    type: 'selfie_with_license',
    label: 'Selfie holding your licence',
    hint: 'So dispatch can confirm the licence is yours.',
    required: true,
  },
  {
    type: 'vehicle_photo',
    label: 'Photo of your motorcycle',
    hint: 'Side view with the plate readable.',
    required: true,
  },
  {
    type: 'nbi_clearance',
    label: 'NBI clearance',
    hint: 'Customers ride with you alone. Optional at sign-up, required before approval.',
    required: false,
  },
  {
    type: 'barangay_clearance',
    label: 'Barangay clearance',
    hint: 'Optional.',
    required: false,
  },
] as const;

export const REQUIRED_DOCUMENTS = DOCUMENTS.filter((d) => d.required).map((d) => d.type);
