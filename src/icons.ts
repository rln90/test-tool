import { createElement } from 'lucide';

type IconNode = Parameters<typeof createElement>[0];

/** Erzeugt ein einfarbiges Lucide-Icon (stroke = currentColor). */
export function icon(node: IconNode, size = 16): SVGElement {
  const el = createElement(node, { width: size, height: size, 'stroke-width': 2, stroke: 'currentColor' });
  el.setAttribute('aria-hidden', 'true');
  return el;
}
