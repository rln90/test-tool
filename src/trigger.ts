import { KeyRound, X } from 'lucide';
import { h } from './dom';
import { icon } from './icons';
import type { GithubConfig } from './types';

const TOKEN_KEY = 'marktdaten-dashboard:github-token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Speicher nicht verfügbar (z. B. privates Fenster) – Token gilt dann nur für diese Sitzung.
  }
}

let sessionToken: string | null = null;
const currentToken = (): string | null => sessionToken ?? readToken();

/** Dialog zum Hinterlegen des GitHub-Tokens. Liefert das Token oder null bei Abbruch. */
function askToken(cfg: GithubConfig): Promise<string | null> {
  return new Promise((resolveToken) => {
    const input = h('input', {
      type: 'password',
      class: 'input',
      placeholder: 'github_pat_…',
      autocomplete: 'off',
      'aria-label': 'GitHub-Token',
    });
    const save = h('button', { type: 'submit', class: 'btn primary' }, 'Speichern und abrufen');
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Abbrechen');
    const remove = h('button', { type: 'button', class: 'btn link' }, 'Gespeichertes Token entfernen');
    const close = h('button', { type: 'button', class: 'icon-btn', title: 'Schließen', 'aria-label': 'Schließen' }, icon(X));

    const form = h(
      'form',
      { method: 'dialog', class: 'dialog-body' },
      h('header', { class: 'dialog-head' }, h('h2', {}, icon(KeyRound), 'Datenabruf starten'), close),
      h(
        'p',
        {},
        'Um neue Daten sofort abzurufen, startet das Dashboard den GitHub-Workflow. Dafür wird einmalig ein GitHub-Token benötigt, das nur in diesem Browser gespeichert wird.',
      ),
      h(
        'ol',
        {},
        h(
          'li',
          {},
          h(
            'a',
            { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' },
            'Fine-grained Token anlegen',
          ),
        ),
        h('li', {}, `Repository access: nur „${cfg.owner}/${cfg.repo}“`),
        h('li', {}, 'Permissions → Actions: „Read and write“'),
        h('li', {}, 'Token kopieren und hier einfügen'),
      ),
      input,
      h('div', { class: 'dialog-actions' }, readToken() ? remove : null, cancel, save),
    );
    const dialog = h('dialog', { class: 'dialog' }, form);
    document.body.append(dialog);

    const finish = (value: string | null) => {
      dialog.close();
      dialog.remove();
      resolveToken(value);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (token) finish(token);
    });
    cancel.addEventListener('click', () => finish(null));
    close.addEventListener('click', () => finish(null));
    remove.addEventListener('click', () => {
      writeToken(null);
      sessionToken = null;
      finish(null);
    });
    dialog.addEventListener('cancel', () => finish(null));
    dialog.showModal();
    input.focus();
  });
}

export type TriggerResult = { ok: true } | { ok: false; message: string } | { ok: false; cancelled: true };

/** Startet den Datenabruf-Workflow über die GitHub-API (workflow_dispatch). */
export async function triggerWorkflow(cfg: GithubConfig): Promise<TriggerResult> {
  let token = currentToken();
  if (!token) {
    token = await askToken(cfg);
    if (!token) return { ok: false, cancelled: true };
    sessionToken = token;
    writeToken(token);
  }
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: cfg.ref }),
    });
  } catch {
    return { ok: false, message: 'GitHub ist nicht erreichbar.' };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    writeToken(null);
    sessionToken = null;
    return {
      ok: false,
      message: `GitHub hat den Abruf abgelehnt (HTTP ${res.status}). Bitte Token und Berechtigung „Actions: Read and write“ prüfen.`,
    };
  }
  return { ok: false, message: `GitHub-Fehler: HTTP ${res.status}` };
}
