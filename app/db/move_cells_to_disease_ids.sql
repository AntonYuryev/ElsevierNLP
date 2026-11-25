-- Move the records (medscan_id) found by the cellDictionary query in step 2 from the 11000000-11999999 range to the Disease ID range (9000000-9999999).
--   new ID = old ID - 2000000   (11033671 -> 9033671)   if that ID does not exist in the dictionary yet
--   otherwise the next free ID above the highest ID used in the Disease range (max + 1, max + 2, ...), in old-ID order.
-- "Exists" = the ID occurs in ANY dictionary table, looked up only within 9000000-9999999 (the new ID must be free everywhere). Only ObjectNames and cellDictionary are moved: the selected aliases exist only there.
-- All the rows of the ID in those two tables move (also aliases of the record that the query does not select).
-- The URN (urn:agi-cellline:<name>) becomes urn:agi-disease:<name> (step 6b).
-- One transaction; temporary tables hold the mapping. Dry run: replace the last COMMIT with ROLLBACK.

BEGIN;

-- 1) the IDs of the Disease range (9000000-9999999) that exist in ANY dictionary table: a new ID must not be in this list (old - 2000000 always falls into this range)
CREATE TEMP TABLE all_ids ON COMMIT DROP AS
SELECT DISTINCT medscan_id FROM (
            SELECT medscan_id FROM objectnames WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM curnames WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM combnames WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM exactliteral WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM keywords WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM chemnames WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM rsmap WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM celldictionary WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM casdictionary WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM userdict WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM proteinclasses WHERE medscan_id BETWEEN 9000000 AND 9999999
  UNION ALL SELECT medscan_id FROM ontology WHERE medscan_id BETWEEN 9000000 AND 9999999
) u;

-- 2) the records to move: the medscan_ids of the rows this query returns
CREATE TEMP TABLE id_move (old_id BIGINT PRIMARY KEY, new_id BIGINT) ON COMMIT DROP;
INSERT INTO id_move (old_id)
SELECT DISTINCT medscan_id FROM celldictionary
WHERE medscan_id BETWEEN 11000000 AND 11999999
  AND alias LIKE '%oma'
  AND alias NOT LIKE '%nstitute%'
  AND alias NOT LIKE '%niversity%'
  AND substr(alias, 1, 5) !~ '\s'
  AND alias !~ '[0-9]'
  AND alias !~* '\m(mouse|mice|murine|rat|rats|rodent|hamster|hamsters|guinea pig|gerbil|rabbit|rabbits|chicken|chickens|avian|duck|quail|dog|dogs|canine|cat|cats|feline|ferret|mink|pig|pigs|porcine|swine|boar|cow|cows|cattle|bovine|calf|horse|equine|sheep|ovine|goat|caprine|monkey|macaque|rhesus|baboon|marmoset|chimpanzee|primate|simian|zebrafish|fish|trout|salmon|medaka|xenopus|frog|toad|drosophila|fruit fly|caenorhabditis|c\. elegans|yeast|arabidopsis|e\. coli|bacterial|viral|human|humans|rattlesnake|tamarin|budgerigar|poeciliopsis|xiphophorus )\M';

-- 3) old - 2000000 when that ID does not exist yet
UPDATE id_move m SET new_id = m.old_id - 2000000
WHERE NOT EXISTS (SELECT 1 FROM all_ids a WHERE a.medscan_id = m.old_id - 2000000);

-- 4) the others: max(ID in the Disease range) + 1, +2, ...  (also above the IDs assigned in step 3)
WITH top AS (
  SELECT GREATEST(
           COALESCE((SELECT MAX(medscan_id) FROM all_ids WHERE medscan_id BETWEEN 9000000 AND 9999999), 8999999),
           COALESCE((SELECT MAX(new_id) FROM id_move), 8999999)) AS mx
), c AS (
  SELECT old_id, ROW_NUMBER() OVER (ORDER BY old_id) AS rn FROM id_move WHERE new_id IS NULL
)
UPDATE id_move m SET new_id = top.mx + c.rn FROM c, top WHERE m.old_id = c.old_id;

-- 5) safety: everything must fit into the Disease range and be unique
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM id_move WHERE new_id IS NULL OR new_id NOT BETWEEN 9000000 AND 9999999) THEN
    RAISE EXCEPTION 'Not enough free IDs in the Disease range 9000000-9999999';
  END IF;
  IF (SELECT COUNT(DISTINCT new_id) FROM id_move) <> (SELECT COUNT(*) FROM id_move) THEN
    RAISE EXCEPTION 'Duplicate new IDs';
  END IF;
END $$;

-- 6) move the records: ObjectNames and cellDictionary only (old IDs are 11000000-11999999 and new IDs 9000000-9999999, so nothing can chain)
UPDATE objectnames    t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE celldictionary t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;

-- 6b) the URN follows the new entity type: urn:agi-cellline:<name>  ->  urn:agi-disease:<name>  (urnTag of Cell lines = cellline, of Diseases = disease; entityTypes.js).
--     ObjectNames only. Only URNs with that prefix are changed; any other URN (e.g. an external database id) stays as it is - the report counts them.
UPDATE objectnames t SET urn = 'urn:agi-disease:' || substr(t.urn, length('urn:agi-cellline:') + 1)
FROM id_move m WHERE t.medscan_id = m.new_id AND t.urn LIKE 'urn:agi-cellline:%';

-- 7) report (shown as the result of the script)
SELECT COUNT(*)                                         AS records_moved,
       COUNT(*) FILTER (WHERE new_id = old_id - 2000000) AS kept_old_minus_2000000,
       COUNT(*) FILTER (WHERE new_id <> old_id - 2000000) AS got_next_free_id,
       MIN(new_id) AS min_new_id, MAX(new_id) AS max_new_id,
       (SELECT COUNT(*) FROM objectnames o JOIN id_move m ON o.medscan_id = m.new_id WHERE o.urn LIKE 'urn:agi-disease:%') AS objectnames_with_disease_urn,
       (SELECT COUNT(*) FROM objectnames o JOIN id_move m ON o.medscan_id = m.new_id WHERE o.urn IS NULL OR o.urn NOT LIKE 'urn:agi-disease:%') AS objectnames_urn_left_unchanged
FROM id_move;

COMMIT;   -- ROLLBACK; for a dry run
