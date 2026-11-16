import { ArrowDownRight, ArrowUpRight, CalendarDays, History, Minus, TriangleAlert } from 'lucide';
import { loadCurveAt } from './api';
import { h } from './dom';
import { icon } from './icons';
import { normalizeCurveLines, pruneCharts, renderCurve, renderLine, renderSeasonal } from './charts';
import { buildSeasonal } from './seasonal';
import { fmtDate, fmtDateTime, fmtNumber, fmtSigned, trendClass } from './format';
import { sparkline } from './sparkline';
import type { Curve, CurveLine, Instrument, MarketData, Measure, Point } from './types';

// ---------- Zustand (gewähltes Instrument, Zeitraum) ----------

const RANGES = [
  { key: '1M', label: '1 M', days: 30 },
  { key: '3M', label: '3 M', days: 91 },
  { key: '6M', label: '6 M', days: 183 },
  { key: '1Y', label: '1 J', days: 365 },
  { key: '2Y', label: '2 J', days: 730 },
  { key: '3Y', label: '3 J', days: 1096 },
  { key: '5Y', label: '5 J', days: 1826 },
] as const;
/** Ab hier stammen ältere Punkte aus Wochenkursen. */
const DAILY_DAYS = 183;
type RangeKey = (typeof RANGES)[number]['key'];

const PREF_KEY = 'marktdaten-dashboard:auswahl';

function readPrefs(): { selected?: string; range?: RangeKey; compare?: string | null; view?: string; seasonYears?: number } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writePrefs(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ selected: state.selected, range: state.range, compare: state.compare, view: state.view, seasonYears: state.seasonYears }));
  } catch {
    // Speicher nicht verfügbar – Auswahl gilt dann nur bis zum Neuladen.
  }
}

const prefs = readPrefs();
const state: { selected?: string; range: RangeKey; compare: string | null; view: 'verlauf' | 'saison'; seasonYears: number } = {
  selected: prefs.selected,
  range: RANGES.some((r) => r.key === prefs.range) ? (prefs.range as RangeKey) : '6M',
  compare: prefs.compare === undefined ? 'vor 1 Jahr' : prefs.compare,
  view: prefs.view === 'saison' ? 'saison' : 'verlauf',
  seasonYears: [2, 3, 5].includes(Number(prefs.seasonYears)) ? Number(prefs.seasonYears) : 5,
};

let lastData: MarketData | null = null;
let lastContainer: HTMLElement | null = null;

// ---------- Berechnungen ----------

type Kind = 'asset' | 'rates' | 'fx';

function kindOf(i: Instrument): Kind {
  if (i.kind) return i.kind;
  if (i.price) return 'asset';
  return i.measures.some((m) => m.unit === '%') ? 'rates' : 'fx';
}

const DAY = 86400000;

function shiftDate(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * DAY).toISOString().slice(0, 10);
}

/** Prozentuale Veränderung des letzten Werts gegenüber dem Wert vor `days` Tagen. */
function changePct(series: Point[] | undefined, days: number): number | null {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const target = shiftDate(last.t, days);
  let base: Point | undefined;
  for (const p of series) {
    if (p.t <= target) base = p;
    else break;
  }
  base ??= series[0];
  return base.v ? ((last.v - base.v) / base.v) * 100 : null;
}

function sliceDays(series: Point[] | undefined, days: number): Point[] {
  if (!series?.length) return [];
  const from = shiftDate(series[series.length - 1].t, days);
  return series.filter((p) => p.t >= from);
}

function measure(items: Array<Instrument | Curve>, key: string): Measure | undefined {
  for (const it of items) {
    const m = it.measures?.find((x) => x.key === key);
    if (m) return m;
  }
  return undefined;
}

// ---------- Bausteine ----------

function trendIcon(v: number | null | undefined): SVGElement {
  if (v === null || v === undefined || v === 0) return icon(Minus, 13);
  return v > 0 ? icon(ArrowUpRight, 13) : icon(ArrowDownRight, 13);
}

