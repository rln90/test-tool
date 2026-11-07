const locale = 'de-DE';

export function fmtNumber(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtSigned(v: number | null | undefined, decimals = 2, suffix = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const s = fmtNumber(Math.abs(v), decimals);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${s}${suffix}`;
}

export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return '–';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return fmtDate(iso, true);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDate(iso: string, long = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: long ? 'numeric' : '2-digit' });
}

export function trendClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}
