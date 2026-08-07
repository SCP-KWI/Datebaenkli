-- Datebänkli — demo data.
--
-- Kantone and Gemeinden are real (canton ids follow the official Swiss
-- numbering, ZH=1 … JU=26). Everything school- and shop-related is invented.
--
-- Generated rows use abs(hashtext(...)) rather than random(), so the dataset is
-- byte-identical on every deployment. That matters: v2 exercises compare a
-- student's result against a reference solution, and both must agree about
-- what "the" answer is. It also keeps the migration checksum meaningful.

-- --- Kantone -----------------------------------------------------------------

INSERT INTO demo.kantone (id, kuerzel, name, hauptort, einwohner, flaeche_km2, beitritt_jahr) VALUES
  ( 1, 'ZH', 'Zürich',                 'Zürich',        1579967, 1728.9, 1351),
  ( 2, 'BE', 'Bern',                   'Bern',          1051437, 5959.4, 1353),
  ( 3, 'LU', 'Luzern',                 'Luzern',         421046, 1493.4, 1332),
  ( 4, 'UR', 'Uri',                    'Altdorf',         37275, 1076.6, 1291),
  ( 5, 'SZ', 'Schwyz',                 'Schwyz',         165367,  907.9, 1291),
  ( 6, 'OW', 'Obwalden',               'Sarnen',          38742,  490.6, 1291),
  ( 7, 'NW', 'Nidwalden',              'Stans',           44433,  275.9, 1291),
  ( 8, 'GL', 'Glarus',                 'Glarus',          41433,  685.3, 1352),
  ( 9, 'ZG', 'Zug',                    'Zug',            130404,  238.7, 1352),
  (10, 'FR', 'Freiburg',               'Freiburg',       333433, 1670.7, 1481),
  (11, 'SO', 'Solothurn',              'Solothurn',      281616,  790.5, 1481),
  (12, 'BS', 'Basel-Stadt',            'Basel',          196735,   37.0, 1501),
  (13, 'BL', 'Basel-Landschaft',       'Liestal',        292955,  517.9, 1501),
  (14, 'SH', 'Schaffhausen',           'Schaffhausen',    84435,  298.5, 1501),
  (15, 'AR', 'Appenzell Ausserrhoden', 'Herisau',         55995,  242.9, 1513),
  (16, 'AI', 'Appenzell Innerrhoden',  'Appenzell',       16619,  172.5, 1513),
  (17, 'SG', 'St. Gallen',             'St. Gallen',     522497, 2030.7, 1803),
  (18, 'GR', 'Graubünden',             'Chur',           202538, 7105.2, 1803),
  (19, 'AG', 'Aargau',                 'Aarau',          720858, 1403.8, 1803),
  (20, 'TG', 'Thurgau',                'Frauenfeld',     288015,  991.9, 1803),
  (21, 'TI', 'Tessin',                 'Bellinzona',     350986, 2812.2, 1803),
  (22, 'VD', 'Waadt',                  'Lausanne',       826168, 3212.1, 1803),
  (23, 'VS', 'Wallis',                 'Sitten',         356309, 5224.5, 1815),
  (24, 'NE', 'Neuenburg',              'Neuenburg',      176496,  802.3, 1815),
  (25, 'GE', 'Genf',                   'Genf',           514114,  282.5, 1815),
  (26, 'JU', 'Jura',                   'Delsberg',        74187,  838.6, 1979);

-- --- Gemeinden ---------------------------------------------------------------