/** Farbige Prozent-Plakette (grün/rot) – für Kurse. */
function pill(v: number | null | undefined, neutral = false): HTMLElement {
  return h(
    'span',
    { class: `pill ${neutral ? 'flat' : trendClass(v)}` },
    trendIcon(v),
    fmtSigned(v, 2, ' %'),
  );
}

/** Veränderung als Text mit Pfeil; bei Zinsen neutral eingefärbt. */
function delta(v: number | null | undefined, decimals: number, unit: string, neutral: boolean, title?: string): HTMLElement {
  return h(
    'span',
    { class: `delta ${neutral ? 'flat' : trendClass(v)}`, title: title ?? '' },
    trendIcon(v),
    fmtSigned(v, decimals, unit ? ` ${unit}` : ''),
  );
}

function pctText(v: number | null | undefined): HTMLElement {
  return h('span', { class: `num ${trendClass(v)}` }, fmtSigned(v, 1, ' %'));
}

function staleBadge(item: { error?: string; stale?: boolean }): HTMLElement | null {
  if (!item.error) return null;
  return h(
    'span',
    { class: 'badge warn', title: item.error },
    icon(item.stale ? History : TriangleAlert, 12),
    item.stale ? 'veraltet' : 'fehlt',
  );
}

/** Kurzcodes je Bereich (sichtbar nur in der Terminal-Gestaltung). */
const CODES: Record<string, string> = {
  Kursliste: 'WL',
  'Euro-Zinskurve': 'YC',
  'Leitzinsen & Renditen': 'IR',
  Wechselkurse: 'FX',
};

function panel(title: string, sub: string | null, ...children: Array<Node | null>): HTMLElement {
  const code = CODES[title];
  return h(
    'section',
    { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h3', code ? { 'data-code': code } : {}, title), sub ? h('span', { class: 'panel-sub' }, sub) : null),
    ...children,
  );
}

function sectionHead(title: string, note?: string): HTMLElement {
  return h('div', { class: 'section-head' }, h('h2', {}, title), note ? h('span', { class: 'section-note' }, note) : null);
}

// ---------- Überblick ----------

function kpi(label: string, m: Measure | undefined, opts: { unit?: string; deltaUnit?: string; decimals?: number } = {}): HTMLElement {
  const decimals = opts.decimals ?? m?.decimals ?? 2;
  const unit = opts.unit ?? m?.unit ?? '';
  const d = m && m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
  return h(
    'div',
    { class: 'kpi' },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, m ? `${fmtNumber(m.value, decimals)}${unit ? ` ${unit}` : ''}` : '–'),
    h(
      'div',
      { class: 'kpi-foot' },
      d !== null ? delta(d, decimals, opts.deltaUnit ?? m?.deltaUnit ?? unit, true) : null,
      m?.previousLabel ? h('span', { class: 'muted' }, m.previousLabel) : null,
    ),
  );
}

function overview(data: MarketData): HTMLElement | null {
  const items = [...data.instruments, ...(data.curves ?? [])];
  const dfr = measure(items, 'dfr');
  const y10 = measure(items, 'y10Y');
  const spread = measure(items, 'spread10y2y');
  const usd = measure(items, 'USD');
  if (!dfr && !y10 && !spread && !usd) return null;
  return h(
    'div',
    { class: 'kpis' },
    kpi('EZB-Einlagezins', dfr),
    kpi('Rendite 10 J. (AAA)', y10),
    kpi('Spread AAA 10 J. – 2 J.', spread),
    kpi('EUR / USD', usd, { decimals: 4 }),
  );
}

// ---------- Märkte: Kursliste + Chart ----------

