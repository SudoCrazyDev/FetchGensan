'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useApi, useProfile, useSessionUser } from '@fetch/api/react';

import { Button } from './ui';

const NAV = [
  { href: '/', label: 'Dispatch board' },
  { href: '/jobs', label: 'Bookings' },
  { href: '/drivers', label: 'Riders' },
  { href: '/customers', label: 'Customers' },
  { href: '/landmarks', label: 'Landmarks' },
  { href: '/fares', label: 'Fares' },
  { href: '/reports', label: 'Reports' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Auth and role gate for the console.
 *
 * The gate here is a courtesy, not the security boundary -- `is_staff()` in
 * the `dispatch_board` and `driver_roster` views is what actually stops a
 * customer reading the fleet. This just shows them a clear message instead
 * of a page of empty tables.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const router = useRouter();
  const { userId, loading } = useSessionUser();
  const { data: profile, isLoading: profileLoading } = useProfile();

  useEffect(() => {
    if (!loading && !userId && pathname !== '/login') router.replace('/login');
  }, [loading, userId, pathname, router]);

  if (loading || (userId && profileLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">Loading…</div>
    );
  }

  if (!userId) return null;

  const isStaff = profile?.role === 'dispatcher' || profile?.role === 'admin';

  if (!isStaff) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-xl font-bold">This account is not a dispatcher</h1>
        <p className="max-w-md text-sm text-muted">
          Signed in as {profile?.phone}. Ask an admin to set your role to{' '}
          <code className="rounded bg-raised px-1">dispatcher</code>, then reload.
        </p>
        <Button variant="secondary" onClick={() => void api.auth.signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="font-bold tracking-tight">
            Fetch<span className="text-brand">Gensan</span>
          </span>

          <nav className="flex flex-wrap gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  isActive(pathname, item.href)
                    ? 'bg-raised text-ink'
                    : 'text-muted hover:bg-surface hover:text-ink'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span>
              {profile?.full_name || profile?.phone}
              <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                {profile?.role}
              </span>
            </span>
            <Button variant="secondary" onClick={() => void api.auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
