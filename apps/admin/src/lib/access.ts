/**
 * Client-side mirrors of the escalation rules in 20260930000100_rbac.sql,
 * used ONLY to grey out controls the database would refuse anyway. The
 * database remains the judge; if these drift, the worst case is a button
 * that errors instead of being disabled.
 */

import type { DirectoryUser, PermissionKey, RoleSummary } from '@fetch/api';

export function permissionsOf(roleIds: Iterable<string>, roles: RoleSummary[]): Set<PermissionKey> {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const out = new Set<PermissionKey>();
  for (const id of roleIds) {
    for (const p of byId.get(id)?.permissions ?? []) out.add(p);
  }
  return out;
}

/** You cannot hand out a power you do not have yourself. */
export function canGrant(role: RoleSummary, mine: readonly PermissionKey[]): boolean {
  return role.permissions.every((p) => mine.includes(p));
}

/** users.manage, and the target's powers are a subset of yours. */
export function canManage(
  user: DirectoryUser,
  roles: RoleSummary[],
  mine: readonly PermissionKey[],
): boolean {
  if (!mine.includes('users.manage')) return false;
  for (const p of permissionsOf(
    user.roles.map((r) => r.id),
    roles,
  )) {
    if (!mine.includes(p)) return false;
  }
  return true;
}

/** A readable temporary password: three short words and a number. */
export function generatePassword(): string {
  const words = [
    'tuna',
    'mango',
    'habal',
    'pier',
    'lagao',
    'bulaong',
    'calumpang',
    'fishport',
    'durian',
    'sakay',
    'banca',
    'kalye',
    'palengke',
    'sunset',
    'bay',
    'tambler',
  ];
  const pick = () => {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    return words[n[0]! % words.length]!;
  };
  const num = new Uint32Array(1);
  crypto.getRandomValues(num);
  return `${pick()}-${pick()}-${pick()}-${(num[0]! % 90) + 10}`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-PH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
