import type { AppConfig } from '@internal/web-kit';
import { createContext, useContext } from 'react';

export const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('useConfig outside ConfigContext');
  return config;
}
