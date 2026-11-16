#!/usr/bin/env node
/**
 * Holt alle Daten für das Dashboard (siehe scripts/lib/collect.mjs) und schreibt sie als JSON-Datei.
 *
 * Fällt ein Bereich aus, wird – falls angegeben – der letzte veröffentlichte Stand übernommen
 * und als veraltet markiert (Umgebungsvariable PREVIOUS_DATA_URL oder --previous).
 *
 * Aufruf:
 *   node scripts/fetch-data.mjs [--config data.config.json] [--out public/data/marketdata.json] [--previous url|datei]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collectData, NoDataError, summarize } from './lib/collect.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = JSON.parse(await readFile(resolve(arg('config', 'data.config.json')), 'utf8'));
const outPath = resolve(arg('out', 'public/data/marketdata.json'));
const previousSrc = arg('previous', process.env.PREVIOUS_DATA_URL);

async function loadPrevious() {
  if (!previousSrc) return null;
  try {
    const text = /^https?:/.test(previousSrc)
      ? await (await fetch(previousSrc, { signal: AbortSignal.timeout(30000) })).text()
      : await readFile(previousSrc, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    console.warn(`Vorheriger Datenstand nicht lesbar (${err instanceof Error ? err.message : err}) – fahre ohne fort.`);
    return null;
  }
}

let data;
try {
  data = await collectData(config, await loadPrevious());
} catch (err) {
  if (err instanceof NoDataError) {
    // Letzten gültigen Datenstand nicht überschreiben, wenn gar nichts geladen werden konnte.
    console.error('Keine Daten geladen – Ausgabedatei bleibt unverändert.');
    process.exit(2);
  }
  throw err;
}

// Wochenkurse hängen bereits an den Instrumenten; die Sammelliste wird nur im Worker gebraucht.
delete data.longSeries;

// Atomar schreiben, damit das Dashboard nie eine halb geschriebene Datei liest.
await mkdir(dirname(outPath), { recursive: true });
await writeFile(`${outPath}.tmp`, JSON.stringify(data));
await rename(`${outPath}.tmp`, outPath);
console.log(`${summarize(data)} → ${outPath}`);
