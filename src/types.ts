/** Ein Punkt einer Zeitreihe: ISO-Datum + Wert. */
export interface Point {
  t: string;
  v: number;
}

/** Eine Kennzahl (Measure) eines Instruments, z. B. KGV, Sentiment, Umsatzwachstum. */
export interface Measure {
  key: string;
  label: string;
  value: number | null;
  /** Vorheriger Wert, um eine Veränderung anzuzeigen. */
  previous?: number | null;
  /** Beschreibung des Vorwerts, z. B. „ggü. 01.05.2026“. */
  previousLabel?: string;
  unit?: string;
  /** Einheit der Veränderung, falls abweichend (z. B. „%-Pkt.“ bei Zinsen). */
  deltaUnit?: string;
  /** true = Anstieg/Rückgang nicht als gut/schlecht einfärben (z. B. Zinsen). */
  neutral?: boolean;
  /** Anzahl Nachkommastellen für die Anzeige. */
  decimals?: number;
  asOf?: string;
  series?: Point[];
}

export interface Price {
  last: number;
  change?: number | null;
  changePct?: number | null;
  asOf?: string;
}

export interface Instrument {
  id: string;
  name: string;
  /** Zusatzhinweis, z. B. welches Wertpapier als Stellvertreter dient. */
  note?: string;
  ticker?: string;
  currency?: string;
  source?: string;
  price?: Price;
  /** Kursverlauf. */
  series?: Point[];
  measures: Measure[];
  /** Fehlermeldung, falls dieses Instrument beim Abruf nicht geladen werden konnte. */
  error?: string;
}

export interface CurvePoint {
  /** Laufzeit, z. B. „10Y“. */
  label: string;
  years: number;
  v: number;
}

export interface CurveLine {
  label: string;
  asOf: string;
  points: CurvePoint[];
}

/** Zinskurve: erste Linie = aktuell, weitere = Vergleichsstände. */
export interface Curve {
  id: string;
  name: string;
  unit?: string;
  source?: string;
  lines: CurveLine[];
  measures?: Measure[];
  error?: string;
}

/** Datenformat der Datei, die das Dashboard regelmäßig neu lädt. */
export interface MarketData {
  generatedAt: string;
  source: string;
  /** true = Beispieldaten, keine echten Marktdaten. */
  sample?: boolean;
  instruments: Instrument[];
  curves?: Curve[];
}

export interface AppConfig {
  dataUrl: string;
  refreshSeconds: number;
}
