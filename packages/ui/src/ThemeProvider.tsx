import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { type Theme, darkTheme, lightTheme } from './theme';

const ThemeContext = createContext<Theme>(lightTheme);

export interface ThemeProviderProps {
  children: ReactNode;
  /**
   * Force a scheme. The driver app pins this to 'dark': a white screen on a
   * handlebar mount at 2am wrecks night vision, and the driver has no spare
   * hand to change a setting mid-shift.
   */
  scheme?: 'light' | 'dark' | 'system';
}

export function ThemeProvider({ children, scheme = 'system' }: ThemeProviderProps) {
  const system = useColorScheme();
  const resolved = scheme === 'system' ? (system ?? 'light') : scheme;

  const theme = useMemo(() => (resolved === 'dark' ? darkTheme : lightTheme), [resolved]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
