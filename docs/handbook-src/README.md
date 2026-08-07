# Handbuch-Generator

Baut `../handbuch.html` — das Handbuch für Lehrpersonen als eine einzige,
selbsttragende Datei. Fonts, Screenshots und Pfeil-Overlays sind eingebettet;
die einzigen externen URLs sind drei Seiten der PostgreSQL-Dokumentation, eine
Markdown-Kurzreferenz (Kapitel 10) und die Adresse der App selbst.

Es ist bewusst eine eigene Datei und kein Abschnitt in `docs/`: `API.md`,
`ARCHITECTURE.md` und `HANDOFF.md` richten sich an Leute, die den Code ändern.
Dieses hier richtet sich an Leute, die unterrichten, und nimmt nichts als
bekannt an.

## Nur Text ändern

Der ganze Inhalt steht in `handbuch.src.html`. Danach:

```bash
node build.mjs
```

Das genügt, solange sich die Screenshots nicht ändern: `shots/rects.json` und
`shots/web/*.webp` liegen mit im Repo, die App muss dafür nicht laufen.

## Kapitel 10 hat noch keine Abbildung

Der Übungs-Abschnitt ist bewusst rein textlich gebaut worden. Die Abbildungen
entstehen in `shots.mjs`, das mit Puppeteer durch die laufende App fährt; für
`/uebungen` gibt es dort noch keinen Ablauf. Solange keiner existiert, ist eine
fehlende Abbildung ehrlicher als eine erfundene — der Text steht für sich.

Wer das nachholt, braucht zwei Aufnahmen: die Detailansicht einer Übung mit
Tabellenliste und Verteilung, und den Balken über dem Editor mit aufgeklappter
Aufgabenstellung. Danach `{{FIG:uebungen}}` bzw. `{{FIG:uebung-balken}}` an den
passenden Stellen in `handbuch.src.html` einsetzen.

## Screenshots neu aufnehmen

Nötig, sobald sich die Oberfläche ändert. Voraussetzungen: PostgreSQL-Server
und -Client auf dem PATH (`initdb`, `pg_ctl`, `psql`), `npm install` hier **und**
in `../../app`, ImageMagick, und Chromium (`CHROME_PATH` überschreibt
`/usr/bin/chromium`).

```bash
bash refresh.sh && node build.mjs
```

`refresh.sh` baut sich einen eigenen Wegwerf-Cluster unter `/tmp/dbk-handbuch`,
startet die App auf Port 3222, füllt sie mit Demo-Daten, fährt mit Puppeteer
durch die Oberfläche, konvertiert die PNGs nach WebP und räumt beides am Ende
wieder ab. Es fasst **weder** den Cluster unter `/tmp/dbk` (HANDOFF §6) **noch**
den Server an; Port, Arbeitsverzeichnis und Datenverzeichnis sind über
`DBK_HANDBOOK_PORT`, `DBK_HANDBOOK_WORK` und `DBK_HANDBOOK_PGPORT`
verschiebbar, falls doch einmal etwas kollidiert.

Der Lauf dauert rund zweieinhalb Minuten, davon geht die Hälfte an
`initdb` und den Build.

## Was die Dateien tun

| Datei | Zweck |
|---|---|
| `handbuch.src.html` | Inhalt und Chalk-Styling. `{{FIG:name}}` und `{{FONTS}}` sind die Platzhalter; ein übrig gebliebener bricht den Build ab. |
| `build.mjs` | Setzt die Datei zusammen: Fonts einbetten, Bilder als Data-URI, Pfeile als SVG. Die Zuschnitte der Abbildungen stehen oben in `FIGURES`. |
| `shots.mjs` | Fährt die App ab und schreibt `shots/*.png` **plus** `shots/rects.json` — die Bounding-Boxen der markierten Elemente, aus denen `build.mjs` die Pfeile berechnet. Welche Elemente nummeriert werden, steht in den `shot(...)`-Aufrufen. |
| `demo_seed.mjs` | Die Demo-Klasse: eine Lehrperson, sieben Lernende, und was sie in einer Lektion angestellt haben. Läuft über die HTTP-API der App, damit nichts an einer Route vorbei erfunden wird. |
| `kioskumsatz.csv` | Die Datei, die im CSV-Abschnitt importiert wird. Schweizer Excel-Dialekt, mit Absicht. |
| `refresh.sh` | Cluster bauen → App starten → seed → `shots.mjs` → WebP → alles wieder stoppen. |
| `check.mjs` | Rendert das fertige Handbuch in Light und Dark und legt Abbildungen und Seitenstreifen unter `check/` ab — zum Drüberschauen. |
| `mobile.mjs` | Dasselbe im Handy-Viewport und meldet, ob etwas seitlich überläuft. |

## Warum ein Pfeil sitzt, wo er sitzt

Die Pfeile werden nicht von Hand platziert. `shots.mjs` liest beim
Screenshotten die Bounding-Box jedes markierten Elements aus dem DOM,
`build.mjs` legt daraus ein SVG über das Bild. Ein Layout-Wechsel in der App
verschiebt die Pfeile also automatisch mit — solange die Selektoren in
`shots.mjs` noch treffen. Fehlt einer, meldet der Lauf `!! missing`.

Was der Mechanismus **nicht** kann: zwei Elemente auf derselben Höhe. Die
Badges stehen in einer festen Spalte am Rand, also legen sich zwei Marken mit
gleichem `y` übereinander und eine davon verschwindet. Deshalb ist in mehreren
Abbildungen eine ganze Leiste oder Zelle markiert statt der einzelnen Knöpfe
darin — siehe die Kommentare bei den betroffenen `shot(...)`-Aufrufen.

## Viewports

Desktop 1280×880 (dsf 2) für alles, weil Datebänkli ein Laptop-Werkzeug ist:
Das Layout klappt unter ~820 px zusammen und die Seite ist auf 1180 px
begrenzt. Die Lektionsansicht bekommt zusätzlich einen Tablet-Viewport
820×1180, weil das die einzige Seite ist, die man im Unterricht in der Hand
hält. Ein Handy-Viewport (390) wurde bewusst **nicht** verwendet: Dort ist die
Tabelle breiter als der Bildschirm, und beide möglichen Zuschnitte — mitsamt
Überlauf oder abgeschnitten — würden die App falsch darstellen.

## Nicht im Repo

`node_modules/`, `check/`, die PNG-Zwischenstufe unter `shots/` und
`shots/demo.json` — siehe `.gitignore`. Das Repo ist öffentlich, und
`demo.json` hält die Zugangspasswörter des Wegwerf-Clusters im Klartext; sie
sind mit dem Cluster ohnehin weg, aber eine solche Datei einzuchecken ist die
falsche Angewohnheit. `shots.mjs` liest sie im selben Lauf, in dem
`demo_seed.mjs` sie schreibt, also fehlt sie nie, wenn sie gebraucht wird.
