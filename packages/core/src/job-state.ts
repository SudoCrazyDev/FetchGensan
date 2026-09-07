/**
 * The job state machine, mirrored from the database.
 *
 * `allowed_job_transitions()` in supabase/migrations/20260907000500_job_state.sql
 * is the authority -- it is what actually rejects an illegal write. This
 * file exists so the apps can grey out a button instead of firing a request
 * that will fail, and so the driver app can label the primary action
 * correctly for each job type.
 *
 * job-state.test.ts parses the SQL and asserts the two tables agree, so a
 * transition added in one place cannot silently diverge from the other.
 */

export const JOB_TYPES = ['ride', 'errand', 'delivery'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'draft',
  'searching',
  'assigned',
  'arriving',
  'arrived_pickup',
  'shopping',
  'awaiting_approval',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * `null` means the transition set is the same for every job type. Only
 * `arrived_pickup` differs: an errand goes shopping, a ride or delivery
 * just departs.
 */
type TransitionRule = JobStatus[] | Partial<Record<JobType, JobStatus[]>>;

const TRANSITIONS: Record<JobStatus, TransitionRule> = {
  draft: ['searching', 'cancelled'],
  searching: ['assigned', 'cancelled', 'expired'],
  assigned: ['arriving', 'cancelled'],
  arriving: ['arrived_pickup', 'cancelled'],
  arrived_pickup: {
    ride: ['in_progress', 'cancelled'],
    delivery: ['in_progress', 'cancelled'],
    errand: ['shopping', 'cancelled'],
  },
  shopping: ['awaiting_approval', 'cancelled'],
  // Back to `shopping` covers the customer rejecting the receipt and asking
  // the driver to swap something out.
  awaiting_approval: ['in_progress', 'shopping', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: ['searching', 'cancelled'],
};

export function allowedTransitions(type: JobType, from: JobStatus): JobStatus[] {
  const rule = TRANSITIONS[from];
  if (Array.isArray(rule)) return rule;
  return rule[type] ?? [];
}

export function canTransition(type: JobType, from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions(type, from).includes(to);
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'cancelled',
  'expired',
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/** A job that occupies the driver and shows on the customer tracking screen. */
export function isLive(status: JobStatus): boolean {
  return (
    status === 'assigned' ||
    status === 'arriving' ||
    status === 'arrived_pickup' ||
    status === 'shopping' ||
    status === 'awaiting_approval' ||
    status === 'in_progress'
  );
}

/**
 * The status the driver's primary button should move the job to, or null
 * when the next move is not theirs to make.
 *
 * `awaiting_approval` deliberately returns null: the driver is waiting on
 * the customer to accept the receipt total and must not be able to skip it.
 */
export function driverNextStatus(type: JobType, from: JobStatus): JobStatus | null {
  switch (from) {
    case 'assigned':
      return 'arriving';
    case 'arriving':
      return 'arrived_pickup';
    case 'arrived_pickup':
      return type === 'errand' ? 'shopping' : 'in_progress';
    case 'shopping':
      // Reached by submitting a receipt, not by a plain status change.
      return 'awaiting_approval';
    case 'in_progress':
      return 'completed';
    default:
      return null;
  }
}

// ---------------------------------------------------------------- labels

/**
 * Wording is per job type on purpose. "Arrived at pickup" is meaningless on
 * an errand where the pickup is a supermarket, and "Rider is on the way"
 * is wrong for a parcel.
 */
const CUSTOMER_LABELS: Record<JobStatus, Record<JobType, string>> = {
  draft: {
    ride: 'Scheduled',
    errand: 'Scheduled',
    delivery: 'Scheduled',
  },
  searching: {
    ride: 'Looking for a rider near you',
    errand: 'Looking for someone to shop for you',
    delivery: 'Looking for a rider near you',
  },
  assigned: {
    ride: 'Rider found',
    errand: 'Shopper found',
    delivery: 'Rider found',
  },
  arriving: {
    ride: 'Your rider is on the way',
    errand: 'Heading to the store',
    delivery: 'Heading to pick up your parcel',
  },
  arrived_pickup: {
    ride: 'Your rider has arrived',
    errand: 'At the store',
    delivery: 'At the pickup point',
  },
  shopping: {
    ride: 'Shopping',
    errand: 'Buying your items',
    delivery: 'Collecting',
  },
  awaiting_approval: {
    ride: 'Waiting for your approval',
    errand: 'Please review the receipt total',
    delivery: 'Waiting for your approval',
  },
  in_progress: {
    ride: 'On the way to your destination',
    errand: 'Delivering your items',
    delivery: 'Your parcel is on the way',
  },
  completed: { ride: 'Completed', errand: 'Completed', delivery: 'Delivered' },
  cancelled: { ride: 'Cancelled', errand: 'Cancelled', delivery: 'Cancelled' },
  expired: {
    ride: 'No rider available right now',
    errand: 'No shopper available right now',
    delivery: 'No rider available right now',
  },
};

export function customerStatusLabel(type: JobType, status: JobStatus): string {
  return CUSTOMER_LABELS[status][type];
}

/** Text for the driver's big primary button. */
export function driverActionLabel(type: JobType, status: JobStatus): string | null {
  switch (status) {
    case 'assigned':
      return type === 'errand' ? 'Start heading to store' : 'Start trip to pickup';
    case 'arriving':
      return type === 'errand' ? "I'm at the store" : "I've arrived";
    case 'arrived_pickup':
      if (type === 'errand') return 'Start shopping';
      return type === 'ride' ? 'Start the ride' : 'Parcel collected';
    case 'shopping':
      return 'Submit receipt';
    case 'awaiting_approval':
      return null; // waiting on the customer
    case 'in_progress':
      return type === 'ride' ? 'Drop off passenger' : 'Mark delivered';
    default:
      return null;
  }
}

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  ride: 'Ride',
  errand: 'Errand',
  delivery: 'Delivery',
};
