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
      notice: typeof cfg.notice === 'string' ? cfg.notice : undefined,
      refreshUrl: typeof cfg.refreshUrl === 'string' ? cfg.refreshUrl : undefined,
      refreshParts: Array.isArray(cfg.refreshParts) ? cfg.refreshParts : undefined,
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

/** Startet über den Cloudflare Worker den sofortigen Abruf aller Teilbereiche (parallel). */
export async function refreshViaWorker(url: string, parts: string[]): Promise<{ ok: boolean; message?: string }> {
  const results = await Promise.all(
    parts.map(async (part) => {
      try {
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}part=${encodeURIComponent(part)}`, { method: 'POST', cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        return { ok: res.ok && body.ok !== false, message: body.message ?? (res.ok ? undefined : `HTTP ${res.status}`) };
      } catch {
        return { ok: false, message: 'Server nicht erreichbar.' };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { ok: true };
  const messages = [...new Set(failed.map((r) => r.message).filter(Boolean))];
  return { ok: failed.length < results.length, message: messages.join(' ') || 'Abruf fehlgeschlagen.' };
}
