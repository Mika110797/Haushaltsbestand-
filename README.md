# Haushaltsbestand v1.6.1 – Cache-Fix

Bitte auf GitHub diese **3 Dateien ersetzen**:
- index.html
- app.js
- sw.js

Warum diesmal index.html?
Die neue app.js wird jetzt ausdrücklich als `app.js?v=161` geladen. Damit kann die installierte Home-Bildschirm-App nicht mehr so leicht eine alte JavaScript-Datei aus dem Cache weiterverwenden.

Nach erfolgreichem Update erscheint in der Bestandsansicht ganz oben:
🏠 Vanessa · 🏠 Mika · 🏘️ Alle

Alle bisherigen Daten liegen weiterhin unter Vanessas Haushalt.
