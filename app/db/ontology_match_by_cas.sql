-- Ontology: rows with an old CAS URN (urn:agi-cas:<CAS>) and no medscan_id.
-- The CAS number is looked up in ExactLiteral (alias = CAS number). Only a CAS that belongs to exactly ONE medscan_id is used.
-- Then medscan_id is filled and the old URN is replaced by the CURRENT URN of that record in ObjectNames (only if the record has exactly one).
-- Step 1 previews, step 2 updates, step 3 shows what is left.

-- 1) preview
WITH un AS (SELECT id, urn, substring(urn FROM length('urn:agi-cas:') + 1) AS cas FROM ontology WHERE medscan_id IS NULL AND starts_with(urn, 'urn:agi-cas:')),
h AS (SELECT alias AS cas, min(medscan_id) AS mid FROM exactliteral WHERE (bdeleted IS NULL OR bdeleted = FALSE) AND alias IN (SELECT cas FROM un)
      GROUP BY alias HAVING count(DISTINCT medscan_id) = 1)
SELECT un.urn AS old_urn, h.mid AS medscan_id, (SELECT string_agg(DISTINCT o.urn, ', ') FROM objectnames o WHERE o.medscan_id = h.mid AND o.urn <> '') AS current_urn
FROM un JOIN h USING (cas) ORDER BY un.urn;

-- 2) update
WITH un AS (SELECT id, substring(urn FROM length('urn:agi-cas:') + 1) AS cas FROM ontology WHERE medscan_id IS NULL AND starts_with(urn, 'urn:agi-cas:')),
h AS (SELECT alias AS cas, min(medscan_id) AS mid FROM exactliteral WHERE (bdeleted IS NULL OR bdeleted = FALSE) AND alias IN (SELECT cas FROM un)
      GROUP BY alias HAVING count(DISTINCT medscan_id) = 1),
cur AS (SELECT medscan_id, min(urn) AS urn FROM objectnames WHERE urn <> '' GROUP BY medscan_id HAVING count(DISTINCT urn) = 1)
UPDATE ontology o SET medscan_id = h.mid, urn = COALESCE(cur.urn, o.urn)
FROM un JOIN h USING (cas) LEFT JOIN cur ON cur.medscan_id = h.mid WHERE o.id = un.id;

-- 3) what is left
SELECT count(*) AS total, count(medscan_id) AS with_id, count(*) - count(medscan_id) AS without_id FROM ontology;
