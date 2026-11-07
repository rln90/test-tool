#!/usr/bin/env node
/**
 * Holt alle Daten für das Dashboard und schreibt sie im Format von src/types.ts (MarketData).
 *
 *  - Kurse (Aktien, ETFs/Indizes): Bigdata.com Structured Data API
 *      POST /v1/price/daily/query  (Tagesschlusskurse)
 *      POST /v1/quote/query        (aktueller Kurs)
 *    Authentifizierung: Header x-api-key, Key aus der Umgebungsvariable BIGDATA_API_KEY.
 *  - Euro-Zinsen und Zinskurve: EZB Data Portal (frei, ohne Key).
 *
 * Aufruf:
 *   BIGDATA_API_KEY=... node scripts/fetch-data.mjs [--config data.config.json] [--out public/data/marketdata.json]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = JSON.parse(await readFile(resolve(arg('config', 'data.config.json')), 'utf8'));
const outPath = resolve(arg('out', 'public/data/marketdata.json'));
const historyDays = config.historyDays ?? 180;
const TIMEOUT = 30000;

// ---------- Hilfsfunktionen ----------

const DAY = 86400000;
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDate(new Date(Date.now() - n * DAY));

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Wert der Reihe, der am oder vor dem Datum liegt (Reihe aufsteigend sortiert). */
function valueAtOrBefore(series, date) {
  let found = null;
  for (const p of series) {
    if (p.t <= date) found = p;
    else break;
  }
  return found;
}

function perfMeasure(key, label, series, days) {
  const last = series.at(-1);
  const base = last && valueAtOrBefore(series, isoDate(new Date(new Date(last.t).getTime() - days * DAY)));
  const value = last && base && base.v ? ((last.v - base.v) / base.v) * 100 : null;
  return { key, label, value, unit: '%', decimals: 1 };
}

// ---------- Bigdata.com ----------

async function bigdata(path, body) {
  const key = process.env.BIGDATA_API_KEY;
  if (!key) throw new Error('BIGDATA_API_KEY ist nicht gesetzt');
  const base = (process.env.BIGDATA_API_URL ?? config.bigdata.baseUrl).replace(/\/$/, '');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bigdata.com ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors?.length && !json.results?.length) {
    throw new Error(`Bigdata.com ${path}: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  return json;
}

function quoteTime(ts) {
  if (ts === undefined || ts === null) return undefined;
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  return String(ts);
}

async function fetchBigdataInstrument(inst) {
  const out = {
    id: inst.id,
    name: inst.name,
    note: inst.note,
    ticker: inst.ticker,
    source: 'Bigdata.com',
    measures: [],
  };
  try {
    const identifier = { type: 'rp_entity_id', value: inst.rpEntityId };
    const [daily, quote] = await Promise.all([
      bigdata('/v1/price/daily/query', { identifier, date_range: { start: daysAgo(historyDays), end: daysAgo(0) } }),
      inst.quote ? bigdata('/v1/quote/query', { identifier }).catch((e) => ({ quoteError: errMsg(e) })) : null,
    ]);

    const res = daily.results?.[0];
    if (!res?.values?.length) throw new Error('keine Kursdaten erhalten');
    const col = Object.fromEntries(res.fields.map((f, i) => [String(f).toUpperCase(), i]));
    const rows = [...res.values].sort((a, b) => String(a[col.DATE]).localeCompare(String(b[col.DATE])));
    out.series = rows
      .map((r) => ({ t: String(r[col.DATE]), v: num(r[col.CLOSE]) }))
      .filter((p) => p.v !== null);
    const lastRow = rows.at(-1);
    out.currency = col.CURRENCY !== undefined ? lastRow[col.CURRENCY] : undefined;
    out.price = {
      last: num(lastRow[col.CLOSE]),
      change: num(lastRow[col.CHANGE]),
      changePct: num(lastRow[col.CHANGE_PERCENT]),
      asOf: String(lastRow[col.DATE]),
    };

    const q = quote?.results?.[0];
    if (q && num(q.price) !== null) {
      out.price = {
        last: num(q.price),
        change: num(q.change),
        changePct: num(q.change_percentage),
        asOf: quoteTime(q.timestamp) ?? out.price.asOf,
      };
      out.currency = q.currency ?? out.currency;
    } else if (quote?.quoteError) {
      console.warn(`[${inst.id}] Quote nicht verfügbar, nutze Schlusskurs: ${quote.quoteError}`);
    }

    out.measures = [
      perfMeasure('perf1m', 'Perf. 1 Monat', out.series, 30),
      perfMeasure('perf6m', `Perf. ${Math.round(historyDays / 30)} Monate`, out.series, historyDays - 1),
    ];
    if (q) {
      out.measures.push(
        { key: 'high52', label: '52W-Hoch', value: num(q.year_high) },
        { key: 'low52', label: '52W-Tief', value: num(q.year_low) },
      );
    }
  } catch (err) {
    out.error = errMsg(err);
    console.error(`[${inst.id}] ${out.error}`);
  }
  return out;
}

// ---------- EZB ----------

/** Lädt eine oder mehrere EZB-Reihen (SDMX-JSON) → Map: letzter Schlüsselteil → [{t, v}] aufsteigend. */
async function ecb(flow, key, startPeriod) {
  const url = `${config.ecb.baseUrl}/${flow}/${key}?format=jsondata&startPeriod=${startPeriod}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`EZB ${flow}/${key}: HTTP ${res.status}`);
  const json = await res.json();
  const dims = json.structure.dimensions;
  const times = dims.observation[0].values.map((v) => v.id);
  const lastDim = dims.series.at(-1).values.map((v) => v.id);
  const result = new Map();
  for (const [sKey, s] of Object.entries(json.dataSets[0].series ?? {})) {
    const idx = Number(sKey.split(':').at(-1));
    const pts = Object.entries(s.observations)
      .map(([o, vals]) => ({ t: times[Number(o)], v: num(vals[0]) }))
      .filter((p) => p.v !== null)
      .sort((a, b) => a.t.localeCompare(b.t));
    result.set(lastDim[idx], pts);
  }
  return result;
}

