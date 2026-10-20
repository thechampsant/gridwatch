-- Why each site's location is what it is, in plain words. Shown to operators
-- next to the pin and in the location review list ("Address matched only
-- postal area 201301 ...", "No postal code in the address", "Pinned by operations").
ALTER TABLE sites ADD COLUMN geocode_note text;
