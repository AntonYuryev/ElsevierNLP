-- Move every record of the Organism ID range (7000000-7999999) to the Virus ID range (5000000-5999999).
--   new ID = old ID - 2000000   (7000004 -> 5000004)   if that ID is free in the Virus range
--   otherwise the next free ID above the highest ID used in the Virus range (max + 1, max + 2, ...), in old-ID order.
-- "Used" = the ID occurs in ANY dictionary table (not only objectnames). Runs in one transaction; a temporary table holds the mapping.
-- Dry run: replace the last COMMIT with ROLLBACK.  To move only some records, add a condition to the INSERT INTO id_move below.

BEGIN;

-- 1) every ID that exists in any dictionary table
CREATE TEMP TABLE all_ids ON COMMIT DROP AS
SELECT DISTINCT medscan_id FROM (
            SELECT medscan_id FROM objectnames
  UNION ALL SELECT medscan_id FROM curnames
  UNION ALL SELECT medscan_id FROM combnames
  UNION ALL SELECT medscan_id FROM exactliteral
  UNION ALL SELECT medscan_id FROM keywords
  UNION ALL SELECT medscan_id FROM chemnames
  UNION ALL SELECT medscan_id FROM rsmap
  UNION ALL SELECT medscan_id FROM celldictionary
  UNION ALL SELECT medscan_id FROM casdictionary
  UNION ALL SELECT medscan_id FROM userdict
  UNION ALL SELECT medscan_id FROM proteinclasses
  UNION ALL SELECT medscan_id FROM ontology WHERE medscan_id IS NOT NULL
) u;
CREATE INDEX ON all_ids(medscan_id);

-- 2) the records to move: PASTE YOUR IDs between the $ids$ markers - separated by commas, spaces or new lines (one ID per line is fine)
CREATE TEMP TABLE id_list (id BIGINT) ON COMMIT DROP;
INSERT INTO id_list
SELECT DISTINCT x::bigint FROM regexp_split_to_table($ids$
7000004
7000010
7000123
$ids$, '[\s,;]+') AS x
WHERE x <> '';

CREATE TEMP TABLE id_move (old_id BIGINT PRIMARY KEY, new_id BIGINT) ON COMMIT DROP;
INSERT INTO id_move (old_id)
SELECT l.id FROM id_list l
WHERE l.id BETWEEN 7000000 AND 7999999                                                 -- only the Organism range
  AND EXISTS (SELECT 1 FROM all_ids a WHERE a.medscan_id = l.id);                      -- only IDs that exist in the dictionary

-- 3) old - 2000000 when that ID does not exist yet
UPDATE id_move m SET new_id = m.old_id - 2000000
WHERE NOT EXISTS (SELECT 1 FROM all_ids a WHERE a.medscan_id = m.old_id - 2000000);

-- 4) the others: max(ID in the Virus range) + 1, +2, ...  (also above the IDs assigned in step 3)
WITH top AS (
  SELECT GREATEST(
           COALESCE((SELECT MAX(medscan_id) FROM all_ids WHERE medscan_id BETWEEN 5000000 AND 5999999), 4999999),
           COALESCE((SELECT MAX(new_id) FROM id_move), 4999999)) AS mx
), c AS (
  SELECT old_id, ROW_NUMBER() OVER (ORDER BY old_id) AS rn FROM id_move WHERE new_id IS NULL
)
UPDATE id_move m SET new_id = top.mx + c.rn FROM c, top WHERE m.old_id = c.old_id;

-- 5) safety: everything must fit into the Virus range and be unique
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM id_move WHERE new_id IS NULL OR new_id NOT BETWEEN 5000000 AND 5999999) THEN
    RAISE EXCEPTION 'Not enough free IDs in the Virus range 5000000-5999999';
  END IF;
  IF (SELECT COUNT(DISTINCT new_id) FROM id_move) <> (SELECT COUNT(*) FROM id_move) THEN
    RAISE EXCEPTION 'Duplicate new IDs';
  END IF;
END $$;

-- 6) move the records (old IDs are 7000000-7999999 and new IDs 5000000-5999999, so nothing can chain)
UPDATE objectnames    t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE curnames       t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE combnames      t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE exactliteral   t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE keywords       t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE chemnames      t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE rsmap          t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE celldictionary t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE casdictionary  t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE userdict       t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE proteinclasses t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;
UPDATE ontology       t SET medscan_id = m.new_id FROM id_move m WHERE t.medscan_id = m.old_id;

-- 7) report (shown as the result of the script)
SELECT (SELECT COUNT(*) FROM id_list)                  AS ids_in_your_list,
       (SELECT COUNT(*) FROM id_list WHERE id NOT IN (SELECT old_id FROM id_move)) AS ids_skipped_not_in_range_or_not_found,
       COUNT(*)                                        AS records_moved,
       COUNT(*) FILTER (WHERE new_id = old_id - 2000000) AS kept_old_minus_2000000,
       COUNT(*) FILTER (WHERE new_id <> old_id - 2000000) AS got_next_free_id,
       MIN(new_id) AS min_new_id, MAX(new_id) AS max_new_id,
       (SELECT COUNT(*) FROM objectnames WHERE medscan_id BETWEEN 7000000 AND 7999999) AS objectnames_left_in_old_range
FROM id_move;

COMMIT;   -- ROLLBACK; for a dry run
