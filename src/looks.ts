import { h } from './dom';

/** Wählbare Gestaltungen. „standard“ ist die bisherige Oberfläche. */
export const LOOKS = [
  { id: 'standard', label: 'Standard' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'desk', label: 'Desk' },
  { id: 'research', label: 'Research' },
] as const;
export type LookId = (typeof LOOKS)[number]['id'];

const KEY = 'marktdaten-dashboard:look';
const isLook = (v: unknown): v is LookId => LOOKS.some((l) => l.id === v);

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Reihenfolge: ?look=… in der Adresse, dann die eigene Auswahl im Browser, dann die Vorgabe aus app-config. */
export function resolveLook(configDefault?: string): LookId {
  const fromUrl = new URLSearchParams(location.search).get('look');
  if (isLook(fromUrl)) return fromUrl;
  const own = stored();
  if (isLook(own)) return own;
  return isLook(configDefault) ? configDefault : 'standard';
}

export function applyLook(look: LookId): void {
  document.documentElement.dataset.look = look;
}

/** Kleiner Umschalter für die Fußzeile; ruft onChange nach dem Wechsel auf (Diagramme neu zeichnen). */
export function lookSwitcher(current: LookId, onChange: () => void): HTMLElement {
  const wrap = h('span', { class: 'look-switch', role: 'group', 'aria-label': 'Gestaltung' }, 'Design: ');
  const buttons = LOOKS.map((l) => {
    const b = h('button', { type: 'button', class: 'look-btn', 'aria-pressed': String(l.id === current) }, l.label);
    b.addEventListener('click', () => {
      applyLook(l.id);
      try {
        localStorage.setItem(KEY, l.id);
      } catch {
        // Auswahl gilt dann nur bis zum Neuladen
      }
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      onChange();
    });
    return b;
  });
  wrap.append(...buttons);
  return wrap;
}
