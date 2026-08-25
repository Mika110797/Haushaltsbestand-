# Haushaltsbestand v1.5 – Sicherheit & Backup

Auf GitHub nur diese Dateien ersetzen:
- app.js
- sw.js

Neu:
- Artikel werden beim Löschen nur noch in den Papierkorb verschoben.
- Papierkorb im Bereich „Haushalt“ mit Wiederherstellen-Funktion.
- „Backup sichern“ erstellt eine JSON-Sicherungsdatei mit Kategorien, Artikeln, Beständen, Favoriten, Mindestbeständen, Packungsgrößen, Erkennungsbegriffen und Papierkorb.
- Auf iPhone/iPad wird nach Möglichkeit das Teilen-Menü geöffnet, damit das Backup z. B. in „Dateien“ gespeichert werden kann.
- „Backup wiederherstellen“ liest diese Sicherungsdatei wieder ein.
- Wiederherstellung ist absichtlich nicht zerstörerisch: Artikel, die nach dem Backup neu angelegt wurden, bleiben erhalten.
- Der Statistik-Fix aus v1.4.2 ist bereits enthalten.

Die Supabase-Datenbank wurde bereits passend erweitert.