INSERT INTO demo.gemeinden (id, name, kanton_id, plz, einwohner) VALUES
  ( 1, 'Zürich',        1, 8001, 443037),
  ( 2, 'Winterthur',    1, 8400, 114220),
  ( 3, 'Uster',         1, 8610,  36000),
  ( 4, 'Dübendorf',     1, 8600,  30500),
  ( 5, 'Bern',          2, 3011, 134591),
  ( 6, 'Thun',          2, 3600,  43700),
  ( 7, 'Biel',          2, 2502,  55200),
  ( 8, 'Köniz',         2, 3098,  42500),
  ( 9, 'Luzern',        3, 6003,  82900),
  (10, 'Emmen',         3, 6020,  31000),
  (11, 'Altdorf',       4, 6460,   9600),
  (12, 'Schwyz',        5, 6430,  15200),
  (13, 'Einsiedeln',    5, 8840,  16300),
  (14, 'Sarnen',        6, 6060,  10600),
  (15, 'Stans',         7, 6370,   8400),
  (16, 'Glarus',        8, 8750,  12500),
  (17, 'Zug',           9, 6300,  31200),
  (18, 'Baar',          9, 6340,  25500),
  (19, 'Freiburg',     10, 1700,  38000),
  (20, 'Bulle',        10, 1630,  25000),
  (21, 'Solothurn',    11, 4500,  16900),
  (22, 'Olten',        11, 4600,  18500),
  (23, 'Basel',        12, 4051, 173863),
  (24, 'Liestal',      13, 4410,  14500),
  (25, 'Allschwil',    13, 4123,  21500),
  (26, 'Schaffhausen', 14, 8200,  36900),
  (27, 'Herisau',      15, 9100,  15300),
  (28, 'Appenzell',    16, 9050,   5800),
  (29, 'St. Gallen',   17, 9000,  76200),
  (30, 'Rapperswil',   17, 8640,  27500),
  (31, 'Chur',         18, 7000,  36500),
  (32, 'Davos',        18, 7270,  10800),
  (33, 'Aarau',        19, 5000,  21800),
  (34, 'Baden',        19, 5400,  20000),
  (35, 'Wettingen',    19, 5430,  21200),
  (36, 'Frauenfeld',   20, 8500,  26200),
  (37, 'Kreuzlingen',  20, 8280,  22600),
  (38, 'Bellinzona',   21, 6500,  44200),
  (39, 'Lugano',       21, 6900,  62300),
  (40, 'Lausanne',     22, 1003, 140202),
  (41, 'Yverdon',      22, 1400,  30800),
  (42, 'Sitten',       23, 1950,  35000),
  (43, 'Brig',         23, 3900,  13100),
  (44, 'Neuenburg',    24, 2000,  33700),
  (45, 'Genf',         25, 1201, 203856),
  (46, 'Delsberg',     26, 2800,  12600);

-- --- Fächer ------------------------------------------------------------------

INSERT INTO demo.faecher (id, name, lehrperson, lektionen) VALUES
  (1, 'Deutsch',                'Frau Bühler',     4),
  (2, 'Mathematik',             'Herr Steiner',    4),
  (3, 'Englisch',               'Frau Marti',      3),
  (4, 'Französisch',            'Herr Rochat',     3),
  (5, 'Wirtschaft und Recht',   'Frau Zingg',      3),
  (6, 'Information & Kommunikation', 'Herr Schaffner', 2),
  (7, 'Geschichte',             'Frau Aebischer',  2),
  (8, 'Sport',                  'Herr Odermatt',   2);

-- --- SchülerInnen ------------------------------------------------------------