function watchlist(assets: Instrument[], selected: Instrument | undefined): HTMLElement {
  const body = h('tbody', {});
  let group: string | undefined;
  for (const a of assets) {
    if (a.group && a.group !== group) {
      group = a.group;
      body.append(h('tr', { class: 'group-row' }, h('th', { colspan: '6', scope: 'colgroup' }, group)));
    }
    const p = a.price;
    const isSel = a.id === selected?.id;
    const row = h(
      'tr',
      { class: `row${isSel ? ' selected' : ''}`, tabindex: '0', 'aria-selected': String(isSel), title: 'Im Chart anzeigen' },
      h(
        'td',
        { class: 'name-cell', title: [a.name, a.ticker, a.note].filter(Boolean).join(' · ') },
        h('div', { class: 'name' }, a.name, staleBadge(a)),
        h('div', { class: 'meta' }, [a.ticker, a.note].filter(Boolean).join(' · ')),
      ),
      h(
        'td',
        { class: 'num' },
        h('div', {}, fmtNumber(p?.last)),
        h('div', { class: 'meta' }, a.currency ?? ''),
      ),
      h('td', { class: 'num' }, pill(p?.changePct)),
      h('td', { class: 'num hide-sm' }, pctText(changePct(a.series, 30))),
      h('td', { class: 'num hide-sm' }, pctText(changePct(a.series, 183))),
      h('td', { class: 'spark-cell hide-sm' }, sparkline(a.series, `Verlauf ${a.name}`)),
    );
    const select = () => {
      state.selected = a.id;
      writePrefs();
      rerender();
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    body.append(row);
  }
  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Name'),
        h('th', { scope: 'col', class: 'num' }, 'Kurs'),
        h('th', { scope: 'col', class: 'num' }, 'Tag'),
        h('th', { scope: 'col', class: 'num hide-sm' }, '1 M'),
        h('th', { scope: 'col', class: 'num hide-sm' }, '6 M'),
        h('th', { scope: 'col', class: 'spark-cell hide-sm' }, 'Verlauf'),
      ),
    ),
    body,
  );
  return panel('Kursliste', 'Zeile anklicken für den Chart', h('div', { class: 'table-wrap' }, table));
}

/** Wochenkurse (vor Beginn der Tageskurse) + Tageskurse als ein durchgehender Verlauf. */
function fullSeries(a: Instrument): Point[] {
  const daily = a.series ?? [];
  const first = daily[0]?.t;
  const older = (a.longSeries ?? []).filter((p) => !first || p.t < first);
  return [...older, ...daily];
}

/** Segment-Umschalter (Knöpfe in einer Gruppe); disabled: Begründung als Tooltip. */
function segmented<T extends string | number>(
  label: string,
  options: Array<{ value: T; text: string; disabled?: string }>,
  active: T,
  onChoose: (v: T) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': label },
    ...options.map((o) => {
      const isActive = o.value === active;
      const b = h('button', { type: 'button', class: `tab${isActive ? ' active' : ''}`, 'aria-pressed': String(isActive) }, o.text);
      if (o.disabled) {
        b.setAttribute('disabled', '');
        b.title = o.disabled;
      }
      b.addEventListener('click', () => onChoose(o.value));
      return b;
    }),
  );
}

