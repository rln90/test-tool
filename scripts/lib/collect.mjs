/**
 * Sammelt alle Dashboard-Daten (Format: src/types.ts → MarketData).
 * Läuft unverändert in Node (scripts/fetch-data.mjs) und im Cloudflare Worker (worker/index.js):
 * nutzt nur fetch, keine Datei- oder Node-APIs.
 *
 *  - Kurse und Wechselkurse: Yahoo Finance (inoffizielle Chart-Schnittstelle, ohne Key)
 *  - Euro-Leitzinsen, €STR, Zinskurve: EZB Data Portal (offiziell, ohne Key)
 *  - Wechselkurse ersatzweise: EZB-Referenzkurse, falls Yahoo für eine Währung ausfällt
 */

const TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; marktdaten-dashboard/1.0)';

/** Wird bei jedem Aufruf von collectData gesetzt. */
let config;
let historyDays = 180;

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

const deDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

// ---------- Yahoo Finance ----------

/**
 * Eigene Warteschlange je Abruf: Anfragen laufen nacheinander mit kurzer Pause, um Yahoo nicht zu überlasten.
 * Bewusst nicht global – im Cloudflare Worker darf ein Request nicht auf Promises eines anderen Requests warten.
 */
function createYahooClient() {
  let queue = Promise.resolve();
  return (symbol) => {
    const p = queue.then(() => yahooRequest(symbol));
    queue = p.catch(() => {}).then(() => sleep(config.yahoo.pauseMs ?? 400));
    return p;
  };
}

