import type { AppConfig, MarketData } from './types';

const DEFAULT_CONFIG: AppConfig = {
  dataUrl: 'data/marketdata.json',
  refreshSeconds: 300,
};

async function getJson<T>(url: string): Promise<T> {
  // Cache-Busting, damit der Browser bei jeder Aktualisierung frische Daten holt.
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} beim Laden von ${url}`);
  }
  return (await res.json()) as T;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const cfg = await getJson<Partial<AppConfig>>('app-config.json');
    return {
      dataUrl: cfg.dataUrl || DEFAULT_CONFIG.dataUrl,
      refreshSeconds: Math.max(15, Number(cfg.refreshSeconds) || DEFAULT_CONFIG.refreshSeconds),
      github: cfg.github?.owner && cfg.github.repo && cfg.github.workflow ? cfg.github : undefined,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function loadMarketData(url: string): Promise<MarketData> {
  const data = await getJson<MarketData>(url);
  if (!data || !Array.isArray(data.instruments)) {
    throw new Error('Ungültiges Datenformat: Feld „instruments“ fehlt.');
  }
  return data;
}