function chartPanel(a: Instrument | undefined): HTMLElement {
  if (!a) return panel('Chart', null, h('div', { class: 'empty' }, 'Keine Kursdaten vorhanden.'));
  const all = fullSeries(a);
  const lastT = all.at(-1)?.t;
  const firstT = all[0]?.t;
  // Ein Zeitraum ist verfügbar, wenn der Verlauf (mit 14 Tagen Spielraum) weit genug zurückreicht.
  const available = (r: (typeof RANGES)[number]) =>
    r.days <= DAILY_DAYS || (!!firstT && !!lastT && firstT <= shiftDate(lastT, r.days - 14));
  const wanted = RANGES.find((r) => r.key === state.range) ?? RANGES[2];
  const range = available(wanted) ? wanted : [...RANGES].reverse().find(available) ?? RANGES[2];
  // Bis 6 Monate nur Tageskurse (genauer, gleiche Basis wie die Kursliste), darüber mit Wochenkursen.
  const series = sliceDays(range.days <= DAILY_DAYS ? (a.series ?? []) : all, range.days);
  const values = series.map((p) => p.v);
  const p = a.price;

  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Zeitraum' },
    ...RANGES.map((r) => {
      const ok = available(r);
      const active = r.key === range.key;
      const b = h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `tab${active ? ' active' : ''}`,
          'aria-selected': String(active),
          title: ok ? `Verlauf ${r.label.replace('M', 'Monat(e)').replace('J', 'Jahr(e)')}` : `Für ${a.name} liegen Kurse erst ab ${fmtDate(firstT ?? '', true)} vor`,
        },
        r.label,
      );
      if (!ok) b.setAttribute('disabled', '');
      b.addEventListener('click', () => {
        state.range = r.key;
        writePrefs();
        rerender();
      });
      return b;
    }),
  );
  const rangeNote =
    wanted.key !== range.key
      ? `${wanted.label} nicht verfügbar – Kurse erst ab ${fmtDate(firstT ?? '', true)}`
      : range.days > DAILY_DAYS
        ? 'Ältere Werte als Wochenschlusskurse'
        : null;

  const stat = (label: string, value: Node | string) =>
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));

  const viewSwitch = segmented(
    'Ansicht',
    [
      { value: 'verlauf' as const, text: 'Verlauf' },
      { value: 'saison' as const, text: 'Saisonal' },
    ],
    state.view,
    (v) => {
      state.view = v;
      writePrefs();
      rerender();
    },
  );

  const canvas = h('canvas', { 'aria-label': `${state.view === 'saison' ? 'Saisonale Ansicht' : 'Kursverlauf'} ${a.name}`, role: 'img' });
  let tools: Array<Node | null>;
  let statsRow: HTMLElement;

  if (state.view === 'saison') {
    // Alle Jahre in gleicher Auflösung (Wochenschlusskurse), dazu der neueste Tageskurs als aktueller Stand.
    const weekly = a.longSeries ?? [];
    const lastDaily = a.series?.at(-1);
    const seasonSource =
      weekly.length && lastDaily
        ? [...weekly.filter((pt) => pt.t < lastDaily.t), lastDaily]
        : all;
    const probe = buildSeasonal(seasonSource, 99);
    const count = Math.min(state.seasonYears, Math.max(probe.available, 1));
    const seasonal = buildSeasonal(seasonSource, count);
    const yearSwitch = segmented(
      'Anzahl Jahre',
      [2, 3, 5].map((n) => ({
        value: n,
        text: `${n} J`,
        disabled: probe.available < n ? `Für ${a.name} gibt es nur ${probe.available} Jahr(e) mit Kursen ab Jahresbeginn` : undefined,
      })),
      count,
      (n) => {
        state.seasonYears = n;
        writePrefs();
        rerender();
      },
    );
    const note =
      probe.available < state.seasonYears
        ? `${state.seasonYears} Jahre nicht verfügbar – ${probe.available} Jahr(e) mit Kursen ab Jahresbeginn`
        : 'Veränderung seit Jahresbeginn in % · Wochenschlusskurse';
    tools = [viewSwitch, yearSwitch, h('span', { class: 'muted' }, note)];
    if (seasonal.years.length) requestAnimationFrame(() => renderSeasonal('main-chart', canvas, seasonal));
    statsRow = h(
      'div',
      { class: 'stats stats-years' },
      ...[...seasonal.years].reverse().map((y) => stat(y.current ? `${y.year} bisher` : String(y.year), pctText(y.total))),
      seasonal.average ? stat(seasonal.average.label, pctText(seasonal.average.points.at(-1)?.y)) : null,
    );
  } else {
    tools = [viewSwitch, tabs, rangeNote ? h('span', { class: 'muted' }, rangeNote) : null];
    requestAnimationFrame(() => renderLine('main-chart', canvas, series));
    statsRow = h(
      'div',
      { class: 'stats' },
      stat(`Veränderung ${range.label}`, pctText(changePct(series, range.days + 1))),
      stat(`Hoch ${range.label}`, fmtNumber(values.length ? Math.max(...values) : null)),
      stat(`Tief ${range.label}`, fmtNumber(values.length ? Math.min(...values) : null)),
      stat('Stand', p?.asOf ? fmtDateTime(p.asOf) : '–'),
    );
  }

  return h(
    'section',
    { class: 'panel chart-panel' },
    h(
      'header',
      { class: 'chart-head' },
      h(
        'div',
        { class: 'chart-title' },
        h('h3', { 'data-code': state.view === 'saison' ? 'SEAS' : 'GP' }, a.name, staleBadge(a)),
        h('div', { class: 'meta' }, [a.ticker, a.note, a.currency].filter(Boolean).join(' · ')),
      ),
      h(
        'div',
        { class: 'chart-price' },
        h('div', { class: 'price-big' }, fmtNumber(p?.last), a.currency ? h('span', { class: 'cur' }, a.currency) : null),
        h('div', { class: 'price-change' }, delta(p?.change, 2, '', false), pill(p?.changePct)),
      ),
    ),
    h('div', { class: 'panel-tools chart-tools' }, ...tools),
    h('div', { class: 'chart-box' }, canvas),
    statsRow,
  );
}

