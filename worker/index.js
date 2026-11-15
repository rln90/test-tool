/**
 * Cloudflare Worker: liefert das Dashboard aus (statische Dateien aus dist/) und hält die Daten aktuell.
 *
 *  - Stündlich laufen vier Cron-Jobs, je einer pro Teilbereich (Kurse, ETFs & Bitcoin, Wechselkurse, EZB).
 *    Die Aufteilung hält jeden Lauf unter dem CPU-Limit des kostenlosen Workers-Tarifs.
 *  - Ergebnisse liegen im KV-Speicher DATA unter „part:<name>“.
 *  - GET  /data/marketdata.json  → alle Teilbereiche zusammengeführt
 *  - GET  /app-config.json       → Konfiguration für den Browser (Abruf über /api/refresh)
 *  - POST /api/refresh?part=…    → Teilbereich sofort neu abrufen („Jetzt abrufen“)
 */
import config from '../data.config.json';
import { collectData, mergeParts, NoDataError, PARTS, summarize } from '../scripts/lib/collect.mjs';

/** Welcher Cron-Ausdruck welchen Teilbereich abruft (muss zu wrangler.jsonc passen). */
const CRON_PART = {
  '5 * * * *': 'kurse',
  '6 * * * *': 'fx',
  '7 * * * *': 'ezb',
  '8 * * * *': 'etf',
};

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
  return json({ ...cfg, refreshUrl: 'api/refresh', refreshParts: PARTS });
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
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const part = CRON_PART[event.cron];
    if (!part) {
      console.error(`Unbekannter Cron-Ausdruck „${event.cron}“`);
      return;
    }
    ctx.waitUntil(updatePart(env, part));
  },
};
