# Marktdaten-Dashboard

Persönliches Dashboard mit stündlich aktualisierten Marktdaten.

| Bereich | Quelle | Key |
|---|---|---|
| ETFs (Xetra, EUR): iShares Core MSCI World, Vanguard FTSE Emerging Markets, Xtrackers MSCI World IT, Amundi Core Stoxx Europe 600; Bitcoin in EUR | Yahoo Finance (inoffizielle Schnittstelle) | nein |
| Wechselkurse EUR → USD, GBP, JPY, CNY, PLN, SEK, NOK, RUB | Yahoo Finance, ersatzweise EZB-Referenzkurse (außer RUB) | nein |
| EZB-Leitzinsen, €STR | EZB Data Portal | nein |
| Euro-Zinskurve: EURIBOR (1 W – 12 M), ab 2 J. Pfandbriefe und AAA-Staatsanleihen, Vergleich vor 30 Tagen / 1 Jahr | Bundesbank (EURIBOR, Pfandbriefe), EZB (AAA) | nein |

EUR-Swapsätze sind nicht enthalten: Es gibt keine kostenlose Quelle (lizenzpflichtig). Die Pfandbrief-Kurve der Bundesbank dient als frei verfügbare Näherung für das Zinsniveau von Banken. EURIBOR-Tageswerte veröffentlicht die Bundesbank mit einem Tag Verzögerung; laut Hinweis dort ist eine kommerzielle Nutzung lizenzpflichtig (EMMI).

Fällt eine Quelle aus, bleibt der letzte veröffentlichte Stand stehen und wird als „Veraltet“ markiert.

## Aufbau der Seite

1. **Überblick:** EZB-Einlagezins, Rendite 10 J., Steilheit der Zinskurve (10 J. – 2 J.), EUR/USD
2. **Märkte:** Kursliste mit Tag, 1 M, 6 M und Verlauf; Klick auf eine Zeile zeigt den Chart (1 M bis 6 M aus Tageskursen, 1 / 2 / 3 / 5 J mit Wochenschlusskursen; Zeiträume ohne Daten sind ausgegraut)
3. **Zinsen:** Euro-Zinskurve (EURIBOR bis 12 M, danach Pfandbriefe und AAA-Staatsanleihen); Vergleich mit „vor 30 Tagen“, „vor 1 Jahr“ oder einem frei wählbaren Stichtag ab 06.09.2004 (nur auf Cloudflare); daneben Leitzinsen, EURIBOR und Renditen
4. **Währungen:** Wechselkurse mit Tages-, 1-Monats- und 6-Monats-Veränderung

## Betrieb auf Cloudflare (empfohlen)

Ein Cloudflare Worker liefert die Seite aus und ruft die Daten selbst ab – ohne GitHub Actions.

```
Cloudflare Worker „marktdaten-dashboard“
  ├─ ein Cron-Ausdruck „5-9 * * * *“ = stündlich 5 Läufe; die Minute wählt den Teilbereich:
  │    :05 ETFs & Bitcoin, :06 Wechselkurse, :07 EZB-Leitzinsen, :08 Zinskurve, :09 5-Jahres-Verlauf → KV-Speicher
  ├─ GET  /data/marketdata.json → Daten aus dem KV-Speicher
  ├─ POST /api/refresh?part=…   → Button „Aktualisieren“ (höchstens 1× pro Minute je Bereich)
  ├─ GET  /api/curve?date=…     → Zinskurve zu einem frei gewählten Stichtag (vergangene Tage dauerhaft zwischengespeichert)
  └─ alle anderen Pfade         → statische Seite aus dist/
```

Die Aufteilung in fünf Läufe hält jeden Lauf unter dem CPU-Limit des kostenlosen Workers-Tarifs (10 ms).

### Einrichtung

1. Cloudflare-Dashboard → *Workers & Pages* → *Create* → *Import a repository* → GitHub verbinden und `rln90/test-tool` wählen.
2. Projektname: `marktdaten-dashboard` (muss zu `wrangler.jsonc` passen), Branch `main`,
   Build command `npm run build`, Deploy command `npx wrangler deploy`.
3. Nach dem ersten Deploy die angezeigte `*.workers.dev`-Adresse öffnen und „Aktualisieren“ klicken.
   Die IDs der KV-Speicher stehen in `wrangler.jsonc` (Produktiv- und Vorschau-Speicher).
4. Optional, damit nur du die Seite sehen kannst: *Zero Trust → Access → Applications* → Self-hosted-Anwendung für die
   Worker-Adresse, Richtlinie „Allow“ mit deiner E-Mail-Adresse, Anmeldung per One-time PIN (kostenlos bis 50 Nutzer).
5. Danach den GitHub-Workflow abschalten: *Actions → Dashboard aktualisieren → ⋯ → Disable workflow*.

Jeder Push auf `main` baut und veröffentlicht automatisch neu.

**Vorschau:** Für jeden Pull Request legt Cloudflare eine Vorschau-Version an und schreibt ihre Adresse als Kommentar in den
Pull Request. Vorschauen nutzen den eigenen KV-Speicher `marktdaten-dashboard-preview` und haben keine stündlichen Läufe –
Daten dort per „Aktualisieren“ laden. Vorschau-Adressen sind öffentlich erreichbar.

```bash
npm run cf:dev     # Worker lokal starten (Lauf testen: http://localhost:8787/cdn-cgi/handler/scheduled?cron=5-9+*+*+*+*&time=<Zeitpunkt in ms>)
npm run deploy     # manuell veröffentlichen (wrangler login nötig)
```

## Betrieb über GitHub Pages (bisherig)

```
GitHub Actions (stündlich Mo–Fr, bei Push auf main, oder per Button „Aktualisieren“)
  └─ npm run fetch-data  → public/data/marketdata.json
  └─ npm run build       → dist/
  └─ Veröffentlichung auf GitHub Pages
Browser: lädt die Datendatei alle 5 Minuten neu
```

## Befehle

```bash
npm install
npm run fetch-data    # Daten holen
npm run dev           # Entwicklungsserver
npm run build         # Produktions-Build nach dist/
npm run sample-data   # synthetische Beispieldaten zum Testen der Oberfläche
```

## Konfiguration

- `data.config.json`: Instrumente (Yahoo-Symbole), Währungen, EZB-Zinsreihen, Laufzeiten der Zinskurve.
- `public/app-config.json`: Neulade-Intervall im Browser und GitHub-Angaben für den Button „Aktualisieren“.
- `.github/workflows/dashboard.yml`: Zeitplan des Datenabrufs auf GitHub.
- `wrangler.jsonc`, `worker/index.js`: Cloudflare Worker (Zeitplan unter `triggers.crons`).
- `scripts/lib/collect.mjs`: gemeinsamer Datenabruf für GitHub-Skript und Worker.

## Einrichtung auf GitHub

1. *Settings → Pages → Build and deployment → Source: GitHub Actions*.
2. Änderungen nach `main` mergen; der Workflow läuft danach automatisch.
3. Für den Button „Aktualisieren“: ein [Fine-grained Token](https://github.com/settings/personal-access-tokens/new) nur für dieses Repository mit der Berechtigung *Actions: Read and write* anlegen. Das Dashboard fragt beim ersten Klick danach und speichert es nur im Browser.
