import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import type { Curve, CurveLine, Point } from './types';
import { fmtDate, fmtNumber } from './format';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const charts = new Map<string, Chart>();

/** Zeichnet bzw. aktualisiert einen Linienverlauf im Canvas mit der angegebenen ID. */
export function renderLine(id: string, canvas: HTMLCanvasElement, series: Point[], decimals = 2, compact = false): void {
  const labels = series.map((p) => fmtDate(p.t));
  const values = series.map((p) => p.v);
  // Neutrale Linienfarbe; Auf/Ab wird über die Kennzahlen daneben angezeigt.
  const color = cssVar('--accent');
  const grid = cssVar('--grid');
  const muted = cssVar('--muted');

  const existing = charts.get(id);
  if (existing && existing.canvas === canvas) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = values;
    existing.data.datasets[0].borderColor = color;
    existing.data.datasets[0].backgroundColor = color + '22';
    existing.update('none');
    return;
  }
  existing?.destroy();

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: values,
          borderColor: color,
          backgroundColor: color + '22',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => fmtNumber(ctx.parsed.y, decimals) },
        },
      },
      scales: {
        x: {
          display: !compact,
          grid: { display: false },
          ticks: { color: muted, maxTicksLimit: 5, maxRotation: 0, autoSkipPadding: 24 },
        },
        y: {
          display: !compact,
          position: 'right',
          grid: { color: grid },
          border: { display: false },
          ticks: { color: muted, maxTicksLimit: 5, callback: (v) => fmtNumber(Number(v), decimals) },
        },
      },
    },
  });
  charts.set(id, chart);
}

/** Laufzeit-Kürzel lesbar machen: „3M“ → „3 M“, „10Y“ → „10 J“, „1W“ → „1 W“. */
export function maturityLabel(m: string): string {
  const n = m.slice(0, -1);
  const u = m.slice(-1);
  return `${n} ${u === 'Y' ? 'J' : u}`;
}

/** Ältere Datenstände: erste Linie = aktuell, weitere = Vergleichsstände einer einzigen Kurve. */
export function normalizeCurveLines(curve: Curve): Required<CurveLine>[] {
  const legacy = !curve.lines.some((l) => l.when);
  return curve.lines.map((l, i) => ({
    ...l,
    curve: l.curve ?? 'aaa',
    when: legacy ? (i === 0 ? 'Aktuell' : l.label) : (l.when ?? 'Aktuell'),
  }));
}

/**
 * Zeichnet die Zinskurve: aktuelle Linien kräftig in eigener Farbe je Kurve,
 * der gewählte Vergleichsstand gestrichelt in derselben Farbe.
 */
export function renderCurve(id: string, canvas: HTMLCanvasElement, curve: Curve, compareWhen: string | null): void {
  charts.get(id)?.destroy();
  const muted = cssVar('--muted');
  const grid = cssVar('--grid');
  const colorFor = (key: string) => (key === 'pfandbrief' ? cssVar('--series-2') : cssVar('--accent'));
  const unit = curve.unit ? ` ${curve.unit}` : '';

  const lines = normalizeCurveLines(curve).filter((l) => l.when === 'Aktuell' || l.when === compareWhen);
  // Alle Laufzeiten aller Linien, nach Länge sortiert
  const years = new Map<string, number>();
  for (const l of lines) for (const p of l.points) years.set(p.label, p.years);
  const labels = [...years].sort((a, b) => a[1] - b[1]).map(([label]) => label);

  const datasets = lines.map((line) => {
    const current = line.when === 'Aktuell';
    const byLabel = new Map(line.points.map((p) => [p.label, p.v]));
    const color = colorFor(line.curve);
    return {
      label: current ? `${line.label} (${fmtDate(line.asOf)})` : `${line.label} ${line.when} (${fmtDate(line.asOf)})`,
      data: labels.map((l) => byLabel.get(l) ?? null),
      borderColor: current ? color : `${color}99`,
      backgroundColor: current ? color : `${color}99`,
      borderWidth: current ? 2.5 : 1.5,
      borderDash: current ? [] : [5, 4],
      pointRadius: current ? 3 : 0,
      pointHoverRadius: 4,
      tension: 0.3,
      spanGaps: false,
    };
  });

  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels: labels.map(maturityLabel), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: muted, boxWidth: 16, boxHeight: 2, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => (ctx.parsed.y === null ? '' : `${ctx.dataset.label}: ${fmtNumber(ctx.parsed.y, 2)}${unit}`),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted, autoSkip: false, maxRotation: 0 },
          title: { display: true, text: 'Laufzeit (EURIBOR bis 12 M, danach Anleihen)', color: muted },
        },
        y: {
          position: 'right',
          grid: { color: grid },
          border: { display: false },
          ticks: { color: muted, maxTicksLimit: 6, callback: (v) => `${fmtNumber(Number(v), 2)}${unit}` },
        },
      },
    },
  });
  charts.set(id, chart);
}

/** Entfernt Diagramme, deren Canvas nicht mehr im DOM ist. */
export function pruneCharts(): void {
  for (const [id, chart] of charts) {
    if (!chart.canvas.isConnected) {
      chart.destroy();
      charts.delete(id);
    }
  }
}
