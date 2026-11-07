import { ArrowDownRight, ArrowUpRight, Minus, TriangleAlert } from 'lucide';
import { h } from './dom';
import { icon } from './icons';
import { renderCurve, renderLine, pruneCharts } from './charts';
import { fmtDateTime, fmtNumber, fmtSigned, trendClass } from './format';
import type { Curve, Instrument, MarketData, Measure } from './types';

function trendIcon(v: number | null | undefined): SVGElement {
  if (v === null || v === undefined || v === 0) return icon(Minus, 14);
  return v > 0 ? icon(ArrowUpRight, 14) : icon(ArrowDownRight, 14);
}

function measureTile(ownerId: string, m: Measure): HTMLElement {
  const decimals = m.decimals ?? 2;
  const delta =
    m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
  const unit = m.unit ? ` ${m.unit}` : '';
  const deltaUnit = m.deltaUnit ? ` ${m.deltaUnit}` : unit;

  const tile = h(
    'div',
    { class: 'measure', title: m.asOf ? `Stand: ${fmtDateTime(m.asOf)}` : '' },
    h('div', { class: 'measure-label', title: m.label }, m.label),
    h('div', { class: 'measure-value' }, fmtNumber(m.value, decimals) + unit),
    delta !== null
      ? h(
          'div',
          { class: `measure-delta ${m.neutral ? 'flat' : trendClass(delta)}`, title: m.previousLabel ?? 'Veränderung zum Vorwert' },
          trendIcon(delta),
          fmtSigned(delta, decimals, deltaUnit),
        )
      : null,
  );

  if (m.series && m.series.length > 1) {
    const canvas = h('canvas', { 'aria-label': `Verlauf ${m.label}`, role: 'img' });
    tile.append(h('div', { class: 'spark' }, canvas));
    requestAnimationFrame(() => renderLine(`${ownerId}:${m.key}`, canvas, m.series!, decimals, true));
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
        inst.note ? h('div', { class: 'note' }, inst.note) : null,
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
    card.append(h('div', { class: 'measures' }, ...inst.measures.map((m) => measureTile(inst.id, m))));
  }

  const foot = [p?.asOf ? `Stand: ${fmtDateTime(p.asOf)}` : '', inst.source ? `Quelle: ${inst.source}` : '']
    .filter(Boolean)
    .join(' · ');
  if (foot) card.append(h('footer', { class: 'card-foot' }, foot));
  return card;
}

function curveCard(curve: Curve): HTMLElement {
  const card = h(
    'article',
    { class: 'card wide' },
    h('header', { class: 'card-head' }, h('div', {}, h('h2', {}, curve.name))),
  );
  if (curve.error) {
    card.append(h('div', { class: 'notice warn' }, icon(TriangleAlert), `Daten nicht verfügbar: ${curve.error}`));
  }
  if (curve.lines.length && curve.lines[0].points.length) {
    const canvas = h('canvas', { 'aria-label': `Zinskurve ${curve.name}`, role: 'img' });
    card.append(h('div', { class: 'chart tall' }, canvas));
    requestAnimationFrame(() => renderCurve(`${curve.id}:curve`, canvas, curve));
  }
  if (curve.measures?.length) {
    card.append(h('div', { class: 'measures' }, ...curve.measures.map((m) => measureTile(curve.id, m))));
  }
  const asOf = curve.lines[0]?.asOf;
  const foot = [asOf ? `Stand: ${fmtDateTime(asOf)}` : '', curve.source ? `Quelle: ${curve.source}` : '']
    .filter(Boolean)
    .join(' · ');
  if (foot) card.append(h('footer', { class: 'card-foot' }, foot));
  return card;
}

export function renderData(container: HTMLElement, data: MarketData): void {
  container.replaceChildren();
  if (data.sample) {
    container.append(
      h('div', { class: 'notice warn' }, icon(TriangleAlert), 'Beispieldaten – keine echten Marktdaten.'),
    );
  }
  const curves = data.curves ?? [];
  if (!data.instruments.length && !curves.length) {
    container.append(h('div', { class: 'empty' }, 'Keine Daten enthalten.'));
    return;
  }
  container.append(h('div', { class: 'grid' }, ...data.instruments.map(instrumentCard), ...curves.map(curveCard)));
  requestAnimationFrame(pruneCharts);
}
