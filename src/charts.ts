import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
} from 'chart.js';
import type { Point } from './types';
import { fmtDate, fmtNumber } from './format';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

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

/** Entfernt Diagramme, deren Canvas nicht mehr im DOM ist. */
export function pruneCharts(): void {
  for (const [id, chart] of charts) {
    if (!chart.canvas.isConnected) {
      chart.destroy();
      charts.delete(id);
    }
  }
}
