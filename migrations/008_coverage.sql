-- H3 hexagon grid for coverage and density (Part A §7.2). Both ship in the
-- TimescaleDB image; h3_postgis needs postgis_raster, hence CASCADE.
-- No tables: cells are computed from sites.location per query, which is
-- instant at pilot size. Production materialises them at geocode time.
CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;