async function fetchEcbRates() {
  const cfg = config.ecb.rates;
  const out = { id: cfg.id, name: cfg.name, source: 'EZB', measures: [] };
  const start = daysAgo(historyDays);
  const results = await Promise.allSettled(
    cfg.series.map(async (s) => {
      const map = await ecb(s.flow, s.series, start);
      const series = [...map.values()][0] ?? [];
      if (!series.length) throw new Error(`keine Daten für ${s.label}`);
      return {
        key: s.key,
        label: s.label,
        value: series.at(-1).v,
        previous: series[0].v,
        previousLabel: `ggü. ${new Date(series[0].t).toLocaleDateString('de-DE')}`,
        unit: '%',
        deltaUnit: '%-Pkt.',
        neutral: true,
        decimals: 2,
        asOf: series.at(-1).t,
        series,
      };
    }),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') out.measures.push(r.value);
    else console.error(`[${cfg.id}] ${errMsg(r.reason)}`);
  }
  if (!out.measures.length) out.error = 'EZB-Zinsdaten nicht verfügbar';
  return out;
}

function maturityYears(m) {
  const n = Number(m.slice(0, -1));
  return m.endsWith('M') ? n / 12 : n;
}

async function fetchEcbCurve() {
  const cfg = config.ecb.curve;
  const out = { id: cfg.id, name: cfg.name, unit: '%', source: 'EZB', lines: [], measures: [] };
  try {
    const maxBack = Math.max(historyDays, ...(cfg.compareDaysAgo ?? [])) + 10;
    const key = cfg.seriesPrefix + cfg.maturities.join(`+${cfg.seriesPrefix.split('.').at(-1)}`);
    const map = await ecb(cfg.flow, key, daysAgo(maxBack));
    const byMat = new Map(cfg.maturities.map((m) => [m, map.get(`SR_${m}`) ?? []]));
    const ref = byMat.get(cfg.maturities.at(-1)).length ? byMat.get(cfg.maturities.at(-1)) : [...byMat.values()].find((s) => s.length);
    if (!ref?.length) throw new Error('keine Zinskurvendaten erhalten');
    const latest = ref.at(-1).t;

    const lineAt = (date, label) => {
      const points = [];
      let asOf = '';
      for (const m of cfg.maturities) {
        const p = valueAtOrBefore(byMat.get(m), date);
        if (p) {
          points.push({ label: m, years: maturityYears(m), v: p.v });
          if (p.t > asOf) asOf = p.t;
        }
      }
      return { label, asOf, points };
    };
    out.lines.push(lineAt(latest, 'Aktuell'));
    for (const d of cfg.compareDaysAgo ?? []) {
      const target = isoDate(new Date(new Date(latest).getTime() - d * DAY));
      const label = d >= 365 ? `vor ${Math.round(d / 365)} Jahr${d >= 730 ? 'en' : ''}` : `vor ${d} Tagen`;
      const line = lineAt(target, label);
      if (line.points.length) out.lines.push(line);
    }

    const since = daysAgo(historyDays);
    const recent = (m) => byMat.get(m).filter((p) => p.t >= since);
    for (const m of cfg.highlight ?? []) {
      const s = recent(m);
      if (!s.length) continue;
      out.measures.push({
        key: `y${m}`,
        label: `Rendite ${m.replace('Y', ' J.').replace('M', ' M.')}`,
        value: s.at(-1).v,
        previous: s[0].v,
        previousLabel: `ggü. ${new Date(s[0].t).toLocaleDateString('de-DE')}`,
        unit: '%',
        deltaUnit: '%-Pkt.',
        neutral: true,
        decimals: 2,
        asOf: s.at(-1).t,
        series: s,
      });
    }
    // Steilheit der Kurve: 10 J. minus 2 J.
    const s10 = recent('10Y');
    const s2 = new Map(recent('2Y').map((p) => [p.t, p.v]));
    const spread = s10.filter((p) => s2.has(p.t)).map((p) => ({ t: p.t, v: p.v - s2.get(p.t) }));
    if (spread.length) {
      out.measures.push({
        key: 'spread10y2y',
        label: 'Spread 10 J. – 2 J.',
        value: spread.at(-1).v,
        previous: spread[0].v,
        previousLabel: `ggü. ${new Date(spread[0].t).toLocaleDateString('de-DE')}`,
        unit: '%-Pkt.',
        neutral: true,
        decimals: 2,
        asOf: spread.at(-1).t,
        series: spread,
      });
    }
  } catch (err) {
    out.error = errMsg(err);
    console.error(`[${cfg.id}] ${out.error}`);
  }
  return out;
}

// ---------- Ablauf ----------

const [instruments, rates, curve] = await Promise.all([
  Promise.all((config.bigdata?.instruments ?? []).map(fetchBigdataInstrument)),
  config.ecb?.rates ? fetchEcbRates() : null,
  config.ecb?.curve ? fetchEcbCurve() : null,
]);

if (rates) instruments.push(rates);
const curves = curve ? [curve] : [];

const all = [...instruments, ...curves];
if (all.length && all.every((x) => x.error)) {
  // Letzten gültigen Datenstand nicht überschreiben, wenn gar nichts geladen werden konnte.
  console.error('Keine Daten geladen – Ausgabedatei bleibt unverändert.');
  process.exit(2);
}

const data = {
  generatedAt: new Date().toISOString(),
  source: 'Bigdata.com, EZB',
  instruments,
  curves,
};

// Atomar schreiben, damit das Dashboard nie eine halb geschriebene Datei liest.
await mkdir(dirname(outPath), { recursive: true });
await writeFile(`${outPath}.tmp`, JSON.stringify(data));
await rename(`${outPath}.tmp`, outPath);

const failed = all.filter((x) => x.error).length;
console.log(`${all.length - failed}/${all.length} Bereiche geschrieben nach ${outPath}`);
