#!/usr/bin/env node
/**
 * Ruft Marktdaten und Measures über die Bigdata.com-API ab und schreibt sie im
 * Dashboard-Format (siehe src/types.ts → MarketData) in eine JSON-Datei.
 *
 * Aufruf:
 *   BIGDATA_API_KEY=... node scripts/fetch-bigdata.mjs [--config bigdata.config.json] [--out pfad.json]
 *
 * Welche Endpunkte abgefragt und welche Felder übernommen werden, steht vollständig
 * in der Konfigurationsdatei (Vorlage: bigdata.config.example.json).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configPath = resolve(arg('config', 'bigdata.config.json'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const outPath = resolve(arg('out', config.output ?? 'public/data/marketdata.json'));

const apiKey = process.env.BIGDATA_API_KEY;
if (!apiKey) {
  console.error('Fehler: Umgebungsvariable BIGDATA_API_KEY ist nicht gesetzt.');
  process.exit(1);
}

const baseUrl = (process.env.BIGDATA_API_URL ?? config.api?.baseUrl ?? '').replace(/\/$/, '');
const keyHeader = config.api?.apiKeyHeader ?? 'X-API-KEY';
const keyPrefix = config.api?.apiKeyPrefix ?? '';
const timeoutMs = config.api?.timeoutMs ?? 30000;

/** Liest einen Wert über einen Pfad wie "quote.data.items[0].close". */
function get(obj, path) {
  if (path === undefined || path === null || path === '') return undefined;
  return String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toSeries(ctx, spec) {
  if (!spec) return undefined;
  const rows = get(ctx, spec.path);
  if (!Array.isArray(rows)) return undefined;
  const pts = rows
    .map((r) => ({ t: String(get(r, spec.t ?? 't')), v: num(get(r, spec.v ?? 'v')) }))
    .filter((p) => p.v !== null && p.t !== 'undefined')
    .sort((a, b) => a.t.localeCompare(b.t));
  return spec.last ? pts.slice(-spec.last) : pts;
}

async function callApi(req) {
  const url = new URL(baseUrl + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: req.method ?? (req.body ? 'POST' : 'GET'),
    headers: {
      [keyHeader]: keyPrefix + apiKey,
      Accept: 'application/json',
      ...(req.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: req.body ? JSON.stringify(req.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} für ${req.path}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

async function fetchInstrument(inst) {
  const out = {
    id: inst.id,
    name: inst.name,
    ticker: inst.ticker,
    currency: inst.currency,
    measures: [],
  };
  try {
    // Alle Anfragen eines Instruments parallel; Ergebnisse unter ihrem Namen ablegen.
    const entries = Object.entries(inst.requests ?? {});
    const results = await Promise.all(entries.map(([, req]) => callApi(req)));
    const ctx = Object.fromEntries(entries.map(([name], i) => [name, results[i]]));

    if (inst.price) {
      const last = num(get(ctx, inst.price.last));
      if (last !== null) {
        out.price = {
          last,
          change: num(get(ctx, inst.price.change)),
          changePct: num(get(ctx, inst.price.changePct)),
          asOf: get(ctx, inst.price.asOf),
        };
      }
    }
    out.series = toSeries(ctx, inst.series);
    if (out.price && out.series?.length && out.price.changePct === null && out.series.length > 1) {
      // Veränderung aus dem Verlauf ableiten, falls die API keine liefert.
      const prev = out.series[out.series.length - 2].v;
      out.price.change = out.price.last - prev;
      out.price.changePct = prev ? ((out.price.last - prev) / prev) * 100 : null;
    }

    out.measures = (inst.measures ?? []).map((m) => ({
      key: m.key,
      label: m.label,
      value: num(get(ctx, m.path)),
      previous: num(get(ctx, m.previousPath)),
      unit: m.unit,
      decimals: m.decimals,
      asOf: get(ctx, m.asOfPath),
      series: toSeries(ctx, m.series),
    }));
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    console.error(`[${inst.id}] ${out.error}`);
  }
  return out;
}

const instruments = await Promise.all((config.instruments ?? []).map(fetchInstrument));
const failed = instruments.filter((i) => i.error).length;
if (instruments.length && failed === instruments.length) {
  // Letzten gültigen Datenstand nicht überschreiben, wenn gar nichts geladen werden konnte.
  console.error('Kein Instrument konnte geladen werden – Ausgabedatei bleibt unverändert.');
  process.exit(2);
}
const data = {
  generatedAt: new Date().toISOString(),
  source: 'Bigdata.com',
  instruments,
};

// Atomar schreiben, damit das Dashboard nie eine halb geschriebene Datei liest.
await mkdir(dirname(outPath), { recursive: true });
const tmp = `${outPath}.tmp`;
await writeFile(tmp, JSON.stringify(data, null, 2));
await rename(tmp, outPath);

console.log(`${instruments.length - failed}/${instruments.length} Instrumente geschrieben nach ${outPath}`);