INSERT INTO demo.schuelerinnen (id, vorname, nachname, geburtsdatum, klasse, gemeinde_id) VALUES
  ( 1, 'Lena',     'Muster',      '2008-03-14', 'K3a',  1),
  ( 2, 'Tim',      'Meier',       '2008-07-02', 'K3a',  2),
  ( 3, 'Sofia',    'Brunner',     '2008-01-25', 'K3a',  5),
  ( 4, 'Noah',     'Keller',      '2007-11-30', 'K3a',  9),
  ( 5, 'Elena',    'Widmer',      '2008-05-09', 'K3a', 17),
  ( 6, 'Luca',     'Frei',        '2008-09-21', 'K3a', 23),
  ( 7, 'Mia',      'Bühler',      '2008-02-17', 'K3a', 29),
  ( 8, 'Jonas',    'Zimmermann',  '2007-12-05', 'K3a', 33),
  ( 9, 'Nina',     'Hofer',       '2008-06-11', 'K3a', 40),
  (10, 'Elias',    'Graf',        '2008-04-28', 'K3a',  3),
  (11, 'Sara',     'Lehmann',     '2008-08-19', 'K3b',  6),
  (12, 'Levin',    'Marti',       '2008-10-07', 'K3b', 10),
  (13, 'Alina',    'Roth',        '2008-03-03', 'K3b', 12),
  (14, 'Nico',     'Schmid',      '2007-10-22', 'K3b', 18),
  (15, 'Emma',     'Baumann',     '2008-12-01', 'K3b', 24),
  (16, 'Simon',    'Hug',         '2008-07-15', 'K3b', 26),
  (17, 'Livia',    'Wyss',        '2008-05-30', 'K3b', 31),
  (18, 'Robin',    'Steiner',     '2008-01-08', 'K3b', 34),
  (19, 'Jana',     'Fischer',     '2008-09-12', 'K3b', 36),
  (20, 'Colin',    'Weber',       '2007-11-16', 'K3b', 45),
  (21, 'Anna',     'Suter',       '2009-02-20', 'W2a',  4),
  (22, 'David',    'Küng',        '2009-06-06', 'W2a',  7),
  (23, 'Leonie',   'Bachmann',    '2009-04-13', 'W2a', 13),
  (24, 'Fabio',    'Rüegg',       '2009-08-27', 'W2a', 19),
  (25, 'Selina',   'Ammann',      '2009-01-31', 'W2a', 21),
  (26, 'Andrin',   'Gerber',      '2009-10-18', 'W2a', 27),
  (27, 'Chiara',   'Kaufmann',    '2009-03-25', 'W2a', 30),
  (28, 'Marc',     'Egger',       '2009-07-09', 'W2a', 35),
  (29, 'Vanessa',  'Locher',      '2009-05-04', 'W2a', 38),
  (30, 'Timo',     'Arnold',      '2009-11-23', 'W2a', 42);

-- --- Noten -------------------------------------------------------------------

-- Three marks per student per subject, on the Swiss half-point scale.
-- Deterministic: the value is a pure function of (student, subject, index).
--
-- Half steps, not quarter steps: demo.noten.note is numeric(2,1), so a 4.25
-- would be silently rounded to 4.3 on insert. Keep the generated values
-- representable in the column they land in.
INSERT INTO demo.noten (id, schuelerin_id, fach_id, note, datum)
SELECT
  row_number() OVER (ORDER BY s.id, f.id, n)                        AS id,
  s.id,
  f.id,
  -- 3.0 … 6.0 in 0.5 steps
  3.0 + (mod(abs(hashtext('note' || s.id || '-' || f.id || '-' || n)::bigint), 7) * 0.5)
                                                                    AS note,
  (DATE '2025-08-18'
    + (mod(abs(hashtext('datum' || s.id || '-' || f.id || '-' || n)::bigint), 120) || ' days')::interval
  )::date                                                           AS datum
FROM demo.schuelerinnen s
CROSS JOIN demo.faecher f
CROSS JOIN generate_series(1, 3) AS n;

-- --- Artikel -----------------------------------------------------------------