async function yahooRequest(symbol) {
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
  // Kryptowährungen handeln auch am Wochenende und bleiben unverändert.
  const tradesWeekends = meta.instrumentType === 'CRYPTOCURRENCY';
  const weekday = lastDate ? new Date(`${lastDate}T12:00:00Z`).getUTCDay() : 1;
  if (lastDate && !tradesWeekends && (weekday === 0 || weekday === 6)) {
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

async function fetchYahooInstrument(inst, yahoo) {
  const out = { id: inst.id, kind: 'asset', group: inst.group, name: inst.name, note: inst.note, ticker: inst.symbol, source: 'Yahoo Finance', measures: [] };
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

// ---------- EZB und Bundesbank (SDMX-JSON) ----------

/**
 * Lädt eine oder mehrere SDMX-Reihen → Map: Wert der unterscheidenden Dimension → [{t, v}] aufsteigend.
 * dimIndex: Position dieser Dimension im Reihenschlüssel; ohne Angabe die einzige Dimension mit mehreren Werten
 * (sonst die letzte). Leere Zeiträume (HTTP 404) ergeben eine leere Map.
 */
async function sdmx(name, url, dimIndex) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    // Die Bundesbank antwortet bei vielen gleichzeitigen Anfragen gelegentlich mit 400/429 – kurz warten und wiederholen.
    if (attempt < 3 && (res.status === 400 || res.status === 429 || res.status >= 500)) {
      await sleep(800 * attempt);
      continue;
    }
    break;
  }
  if (res.status === 404) return new Map();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return new Map(); // keine Daten im Zeitraum (z. B. vor Beginn der Reihe)
  const raw = JSON.parse(text);
  const json = raw.data ?? raw; // Bundesbank verpackt die Antwort in „data“
  const dims = json.structure.dimensions;
  const times = dims.observation[0].values.map((v) => v.id);
  let pos = dimIndex;
  if (pos === undefined) {
    const varying = dims.series.map((d, i) => (d.values.length > 1 ? i : -1)).filter((i) => i >= 0);
    pos = varying.length === 1 ? varying[0] : dims.series.length - 1;
  } else if (pos < 0) {
    pos = dims.series.length + pos;
  }
  const dim = dims.series[pos].values.map((v) => v.id);
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

/** EZB Data Portal. params: z. B. { startPeriod: '2026-01-01' } oder { lastNObservations: 1 }. */
function ecb(flow, key, params, dimIndex = -1) {
  const query = new URLSearchParams({ format: 'jsondata', detail: 'dataonly', ...params });
  return sdmx(`EZB ${flow}`, `${config.ecb.baseUrl}/${flow}/${key}?${query}`, dimIndex);
}

/** Begrenzt gleichzeitige Anfragen (je Abruf neu angelegt, siehe Hinweis bei createYahooClient). */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { task, resolve, reject } = waiting.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

/** Bundesbank-Statistik (Zeitreihen-Datenbank); limit begrenzt gleichzeitige Anfragen. */
function bundesbank(flow, key, params, limit) {
  const query = new URLSearchParams({ detail: 'dataonly', ...params });
  const run = () => sdmx(`Bundesbank ${flow}`, `${config.bundesbank.baseUrl}/${flow}/${key}?${query}`);
  return limit ? limit(run) : run();
}

async function fetchEcbRates() {
  const cfg = config.ecb.rates;
  const out = { id: cfg.id, kind: 'rates', name: cfg.name, source: 'EZB', measures: [] };
  const start = daysAgo(historyDays);
  const results = await Promise.allSettled(
    cfg.series.map(async (s) => {
      const series = [...(await ecb(s.flow, s.series, { startPeriod: start })).values()][0] ?? [];
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
  if (m.endsWith('W')) return n / 52;
  return m.endsWith('M') ? n / 12 : n;
}

/** Lädt einen Abschnitt der Zinskurve (z. B. EURIBOR oder Pfandbriefe) → Map: Laufzeit („3M“, „10Y“) → Reihe. */
async function curveSegment(seg, maturities, params, limit) {
  const codes = maturities.map((m) => seg.maturities[m]);
  const key = seg.key.replace('{m}', codes.join('+'));
  const map = seg.source === 'bundesbank' ? await bundesbank(seg.flow, key, params, limit) : await ecb(seg.flow, key, params, undefined);
  // Bei nur einer angefragten Laufzeit gibt es keine unterscheidende Dimension – direkt zuordnen.
  if (maturities.length === 1) return new Map(map.size ? [[maturities[0], [...map.values()][0]]] : []);
  const byCode = new Map(Object.entries(seg.maturities).map(([m, c]) => [c, m]));
  return new Map([...map].map(([code, series]) => [byCode.get(code) ?? code, series]));
}

/** Punkte eines Abschnitts zum Stichtag (jeweils letzter Wert bis einschließlich date). */
function curvePointsAt(seg, map, date) {
  const pts = [];
  let asOf = '';
  for (const m of Object.keys(seg.maturities)) {
    const p = valueAtOrBefore(map.get(m) ?? [], date);
    if (p) {
      pts.push({ label: m, years: maturityYears(m), v: p.v });
      if (p.t > asOf) asOf = p.t;
    }
  }
  return { pts, asOf };
}

/** Je langem Abschnitt eine Linie: EURIBOR-Punkte + Punkte des Abschnitts. maps[0] = EURIBOR. */
function buildCurveLines(cfg, maps, date, when) {
  const short = curvePointsAt(cfg.short, maps[0], date);
  const lines = [];
  cfg.long.forEach((seg, i) => {
    const long = curvePointsAt(seg, maps[i + 1], date);
    if (!long.pts.length) return;
    const asOf = [short.asOf, long.asOf].filter(Boolean).sort().at(-1);
    lines.push({ label: seg.label, curve: seg.id, when, asOf, points: [...short.pts, ...long.pts] });
  });
  return lines;
}

/**
 * Zinskurve zu einem frei gewählten Stichtag (Format JJJJ-MM-TT). Liefert pro Kurve den letzten
 * verfügbaren Stand bis einschließlich dieses Tages (Wochenenden/Feiertage → Vortag).
 */
export async function fetchCurveAt(cfg, date) {
  config = cfg;
  historyDays = cfg.historyDays ?? 180;
  const c = config.curve;
  const segments = [c.short, ...c.long];
  const limit = createLimiter(2);
  const errors = [];
  const from = isoDate(new Date(new Date(date).getTime() - 10 * DAY));
  const maps = await Promise.all(
    segments.map((seg) =>
      curveSegment(seg, Object.keys(seg.maturities), { startPeriod: from, endPeriod: date }, limit).catch((err) => {
        errors.push(`${seg.label}: ${errMsg(err)}`);
        return new Map();
      }),
    ),
  );
  const lines = buildCurveLines(c, maps, date, `am ${deDate(date)}`);
  return { date, lines, ...(errors.length ? { errors } : {}) };
}

/**
 * Euro-Zinskurve: kurzes Ende aus EURIBOR, ab 2 Jahren je eine Linie pro langem Abschnitt
 * (Pfandbriefe der Bundesbank, AAA-Staatsanleihen der EZB) – aktuell und zu Vergleichsterminen.
 */
async function fetchCurve() {
  const cfg = config.curve;
  const out = { id: cfg.id, name: cfg.name, unit: '%', source: cfg.sourceLabel, lines: [], measures: [] };
  const segments = [cfg.short, ...cfg.long];
  const limit = createLimiter(2);
  const errors = [];
  const safe = (seg, p) =>
    p.catch((err) => {
      errors.push(`${seg.label}: ${errMsg(err)}`);
      return new Map();
    });

  try {
    // 1) aktueller Stand je Abschnitt
    const latest = await Promise.all(
      segments.map((seg) => safe(seg, curveSegment(seg, Object.keys(seg.maturities), { lastNObservations: 1 }, limit))),
    );
    const lastDate = (m) => [...m.values()].map((s) => s.at(-1)?.t).filter(Boolean).sort().at(-1);
    const refDate = lastDate(latest[0]) ?? latest.map(lastDate).filter(Boolean).sort().at(-1);
    if (!refDate) throw new Error(errors.join(' · ') || 'keine Zinskurvendaten erhalten');

    // 2) Vergleichsstände (kleines Fenster vor dem Stichtag) und Verlauf der hervorgehobenen Laufzeiten
    const compares = (cfg.compareDaysAgo ?? []).map((d) => ({ d, target: isoDate(new Date(new Date(refDate).getTime() - d * DAY)) }));
    const historyBySeg = new Map();
    for (const m of [...(cfg.measures ?? []), ...(cfg.spread ? [{ segment: cfg.spread.segment, maturity: cfg.spread.long }, { segment: cfg.spread.segment, maturity: cfg.spread.short }] : [])]) {
      const list = historyBySeg.get(m.segment) ?? new Set();
      list.add(m.maturity);
      historyBySeg.set(m.segment, list);
    }
    const segById = new Map(segments.map((seg) => [seg.id, seg]));
    const [compareMaps, histories] = await Promise.all([
      Promise.all(
        compares.map(({ target }) =>
          Promise.all(
            segments.map((seg) =>
              safe(
                seg,
                curveSegment(seg, Object.keys(seg.maturities), {
                  startPeriod: isoDate(new Date(new Date(target).getTime() - 10 * DAY)),
                  endPeriod: target,
                }, limit),
              ),
            ),
          ),
        ),
      ),
      Promise.all(
        [...historyBySeg].map(async ([segId, mats]) => {
          const seg = segById.get(segId);
          return [segId, seg ? await safe(seg, curveSegment(seg, [...mats], { startPeriod: daysAgo(historyDays) }, limit)) : new Map()];
        }),
      ),
    ]);
    const history = new Map(histories);

    // 3) Linien: EURIBOR-Punkte + Punkte des jeweiligen langen Abschnitts
    out.lines.push(...buildCurveLines(cfg, latest, '9999-12-31', 'Aktuell'));
    compares.forEach(({ d, target }, i) => {
      const when = d >= 365 ? `vor ${Math.round(d / 365)} Jahr${d >= 730 ? 'en' : ''}` : `vor ${d} Tagen`;
      out.lines.push(...buildCurveLines(cfg, compareMaps[i], target, when));
    });

    // 4) Kennzahlen mit Verlauf
    const series = (segId, m) => (history.get(segId)?.get(m) ?? []);
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
    for (const m of cfg.measures ?? []) {
      const s = series(m.segment, m.maturity);
      if (s.length) out.measures.push(rateMeasure(m.key, m.label, s, '%', { deltaUnit: '%-Pkt.', decimals: m.decimals ?? 2 }));
    }
    if (cfg.spread) {
      const sp = cfg.spread;
      const shortMap = new Map(series(sp.segment, sp.short).map((p) => [p.t, p.v]));
      const spread = series(sp.segment, sp.long)
        .filter((p) => shortMap.has(p.t))
        .map((p) => ({ t: p.t, v: p.v - shortMap.get(p.t) }));
      if (spread.length) out.measures.push(rateMeasure(sp.key, sp.label, spread, '%-Pkt.'));
    }
    if (errors.length) {
      console.error(`[${cfg.id}] ${errors.join(' · ')}`);
      if (!out.lines.length) out.error = errors.join(' · ');
    }
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
    const map = await ecb('EXR', `D.${codes.join('+')}.EUR.SP00.A`, { startPeriod: daysAgo(historyDays) }, 1);
    for (const [code, s] of map) if (!s.length || s.at(-1).t < daysAgo(10)) map.delete(code);
    return map;
  } catch (err) {
    console.error(`[fx] EZB-Ersatz fehlgeschlagen: ${errMsg(err)}`);
    return new Map();
  }
}

async function fetchFx(yahoo) {
  const cfg = config.yahoo.fx;
  const out = { id: cfg.id, kind: 'fx', name: cfg.name, note: cfg.note, source: 'Yahoo Finance', measures: [] };
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

/** Ersetzt ausgefallene Bereiche durch den letzten gültigen Stand und markiert sie als veraltet. */
function withFallback(items, previousItems) {
  const prev = new Map((previousItems ?? []).map((x) => [x.id, x]));
  return items.map((x) => {
    const old = prev.get(x.id);
    if (!x.error || !old || (old.error && !old.stale)) return x;
    return { ...old, stale: true, error: `Abruf fehlgeschlagen (${x.error}) – letzter Stand wird angezeigt` };
  });
}


export class NoDataError extends Error {}

/** Teilbereiche, die einzeln abgerufen werden können (z. B. je ein Cloudflare-Cron-Lauf). */
export const PARTS = ['kurse', 'fx', 'ezb', 'kurve'];

/**
 * Holt die gewünschten Teilbereiche (Standard: alle). Ausgefallene Bereiche werden durch den
 * Stand aus `previous` ersetzt und als veraltet markiert. Wirft NoDataError, wenn gar nichts
 * geladen werden konnte.
 */
export async function collectData(cfg, previous = null, parts = PARTS) {
  config = cfg;
  historyDays = cfg.historyDays ?? 180;
  const want = (p) => parts.includes(p);
  const yahoo = createYahooClient();

  // Instrumente gehören zum Teilbereich aus „part“ (Standard: „kurse“).
  const instrumentsFor = (part) => (config.yahoo?.instruments ?? []).filter((inst) => (inst.part ?? 'kurse') === part);
  const wantedInstruments = PARTS.filter(want).flatMap(instrumentsFor);

  const [yahooItems, fx, rates, curve] = await Promise.all([
    Promise.all(wantedInstruments.map((inst) => fetchYahooInstrument(inst, yahoo))),
    want('fx') && config.yahoo?.fx ? fetchFx(yahoo) : null,
    want('ezb') && config.ecb?.rates ? fetchEcbRates() : null,
    want('kurve') && config.curve ? fetchCurve() : null,
  ]);

  const instruments = withFallback([...yahooItems, rates, fx].filter(Boolean), previous?.instruments);
  const curves = withFallback([curve].filter(Boolean), previous?.curves);

  const all = [...instruments, ...curves];
  if (all.length && all.every((x) => x.error && !x.stale)) {
    throw new NoDataError('Keine Daten geladen');
  }
  return {
    generatedAt: new Date().toISOString(),
    source: 'Yahoo Finance, EZB, Bundesbank',
    instruments,
    curves,
  };
}

/** Führt getrennt abgerufene Teilbereiche in der Anzeigereihenfolge zusammen. */
export function mergeParts(byPart) {
  const got = PARTS.map((p) => byPart[p]).filter(Boolean);
  if (!got.length) return null;
  const pick = (p) => byPart[p]?.instruments ?? [];
  return {
    generatedAt: got.map((d) => d.generatedAt).sort().at(-1),
    source: 'Yahoo Finance, EZB, Bundesbank',
    instruments: [...pick('kurse'), ...pick('ezb'), ...pick('fx')],
    // Ältere Datenstände hatten die Zinskurve im Teilbereich „ezb“.
    curves: byPart.kurve?.curves ?? byPart.ezb?.curves ?? [],
  };
}

/** Kurzfassung für Protokolle: „4/5 Bereiche aktuell, 1 veraltet“. */
export function summarize(data) {
  const all = [...data.instruments, ...(data.curves ?? [])];
  const ok = all.filter((x) => !x.error).length;
  const stale = all.filter((x) => x.stale).length;
  return `${ok}/${all.length} Bereiche aktuell, ${stale} veraltet`;
}
