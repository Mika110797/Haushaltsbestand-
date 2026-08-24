# Haushaltsbestand – Version 1

Kleine deutschsprachige PWA für einen gemeinsamen Haushaltsbestand auf iPhone und Android.

## Funktionen
- Zwei getrennte Benutzerkonten
- Gemeinsamer Haushalt per 8-stelligem Einladungscode
- Kategorien und beliebige Haushaltsartikel
- Exakter Bestand mit großen + / − Buttons
- Mindestbestand
- Automatische Einkaufsliste
- Echtzeit-Synchronisierung über Supabase
- Installierbar auf dem Homescreen

## Einrichtung
1. Supabase-Projekt und Datenbank sind bereits eingerichtet und `config.js` ist verbunden.
2. Die Dateien über einen HTTPS-Webhost bereitstellen (z. B. GitHub Pages, Cloudflare Pages, Netlify oder Vercel).
3. Auf beiden Handys öffnen und zum Homescreen hinzufügen.
4. Person 1: Konto anlegen → Haushalt erstellen.
5. Person 2: eigenes Konto anlegen → Einladungscode eingeben.

## Beispiel
- Katzenfutter Huhn: 24 Stk., Mindestbestand 8
- Klopapier: 18 Rollen, Mindestbestand 6
- Cola Zero: 12 Flaschen, Mindestbestand 4

Wenn ein Artikel den Mindestbestand erreicht oder unterschreitet, erscheint er automatisch im Tab „Einkauf“.


## Technischer Stand
- Supabase-Datenbank ist eingerichtet.
- Row Level Security ist aktiv; anonyme Tabellenzugriffe sind gesperrt.
- Frontend nutzt den Publishable Key, niemals einen Secret-/Service-Role-Key.
- Supabase JS ist auf Version 2.112.4 festgesetzt.
- Noch offen: HTTPS-Hosting der statischen PWA.
