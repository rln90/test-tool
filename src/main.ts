import './style.css';
import { Pause, Play, RefreshCw, TriangleAlert } from 'lucide';
import { loadConfig, loadMarketData } from './api';
import { h } from './dom';
import { icon } from './icons';
import { renderData } from './render';
import { fmtDateTime } from './format';
import type { AppConfig } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;

const refreshBtn = h('button', { type: 'button', class: 'btn', title: 'Jetzt aktualisieren' }, icon(RefreshCw), 'Aktualisieren');
const pauseBtn = h('button', { type: 'button', class: 'btn', title: 'Automatische Aktualisierung pausieren' });
const status = h('div', { class: 'status', 'aria-live': 'polite' }, 'Lade Daten …');
const errorBox = h('div', { class: 'notice error', hidden: '' });
const content = h('main', { class: 'content' });

app.append(
  h(
    'header',
    { class: 'topbar' },
    h('div', {}, h('h1', {}, 'Marktdaten-Dashboard'), status),
    h('div', { class: 'actions' }, pauseBtn, refreshBtn),
  ),
  errorBox,
  content,
  h(
    'footer',
    { class: 'pagefoot' },
    'Datenquellen: ',
    h('a', { href: 'https://bigdata.com', target: '_blank', rel: 'noopener' }, 'Bigdata.com'),
    ', ',
    h('a', { href: 'https://data.ecb.europa.eu', target: '_blank', rel: 'noopener' }, 'EZB Data Portal'),
  ),
);

let config: AppConfig;
let timer: number | undefined;
let nextAt = 0;
let paused = false;
let lastGenerated = '';
let lastSource = '';
let loading = false;

function setPauseButton(): void {
  pauseBtn.replaceChildren(paused ? icon(Play) : icon(Pause), paused ? 'Fortsetzen' : 'Pausieren');
  pauseBtn.title = paused ? 'Automatische Aktualisierung fortsetzen' : 'Automatische Aktualisierung pausieren';
}

function updateStatus(): void {
  if (!lastGenerated) return;
  const parts = [`Datenstand: ${fmtDateTime(lastGenerated)}`];
  if (lastSource) parts.push(`Quelle: ${lastSource}`);
  if (paused) parts.push('Aktualisierung pausiert');
  else if (nextAt) parts.push(`nächste Aktualisierung in ${Math.max(0, Math.round((nextAt - Date.now()) / 1000))} s`);
  status.textContent = parts.join(' · ');
}

function schedule(): void {
  window.clearTimeout(timer);
  if (paused || document.hidden) {
    nextAt = 0;
    updateStatus();
    return;
  }
  nextAt = Date.now() + config.refreshSeconds * 1000;
  timer = window.setTimeout(refresh, config.refreshSeconds * 1000);
}

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  try {
    const data = await loadMarketData(config.dataUrl);
    errorBox.hidden = true;
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

refreshBtn.addEventListener('click', () => void refresh());
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  setPauseButton();
  if (paused) schedule();
  else void refresh();
});
document.addEventListener('visibilitychange', () => {
  // Im Hintergrund nicht abrufen; beim Zurückkehren sofort aktualisieren.
  if (document.hidden) schedule();
  else if (!paused) void refresh();
});
window.setInterval(updateStatus, 1000);

setPauseButton();
loadConfig().then((cfg) => {
  config = cfg;
  void refresh();
});
