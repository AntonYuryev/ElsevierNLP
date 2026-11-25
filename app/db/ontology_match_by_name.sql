-- Ontology: fill medscan_id for rows the URN match left empty, by NAME.
-- The name is the last part of the URN, URL-decoded (urn:agi-protfc:JUN%20family -> "JUN family"),
-- compared case-insensitively with objectnames.name. Only a name that belongs to exactly ONE medscan_id is used.
-- Run in the app's SQL tab / psql. Step 1 previews, step 2 updates.

CREATE OR REPLACE FUNCTION pg_temp.urldecode(t text) RETURNS text AS $$
  SELECT convert_from(decode(string_agg(CASE WHEN length(m[1]) = 1 THEN encode(convert_to(m[1], 'UTF8'), 'hex') ELSE substring(m[1] from 2 for 2) END, ''), 'hex'), 'UTF8')
  FROM regexp_matches(t, '%[0-9a-fA-F]{2}|.', 'g') AS m
$$ LANGUAGE sql IMMUTABLE;

-- 1) preview
WITH un AS (
  SELECT id, urn, lower(pg_temp.urldecode(substring(urn FROM '^urn:[^:]*:(.*)$'))) AS nm FROM ontology WHERE medscan_id IS NULL
), hit AS (
  SELECT lower(name) AS nm, min(medscan_id) AS medscan_id FROM objectnames WHERE lower(name) IN (SELECT nm FROM un)
  GROUP BY lower(name) HAVING count(DISTINCT medscan_id) = 1
)
SELECT un.urn, un.nm AS name, hit.medscan_id FROM un JOIN hit USING (nm) ORDER BY un.urn;

-- 2) update
WITH un AS (
  SELECT id, lower(pg_temp.urldecode(substring(urn FROM '^urn:[^:]*:(.*)$'))) AS nm FROM ontology WHERE medscan_id IS NULL
), hit AS (
  SELECT lower(name) AS nm, min(medscan_id) AS medscan_id FROM objectnames WHERE lower(name) IN (SELECT nm FROM un)
  GROUP BY lower(name) HAVING count(DISTINCT medscan_id) = 1
)
UPDATE ontology o SET medscan_id = hit.medscan_id FROM un JOIN hit USING (nm) WHERE o.id = un.id;

-- 3) what is left
SELECT count(*) AS total, count(medscan_id) AS with_id, count(*) - count(medscan_id) AS without_id FROM ontology;
