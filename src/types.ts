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
  unit?: string;
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
  ticker?: string;
  currency?: string;
  price?: Price;
  /** Kursverlauf. */
  series?: Point[];
  measures: Measure[];
  /** Fehlermeldung, falls dieses Instrument beim Abruf nicht geladen werden konnte. */
  error?: string;
}

/** Datenformat der Datei, die das Dashboard regelmäßig neu lädt. */
export interface MarketData {
  generatedAt: string;
  source: string;
  /** true = Beispieldaten, keine echten Marktdaten. */
  sample?: boolean;
  instruments: Instrument[];
}

export interface AppConfig {
  dataUrl: string;
  refreshSeconds: number;
}
