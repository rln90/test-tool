# Marktdaten-Dashboard

Persönliches Dashboard mit stündlich aktualisierten Marktdaten.

| Bereich | Quelle | Key |
|---|---|---|
| MSCI World (Kursindex, USD), Toyota (Tokio) | Yahoo Finance (inoffizielle Schnittstelle) | nein |
| Wechselkurse EUR → USD, GBP, JPY, CNY, CNH, PLN, SEK, NOK, RUB | Yahoo Finance, ersatzweise EZB-Referenzkurse (außer RUB, CNH) | nein |
| EZB-Leitzinsen, €STR | EZB Data Portal | nein |
| Euro-Zinskurve (AAA-Staatsanleihen) mit Vergleich vor 30 Tagen / 1 Jahr | EZB Data Portal | nein |

Fällt eine Quelle aus, bleibt der letzte veröffentlichte Stand stehen und wird als „Veraltet“ markiert.

## Ablauf

```
GitHub Actions (stündlich Mo–Fr, bei Push auf main, oder per Button „Jetzt abrufen“)
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
- `public/app-config.json`: Neulade-Intervall im Browser und GitHub-Angaben für den Button „Jetzt abrufen“.
- `.github/workflows/dashboard.yml`: Zeitplan des Datenabrufs.

## Einrichtung auf GitHub

1. *Settings → Pages → Build and deployment → Source: GitHub Actions*.
2. Änderungen nach `main` mergen; der Workflow läuft danach automatisch.
3. Für den Button „Jetzt abrufen“: ein [Fine-grained Token](https://github.com/settings/personal-access-tokens/new) nur für dieses Repository mit der Berechtigung *Actions: Read and write* anlegen. Das Dashboard fragt beim ersten Klick danach und speichert es nur im Browser.
