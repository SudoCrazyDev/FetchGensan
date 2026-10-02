'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import type { PermissionKey } from '@fetch/api';
import { useApi, useMyPermissions, useProfile, useSessionUser } from '@fetch/api/react';

import { Logo } from './Logo';
import { Button, Card } from './ui';

const NAV: { href: string; label: string; requires: PermissionKey }[] = [
  { href: '/', label: 'Dispatch board', requires: 'console.access' },
  { href: '/jobs', label: 'Bookings', requires: 'console.access' },
  { href: '/drivers', label: 'Riders', requires: 'console.access' },
  { href: '/customers', label: 'Customers', requires: 'console.access' },
  { href: '/landmarks', label: 'Landmarks', requires: 'console.access' },
  { href: '/fares', label: 'Fares', requires: 'console.access' },
  { href: '/reports', label: 'Reports', requires: 'console.access' },
  { href: '/users', label: 'Users', requires: 'users.view' },
  { href: '/roles', label: 'Roles', requires: 'users.view' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Where to send someone after sign-in: the first page they can use. */
export function homeFor(permissions: readonly string[]): string {
  return NAV.find((item) => permissions.includes(item.requires))?.href ?? '/';
}

/**
 * Auth and permission gate for the console.
 *
 * The gate here is a courtesy, not the security boundary. Every view and
 * RPC behind these pages checks has_permission() in the database, so
 * someone without access who reaches a page anyway sees empty tables and
 * refused writes. This just tells them why, instead.
 *
 * `requires` is the permission the page itself needs. Anyone holding at
 * least one console permission gets the frame and the nav, so a help-desk
 * role with only user management still has somewhere to land.
 */
export function Shell({
  children,
  requires = 'console.access',
}: {
  children: React.ReactNode;
  requires?: PermissionKey;
}) {
  const api = useApi();
  const pathname = usePathname();
  const router = useRouter();
  const { userId, loading } = useSessionUser();
  const { data: profile } = useProfile();
  const { data: permissions, isLoading: permissionsLoading } = useMyPermissions();

  useEffect(() => {
    if (!loading && !userId) router.replace('/login');
  }, [loading, userId, router]);

  if (loading || (userId && permissionsLoading)) {
    return <div className="flex min-h-screen items-center justify-center text-muted">Loading…</div>;
  }

  if (!userId) return null;

  const held = permissions ?? [];
  const nav = NAV.filter((item) => held.includes(item.requires));

  if (nav.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-xl font-bold">This account cannot use the console</h1>
        <p className="max-w-md text-sm text-muted">
          Signed in as {profile?.full_name || profile?.phone}. Ask an admin to give you a role such
          as <span className="font-semibold text-ink">Dispatcher</span>, then reload.
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
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href={nav[0]!.href} aria-label="FetchGensan console home">
            <Logo />
          </Link>

          <nav className="-mx-1 flex gap-1 overflow-x-auto">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
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
            <span className="hidden sm:inline">{profile?.full_name || profile?.phone}</span>
            <Button variant="secondary" onClick={() => void api.auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">
        {held.includes(requires) ? (
          children
        ) : (
          <Card className="mx-auto mt-10 max-w-lg text-center">
            <h1 className="text-lg font-bold">You do not have access to this page</h1>
            <p className="mt-2 text-sm text-muted">
              Your role does not include it. Ask an admin if you need it.
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
