#!/usr/bin/env node
/**
 * Holt alle Daten für das Dashboard und schreibt sie im Format von src/types.ts (MarketData).
 *
 *  - Kurse und Wechselkurse: Yahoo Finance (inoffizielle Chart-Schnittstelle, ohne Key)
 *  - Euro-Leitzinsen, €STR, Zinskurve: EZB Data Portal (offiziell, ohne Key)
 *  - Wechselkurse ersatzweise: EZB-Referenzkurse, falls Yahoo für eine Währung ausfällt
 *
 * Fällt ein Bereich ganz aus, wird – falls angegeben – der letzte veröffentlichte Stand
 * übernommen und als veraltet markiert (Umgebungsvariable PREVIOUS_DATA_URL oder --previous).
 *
 * Aufruf:
 *   node scripts/fetch-data.mjs [--config data.config.json] [--out public/data/marketdata.json] [--previous url|datei]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = JSON.parse(await readFile(resolve(arg('config', 'data.config.json')), 'utf8'));
const outPath = resolve(arg('out', 'public/data/marketdata.json'));
const previousSrc = arg('previous', process.env.PREVIOUS_DATA_URL);
const historyDays = config.historyDays ?? 180;
const TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; marktdaten-dashboard/1.0)';

// ---------- Hilfsfunktionen ----------

const DAY = 86400000;
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDate(new Date(Date.now() - n * DAY));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const deDate = (iso) => new Date(iso).toLocaleDateString('de-DE');

// ---------- Yahoo Finance ----------

/** Nacheinander abfragen, mit kurzer Pause, um Yahoo nicht zu überlasten. */
let yahooQueue = Promise.resolve();
function yahoo(symbol) {
  const run = async () => {
    const url = `${config.yahoo.baseUrl}/${encodeURIComponent(symbol)}?range=${Math.ceil(historyDays / 30)}mo&interval=1d`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const json = await res.json().catch(() => null);
        const result = json?.chart?.result?.[0];
        if (!res.ok || !result) {
          const desc = json?.chart?.error?.description ?? `HTTP ${res.status}`;
          throw Object.assign(new Error(desc), { final: true });
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (err.final) break;
        await sleep(1500 * attempt);
      }
    }
    throw new Error(`Yahoo ${symbol}: ${errMsg(lastErr)}`);
  };
  const p = yahooQueue.then(run);
  yahooQueue = p.catch(() => {}).then(() => sleep(config.yahoo.pauseMs ?? 400));
  return p;
}

/** Wandelt eine Yahoo-Antwort in Kurs + Tagesreihe (Datum in Börsen-Ortszeit). */
function parseYahoo(result) {
  const meta = result.meta;
  const offset = (meta.gmtoffset ?? 0) * 1000;
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const byDate = new Map();
  (result.timestamp ?? []).forEach((ts, i) => {
    const v = num(closes[i]);
    if (v !== null) byDate.set(isoDate(new Date(ts * 1000 + offset)), v);
  });
  const series = [...byDate].map(([t, v]) => ({ t, v })).sort((a, b) => a.t.localeCompare(b.t));

  const last = num(meta.regularMarketPrice) ?? series.at(-1)?.v ?? null;
  const lastTime = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null;
  let lastDate = lastTime ? isoDate(new Date(lastTime.getTime() + offset)) : series.at(-1)?.t;
  // Yahoo stempelt manche Kurse (Indizes, Devisen) mit Samstag/Sonntag – dem letzten Handelstag zuordnen.
  const weekday = lastDate ? new Date(`${lastDate}T12:00:00Z`).getUTCDay() : 1;
  if (lastDate && (weekday === 0 || weekday === 6)) {
    lastDate = [...series].reverse().find((p) => p.t <= lastDate && ![0, 6].includes(new Date(`${p.t}T12:00:00Z`).getUTCDay()))?.t ?? lastDate;
    while (series.length && series.at(-1).t > lastDate) series.pop();
  }
  // Vortagesschluss: letzter Schlusskurs vor dem Handelstag des aktuellen Kurses.
  const prev = [...series].reverse().find((p) => p.t < lastDate)?.v ?? null;
  if (last !== null && lastDate) {
    if (series.at(-1)?.t === lastDate) series[series.length - 1] = { t: lastDate, v: last };
    else series.push({ t: lastDate, v: last });
  }
  return {
    currency: meta.currency,
    exchange: meta.fullExchangeName ?? meta.exchangeName,
    series,
    price:
      last === null
        ? undefined
        : {
            last,
            change: prev !== null ? last - prev : null,
            changePct: prev ? ((last - prev) / prev) * 100 : null,
            asOf: lastTime ? lastTime.toISOString() : lastDate,
          },
  };
}

