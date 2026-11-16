import type { Point } from './types';

/** Ein Kalenderjahr der saisonalen Ansicht: x = Tag im Jahr (0 = 1. Januar), y = Veränderung seit Jahresbeginn in %. */
export interface SeasonYear {
  year: number;
  current: boolean;
  points: { x: number; y: number }[];
  /** Veränderung im ganzen Jahr bzw. seit Jahresbeginn (laufendes Jahr). */
  total: number | null;
}

export interface Seasonal {
  years: SeasonYear[];
  /** Durchschnitt der abgeschlossenen Jahre (mindestens zwei), sonst null. */
  average: { label: string; points: { x: number; y: number }[] } | null;
  /** Wie viele Jahre mit vollständigem Jahresbeginn insgesamt verfügbar sind. */
  available: number;
}

const DAY = 86400000;

function dayOfYear(t: string): number {
  const d = Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));
  return Math.round((d - Date.UTC(Number(t.slice(0, 4)), 0, 1)) / DAY);
}

/**
 * Alle Jahre, für die ein Startwert existiert: der letzte Kurs des Vorjahres (ab 15.12.)
 * oder ersatzweise ein Kurs in den ersten 14 Tagen des Jahres.
 */
function allYears(series: Point[]): SeasonYear[] {
  if (!series.length) return [];
  const lastYear = Number(series[series.length - 1].t.slice(0, 4));
  const firstYear = Number(series[0].t.slice(0, 4));
  const result: SeasonYear[] = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const inYear = series.filter((p) => p.t.startsWith(`${y}-`));
    if (!inYear.length) continue;
    const prev = [...series].reverse().find((p) => p.t < `${y}-01-01` && p.t >= `${y - 1}-12-15`);
    let base: number;
    let points: { x: number; y: number }[];
    if (prev) {
      base = prev.v;
      points = [{ x: 0, y: 0 }];
    } else if (inYear[0].t <= `${y}-01-14`) {
      base = inYear[0].v;
      points = [];
    } else {
      continue; // Jahresbeginn fehlt – kein fairer Vergleich möglich
    }
    if (!base) continue;
    for (const p of inYear) points.push({ x: dayOfYear(p.t), y: (p.v / base - 1) * 100 });
    result.push({ year: y, current: y === lastYear, points, total: points[points.length - 1]?.y ?? null });
  }
  return result;
}

function valueAt(points: { x: number; y: number }[], x: number): number | null {
  if (!points.length || x < points[0].x || x > points[points.length - 1].x) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return points[points.length - 1].y;
}

/** Die letzten `count` Jahre (inkl. laufendem) übereinander, dazu der Durchschnitt der abgeschlossenen Jahre. */
export function buildSeasonal(series: Point[], count: number): Seasonal {
  const years = allYears(series);
  const shown = years.slice(-count);
  const done = shown.filter((y) => !y.current);
  let average: Seasonal['average'] = null;
  if (done.length >= 2) {
    const pts: { x: number; y: number }[] = [];
    for (let x = 0; x <= 364; x += 3) {
      const vals = done.map((y) => valueAt(y.points, x));
      if (vals.every((v): v is number => v !== null)) pts.push({ x, y: vals.reduce((s, v) => s + v, 0) / vals.length });
    }
    if (pts.length > 1) average = { label: `Ø ${done[0].year}–${done[done.length - 1].year}`, points: pts };
  }
  return { years: shown, average, available: years.length };
}

/** Tag im Jahr → „12. Mär“ (Bezugsjahr ohne Schalttag). */
export function dayLabel(x: number): string {
  const d = new Date(Date.UTC(2025, 0, 1) + Math.round(x) * DAY);
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
