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
  /** Art des Eintrags: Kurs (ETF, Krypto …), Zinsen oder Wechselkurse. */
  kind?: 'asset' | 'rates' | 'fx';
  /** Gruppe in der Kursliste, z. B. „ETF“ oder „Krypto“. */
  group?: string;
  name: string;
  /** Zusatzhinweis, z. B. welches Wertpapier als Stellvertreter dient. */
  note?: string;
  ticker?: string;
  currency?: string;
  source?: string;
  price?: Price;
  /** Kursverlauf (Tageskurse, ca. 6 Monate). */
  series?: Point[];
  /** Älterer Verlauf als Wochenkurse (bis 5 Jahre), endet vor dem ersten Punkt von series. */
  longSeries?: Point[];
  measures: Measure[];
  /** Fehlermeldung, falls dieses Instrument beim Abruf nicht geladen werden konnte. */
  error?: string;
  /** true = Abruf fehlgeschlagen, es wird der letzte gültige Stand angezeigt. */
  stale?: boolean;
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
  /** Welche Kurve (z. B. „pfandbrief“, „aaa“); fehlt bei älteren Datenständen. */
  curve?: string;
  /** Stichtag als Text: „Aktuell“, „vor 30 Tagen“ …; fehlt bei älteren Datenständen. */
  when?: string;
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
  stale?: boolean;
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

/** Angaben, um den Datenabruf (GitHub-Workflow) aus dem Dashboard heraus zu starten. */
export interface GithubConfig {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
}

export interface AppConfig {
  dataUrl: string;
  refreshSeconds: number;
  github?: GithubConfig;
  /** Endpunkt für sofortigen Abruf (Cloudflare Worker), je Teilbereich per POST ?part=… */
  refreshUrl?: string;
  refreshParts?: string[];
  /** Endpunkt für die Zinskurve zu einem frei gewählten Stichtag (nur Cloudflare Worker). */
  curveUrl?: string;
  curveMinDate?: string;
  /** Optionaler Hinweis oben auf der Seite, z. B. für eine Vorschau. */
  notice?: string;
}

/** Antwort von /api/curve: Zinskurve zu einem frei gewählten Stichtag. */
export interface CurveAtResponse {
  date: string;
  lines: CurveLine[];
  errors?: string[];
  error?: string;
}
