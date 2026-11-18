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
import { dayLabel, type Seasonal } from './seasonal';
import { fmtDate, fmtNumber, fmtSigned } from './format';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Diagrammschrift aus der aktuellen Gestaltung übernehmen (Token --font-num). */
function applyChartFont(): void {
  Chart.defaults.font.family = cssVar('--font-num') || 'system-ui, sans-serif';
}

const charts = new Map<string, Chart>();

/** Zeichnet bzw. aktualisiert einen Linienverlauf im Canvas mit der angegebenen ID. */
export function renderLine(id: string, canvas: HTMLCanvasElement, series: Point[], decimals = 2, compact = false): void {
  applyChartFont();
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

/** Hinterlegt den EURIBOR-Abschnitt (bis 12 M) der Zinskurve mit einer hellen Fläche und Beschriftung. */
const moneyMarketBand = {
  id: 'moneyMarketBand',
  beforeDatasetsDraw(chart: Chart) {
    const opts = (chart.options.plugins as Record<string, unknown>).moneyMarketBand as { lastIndex?: number } | undefined;
    const last = opts?.lastIndex;
    if (last === undefined || last < 0) return;
    const x = chart.scales.x;
    const { top, bottom, left } = chart.chartArea;
    const step = chart.data.labels && chart.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 0;
    const right = x.getPixelForValue(last) + step / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = cssVar('--band');
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.fillStyle = cssVar('--muted');
    ctx.font = `600 11px ${cssVar('--font-num') || 'system-ui, sans-serif'}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('EURIBOR', left + 6, top + 6);
    ctx.restore();
  },
};

/**
 * Zeichnet die Zinskurve: aktuelle Linien kräftig in eigener Farbe je Kurve,
 * Vergleichslinien (Stichtag) gestrichelt in derselben Farbe.
 */
export function renderCurve(id: string, canvas: HTMLCanvasElement, curve: Curve, compareLines: CurveLine[]): void {
  applyChartFont();
  charts.get(id)?.destroy();
  const muted = cssVar('--muted');
  const grid = cssVar('--grid');
  const colorFor = (key: string | undefined) => (key === 'pfandbrief' ? cssVar('--series-2') : cssVar('--accent'));
  const unit = curve.unit ? ` ${curve.unit}` : '';

  const current = normalizeCurveLines(curve).filter((l) => l.when === 'Aktuell');
  const lines = [...current.map((l) => ({ ...l, isCurrent: true })), ...compareLines.map((l) => ({ ...l, isCurrent: false }))];
  // Alle Laufzeiten aller Linien, nach Länge sortiert
  const years = new Map<string, number>();
  for (const l of lines) for (const p of l.points) years.set(p.label, p.years);
  const labels = [...years].sort((a, b) => a[1] - b[1]).map(([label]) => label);
  const lastMoneyMarket = labels.reduce((acc, l, i) => ((years.get(l) ?? 99) < 1.5 ? i : acc), -1);

  const datasets = lines.map((line) => {
    const byLabel = new Map(line.points.map((p) => [p.label, p.v]));
    const color = colorFor(line.curve);
    return {
      label: `${line.label} · ${line.isCurrent ? 'aktuell' : fmtDate(line.asOf, true)}`,
      data: labels.map((l) => byLabel.get(l) ?? null),
      borderColor: line.isCurrent ? color : `${color}aa`,
      backgroundColor: line.isCurrent ? color : `${color}aa`,
      borderWidth: line.isCurrent ? 2.5 : 1.75,
      borderDash: line.isCurrent ? [] : [6, 4],
      pointRadius: line.isCurrent ? 3 : 0,
      pointHoverRadius: 4,
      tension: 0.3,
      spanGaps: false,
    };
  });

  const narrow = canvas.parentElement ? canvas.parentElement.clientWidth < 520 : false;
  const chart = new Chart(canvas, {
    type: 'line',
    data: { labels: labels.map(maturityLabel), datasets },
    plugins: [moneyMarketBand],
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
        ...({ moneyMarketBand: { lastIndex: lastMoneyMarket } } as object),
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted, autoSkip: narrow, autoSkipPadding: 6, maxRotation: 0, font: { size: narrow ? 10 : 12 } },
          title: { display: !narrow, text: 'Laufzeit', color: muted },
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

const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * Saisonale Ansicht: je Kalenderjahr eine Linie (Veränderung seit Jahresbeginn in %),
 * laufendes Jahr kräftig, Vorjahre gedämpft, Durchschnitt gestrichelt.
 */
export function renderSeasonal(id: string, canvas: HTMLCanvasElement, data: Seasonal): void {
  applyChartFont();
  charts.get(id)?.destroy();
  const muted = cssVar('--muted');
  const grid = cssVar('--grid');
  const text = cssVar('--text');
  const palette = [cssVar('--series-2'), cssVar('--compare-2'), cssVar('--compare-1'), cssVar('--year-4')];
  const older = data.years.filter((y) => !y.current).reverse(); // jüngstes Vorjahr zuerst → kräftigste Vorjahresfarbe

  const datasets = data.years.map((y) => {
    const color = y.current ? cssVar('--accent') : palette[older.indexOf(y) % palette.length];
    return {
      label: y.current ? `${y.year} (laufend)` : String(y.year),
      data: y.points,
      borderColor: color,
      backgroundColor: color,
      borderWidth: y.current ? 2.75 : 1.5,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.2,
      order: y.current ? 0 : 2,
    };
  });
  if (data.average) {
    datasets.push({
      label: data.average.label,
      data: data.average.points,
      borderColor: text,
      backgroundColor: text,
      borderWidth: 1.75,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.3,
      order: 1,
      ...({ borderDash: [5, 4] } as object),
    });
  }

  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: muted, boxWidth: 16, boxHeight: 2, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => (items[0] ? dayLabel(items[0].parsed.x ?? 0) : ''),
            label: (ctx) => `${ctx.dataset.label}: ${fmtSigned(ctx.parsed.y, 1, ' %')}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 365,
          grid: { color: grid },
          border: { display: false },
          afterBuildTicks: (scale) => {
            scale.ticks = MONTH_STARTS.map((value) => ({ value }));
          },
          ticks: {
            color: muted,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 4,
            callback: (v) => MONTHS[MONTH_STARTS.indexOf(Number(v))] ?? '',
          },
        },
        y: {
          position: 'right',
          grid: { color: (ctx) => (ctx.tick.value === 0 ? muted : grid) },
          border: { display: false },
          ticks: { color: muted, maxTicksLimit: 6, callback: (v) => fmtSigned(Number(v), 0, ' %') },
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
