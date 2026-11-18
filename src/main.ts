import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './style.css';
import './looks.css';
import { applyLook, lookSwitcher, resolveLook } from './looks';
import { Info, RefreshCw, TriangleAlert } from 'lucide';
import { HttpError, loadConfig, loadMarketData, refreshViaWorker } from './api';
import { h } from './dom';
import { icon } from './icons';
import { rerenderCharts, renderData, setCurveSource } from './render';
import { fmtDateTime } from './format';
import { triggerWorkflow } from './trigger';
import type { AppConfig } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;

/** Ein Knopf für alles: holt neue Daten von den Quellen (Cloudflare/GitHub) oder lädt den Datenstand neu. */
const updateBtn = h('button', { type: 'button', class: 'btn primary' }, icon(RefreshCw), 'Aktualisieren');
const status = h('div', { class: 'status', 'aria-live': 'polite' }, 'Daten werden geladen …');
const infoBox = h('div', { class: 'notice info', hidden: '', role: 'status' });
const errorBox = h('div', { class: 'notice error', hidden: '', role: 'alert' });
const content = h('main', { class: 'content' }, h('div', { class: 'loading' }, 'Daten werden geladen …'));

app.append(
  h(
    'header',
    { class: 'topbar' },
    h('div', {}, h('h1', {}, 'Marktdaten-Dashboard'), status),
    h('div', { class: 'actions' }, updateBtn),
  ),
  infoBox,
  errorBox,
  content,
  h(
    'footer',
    { class: 'pagefoot' },
    'Datenquellen: ',
    h('a', { href: 'https://finance.yahoo.com', target: '_blank', rel: 'noopener' }, 'Yahoo Finance'),
    ', ',
    h('a', { href: 'https://data.ecb.europa.eu', target: '_blank', rel: 'noopener' }, 'EZB Data Portal'),
    ', ',
    h('a', { href: 'https://www.bundesbank.de/de/statistiken/zeitreihen-datenbanken', target: '_blank', rel: 'noopener' }, 'Deutsche Bundesbank'),
    ' · Alle Angaben ohne Gewähr.',
  ),
);

// Gestaltung sofort anwenden (Adresse/Browser), Vorgabe aus app-config folgt nach dem Laden.
applyLook(resolveLook());
const footSwitch = h('div', { class: 'pagefoot' });
app.append(footSwitch);

let config: AppConfig;
let timer: number | undefined;
let lastGenerated = '';
let loading = false;
let fetching = false;
let waitingSince = 0;
/** Wurde bei leerem Datenspeicher schon automatisch ein erster Abruf gestartet? */
let autoFetchStarted = false;

function showInfo(text: string | null): void {
  infoBox.hidden = !text;
  if (text) infoBox.replaceChildren(icon(Info), text);
}

function updateStatus(): void {
  if (!lastGenerated) return;
  const auto = config.refreshUrl || config.github ? 'neue Daten stündlich automatisch' : 'Seite lädt automatisch neu';
  status.textContent = `Stand: ${fmtDateTime(lastGenerated)} · ${auto}`;
}

function setBusy(busy: boolean, label = 'Aktualisieren'): void {
  fetching = busy;
  updateBtn.disabled = busy;
  updateBtn.classList.toggle('spinning', busy);
  updateBtn.replaceChildren(icon(RefreshCw), busy ? 'Wird aktualisiert …' : label);
}

/** Während auf einen gestarteten GitHub-Abruf gewartet wird, öfter nachsehen. */
function currentInterval(): number {
  return waitingSince ? 15 : config.refreshSeconds;
}

function schedule(): void {
  window.clearTimeout(timer);
  if (document.hidden) return;
  timer = window.setTimeout(refresh, currentInterval() * 1000);
}

/** Lädt den zuletzt gespeicherten Datenstand und zeigt ihn an. */
async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const data = await loadMarketData(config.dataUrl);
    errorBox.hidden = true;
    if (waitingSince && data.generatedAt !== lastGenerated && Date.parse(data.generatedAt) > waitingSince) {
      waitingSince = 0;
      setBusy(false);
      showInfo(null);
    } else if (waitingSince && Date.now() - waitingSince > 10 * 60 * 1000) {
      waitingSince = 0;
      setBusy(false);
      showInfo('Der Abruf dauert ungewöhnlich lange. Den Status siehst du auf GitHub unter „Actions“.');
    }
    lastGenerated = data.generatedAt;
    renderData(content, data);
  } catch (err) {
    if (err instanceof HttpError && err.status === 503) {
      // Noch keine Daten gespeichert (z. B. neue Vorschau-Version): kein Fehler, sondern erster Abruf.
      errorBox.hidden = true;
      if (!lastGenerated) status.textContent = 'Noch keine Daten vorhanden.';
      if (config.refreshUrl && !autoFetchStarted) {
        autoFetchStarted = true;
        content.replaceChildren(h('div', { class: 'loading' }, 'Erster Abruf läuft, das dauert einige Sekunden …'));
        window.setTimeout(() => void startFetch(), 0);
      } else if (!config.refreshUrl) {
        showInfo(err.message);
      }
    } else {
      errorBox.replaceChildren(
        icon(TriangleAlert),
        `Daten konnten nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`,
      );
      errorBox.hidden = false;
      if (!lastGenerated) {
        status.textContent = 'Keine Daten geladen.';
        content.replaceChildren();
      }
    }
  } finally {
    loading = false;
    schedule();
    updateStatus();
  }
}

/** „Aktualisieren“: neue Daten von den Quellen holen (Worker oder GitHub-Workflow), sonst nur neu laden. */
async function startFetch(): Promise<void> {
  if (fetching) return;
  if (config.refreshUrl) {
    setBusy(true);
    const result = await refreshViaWorker(config.refreshUrl, config.refreshParts ?? ['kurse', 'fx', 'ezb', 'kurve', 'lang', 'risiko', 'haefen']);
    setBusy(false);
    showInfo(result.ok && !result.message ? null : (result.message ?? null));
    await refresh();
    return;
  }
  if (config.github) {
    setBusy(true);
    const result = await triggerWorkflow(config.github);
    if (result.ok) {
      waitingSince = Date.now();
      showInfo('Abruf gestartet. Neue Daten erscheinen automatisch, sobald sie veröffentlicht sind (ca. 1–2 Minuten).');
      schedule();
      return;
    }
    setBusy(false);
    if ('message' in result) showInfo(result.message);
    return;
  }
  setBusy(true);
  await refresh();
  setBusy(false);
}

updateBtn.addEventListener('click', () => void startFetch());
document.addEventListener('visibilitychange', () => {
  // Im Hintergrund nicht neu laden; beim Zurückkehren sofort aktualisieren.
  if (document.hidden) window.clearTimeout(timer);
  else void refresh();
});
// Diagramme lesen ihre Farben aus dem Theme – bei Wechsel hell/dunkel neu zeichnen.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);

loadConfig().then((cfg) => {
  config = cfg;
  const look = resolveLook(cfg.look);
  applyLook(look);
  footSwitch.replaceChildren(lookSwitcher(look, rerenderCharts));
  setCurveSource(cfg.curveUrl, cfg.curveMinDate);
  updateBtn.title =
    cfg.refreshUrl || cfg.github
      ? 'Neue Daten von den Quellen abrufen'
      : 'Gespeicherten Datenstand neu laden';
  if (cfg.notice) showInfo(cfg.notice);
  void refresh();
});