// ---------- Zinsen ----------

function rateRow(m: Measure): HTMLElement {
  const d = m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
  const decimals = m.decimals ?? 2;
  return h(
    'li',
    { class: 'rate' },
    h('div', { class: 'rate-label' }, m.label, h('div', { class: 'meta' }, m.asOf ? `Stand ${fmtDate(m.asOf, true)}` : '')),
    h('div', { class: 'num rate-value' }, `${fmtNumber(m.value, decimals)} ${m.unit ?? ''}`.trim()),
    h('div', { class: 'num' }, d !== null ? delta(d, decimals, m.deltaUnit ?? m.unit ?? '', true, m.previousLabel) : null),
    h('div', { class: 'spark-cell' }, sparkline(m.series, `Verlauf ${m.label}`)),
  );
}

function ratesPanel(rates: Instrument | undefined, curve: Curve | undefined): HTMLElement {
  const groups: Array<[string, Measure[], { error?: string; stale?: boolean } | undefined]> = [
    ['EZB', rates?.measures ?? [], rates],
    ['Geldmarkt & Anleihen', curve?.measures ?? [], curve],
  ];
  const list = h('div', { class: 'rates' });
  for (const [title, ms, item] of groups) {
    if (!ms.length && !item?.error) continue;
    list.append(
      h('div', { class: 'list-head' }, title, item ? staleBadge(item) : null),
      h('ul', { class: 'rate-list' }, ...ms.map(rateRow)),
    );
  }
  const first = curve?.measures?.[0]?.previousLabel ?? rates?.measures?.[0]?.previousLabel;
  return panel('Leitzinsen & Renditen', first ? `Veränderung ${first}` : null, list);
}

// Zinskurven zu frei gewählten Stichtagen (vom Worker geladen), je Datum zwischengespeichert.
const curveAtCache = new Map<string, { loading: boolean; lines: CurveLine[]; error?: string }>();
let curveSource: { url: string; minDate: string } | null = null;

/** Aktiviert die freie Datumsauswahl (nur wenn der Cloudflare Worker /api/curve anbietet). */
export function setCurveSource(url: string | undefined, minDate: string | undefined): void {
  curveSource = url ? { url, minDate: minDate ?? '2004-09-06' } : null;
}

const CUSTOM = 'datum:';

function requestCurveAt(date: string): void {
  if (!curveSource || curveAtCache.get(date)?.loading || curveAtCache.get(date)?.lines.length) return;
  curveAtCache.set(date, { loading: true, lines: [] });
  loadCurveAt(curveSource.url, date)
    .then((r) =>
      curveAtCache.set(date, {
        loading: false,
        lines: r.lines,
        error: r.lines.length ? (r.errors?.length ? 'Teilweise nicht verfügbar.' : undefined) : 'Für diesen Tag liegen keine Daten vor.',
      }),
    )
    .catch((err: unknown) => curveAtCache.set(date, { loading: false, lines: [], error: err instanceof Error ? err.message : String(err) }))
    .finally(rerender);
}

