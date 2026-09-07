import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  JOB_STATUSES,
  JOB_TYPES,
  type JobStatus,
  type JobType,
  allowedTransitions,
  canTransition,
  driverActionLabel,
  driverNextStatus,
  isLive,
  isTerminal,
} from './job-state';

const MIGRATION = join(
  import.meta.dirname,
  '../../../supabase/migrations/20260907000500_job_state.sql',
);

/**
 * Parses `allowed_job_transitions()` out of the migration.
 *
 * Reading the SQL rather than duplicating it is the whole point: this test
 * fails if someone adds a transition to the database without adding it
 * here, which is the mistake that would otherwise ship a driver app whose
 * primary button throws.
 */
function parseSqlTransitions(): Record<JobType, Record<string, string[]>> {
  const sql = readFileSync(MIGRATION, 'utf8');

  const fnStart = sql.indexOf('create or replace function allowed_job_transitions');
  expect(fnStart, 'allowed_job_transitions() not found in the migration').toBeGreaterThan(-1);
  const body = sql.slice(fnStart, sql.indexOf('guard_job_transition'));

  const result = {
    ride: {} as Record<string, string[]>,
    errand: {} as Record<string, string[]>,
    delivery: {} as Record<string, string[]>,
  };

  const readArray = (chunk: string): string[] => {
    const m = /array\[([^\]]*)\]/.exec(chunk);
    if (!m || m[1] === undefined) return [];
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
  };

  // Split on each `when '<status>' then`, keeping the status name.
  const clauses = body.split(/when\s+'([a-z_]+)'\s+then/).slice(1);

  for (let i = 0; i < clauses.length; i += 2) {
    const status = clauses[i];
    const chunk = clauses[i + 1];
    if (!status || chunk === undefined) continue;

    // Stop at the next `when`/`else`/`end` so we only read this clause.
    const conditional = /case\s+when\s+p_type\s*=\s*'errand'\s*then([\s\S]*?)else([\s\S]*?)end/.exec(
      chunk,
    );

    if (conditional && conditional[1] && conditional[2]) {
      const errandArr = readArray(conditional[1]);
      const otherArr = readArray(conditional[2]);
      result.errand[status] = errandArr;
      result.ride[status] = otherArr;
      result.delivery[status] = otherArr;
    } else {
      const arr = readArray(chunk);
      for (const t of JOB_TYPES) result[t][status] = arr;
    }
  }

  return result;
}

describe('job state machine', () => {
  it('matches the transition table in the SQL migration exactly', () => {
    const fromSql = parseSqlTransitions();

    for (const type of JOB_TYPES) {
      for (const status of JOB_STATUSES) {
        const sqlAllows = [...(fromSql[type][status] ?? [])].sort();
        const tsAllows = [...allowedTransitions(type, status)].sort();

        expect(tsAllows, `${type} / ${status}`).toEqual(sqlAllows);
      }
    }
  });

  it('covers every status in the SQL table', () => {
    const fromSql = parseSqlTransitions();
    for (const status of JOB_STATUSES) {
      expect(fromSql.ride, `SQL is missing a clause for '${status}'`).toHaveProperty(status);
    }
  });

  it('sends an errand shopping and a ride straight off', () => {
    expect(canTransition('errand', 'arrived_pickup', 'shopping')).toBe(true);
    expect(canTransition('errand', 'arrived_pickup', 'in_progress')).toBe(false);

    expect(canTransition('ride', 'arrived_pickup', 'in_progress')).toBe(true);
    expect(canTransition('ride', 'arrived_pickup', 'shopping')).toBe(false);
  });

  it('never lets a ride or delivery reach an errand-only state', () => {
    const errandOnly: JobStatus[] = ['shopping', 'awaiting_approval'];
    const reachable = new Set<JobStatus>();

    for (const type of ['ride', 'delivery'] as const) {
      const seen = new Set<JobStatus>(['draft']);
      const queue: JobStatus[] = ['draft'];
      while (queue.length) {
        const current = queue.shift()!;
        for (const next of allowedTransitions(type, current)) {
          reachable.add(next);
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }

    for (const status of errandOnly) {
      expect(reachable.has(status), `${status} should be unreachable`).toBe(false);
    }
  });

  it('treats completed and cancelled as dead ends', () => {
    for (const type of JOB_TYPES) {
      expect(allowedTransitions(type, 'completed')).toEqual([]);
      expect(allowedTransitions(type, 'cancelled')).toEqual([]);
    }
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('in_progress')).toBe(false);
  });

  it('lets an expired job be pushed back out to a wider radius', () => {
    expect(canTransition('ride', 'expired', 'searching')).toBe(true);
  });

  it('will not let a driver skip the customer receipt approval', () => {
    // The driver's button must go dead at awaiting_approval -- otherwise a
    // shopper could mark an errand delivered without the customer ever
    // agreeing to the total.
    expect(driverNextStatus('errand', 'awaiting_approval')).toBeNull();
    expect(driverActionLabel('errand', 'awaiting_approval')).toBeNull();
  });

  it('offers a driver action for every status the driver owns', () => {
    const driverOwned: JobStatus[] = [
      'assigned',
      'arriving',
      'arrived_pickup',
      'shopping',
      'in_progress',
    ];
    for (const type of JOB_TYPES) {
      for (const status of driverOwned) {
        expect(driverActionLabel(type, status), `${type}/${status}`).toBeTruthy();
      }
    }
  });

  it("every driverNextStatus is a transition the database would accept", () => {
    for (const type of JOB_TYPES) {
      for (const status of JOB_STATUSES) {
        const next = driverNextStatus(type, status);
        if (next === null) continue;
        expect(canTransition(type, status, next), `${type}: ${status} -> ${next}`).toBe(true);
      }
    }
  });

  it('marks exactly the statuses that occupy a driver as live', () => {
    const live = JOB_STATUSES.filter(isLive);
    expect(live).toEqual([
      'assigned',
      'arriving',
      'arrived_pickup',
      'shopping',
      'awaiting_approval',
      'in_progress',
    ]);
  });
});