async function fetchYahooInstrument(inst) {
  const out = { id: inst.id, name: inst.name, note: inst.note, ticker: inst.symbol, source: 'Yahoo Finance', measures: [] };
  try {
    const y = parseYahoo(await yahoo(inst.symbol));
    if (!y.price) throw new Error('kein Kurs erhalten');
    Object.assign(out, { currency: y.currency ?? inst.currency, price: y.price, series: y.series });
    const vals = y.series.map((p) => p.v);
    out.measures = [
      perfMeasure('perf1m', 'Perf. 1 Monat', y.series, 30),
      perfMeasure('perfhist', `Perf. ${Math.round(historyDays / 30)} Monate`, y.series, historyDays),
      { key: 'high', label: `Hoch ${Math.round(historyDays / 30)} M.`, value: Math.max(...vals) },
      { key: 'low', label: `Tief ${Math.round(historyDays / 30)} M.`, value: Math.min(...vals) },
    ];
  } catch (err) {
    out.error = errMsg(err);
    console.error(`[${inst.id}] ${out.error}`);
  }
  return out;
}

// ---------- EZB ----------

/** Lädt eine oder mehrere EZB-Reihen (SDMX-JSON) → Map: Wert der gewählten Dimension → [{t, v}] aufsteigend. */
async function ecb(flow, key, startPeriod, dimIndex = -1) {
  const url = `${config.ecb.baseUrl}/${flow}/${key}?format=jsondata&startPeriod=${startPeriod}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`EZB ${flow}/${key}: HTTP ${res.status}`);
  const json = await res.json();
  const dims = json.structure.dimensions;
  const times = dims.observation[0].values.map((v) => v.id);
  const dim = dims.series.at(dimIndex).values.map((v) => v.id);
  const pos = dimIndex < 0 ? dims.series.length + dimIndex : dimIndex;
  const result = new Map();
  for (const [sKey, s] of Object.entries(json.dataSets[0].series ?? {})) {
    const idx = Number(sKey.split(':')[pos]);
    const pts = Object.entries(s.observations)
      .map(([o, vals]) => ({ t: times[Number(o)], v: num(vals[0]) }))
      .filter((p) => p.v !== null)
      .sort((a, b) => a.t.localeCompare(b.t));
    result.set(dim[idx], pts);
  }
  return result;
}

async function fetchEcbRates() {
  const cfg = config.ecb.rates;
  const out = { id: cfg.id, name: cfg.name, source: 'EZB', measures: [] };
  const start = daysAgo(historyDays);
  const results = await Promise.allSettled(
    cfg.series.map(async (s) => {
      const series = [...(await ecb(s.flow, s.series, start)).values()][0] ?? [];
      if (!series.length) throw new Error(`keine Daten für ${s.label}`);
      return {
        key: s.key,
        label: s.label,
        value: series.at(-1).v,
        previous: series[0].v,
        previousLabel: `ggü. ${deDate(series[0].t)}`,
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
    const ref = [...byMat.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
    if (!ref.length) throw new Error('keine Zinskurvendaten erhalten');
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
    const rateMeasure = (key, label, s, unit, extra = {}) => ({
      key,
      label,
      value: s.at(-1).v,
      previous: s[0].v,
      previousLabel: `ggü. ${deDate(s[0].t)}`,
      unit,
      neutral: true,
      decimals: 2,
      asOf: s.at(-1).t,
      series: s,
      ...extra,
    });
    for (const m of cfg.highlight ?? []) {
      const s = recent(m);
      if (s.length) {
        out.measures.push(
          rateMeasure(`y${m}`, `Rendite ${m.replace('Y', ' J.').replace('M', ' M.')}`, s, '%', { deltaUnit: '%-Pkt.' }),
        );
      }
    }
    // Steilheit der Kurve: 10 J. minus 2 J.
    const s2 = new Map(recent('2Y').map((p) => [p.t, p.v]));
    const spread = recent('10Y')
      .filter((p) => s2.has(p.t))
      .map((p) => ({ t: p.t, v: p.v - s2.get(p.t) }));
    if (spread.length) out.measures.push(rateMeasure('spread10y2y', 'Spread 10 J. – 2 J.', spread, '%-Pkt.'));
  } catch (err) {
    out.error = errMsg(err);
    console.error(`[${cfg.id}] ${out.error}`);
  }
  return out;
}

// ---------- Wechselkurse ----------

/** EZB-Referenzkurse als Ersatz; Reihen, die seit über 10 Tagen ruhen (z. B. RUB), werden verworfen. */
async function ecbFxFallback(codes) {
  if (!config.ecb.fxFallback || !codes.length) return new Map();
  try {
    const map = await ecb('EXR', `D.${codes.join('+')}.EUR.SP00.A`, daysAgo(historyDays), 1);
    for (const [code, s] of map) if (!s.length || s.at(-1).t < daysAgo(10)) map.delete(code);
    return map;
  } catch (err) {
    console.error(`[fx] EZB-Ersatz fehlgeschlagen: ${errMsg(err)}`);
    return new Map();
  }
}

async function fetchFx() {
  const cfg = config.yahoo.fx;
  const out = { id: cfg.id, name: cfg.name, note: cfg.note, source: 'Yahoo Finance', measures: [] };
  const results = await Promise.all(
    cfg.currencies.map((c) =>
      yahoo(`${cfg.base}${c.code}=X`)
        .then((r) => ({ c, y: parseYahoo(r) }))
        .catch((err) => ({ c, err: errMsg(err) })),
    ),
  );
  const missing = results.filter((r) => r.err || !r.y.price).map((r) => r.c.code);
  const ecbFx = await ecbFxFallback(missing);
  let usedEcb = false;

  for (const { c, y, err } of results) {
    const m = { key: c.code, label: `${c.code} ${c.label}`, unit: '', decimals: c.decimals ?? 4, neutral: true };
    if (y?.price) {
      Object.assign(m, {
        value: y.price.last,
        previous: y.price.change !== null ? y.price.last - y.price.change : null,
        previousLabel: 'ggü. Vortag',
        asOf: y.price.asOf,
        series: y.series,
      });
    } else if (ecbFx.has(c.code)) {
      const s = ecbFx.get(c.code);
      usedEcb = true;
      Object.assign(m, {
        label: `${m.label} (EZB)`,
        value: s.at(-1).v,
        previous: s.at(-2)?.v ?? null,
        previousLabel: 'ggü. Vortag (EZB-Referenzkurs)',
        asOf: s.at(-1).t,
        series: s,
      });
    } else {
      console.error(`[fx] ${c.code}: ${err ?? 'kein Kurs'}`);
      Object.assign(m, { value: null, label: `${m.label} (nicht verfügbar)` });
    }
    out.measures.push(m);
  }
  if (usedEcb) out.source = 'Yahoo Finance, ersatzweise EZB';
  if (out.measures.every((m) => m.value === null)) out.error = 'keine Wechselkurse erhalten';
  return out;
}

// ---------- Ablauf ----------

async function loadPrevious() {
  if (!previousSrc) return null;
  try {
    const text = /^https?:/.test(previousSrc)
      ? await (await fetch(previousSrc, { signal: AbortSignal.timeout(TIMEOUT) })).text()
      : await readFile(previousSrc, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    console.warn(`Vorheriger Datenstand nicht lesbar (${errMsg(err)}) – fahre ohne fort.`);
    return null;
  }
}

/** Ersetzt ausgefallene Bereiche durch den letzten gültigen Stand und markiert sie als veraltet. */
function withFallback(items, previousItems) {
  const prev = new Map((previousItems ?? []).map((x) => [x.id, x]));
  return items.map((x) => {
    const old = prev.get(x.id);
    if (!x.error || !old || (old.error && !old.stale)) return x;
    return { ...old, stale: true, error: `Abruf fehlgeschlagen (${x.error}) – letzter Stand wird angezeigt` };
  });
}

const [previous, yahooItems, fx, rates, curve] = await Promise.all([
  loadPrevious(),
  Promise.all((config.yahoo?.instruments ?? []).map(fetchYahooInstrument)),
  config.yahoo?.fx ? fetchFx() : null,
  config.ecb?.rates ? fetchEcbRates() : null,
  config.ecb?.curve ? fetchEcbCurve() : null,
]);

const instruments = withFallback([...yahooItems, rates, fx].filter(Boolean), previous?.instruments);
const curves = withFallback([curve].filter(Boolean), previous?.curves);

const all = [...instruments, ...curves];
if (all.length && all.every((x) => x.error && !x.stale)) {
  // Letzten gültigen Datenstand nicht überschreiben, wenn gar nichts geladen werden konnte.
  console.error('Keine Daten geladen – Ausgabedatei bleibt unverändert.');
  process.exit(2);
}

const data = {
  generatedAt: new Date().toISOString(),
  source: 'Yahoo Finance, EZB',
  instruments,
  curves,
};

// Atomar schreiben, damit das Dashboard nie eine halb geschriebene Datei liest.
await mkdir(dirname(outPath), { recursive: true });
await writeFile(`${outPath}.tmp`, JSON.stringify(data));
await rename(`${outPath}.tmp`, outPath);

const ok = all.filter((x) => !x.error).length;
const stale = all.filter((x) => x.stale).length;
console.log(`${ok}/${all.length} Bereiche aktuell, ${stale} veraltet → ${outPath}`);
