import { ArrowDownRight, ArrowUpRight, Minus, TriangleAlert } from 'lucide';
import { h } from './dom';
import { icon } from './icons';
import { renderLine, pruneCharts } from './charts';
import { fmtDateTime, fmtNumber, fmtSigned, trendClass } from './format';
import type { Instrument, MarketData, Measure } from './types';

function trendIcon(v: number | null | undefined): SVGElement {
  if (v === null || v === undefined || v === 0) return icon(Minus, 14);
  return v > 0 ? icon(ArrowUpRight, 14) : icon(ArrowDownRight, 14);
}

function measureTile(inst: Instrument, m: Measure): HTMLElement {
  const decimals = m.decimals ?? 2;
  const delta =
    m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
  const unit = m.unit ? ` ${m.unit}` : '';

  const tile = h(
    'div',
    { class: 'measure', title: m.asOf ? `Stand: ${fmtDateTime(m.asOf)}` : '' },
    h('div', { class: 'measure-label', title: m.label }, m.label),
    h('div', { class: 'measure-value' }, fmtNumber(m.value, decimals) + unit),
    delta !== null
      ? h(
          'div',
          { class: `measure-delta ${trendClass(delta)}`, title: 'Veränderung zum Vorwert' },
          trendIcon(delta),
          fmtSigned(delta, decimals, unit),
        )
      : null,
  );

  if (m.series && m.series.length > 1) {
    const canvas = h('canvas', { 'aria-label': `Verlauf ${m.label}`, role: 'img' });
    tile.append(h('div', { class: 'spark' }, canvas));
    requestAnimationFrame(() => renderLine(`${inst.id}:${m.key}`, canvas, m.series!, decimals, true));
  }
  return tile;
}

function instrumentCard(inst: Instrument): HTMLElement {
  const p = inst.price;
  const card = h(
    'article',
    { class: 'card' },
    h(
      'header',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('h2', {}, inst.name),
        h('div', { class: 'sub' }, [inst.ticker, inst.currency].filter(Boolean).join(' · ')),
      ),
      p
        ? h(
            'div',
            { class: 'price' },
            h('div', { class: 'price-last' }, fmtNumber(p.last)),
            h(
              'div',
              { class: `price-change ${trendClass(p.changePct ?? p.change)}` },
              trendIcon(p.changePct ?? p.change),
              p.change !== undefined && p.change !== null ? fmtSigned(p.change) : '',
              p.changePct !== undefined && p.changePct !== null ? ` (${fmtSigned(p.changePct, 2, ' %')})` : '',
            ),
          )
        : null,
    ),
  );

  if (inst.error) {
    card.append(h('div', { class: 'notice warn' }, icon(TriangleAlert), `Daten nicht verfügbar: ${inst.error}`));
  }

  if (inst.series && inst.series.length > 1) {
    const canvas = h('canvas', { 'aria-label': `Kursverlauf ${inst.name}`, role: 'img' });
    card.append(h('div', { class: 'chart' }, canvas));
    requestAnimationFrame(() => renderLine(`${inst.id}:price`, canvas, inst.series!));
  }

  if (inst.measures.length) {
    card.append(h('div', { class: 'measures' }, ...inst.measures.map((m) => measureTile(inst, m))));
  }

  if (p?.asOf) card.append(h('footer', { class: 'card-foot' }, `Stand: ${fmtDateTime(p.asOf)}`));
  return card;
}

export function renderData(container: HTMLElement, data: MarketData): void {
  container.replaceChildren();
  if (data.sample) {
    container.append(
      h('div', { class: 'notice warn' }, icon(TriangleAlert), 'Beispieldaten – keine echten Marktdaten.'),
    );
  }
  if (!data.instruments.length) {
    container.append(h('div', { class: 'empty' }, 'Keine Instrumente in den Daten enthalten.'));
    return;
  }
  container.append(h('div', { class: 'grid' }, ...data.instruments.map(instrumentCard)));
  requestAnimationFrame(pruneCharts);
}
