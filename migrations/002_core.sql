-- Core catalogue: Operator (tenant) -> Site -> Charger -> Connector.
-- The vendor feed has no site catalogue endpoint, so this is loaded at CPO
-- onboarding (here: from the pilot dataset).

CREATE TABLE operators (
  operator_id text PRIMARY KEY,
  name        text    NOT NULL,
  country     char(2) NOT NULL,
  currency    char(3) NOT NULL,
  timezone    text    NOT NULL  -- IANA zone, never a fixed offset
);

CREATE TABLE csms_connections (
  connection_id      text PRIMARY KEY,
  vendor             text NOT NULL,
  base_url           text NOT NULL,
  webhook_secret_ref text NOT NULL  -- name in the secrets manager, never the secret
);

CREATE TABLE sites (
  site_id            text PRIMARY KEY,
  operator_id        text NOT NULL REFERENCES operators,
  connection_id      text NOT NULL REFERENCES csms_connections,
  name               text NOT NULL,
  address            text NOT NULL,
  country            char(2) NOT NULL,
  timezone           text NOT NULL,
  -- The vendor sends no coordinates; these come from the geocoding chain.
  location           geography(Point, 4326),
  geocode_status     text NOT NULL DEFAULT 'pending'
                     CHECK (geocode_status IN ('pending', 'resolved', 'unresolved')),
  geocode_precision  text CHECK (geocode_precision IN ('rooftop', 'street', 'landmark', 'postal_code', 'city')),
  geocode_source     text,
  geocode_confidence numeric(3, 2),
  geocoded_at        timestamptz,
  synthetic          boolean NOT NULL DEFAULT false,
  CHECK ((geocode_status = 'resolved') = (location IS NOT NULL))
);
CREATE INDEX sites_location_gix ON sites USING gist (location);
CREATE INDEX sites_operator_idx ON sites (operator_id);

-- Human-verified coordinates win over any geocoder result.
CREATE TABLE geocode_overrides (
  site_id    text PRIMARY KEY REFERENCES sites ON DELETE CASCADE,
  lat        double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng        double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  precision  text NOT NULL,
  note       text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cached provider results, keyed by normalised address. Only providers whose
-- licence allows permanent storage may be cached here.
CREATE TABLE geocode_cache (
  address_key text PRIMARY KEY,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  precision   text NOT NULL,
  source      text NOT NULL,
  confidence  numeric(3, 2),
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Assumption: vendor charger IDs are unique within GridWatch. If a vendor
-- cannot guarantee that, IDs are namespaced by connection at onboarding.
CREATE TABLE chargers (
  charger_id    text PRIMARY KEY,
  site_id       text NOT NULL REFERENCES sites,
  operator_id   text NOT NULL REFERENCES operators,
  connection_id text NOT NULL REFERENCES csms_connections,
  model         text,
  max_kw        numeric(7, 2) NOT NULL CHECK (max_kw > 0)
);
CREATE INDEX chargers_site_idx ON chargers (site_id);

CREATE TABLE connectors (
  charger_id   text NOT NULL REFERENCES chargers,
  connector_id text NOT NULL,
  operator_id  text NOT NULL REFERENCES operators,
  site_id      text NOT NULL REFERENCES sites,
  PRIMARY KEY (charger_id, connector_id)
);
CREATE INDEX connectors_site_idx ON connectors (site_id);

-- The brief gives no tariffs. Seeded rows are marked is_sample.
CREATE TABLE tariffs (
  tariff_id     text PRIMARY KEY,
  operator_id   text NOT NULL REFERENCES operators,
  currency      char(3) NOT NULL,
  price_per_kwh numeric(12, 4) NOT NULL CHECK (price_per_kwh >= 0),
  session_fee   numeric(12, 2) NOT NULL CHECK (session_fee >= 0),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  is_sample     boolean NOT NULL DEFAULT true,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX tariffs_lookup_idx ON tariffs (operator_id, valid_from DESC);
