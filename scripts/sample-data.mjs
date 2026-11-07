#!/usr/bin/env node
/**
 * Erzeugt synthetische Beispieldaten (sample: true) zum Testen der Oberfläche
 * ohne API-Zugang. Das Dashboard zeigt dafür einen deutlichen Hinweis an.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const outPath = resolve(process.argv[2] ?? 'public/data/marketdata.json');

function walk(start, n, vol) {
  const pts = [];
  let v = start;
  const day = 86400000;
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    v = Math.max(1, v * (1 + (Math.random() - 0.5) * vol));
    pts.push({ t: new Date(now - i * day).toISOString().slice(0, 10), v: Math.round(v * 100) / 100 });
  }
  return pts;
}

function instrument(id, name, start) {
  const series = walk(start, 120, 0.03);
  const last = series.at(-1).v;
  const prev = series.at(-2).v;
  const senti = walk(0.5, 30, 0.2).map((p) => ({ t: p.t, v: Math.round((p.v - 0.5) * 100) / 100 }));
  return {
    id,
    name,
    ticker: id.toUpperCase(),
    currency: 'EUR',
    price: { last, change: last - prev, changePct: ((last - prev) / prev) * 100, asOf: new Date().toISOString() },
    series,
    measures: [
      { key: 'pe', label: 'KGV', value: Math.round(Math.random() * 300) / 10, previous: Math.round(Math.random() * 300) / 10, decimals: 1 },
      { key: 'div', label: 'Dividendenrendite', value: Math.round(Math.random() * 500) / 100, unit: '%' },
      { key: 'sent', label: 'Sentiment', value: senti.at(-1).v, previous: senti.at(-2).v, series: senti },
    ],
  };
}

const data = {
  generatedAt: new Date().toISOString(),
  source: 'Beispieldaten',
  sample: true,
  instruments: [
    instrument('bsp-a', 'Beispiel-Aktie A', 120),
    instrument('bsp-b', 'Beispiel-Aktie B', 45),
    instrument('bsp-c', 'Beispiel-Index C', 4800),
  ],
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(data, null, 2));
console.log(`Beispieldaten geschrieben nach ${outPath}`);
