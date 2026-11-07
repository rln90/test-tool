# Marktdaten-Dashboard

Web-Tool zur automatisch aktualisierenden Darstellung ausgewählter Marktdaten und Measures von [Bigdata.com](https://bigdata.com).

## Aufbau

```
Bigdata.com-API ──► scripts/fetch-bigdata.mjs ──► data/marketdata.json ──► Dashboard (dist/)
                    (mit API-Key, serverseitig)                           lädt die Datei alle N Sekunden neu
```

Der API-Key bleibt dadurch auf dem Server bzw. in der CI und landet nie im Browser.

- **Dashboard** (`src/`): Vite + TypeScript, Chart.js, Lucide-Icons. Zeigt pro Instrument Kurs, Veränderung, Kursverlauf und beliebige Kennzahlen (mit optionalem Vorwert und Mini-Verlauf). Aktualisiert sich automatisch, pausiert im Hintergrund-Tab, manuell auslösbar.
- **Laufzeit-Konfiguration** (`public/app-config.json` → `dist/app-config.json`): `dataUrl` und `refreshSeconds` (Standard 300 s), änderbar ohne neuen Build.
- **Datenformat**: siehe `src/types.ts` (`MarketData`).

## Befehle

```bash
npm install
npm run dev           # Entwicklungsserver
npm run build         # Produktions-Build nach dist/
npm run sample-data   # synthetische Beispieldaten (als solche gekennzeichnet) zum Testen
npm run fetch-data    # echte Daten über die Bigdata.com-API abrufen
```

## Bigdata.com anbinden

1. `bigdata.config.example.json` nach `bigdata.config.json` kopieren.
2. Je Instrument unter `requests` die Endpunkte eintragen und unter `price`, `series`, `measures` die Feldpfade in der API-Antwort angeben (z. B. `prices.data.history`, `tearsheet.data.pe_ratio`; das erste Segment ist der Name der Anfrage).
3. Abrufen:
   ```bash
   BIGDATA_API_KEY=... npm run fetch-data
   ```
   Optional `BIGDATA_API_URL` setzt die Basis-URL; `--out dist/data/marketdata.json` schreibt direkt in einen bestehenden Build.

Schlägt der Abruf für alle Instrumente fehl, bleibt die bisherige Datei unverändert. Einzelne Fehler werden pro Instrument im Dashboard angezeigt.

## Automatische Aktualisierung im Betrieb

Den Abruf zyklisch ausführen (z. B. Cron auf dem Webserver oder geplanter CI-Job) und die Datei nach `dist/data/marketdata.json` schreiben. Das geöffnete Dashboard übernimmt neue Daten beim nächsten Intervall automatisch.
