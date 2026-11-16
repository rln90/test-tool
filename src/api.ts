import type { AppConfig, CurveAtResponse, MarketData } from './types';

const DEFAULT_CONFIG: AppConfig = {
  dataUrl: 'data/marketdata.json',
  refreshSeconds: 300,
};

/** Fehler beim Laden mit HTTP-Status und ggf. der Meldung des Servers (Feld „error“). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string | undefined,
    url: string,
  ) {
    super(serverMessage ?? `HTTP ${status} beim Laden von ${url}`);
  }
}

async function getJson<T>(url: string): Promise<T> {
  // Cache-Busting, damit der Browser bei jeder Aktualisierung frische Daten holt.
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new HttpError(res.status, typeof body?.error === 'string' ? body.error : undefined, url);
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
      look: typeof cfg.look === 'string' ? cfg.look : undefined,
      refreshUrl: typeof cfg.refreshUrl === 'string' ? cfg.refreshUrl : undefined,
      refreshParts: Array.isArray(cfg.refreshParts) ? cfg.refreshParts : undefined,
      curveUrl: typeof cfg.curveUrl === 'string' ? cfg.curveUrl : undefined,
      curveMinDate: typeof cfg.curveMinDate === 'string' ? cfg.curveMinDate : undefined,
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

/** Zinskurve zu einem Stichtag über den Worker laden (vergangene Tage liegen dort im Zwischenspeicher). */
export async function loadCurveAt(url: string, date: string): Promise<CurveAtResponse> {
  const sep = url.includes('?') ? '&' : '?';
  let res: Response;
  try {
    res = await fetch(`${url}${sep}date=${encodeURIComponent(date)}`, { cache: 'no-store' });
  } catch {
    throw new Error('Server nicht erreichbar.');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<CurveAtResponse>;
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { date, lines: body.lines ?? [], errors: body.errors };
}
