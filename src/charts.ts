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
import type { Curve, Point } from './types';
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

/** Zeichnet eine Zinskurve: aktuelle Linie kräftig, Vergleichsstände gestrichelt und gedämpft. */
export function renderCurve(id: string, canvas: HTMLCanvasElement, curve: Curve): void {
  charts.get(id)?.destroy();
  const accent = cssVar('--accent');
  const muted = cssVar('--muted');
  const grid = cssVar('--grid');
  const compareColors = [cssVar('--compare-1'), cssVar('--compare-2'), muted];
  const labels = curve.lines[0]?.points.map((p) => p.label) ?? [];
  const unit = curve.unit ? ` ${curve.unit}` : '';

  const datasets = curve.lines.map((line, i) => {
    const byLabel = new Map(line.points.map((p) => [p.label, p.v]));
    const color = i === 0 ? accent : compareColors[(i - 1) % compareColors.length];
    return {
      label: `${line.label} (${fmtDate(line.asOf)})`,
      data: labels.map((l) => byLabel.get(l) ?? null),
      borderColor: color,
      backgroundColor: color,
      borderWidth: i === 0 ? 2.5 : 1.5,
      borderDash: i === 0 ? [] : [5, 4],
      pointRadius: i === 0 ? 3 : 0,
      pointHoverRadius: 4,
      tension: 0.3,
    };
  });

  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
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
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtNumber(ctx.parsed.y, 2)}${unit}` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted },
          title: { display: true, text: 'Laufzeit', color: muted },
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