function curvePanel(curve: Curve | undefined): HTMLElement {
  if (!curve?.lines.length) return panel('Euro-Zinskurve', null, h('div', { class: 'empty' }, curve?.error ?? 'Keine Daten.'));
  const lines = normalizeCurveLines(curve);
  const presets = [...new Set(lines.map((l) => l.when).filter((w) => w !== 'Aktuell'))];
  const customDate = state.compare?.startsWith(CUSTOM) && curveSource ? state.compare.slice(CUSTOM.length) : null;
  const preset = !customDate && state.compare && presets.includes(state.compare) ? state.compare : null;

  // Vergleichslinien: Voreinstellung aus den gespeicherten Daten oder frei gewählter Stichtag
  let compareLines: CurveLine[] = preset ? lines.filter((l) => l.when === preset) : [];
  let customInfo: HTMLElement | null = null;
  if (customDate) {
    requestCurveAt(customDate);
    const entry = curveAtCache.get(customDate);
    compareLines = entry?.lines ?? [];
    if (entry?.loading) customInfo = h('span', { class: 'muted' }, 'Lade …');
    else if (entry?.error) customInfo = h('span', { class: 'field-error' }, icon(TriangleAlert, 12), entry.error);
    else if (compareLines.length) {
      const asOf = compareLines.map((l) => l.asOf).sort().at(-1);
      if (asOf && asOf !== customDate) customInfo = h('span', { class: 'muted' }, `letzter Handelstag: ${fmtDate(asOf, true)}`);
    }
  }

  const choose = (value: string | null) => {
    state.compare = value;
    writePrefs();
    rerender();
  };
  const tabs = h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': 'Vergleich mit' },
    ...[null, ...presets].map((w) => {
      const active = !customDate && w === preset;
      const b = h('button', { type: 'button', class: `tab${active ? ' active' : ''}`, 'aria-pressed': String(active) }, w ?? 'Keiner');
      b.addEventListener('click', () => choose(w));
      return b;
    }),
  );

  let dateField: HTMLElement | null = null;
  if (curveSource) {
    const today = new Date().toISOString().slice(0, 10);
    const input = h('input', {
      type: 'date',
      id: 'curve-date',
      class: `date-input${customDate ? ' active' : ''}`,
      min: curveSource.minDate,
      max: today,
      value: customDate ?? '',
      'aria-label': 'Stichtag für den Vergleich',
    });
    input.addEventListener('change', () => {
      const v = input.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= curveSource!.minDate && v <= today) choose(CUSTOM + v);
      else if (!v) choose(null);
    });
    dateField = h('label', { class: 'date-field', for: 'curve-date' }, icon(CalendarDays, 14), h('span', { class: 'sr-only' }, 'Stichtag'), input);
  }

  const canvas = h('canvas', { 'aria-label': `Zinskurve ${curve.name}`, role: 'img' });
  requestAnimationFrame(() => renderCurve('curve-chart', canvas, curve, compareLines));
  const asOf = lines.filter((l) => l.when === 'Aktuell').map((l) => l.asOf).sort().at(-1);
  const legacy = !curve.lines.some((l) => l.when);
  return panel(
    'Euro-Zinskurve',
    `${legacy ? 'AAA-Staatsanleihen' : 'EURIBOR bis 12 M, ab 2 J. Pfandbriefe und AAA-Staatsanleihen'}${asOf ? ` · Stand ${fmtDate(asOf, true)}` : ''}`,
    staleBadge(curve),
    h(
      'div',
      { class: 'panel-tools' },
      h('span', { class: 'muted' }, 'Vergleich mit'),
      presets.length ? tabs : null,
      dateField,
      customInfo,
    ),
    h('div', { class: 'chart-box tall' }, canvas),
  );
}

// ---------- Währungen ----------

