-- Datebänkli — teaching database, structure.
--
-- Runs as dbk_app (the database owner). Creates the shared, read-only `demo`
-- schema. Student schemas are created at provisioning time, not here.
--
-- Grants go to PUBLIC deliberately: every student role provisioned later then
-- inherits read access to the demo data with no extra grant. Nobody but
-- dbk_app can write, because dbk_app owns everything in here.

CREATE SCHEMA IF NOT EXISTS demo;

COMMENT ON SCHEMA demo IS
  'Gemeinsame Beispieldaten, nur lesbar. Shared read-only example data.';

GRANT USAGE ON SCHEMA demo TO PUBLIC;

-- --- Kantone -----------------------------------------------------------------

CREATE TABLE demo.kantone (
  id            smallint    PRIMARY KEY,
  kuerzel       char(2)     NOT NULL UNIQUE,
  name          text        NOT NULL,
  hauptort      text        NOT NULL,
  einwohner     integer     NOT NULL,
  flaeche_km2   numeric(7,1) NOT NULL,
  beitritt_jahr smallint    NOT NULL
);

COMMENT ON TABLE demo.kantone IS 'Die 26 Schweizer Kantone.';
COMMENT ON COLUMN demo.kantone.beitritt_jahr IS 'Jahr des Beitritts zur Eidgenossenschaft.';

-- --- Gemeinden ---------------------------------------------------------------

CREATE TABLE demo.gemeinden (
  id        integer  PRIMARY KEY,
  name      text     NOT NULL,
  kanton_id smallint NOT NULL REFERENCES demo.kantone(id),
  plz       integer  NOT NULL,
  einwohner integer  NOT NULL
);

CREATE INDEX gemeinden_kanton_idx ON demo.gemeinden (kanton_id);

COMMENT ON TABLE demo.gemeinden IS 'Auswahl Schweizer Gemeinden mit Kantonszuordnung.';

-- --- Schule ------------------------------------------------------------------

CREATE TABLE demo.schuelerinnen (
  id           integer PRIMARY KEY,
  vorname      text    NOT NULL,
  nachname     text    NOT NULL,
  geburtsdatum date    NOT NULL,
  klasse       text    NOT NULL,
  gemeinde_id  integer REFERENCES demo.gemeinden(id)
);

CREATE INDEX schuelerinnen_klasse_idx ON demo.schuelerinnen (klasse);

COMMENT ON TABLE demo.schuelerinnen IS 'Fiktive Lernende. Alle Namen frei erfunden.';

CREATE TABLE demo.faecher (
  id          smallint PRIMARY KEY,
  name        text     NOT NULL UNIQUE,
  lehrperson  text     NOT NULL,
  lektionen   smallint NOT NULL
);

CREATE TABLE demo.noten (
  id            integer      PRIMARY KEY,
  schuelerin_id integer      NOT NULL REFERENCES demo.schuelerinnen(id),
  fach_id       smallint     NOT NULL REFERENCES demo.faecher(id),
  note          numeric(2,1) NOT NULL,
  datum         date         NOT NULL,

  -- Schweizer Notenskala: 1.0 bis 6.0, in Viertelnoten.
  CONSTRAINT noten_note_ck CHECK (note >= 1.0 AND note <= 6.0)
);

CREATE INDEX noten_schuelerin_idx ON demo.noten (schuelerin_id);
CREATE INDEX noten_fach_idx ON demo.noten (fach_id);

COMMENT ON TABLE demo.noten IS 'Einzelnoten. Skala 1.0-6.0, 4.0 ist genuegend.';

-- --- Handel ------------------------------------------------------------------

CREATE TABLE demo.artikel (
  id           integer      PRIMARY KEY,
  bezeichnung  text         NOT NULL,
  kategorie    text         NOT NULL,
  preis        numeric(8,2) NOT NULL CHECK (preis >= 0),
  lagerbestand integer      NOT NULL CHECK (lagerbestand >= 0)
);

CREATE INDEX artikel_kategorie_idx ON demo.artikel (kategorie);

CREATE TABLE demo.bestellungen (
  id            integer PRIMARY KEY,
  schuelerin_id integer NOT NULL REFERENCES demo.schuelerinnen(id),
  datum         date    NOT NULL,
  status        text    NOT NULL CHECK (status IN ('offen', 'versendet', 'storniert'))
);

CREATE INDEX bestellungen_schuelerin_idx ON demo.bestellungen (schuelerin_id);

CREATE TABLE demo.bestellpositionen (
  bestellung_id integer      NOT NULL REFERENCES demo.bestellungen(id),
  artikel_id    integer      NOT NULL REFERENCES demo.artikel(id),
  menge         integer      NOT NULL CHECK (menge > 0),
  einzelpreis   numeric(8,2) NOT NULL,
  PRIMARY KEY (bestellung_id, artikel_id)
);

CREATE INDEX bestellpositionen_artikel_idx ON demo.bestellpositionen (artikel_id);

COMMENT ON TABLE demo.bestellpositionen IS
  'Zusammengesetzter Primaerschluessel — gut fuer JOIN- und GROUP BY-Uebungen.';

-- --- read-only for everyone --------------------------------------------------

GRANT SELECT ON ALL TABLES IN SCHEMA demo TO PUBLIC;

-- Applies to demo tables added by future migrations, so we never have to
-- remember to re-grant. Scoped to dbk_app because it owns the demo schema.
ALTER DEFAULT PRIVILEGES FOR ROLE dbk_app IN SCHEMA demo
  GRANT SELECT ON TABLES TO PUBLIC;
