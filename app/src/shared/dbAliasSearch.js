/**
 * Bulk database alias search — the same logic as "Edit Record → search by alias"
 * (DictionaryScreen.searchAlias), batched for thousands of aliases:
 *
 *   1. Tokenized search: for every dictionary table the alias is normalized with that table's
 *      own rules (normalizeForTable) and matched against the table's `normalized` column.
 *   2. Fallback (only for aliases with NO tokenized hit in any table): plain case-insensitive
 *      search LOWER(alias) = LOWER(input) in every table.
 *
 * Tables: curnames, userdict, celldictionary, casdictionary, combnames, exactliteral
 * (chemnames / keywords / rsmap are not searched). The fallback also checks ObjectNames.name.
 *
 * Renderer-only (window.api.db.query).
 */
import { normalizeForTable } from './duplicateCheck.js';

const ACTIVE = `(bdeleted IS NULL OR bdeleted = FALSE)`;
const NORM_TABLES = ['curnames', 'userdict', 'celldictionary', 'casdictionary', 'combnames', 'exactliteral'];
const CHUNK = 2000;
const q = (sql, params) => window.api.db.query(sql, params);

const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };

/**
 * @param {string[]} aliases
 * @returns {Promise<Map<string, {alias:string, hits:Array<{msId:number, table:string, dbAlias:string, via:'tokenized'|'alias'}>, name:string}>>}
 *          keyed by lower-cased input alias; only aliases with at least one hit are present.
 */
export async function findAliasesInDb(aliases) {
  const uniq = [...new Map(aliases.map(a => [a.toLowerCase(), a])).values()];
  const found = new Map(); // lower alias → { alias, hits: [] }
  const addHit = (lowerAlias, alias, hit) => {
    if (!found.has(lowerAlias)) found.set(lowerAlias, { alias, hits: [], name: '' });
    const e = found.get(lowerAlias);
    if (!e.hits.some(h => h.msId === hit.msId && h.table === hit.table && h.dbAlias === hit.dbAlias)) e.hits.push(hit);
  };

  // ── 1. Tokenized search, every table in parallel ──────────────────────────
  await Promise.all(NORM_TABLES.map(async tbl => {
    // key → input aliases producing it (different aliases can normalize to the same key)
    const keyToAliases = new Map();
    for (const a of uniq) {
      const key = await normalizeForTable(a, tbl);
      if (!key) continue;
      if (!keyToAliases.has(key)) keyToAliases.set(key, []);
      keyToAliases.get(key).push(a);
    }
    const keys = [...keyToAliases.keys()];
    for (const part of chunks(keys)) {
      const sql = tbl === 'exactliteral'
        ? `SELECT medscan_id, alias, LOWER(alias) AS k FROM exactliteral WHERE LOWER(alias) = ANY($1) AND ${ACTIVE}`
        : `SELECT medscan_id, alias, normalized AS k FROM ${tbl} WHERE normalized = ANY($1) AND ${ACTIVE}`;
      const res = await q(sql, [part]);
      if (!res.ok) continue;
      for (const row of res.rows)
        for (const a of keyToAliases.get(row.k) || [])
          addHit(a.toLowerCase(), a, { msId: Number(row.medscan_id), table: tbl, dbAlias: row.alias, via: 'tokenized' });
    }
  }));
  // ── 2. Fallback: case-insensitive search for aliases still unmatched ─────────
  // Every dictionary table by alias, plus ObjectNames by entity name (rsmap is NOT searched:
  // it only duplicates curnames / exactliteral).
  const rest = uniq.filter(a => !found.has(a.toLowerCase()));
  if (rest.length) {
    const lowers = [...new Set(rest.map(a => a.toLowerCase()))];
    const byLower = new Map(rest.map(a => [a.toLowerCase(), a]));
    await Promise.all([...NORM_TABLES, 'objectnames'].map(async tbl => {
      for (const part of chunks(lowers)) {
        const sql = tbl === 'objectnames'
          ? `SELECT medscan_id, name AS alias, LOWER(name) AS k FROM objectnames WHERE LOWER(name) = ANY($1) AND ${ACTIVE}`
          : `SELECT medscan_id, alias, LOWER(alias) AS k FROM ${tbl} WHERE LOWER(alias) = ANY($1) AND ${ACTIVE}`;
        const res = await q(sql, [part]);
        if (!res.ok) continue;
        for (const row of res.rows) {
          const a = byLower.get(row.k);
          if (a) addHit(row.k, a, { msId: Number(row.medscan_id), table: tbl, dbAlias: row.alias, via: 'alias' });
        }
      }
    }));
  }

  // ── Entity names for display ───────────────────────────────────────────────
  const ids = [...new Set([...found.values()].flatMap(e => e.hits.map(h => h.msId)))];
  const names = new Map();
  for (const part of chunks(ids)) {
    const res = await q(`SELECT medscan_id, name FROM objectnames WHERE medscan_id = ANY($1)`, [part]);
    if (res.ok) res.rows.forEach(r => names.set(Number(r.medscan_id), r.name));
  }
  for (const e of found.values()) {
    const first = e.hits[0];
    e.name = first ? (names.get(first.msId) || '') : '';
    e.hits.forEach(h => { h.name = names.get(h.msId) || ''; });
  }
  return found;
}
