import type { Point } from './types';

const NS = 'http://www.w3.org/2000/svg';

/** Kleiner Verlauf als SVG (Linie + Fläche), skaliert auf die Breite des Containers. */
export function sparkline(series: Point[] | undefined, label: string): SVGSVGElement | null {
  const values = (series ?? []).map((p) => p.v).filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const w = 100;
  const h = 28;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - 2 * pad);
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);

  const area = document.createElementNS(NS, 'polygon');
  area.setAttribute('points', `0,${h} ${line} ${w},${h}`);
  area.setAttribute('class', 'spark-area');
  const path = document.createElementNS(NS, 'polyline');
  path.setAttribute('points', line);
  path.setAttribute('class', 'spark-line');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, path);
  return svg;
}
