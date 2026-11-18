/**
 * Cloudflare Worker: liefert das Dashboard aus (statische Dateien aus dist/) und hält die Daten aktuell.
 *
 *  - Stündlich sieben Läufe (Minute 5–11), je einer pro Teilbereich: ETFs & Bitcoin, Wechselkurse, EZB-Leitzinsen,
 *    Zinskurve, 5-Jahres-Verlauf, Stress Euroraum, VIX & sichere Häfen. Die Aufteilung hält jeden Lauf unter dem CPU-Limit des kostenlosen Workers-Tarifs.
 *    Die Aufteilung hält jeden Lauf unter dem CPU-Limit des kostenlosen Workers-Tarifs.
 *  - Ergebnisse liegen im KV-Speicher DATA unter „part:<name>“.
 *  - GET  /data/marketdata.json  → alle Teilbereiche zusammengeführt
 *  - GET  /app-config.json       → Konfiguration für den Browser (Abruf über /api/refresh)
 *  - POST /api/refresh?part=…    → Teilbereich sofort neu abrufen („Jetzt abrufen“)
 *  - GET  /api/curve?date=…      → Zinskurve zu einem frei gewählten Stichtag (zwischengespeichert)
 */
import config from '../data.config.json';
import { collectData, fetchCurveAt, mergeParts, NoDataError, PARTS, summarize } from '../scripts/lib/collect.mjs';

/**
 * Ein einziger Cron-Ausdruck („5-11 * * * *“) löst stündlich sieben getrennte Läufe aus.
 * Die Minute bestimmt den Teilbereich; jeder Lauf hat sein eigenes CPU-Budget.
 */
const MINUTE_PART = { 5: 'kurse', 6: 'fx', 7: 'ezb', 8: 'kurve', 9: 'lang', 10: 'risiko', 11: 'haefen' };

/** Mindestabstand zwischen zwei manuellen Abrufen desselben Teilbereichs. */
const MIN_REFRESH_MS = 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const readPart = (env, part) => env.DATA.get(`part:${part}`, 'json');

async function updatePart(env, part) {
  const previous = await readPart(env, part);
  try {
    const data = await collectData(config, previous, [part]);
    await env.DATA.put(`part:${part}`, JSON.stringify(data));
    console.log(`[${part}] ${summarize(data)}`);
    const items = [...data.instruments, ...data.curves];
    if (part === 'lang' && !Object.keys(data.longSeries ?? {}).length) {
      return { ok: false, message: 'Der lange Kursverlauf ist gerade nicht verfügbar.' };
    }
    if (items.length && items.every((x) => x.error)) {
      return { ok: false, message: 'Die Quellen waren nicht erreichbar. Es wird der letzte Stand angezeigt.' };
    }
    return { ok: true, generatedAt: data.generatedAt };
  } catch (err) {
    if (err instanceof NoDataError) {
      console.error(`[${part}] keine Daten geladen – letzter Stand bleibt erhalten`);
      return { ok: false, message: 'Keine Daten erhalten, der letzte Stand bleibt erhalten.' };
    }
    throw err;
  }
}

async function serveData(env) {
  const entries = await Promise.all(PARTS.map(async (p) => [p, await readPart(env, p)]));
  const data = mergeParts(Object.fromEntries(entries));
  if (!data) {
    return json(
      { error: 'Noch keine Daten vorhanden. Der erste Abruf läuft zur nächsten vollen Stunde oder über „Jetzt abrufen“.' },
      503,
    );
  }
  return json(data);
}

async function serveAppConfig(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/app-config.json', request.url)));
  const cfg = res.ok ? await res.json() : {};
  delete cfg.github; // Auf Cloudflare startet der Button den Abruf direkt, ohne GitHub.
  return json({ ...cfg, refreshUrl: 'api/refresh', refreshParts: PARTS, curveUrl: 'api/curve', curveMinDate: CURVE_MIN_DATE });
}

/** Frühester Stichtag: Beginn der AAA-Zinskurve der EZB. */
const CURVE_MIN_DATE = '2004-09-06';

/**
 * Zinskurve zu einem frei gewählten Stichtag. Vergangene Stichtage ändern sich nicht mehr und werden
 * dauerhaft im KV-Speicher abgelegt; die letzten 7 Tage nur für eine Stunde.
 */
async function serveCurveAt(request, env) {
  const date = new URL(request.url).searchParams.get('date') ?? '';
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return json({ error: 'Bitte ein Datum im Format JJJJ-MM-TT angeben.' }, 400);
  }
  if (date < CURVE_MIN_DATE || date > today) {
    return json({ error: `Bitte ein Datum zwischen ${CURVE_MIN_DATE.split('-').reverse().join('.')} und heute wählen.` }, 400);
  }
  const key = `curve:${date}`;
  const cached = await env.DATA.get(key, 'json');
  if (cached) return json(cached);

  const result = await fetchCurveAt(config, date);
  if (!result.lines.length) {
    return json({ error: 'Für diesen Tag liegen keine Zinsdaten vor.', ...result }, 404);
  }
  const recent = Date.now() - Date.parse(date) < 7 * 86400000;
  if (!result.errors) {
    await env.DATA.put(key, JSON.stringify(result), recent ? { expirationTtl: 3600 } : undefined);
  }
  return json(result);
}

async function handleRefresh(request, env) {
  if (request.method !== 'POST') return json({ ok: false, message: 'Nur POST erlaubt.' }, 405);
  const part = new URL(request.url).searchParams.get('part');
  if (!PARTS.includes(part)) return json({ ok: false, message: `Unbekannter Bereich „${part}“.` }, 400);

  const previous = await readPart(env, part);
  const age = previous ? Date.now() - Date.parse(previous.generatedAt) : Infinity;
  // Nach einem fehlgeschlagenen Abruf darf sofort erneut versucht werden.
  const hadErrors = previous && [...previous.instruments, ...previous.curves].some((x) => x.error);
  if (age < MIN_REFRESH_MS && !hadErrors) {
    return json({ ok: false, message: 'Die Daten wurden gerade erst abgerufen. Bitte eine Minute warten.' }, 429);
  }
  return json(await updatePart(env, part));
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/data/marketdata.json') return serveData(env);
    if (pathname === '/app-config.json') return serveAppConfig(request, env);
    if (pathname === '/api/refresh') return handleRefresh(request, env);
    if (pathname === '/api/curve') return serveCurveAt(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const part = MINUTE_PART[new Date(event.scheduledTime).getUTCMinutes()];
    if (!part) {
      console.error(`Kein Teilbereich für ${new Date(event.scheduledTime).toISOString()} (Cron „${event.cron}“)`);
      return;
    }
    ctx.waitUntil(updatePart(env, part));
  },
};
