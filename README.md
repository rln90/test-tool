# Marktdaten-Dashboard

Web-Tool zur automatisch aktualisierenden Darstellung ausgewählter Marktdaten:

| Bereich | Quelle | Schlüssel nötig |
|---|---|---|
| Aktien/ETF-Kurse (MSCI World über iShares MSCI World ETF, Toyota) | [Bigdata.com](https://bigdata.com) Structured Data API | ja (`BIGDATA_API_KEY`) |
| EZB-Leitzinsen, €STR | [EZB Data Portal](https://data.ecb.europa.eu) | nein |
| Euro-Zinskurve (AAA-Staatsanleihen) inkl. Vergleich vor 30 Tagen / 1 Jahr | EZB Data Portal | nein |

## Ablauf

```
GitHub Actions (zeitgesteuert)
  └─ npm run fetch-data  → public/data/marketdata.json   (Bigdata.com + EZB)
  └─ npm run build       → dist/                         (fertige Webseite)
  └─ Veröffentlichung auf GitHub Pages
Browser: lädt data/marketdata.json alle 5 Minuten neu
```

Der API-Key liegt nur als GitHub-Secret vor und gelangt nie in die Webseite.

## Befehle

```bash
npm install
npm run fetch-data    # Daten holen (BIGDATA_API_KEY als Umgebungsvariable)
npm run dev           # Entwicklungsserver
npm run build         # Produktions-Build nach dist/
npm run sample-data   # synthetische Beispieldaten zum Testen der Oberfläche
```

## Konfiguration

- `data.config.json`: welche Instrumente (Bigdata.com `rpEntityId`), Zinsreihen und Laufzeiten abgerufen werden.
- `public/app-config.json`: Neulade-Intervall im Browser (`refreshSeconds`).
- `.github/workflows/dashboard.yml`: Zeitplan des Datenabrufs (Standard: werktags stündlich).

## Einrichtung auf GitHub

1. API-Key unter [platform.bigdata.com/api-keys](https://platform.bigdata.com/api-keys) anlegen.
2. Im Repository: *Settings → Secrets and variables → Actions → New repository secret*, Name `BIGDATA_API_KEY`.
3. *Settings → Pages → Build and deployment → Source: GitHub Actions*.
4. Änderungen nach `main` mergen; danach läuft der Workflow automatisch (oder unter *Actions → Dashboard aktualisieren → Run workflow*).