INSERT INTO demo.artikel (id, bezeichnung, kategorie, preis, lagerbestand) VALUES
  ( 1, 'Notizbuch A5 kariert',    'Papeterie',   4.90, 320),
  ( 2, 'Notizbuch A4 liniert',    'Papeterie',   6.50, 180),
  ( 3, 'Bleistift HB',            'Papeterie',   1.20, 900),
  ( 4, 'Radiergummi',             'Papeterie',   1.50, 640),
  ( 5, 'Leuchtstift gelb',        'Papeterie',   2.80, 410),
  ( 6, 'Leuchtstift grün',        'Papeterie',   2.80, 275),
  ( 7, 'Kugelschreiber blau',     'Papeterie',   2.10, 520),
  ( 8, 'Lineal 30 cm',            'Papeterie',   3.40, 210),
  ( 9, 'Taschenrechner TI-30',    'Elektronik', 24.90,  85),
  (10, 'USB-Stick 32 GB',         'Elektronik', 12.90, 140),
  (11, 'USB-Stick 128 GB',        'Elektronik', 24.50,  60),
  (12, 'Kopfhörer On-Ear',        'Elektronik', 39.90,  35),
  (13, 'Webcam HD',               'Elektronik', 45.00,  18),
  (14, 'Maus kabellos',           'Elektronik', 19.90,  72),
  (15, 'Tastatur CH-Layout',      'Elektronik', 34.50,  40),
  (16, 'Ladekabel USB-C',         'Elektronik',  9.90, 230),
  (17, 'Ordner A4 breit',         'Ordnung',     5.20, 300),
  (18, 'Ordner A4 schmal',        'Ordnung',     4.60, 260),
  (19, 'Register 10-teilig',      'Ordnung',     3.30, 190),
  (20, 'Klarsichthüllen 100er',   'Ordnung',     8.90, 150),
  (21, 'Archivschachtel',         'Ordnung',     7.50,  95),
  (22, 'Rucksack 20 l',           'Taschen',    59.00,  25),
  (23, 'Laptoptasche 14"',        'Taschen',    35.00,  30),
  (24, 'Etui gross',              'Taschen',    14.90, 110),
  (25, 'Trinkflasche 0.75 l',     'Verpflegung',16.90,  88),
  (26, 'Znüni-Box',               'Verpflegung', 11.50,  64),
  (27, 'Thermosbecher',           'Verpflegung',22.00,  42),
  (28, 'Wörterbuch DE-FR',        'Bücher',     29.80,  55),
  (29, 'Wörterbuch DE-EN',        'Bücher',     29.80,  48),
  (30, 'Formelsammlung',          'Bücher',     18.50,  70);

-- --- Bestellungen ------------------------------------------------------------

INSERT INTO demo.bestellungen (id, schuelerin_id, datum, status)
SELECT
  b                                                                        AS id,
  1 + mod(abs(hashtext('kunde' || b)::bigint), 30)                         AS schuelerin_id,
  (DATE '2025-09-01'
    + (mod(abs(hashtext('bdatum' || b)::bigint), 150) || ' days')::interval
  )::date                                                                  AS datum,
  (ARRAY['offen', 'versendet', 'versendet', 'versendet', 'storniert'])
    [1 + mod(abs(hashtext('status' || b)::bigint), 5)]                     AS status
FROM generate_series(1, 60) AS b;

-- 1–4 positions per order. DISTINCT ON collapses the occasional duplicate
-- article the hash produces, which the composite primary key would reject.
INSERT INTO demo.bestellpositionen (bestellung_id, artikel_id, menge, einzelpreis)
SELECT DISTINCT ON (p.bestellung_id, p.artikel_id)
  p.bestellung_id,
  p.artikel_id,
  p.menge,
  a.preis
FROM (
  SELECT
    b.id                                                              AS bestellung_id,
    1 + mod(abs(hashtext('pos' || b.id || '-' || k)::bigint), 30)     AS artikel_id,
    1 + mod(abs(hashtext('menge' || b.id || '-' || k)::bigint), 5)    AS menge
  FROM demo.bestellungen b
  CROSS JOIN LATERAL generate_series(
    1,
    1 + mod(abs(hashtext('anzahl' || b.id)::bigint), 4)
  ) AS k
) p
JOIN demo.artikel a ON a.id = p.artikel_id
-- The ORDER BY is not cosmetic: without it DISTINCT ON keeps an arbitrary row
-- among the duplicates, and `menge` would differ between deployments.
ORDER BY p.bestellung_id, p.artikel_id, p.menge;

-- --- statistics --------------------------------------------------------------

ANALYZE demo.kantone;
ANALYZE demo.gemeinden;
ANALYZE demo.schuelerinnen;
ANALYZE demo.faecher;
ANALYZE demo.noten;
ANALYZE demo.artikel;
ANALYZE demo.bestellungen;
ANALYZE demo.bestellpositionen;
