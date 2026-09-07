'use client';

import { ApiProvider } from '@fetch/api/react';

import { api } from '@/lib/supabase';

export function Providers({ children }: { children: React.ReactNode }) {
  return <ApiProvider api={api}>{children}</ApiProvider>;
}