function fxPanel(fx: Instrument | undefined): HTMLElement {
  if (!fx) return panel('Wechselkurse', null, h('div', { class: 'empty' }, 'Keine Daten.'));
  const rows = fx.measures.map((m) => {
    const decimals = m.decimals ?? 4;
    const d = m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
    const dPct = d !== null && m.previous ? (d / m.previous) * 100 : null;
    const [code, ...rest] = m.label.split(' ');
    return h(
      'tr',
      { class: 'row' },
      h('td', { class: 'name-cell' }, h('div', { class: 'name' }, code), h('div', { class: 'meta' }, rest.join(' '))),
      h('td', { class: 'num' }, fmtNumber(m.value, decimals)),
      h('td', { class: 'num hide-sm' }, delta(d, decimals, '', true)),
      h('td', { class: 'num' }, h('span', { class: 'num flat' }, fmtSigned(dPct, 2, ' %'))),
      h('td', { class: 'num hide-sm' }, h('span', { class: 'num flat' }, fmtSigned(changePct(m.series, 30), 1, ' %'))),
      h('td', { class: 'num hide-sm' }, h('span', { class: 'num flat' }, fmtSigned(changePct(m.series, 183), 1, ' %'))),
      h('td', { class: 'spark-cell' }, sparkline(m.series, `Verlauf ${m.label}`)),
    );
  });
  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Währung'),
        h('th', { scope: 'col', class: 'num' }, 'Kurs'),
        h('th', { scope: 'col', class: 'num hide-sm' }, 'Tag'),
        h('th', { scope: 'col', class: 'num' }, 'Tag %'),
        h('th', { scope: 'col', class: 'num hide-sm' }, '1 M'),
        h('th', { scope: 'col', class: 'num hide-sm' }, '6 M'),
        h('th', { scope: 'col', class: 'spark-cell' }, 'Verlauf 6 M'),
      ),
    ),
    h('tbody', {}, ...rows),
  );
  return panel('Wechselkurse', `${fx.note ?? '1 EUR = …'}`, staleBadge(fx), h('div', { class: 'table-wrap' }, table));
}

// ---------- Seite ----------

function problems(data: MarketData): HTMLElement | null {
  const all = [...data.instruments, ...(data.curves ?? [])];
  const stale = all.filter((x) => x.stale).map((x) => x.name);
  const missing = all.filter((x) => x.error && !x.stale).map((x) => x.name);
  const parts: string[] = [];
  if (data.sample) parts.push('Beispieldaten – keine echten Marktdaten.');
  if (stale.length) parts.push(`Letzter Abruf fehlgeschlagen, älterer Stand: ${stale.join(', ')}.`);
  if (missing.length) parts.push(`Nicht verfügbar: ${missing.join(', ')}.`);
  if (!parts.length) return null;
  return h('div', { class: 'notice warn' }, icon(TriangleAlert), parts.join(' '));
}

function rerender(): void {
  if (lastContainer && lastData) renderData(lastContainer, lastData);
}

/** Neu zeichnen, z. B. nach Wechsel zwischen hellem und dunklem Erscheinungsbild. */
export const rerenderCharts = rerender;

export function renderData(container: HTMLElement, data: MarketData): void {
  lastData = data;
  lastContainer = container;
  const assets = data.instruments.filter((i) => kindOf(i) === 'asset');
  const rates = data.instruments.find((i) => kindOf(i) === 'rates');
  const fx = data.instruments.find((i) => kindOf(i) === 'fx');
  const curve = data.curves?.[0];
  const selected = assets.find((a) => a.id === state.selected) ?? assets[0];

  container.replaceChildren(
    ...[
      problems(data),
      overview(data),
      sectionHead('Märkte', `ETFs an Xetra in EUR, Bitcoin in EUR · Quelle: ${assets[0]?.source ?? 'Yahoo Finance'}`),
      h('div', { class: 'grid-2 markets' }, watchlist(assets, selected), chartPanel(selected)),
      sectionHead('Zinsen', `Quelle: ${[...new Set([rates?.source, ...(curve?.source ?? '').split(', ')].filter(Boolean))].join(', ') || 'EZB'}`),
      h('div', { class: 'grid-2 rates-grid' }, curvePanel(curve), ratesPanel(rates, curve)),
      sectionHead('Währungen', `Quelle: ${fx?.source ?? 'Yahoo Finance'}`),
      fxPanel(fx),
    ].filter((x): x is HTMLElement => x !== null),
  );
  requestAnimationFrame(pruneCharts);
}
