-- Move the cellDictionary aliases found by the query in step 2 (medscan_id < 2000000, alias shorter than 20 characters) to the CellLineName ID range (11000000-11999999).
--   Aliases that share one old medscan_id get ONE new ID (the same new ID for all of them).
--   new ID = 11000000 + (old ID mod 1000000)   (123 -> 11000123, 1000123 -> 11000123)   if that ID is free
--   otherwise the next free ID above the highest ID used in the CellLine range (max + 1, max + 2, ...), in old-ID order.
-- "Free" = the ID is not used in cellDictionary or ObjectNames (in the CellLine range) and no other old ID of this batch took it.
-- Only the SELECTED rows of cellDictionary move: other rows of the old ID (longer aliases, rows in other tables, the ObjectNames row of the old record) stay where they are.
-- The new records get no ObjectNames row (name / URN): add them afterwards (see the check query at the end).
-- One transaction; temporary tables hold the mapping. Dry run: replace the last COMMIT with ROLLBACK.

BEGIN;

-- 1) the rows to move (by row id): the result of the query
CREATE TEMP TABLE sel (id BIGINT PRIMARY KEY, old_id BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO sel (id, old_id)
SELECT id, medscan_id FROM celldictionary
WHERE medscan_id < 2000000
  AND length(alias) < 20;

-- 2) the IDs of the CellLine range that are used in cellDictionary or ObjectNames
CREATE TEMP TABLE used_ids ON COMMIT DROP AS
SELECT medscan_id FROM celldictionary WHERE medscan_id BETWEEN 11000000 AND 11999999
UNION
SELECT medscan_id FROM objectnames    WHERE medscan_id BETWEEN 11000000 AND 11999999;

-- 3) one new ID per old ID
CREATE TEMP TABLE id_move (old_id BIGINT PRIMARY KEY, new_id BIGINT) ON COMMIT DROP;
INSERT INTO id_move (old_id) SELECT DISTINCT old_id FROM sel;

-- 3a) the preferred ID (same last 6 digits) when it is free and no other old ID of the batch wants it (the lowest old ID gets it)
WITH pref AS (
  SELECT old_id, 11000000 + (old_id % 1000000) AS p,
         ROW_NUMBER() OVER (PARTITION BY 11000000 + (old_id % 1000000) ORDER BY old_id) AS rn
  FROM id_move
)
UPDATE id_move m SET new_id = pref.p
FROM pref
WHERE m.old_id = pref.old_id AND pref.rn = 1
  AND NOT EXISTS (SELECT 1 FROM used_ids u WHERE u.medscan_id = pref.p);

-- 3b) the others: max(ID used in the CellLine range) + 1, +2, ...
WITH top AS (
  SELECT GREATEST(
           COALESCE((SELECT MAX(medscan_id) FROM used_ids), 10999999),
           COALESCE((SELECT MAX(new_id) FROM id_move), 10999999)) AS mx
), c AS (
  SELECT old_id, ROW_NUMBER() OVER (ORDER BY old_id) AS rn FROM id_move WHERE new_id IS NULL
)
UPDATE id_move m SET new_id = top.mx + c.rn FROM c, top WHERE m.old_id = c.old_id;

-- 4) safety: everything must fit into the CellLine range and be unique
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM id_move WHERE new_id IS NULL OR new_id NOT BETWEEN 11000000 AND 11999999) THEN
    RAISE EXCEPTION 'Not enough free IDs in the CellLine range 11000000-11999999';
  END IF;
  IF (SELECT COUNT(DISTINCT new_id) FROM id_move) <> (SELECT COUNT(*) FROM id_move) THEN
    RAISE EXCEPTION 'Duplicate new IDs';
  END IF;
END $$;

-- 5) move the selected rows (by row id: only these aliases change their ID)
UPDATE celldictionary c SET medscan_id = m.new_id
FROM sel s JOIN id_move m ON m.old_id = s.old_id
WHERE c.id = s.id;

-- 6) report (shown as the result of the script)
SELECT (SELECT COUNT(*) FROM sel)                          AS aliases_moved,
       COUNT(*)                                            AS records_created,
       COUNT(*) FILTER (WHERE new_id = 11000000 + (old_id % 1000000)) AS got_preferred_id,
       COUNT(*) FILTER (WHERE new_id <> 11000000 + (old_id % 1000000)) AS got_next_free_id,
       MIN(new_id) AS min_new_id, MAX(new_id) AS max_new_id
FROM id_move;

COMMIT;   -- ROLLBACK; for a dry run

-- Afterwards: the new records have no ObjectNames row. Their IDs (the ones with an alias in cellDictionary but no name / URN):
--   select distinct c.medscan_id from celldictionary c
--   where c.medscan_id between 11000000 and 11999999 and not exists (select 1 from objectnames o where o.medscan_id = c.medscan_id);
