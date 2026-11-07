import './style.css';
import { CloudDownload, Info, Pause, Play, RefreshCw, TriangleAlert } from 'lucide';
import { loadConfig, loadMarketData } from './api';
import { h } from './dom';
import { icon } from './icons';
import { renderData } from './render';
import { fmtDateTime } from './format';
import { triggerWorkflow } from './trigger';
import type { AppConfig } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;

const fetchBtn = h(
  'button',
  { type: 'button', class: 'btn primary', title: 'Neue Daten von den Quellen abrufen (dauert ca. 1–2 Minuten)', hidden: '' },
  icon(CloudDownload),
  'Jetzt abrufen',
);
const refreshBtn = h(
  'button',
  { type: 'button', class: 'btn', title: 'Zuletzt veröffentlichten Datenstand neu laden' },
  icon(RefreshCw),
  'Neu laden',
);
const pauseBtn = h('button', { type: 'button', class: 'btn' });
const status = h('div', { class: 'status', 'aria-live': 'polite' }, 'Lade Daten …');
const infoBox = h('div', { class: 'notice info', hidden: '' });
const errorBox = h('div', { class: 'notice error', hidden: '' });
const content = h('main', { class: 'content' });

app.append(
  h(
    'header',
    { class: 'topbar' },
    h('div', {}, h('h1', {}, 'Marktdaten-Dashboard'), status),
    h('div', { class: 'actions' }, pauseBtn, refreshBtn, fetchBtn),
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
    ' · Neue Daten werden stündlich abgerufen.',
  ),
);

let config: AppConfig;
let timer: number | undefined;
let nextAt = 0;
let paused = false;
let lastGenerated = '';
let lastSource = '';
let loading = false;
let waitingSince = 0;

function showInfo(text: string | null): void {
  infoBox.hidden = !text;
  if (text) infoBox.replaceChildren(icon(Info), text);
}

function setPauseButton(): void {
  pauseBtn.replaceChildren(paused ? icon(Play) : icon(Pause), paused ? 'Fortsetzen' : 'Pausieren');
  pauseBtn.title = paused ? 'Automatisches Neuladen fortsetzen' : 'Automatisches Neuladen pausieren';
}

function updateStatus(): void {
  if (!lastGenerated) return;
  const parts = [`Datenstand: ${fmtDateTime(lastGenerated)}`];
  if (lastSource) parts.push(`Quelle: ${lastSource}`);
  if (paused) parts.push('Neuladen pausiert');
  else if (nextAt) parts.push(`neu laden in ${Math.max(0, Math.round((nextAt - Date.now()) / 1000))} s`);
  status.textContent = parts.join(' · ');
}

/** Während auf einen gestarteten Abruf gewartet wird, öfter nachsehen. */
function currentInterval(): number {
  return waitingSince ? 15 : config.refreshSeconds;
}

function schedule(): void {
  window.clearTimeout(timer);
  if (paused || document.hidden) {
    nextAt = 0;
    updateStatus();
    return;
  }
  nextAt = Date.now() + currentInterval() * 1000;
  timer = window.setTimeout(refresh, currentInterval() * 1000);
}

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  try {
    const data = await loadMarketData(config.dataUrl);
    errorBox.hidden = true;
    if (waitingSince && data.generatedAt !== lastGenerated && Date.parse(data.generatedAt) > waitingSince) {
      waitingSince = 0;
      fetchBtn.disabled = false;
      showInfo(null);
    } else if (waitingSince && Date.now() - waitingSince > 10 * 60 * 1000) {
      waitingSince = 0;
      fetchBtn.disabled = false;
      showInfo('Der Abruf dauert ungewöhnlich lange. Den Status siehst du auf GitHub unter „Actions“.');
    }
    lastGenerated = data.generatedAt;
    lastSource = data.source;
    renderData(content, data);
  } catch (err) {
    errorBox.replaceChildren(
      icon(TriangleAlert),
      `Daten konnten nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`,
    );
    errorBox.hidden = false;
    if (!lastGenerated) status.textContent = 'Keine Daten geladen.';
  } finally {
    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
    schedule();
    updateStatus();
  }
}

async function startFetch(): Promise<void> {
  if (!config.github) return;
  fetchBtn.disabled = true;
  const result = await triggerWorkflow(config.github);
  if (result.ok) {
    waitingSince = Date.now();
    showInfo('Abruf gestartet. Neue Daten erscheinen automatisch, sobald sie veröffentlicht sind (ca. 1–2 Minuten).');
    schedule();
    return;
  }
  fetchBtn.disabled = false;
  if ('message' in result) showInfo(result.message);
}

refreshBtn.addEventListener('click', () => void refresh());
fetchBtn.addEventListener('click', () => void startFetch());
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  setPauseButton();
  if (paused) schedule();
  else void refresh();
});
document.addEventListener('visibilitychange', () => {
  // Im Hintergrund nicht neu laden; beim Zurückkehren sofort aktualisieren.
  if (document.hidden) schedule();
  else if (!paused) void refresh();
});
window.setInterval(updateStatus, 1000);

setPauseButton();
loadConfig().then((cfg) => {
  config = cfg;
  fetchBtn.hidden = !cfg.github;
  if (cfg.notice) showInfo(cfg.notice);
  void refresh();
});
