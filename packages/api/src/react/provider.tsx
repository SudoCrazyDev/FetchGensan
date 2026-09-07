/**
 * Shared React wiring for all three apps.
 *
 * The Api instance is injected rather than created here, because each app
 * builds its client differently (AsyncStorage on native, cookies on the
 * server, localStorage in the browser).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { Api } from '../api';

const ApiContext = createContext<Api | null>(null);

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Most screens are also driven by a realtime subscription, so
        // polling is the fallback rather than the primary path.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Never retry an authorisation or validation failure -- the
          // answer will not change, and on a metered prepaid connection
          // three doomed retries is three wasted requests.
          const code = (error as { code?: string } | null)?.code ?? '';
          if (
            code.startsWith('42') ||
            code === 'PGRST301' ||
            code === '23514' ||
            code === '55P03'
          ) {
            return false;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

export interface ApiProviderProps {
  api: Api;
  queryClient?: QueryClient;
  children: ReactNode;
}

export function ApiProvider({ api, queryClient, children }: ApiProviderProps) {
  const [client] = useState(() => queryClient ?? makeQueryClient());

  return createElement(
    QueryClientProvider,
    { client },
    createElement(ApiContext.Provider, { value: api }, children),
  );
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside an <ApiProvider>');
  return api;
}

/**
 * The signed-in user id, or null. `loading` matters: rendering a sign-in
 * screen for the half second before the stored session is read makes the
 * app look like it logged you out every launch.
 */
export function useSessionUser(): { userId: string | null; loading: boolean } {
  const api = useApi();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void api.auth
      .getSession()
      .then((session) => {
        if (!cancelled) {
          setUserId(session?.user.id ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = api.auth.onAuthStateChange((id) => {
      if (!cancelled) {
        setUserId(id);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  return useMemo(() => ({ userId, loading }), [userId, loading]);
}
