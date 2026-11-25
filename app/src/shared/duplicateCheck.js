/**
 * Shared duplicate-checking utilities for the NLPmanager renderer.
 *
 * Used by: DictionaryScreen (Single Entry, Batch Import), AddAliasDialog (Curate).
 *
 * All functions call window.api.db.query — they are renderer-only despite living
 * in src/shared/ for organisational convenience.
 *
 * Organism / cartridge filtering rules
 * ─────────────────────────────────────
 * "Same alias in a different organism (or cartridge) is NOT a duplicate."
 *
 *   importOrganism  (string | null)
 *     • null  → no filter, any DB row is a match
 *     • value → DB rows whose organisms array is non-empty AND does not include
 *               importOrganism are skipped (they belong to a different organism)
 *
 *   importCartridges  (string[] | null)
 *     • null / []  → no filter, any DB row is a match
 *     • value      → DB rows whose cartridges array is non-empty AND has no
 *                    overlap with importCartridges are skipped
 */

import { makeNormalizer, makeCombTokenizer, makeTokenizer, buildSeparatorSet,
         convertGreekToLatin, normalizeForTableSync, tokenizeForTableSync,
         setXwordsLoader, tokenizeAlias, normalizeAlias, ALL_XWORDS_TABLES, setSpellingMap as _unusedSetSpelling } from './tokenizer.js';

// Register the renderer's xwords loader with the shared tokenizer (single place that reads the xwords tables).
setXwordsLoader(async () => {
  const q = (sql) => window.api.db.query(sql);
  const [sets, sp] = await Promise.all([
    Promise.all(ALL_XWORDS_TABLES.map(async tbl => {
      const r = await q(`SELECT xword FROM ${tbl} ORDER BY xword LIMIT 5000`);
      return [tbl, r.ok ? new Set(r.rows.map(x => x.xword.toLowerCase())) : new Set()];
    })),
    q('SELECT canonical, spellings FROM spelling LIMIT 20000'),
  ]);
  let spelling = null;
  if (sp.ok && sp.rows.length > 0) {
    spelling = new Map();
    for (const row of sp.rows) {
      const canonical = (row.canonical || '').trim().toLowerCase();
      for (const v of (row.spellings || '').trim().toLowerCase().split(/\s+/).filter(Boolean))
        if (v && v !== canonical) spelling.set(v, canonical);
    }
  }
  return { sets: Object.fromEntries(sets), spelling };
});

// ── Local factory helpers (Greek pre-step + makeNormalizer/makeTokenizer) ─────
// Used by batch functions that need a pre-built normalizer applied to many aliases.
function makeXwordNormalizer(xwordSet, { stemming = true, separatorSet = null } = {}) {
  const tok = makeNormalizer(xwordSet, { stemming, separatorSet });
  return (s, originalAlias = null) => tok(
    convertGreekToLatin(s),
    originalAlias != null ? convertGreekToLatin(originalAlias) : null
  );
}
function makeXwordTokenizer(xwordSet, { separatorSet = null } = {}) {
  const tok = makeTokenizer(xwordSet, { separatorSet });
  return (s) => tok(convertGreekToLatin(s));
}
function makeXwordCombTokenizer(xwordSet, { preserveSigns = false, separatorSet = null } = {}) {
  const tok = makeCombTokenizer(xwordSet, { preserveSigns, separatorSet });
  return (s) => tok(convertGreekToLatin(s));
}

// ── Per-table xword cache (loaded once per renderer session) ─────────────────
// Maps xwords table name → Set<string>
const _xwCache = {};

async function _loadXwordSet(xwordsTable) {
  if (!_xwCache[xwordsTable]) {
    const r = await window.api.db.query(`SELECT xword FROM ${xwordsTable} ORDER BY xword LIMIT 5000`);
    const set = r.ok ? new Set(r.rows.map(x => x.xword.toLowerCase())) : new Set();
    // Cache only a successful, non-empty load — a failed/empty read must not make every later
    // tokenization in this session run without xwords.
    if (set.size > 0) _xwCache[xwordsTable] = set;
    return set;
  }
  return _xwCache[xwordsTable];
}

/**
 * Load (or return cached) xword sets for all four xwords tables and compute the
 * global separator set.  Call this once before running several normalizeForTable
 * calls to avoid per-call DB round-trips.
 */
async function _loadAllXwAndSepSet() {
  const [xw, xwCells, xwCas, xwComb] = await Promise.all([
    _loadXwordSet('xwords'),
    _loadXwordSet('xwords_cells'),
    _loadXwordSet('xwords_cas'),
    _loadXwordSet('xwords_comb'),
  ]);
  const sepSet = buildSeparatorSet({ xwords: xw, xwords_cells: xwCells, xwords_cas: xwCas, xwords_comb: xwComb });
  return { xw, xwCells, xwCas, xwComb, sepSet };
}

/**
 * Compute the Phase-2 (normalized column) form of an alias for a given dictionary table.
 *
 * This is the canonical routing function — always use this when you need to compare
 * an alias against the 'normalized' column of a specific table.
 *
 * Rule: the tokenization/normalization must exactly match what the DB stores in the
 * 'normalized' column for that table, i.e. the same pipeline used by retokenize.
 *
 * @param {string} alias       Raw alias string (Greek letters accepted — converted internally)
 * @param {string} tableName   'curnames' | 'exactliteral' | 'celldictionary' | 'casdictionary' |
 *                             'chemnames' | 'userdict' | 'keywords' | 'combnames'
 * @param {string} [matchFlag='']  Only used for exactliteral ('l' = literal/case-sensitive)
 * @returns {Promise<string>}  Normalized form, ready for LOWER(normalized) = LOWER($1) queries
 */
export async function normalizeForTable(alias, tableName, matchFlag = '') {
  if (tableName === 'exactliteral') {
    // exactliteral: for match='l' keep verbatim, otherwise lowercase.
    return matchFlag?.includes('l') ? alias : alias.toLowerCase();
  }
  return normalizeAlias(alias, tableName, matchFlag);   // shared tokenizer.js entry point (loads xwords itself)
}

/**
 * Compute the Phase-1 (tokenized column) form of an alias for a given dictionary table.
 *
 * Use this when you need to compare against the 'tokenized' column (Phase-1, no stemming).
 *
 * @param {string} alias
 * @param {string} tableName
 * @param {string} [matchFlag='']  For combnames match='c': preserves +/- signs in tokenized form.
 * @returns {Promise<string>}
 */
export async function tokenizeForTable(alias, tableName, matchFlag = '') {
  // exactliteral with a literal ('l') flag is case-sensitive: tokenized is the alias VERBATIM
  // (same value Retokenize / exactLiteralTokenized store). Lower-casing it made 'ANA' and 'ana' look identical.
  if (tableName === 'exactliteral' && (matchFlag || '').includes('l')) return alias;
  if (tableName === 'exactliteral' || tableName === 'rsmap' || tableName === 'chemnames') {
    return alias.toLowerCase();
  }
  return tokenizeAlias(alias, tableName, matchFlag);    // shared tokenizer.js entry point (loads xwords itself)
}

// ── Shared constants ──────────────────────────────────────────────────────────
const _EL_ACTIVE = `(bdeleted IS NULL OR bdeleted = FALSE)`;
const _ACTIVE    = `(bdeleted IS NULL OR bdeleted = FALSE)`;

// ── Organism / cartridge compatibility helpers ────────────────────────────────
/**
 * Returns true when a DB row's organism set is compatible with the import organism.
 * Compatible: no import organism, OR DB row has no organisms, OR organisms overlap.
 * @param {object}        row
 * @param {string|null}   importOrganism  — single string or null
 */
function organismMatch(row, importOrganism) {
  if (!importOrganism) return true;
  const rowOrgs = Array.isArray(row.organisms) ? row.organisms : [];
  if (rowOrgs.length === 0) return true; // unspecified → treat as global
  return rowOrgs.includes(importOrganism);
}

/**
 * Returns true when a DB row's cartridge set is compatible with the import cartridges.
 * Compatible: no import cartridges, OR DB row has no cartridges, OR cartridges overlap.
 * @param {object}        row
 * @param {string[]|null} importCartridges  — array or null/[]
 */
function cartridgeMatch(row, importCartridges) {
  if (!importCartridges || importCartridges.length === 0) return true;
  const rowCarts = Array.isArray(row.cartridges) ? row.cartridges : [];
  if (rowCarts.length === 0) return true; // unspecified → treat as global
  return importCartridges.some(c => rowCarts.includes(c));
}

/**
 * Combined organism + cartridge compatibility check.
 */
function dupMatch(row, importOrganism, importCartridges) {
  return organismMatch(row, importOrganism) && cartridgeMatch(row, importCartridges);
}

// ── ExactLiteral duplicate search ────────────────────────────────────────────
/**
 * Single-alias lookup against exactliteral (alias column, not tokenized).
 *
 * Match semantics (mirrors MedScan runtime):
 *   incoming 'l*' vs stored 'l*'   → case-sensitive   (alias = $1)
 *   incoming 'l*' vs stored non-l  → case-insensitive (LOWER(alias) = LOWER($1))
 *   incoming non-'l' vs stored any → case-insensitive (LOWER(alias) = LOWER($1))
 *
 * @param {string}      alias      Raw alias string (not pre-tokenized)
 * @param {string}      matchFlag
 * @param {string|null} [importOrganism]
 * @param {string[]|null} [importCartridges]
 * @returns {Promise<object|null>}  Matching DB row or null.  Throws on DB error.
 */
export async function findExactLiteralDup(alias, matchFlag, importOrganism = null, importCartridges = null) {
  const isLit = matchFlag?.includes('l');
  const sql = isLit
    ? `SELECT medscan_id, alias, match, cartridges, organisms
       FROM exactliteral WHERE ${_EL_ACTIVE} AND (
         (match LIKE '%l%' AND alias = $1)
         OR ((match IS NULL OR match NOT LIKE '%l%') AND LOWER(alias) = LOWER($1))
       )`
    : `SELECT medscan_id, alias, match, cartridges, organisms
       FROM exactliteral WHERE ${_EL_ACTIVE} AND LOWER(alias) = LOWER($1)`;
  const res = await window.api.db.query(sql, [alias]);
  if (!res.ok) throw new Error(res.error);
  // Apply organism/cartridge filter — return first compatible row
  for (const row of res.rows) {
    if (dupMatch(row, importOrganism, importCartridges)) return row;
  }
  return null;
}

/**
 * Batch lookup against exactliteral.
 *
 * @param {string[]}                 aliases
 * @param {(alias: string) => string} getMatchFlag   Per-alias matchFlag supplier
 * @param {string|null}              [importOrganism]
 * @param {string[]|null}            [importCartridges]
 * @returns {Promise<Map<string, object|null>>}  alias → first compatible row | null
 */
export async function findExactLiteralDupBatch(aliases, getMatchFlag, importOrganism = null, importCartridges = null) {
  const CHUNK = 8000;
  const result = new Map(aliases.map(a => [a, null]));

  for (let i = 0; i < aliases.length; i += CHUNK) {
    const chunk        = aliases.slice(i, i + CHUNK);
    const litAliases    = chunk.filter(a =>  getMatchFlag(a)?.includes('l'));
    const nonLitAliases = chunk.filter(a => !getMatchFlag(a)?.includes('l'));

    // Literal-match incoming aliases ──────────────────────────────────────────
    if (litAliases.length) {
      const verbatims = [...new Set(litAliases)];
      const lowers    = verbatims.map(a => a.toLowerCase());

      // Case-sensitive vs stored 'l*' entries
      const ra = await window.api.db.query(
        `SELECT medscan_id, alias, match, cartridges, organisms
         FROM exactliteral WHERE ${_EL_ACTIVE} AND match LIKE '%l%' AND alias = ANY($1)`,
        [verbatims]
      );
      if (!ra.ok) throw new Error(ra.error);
      for (const row of ra.rows) {
        if (result.get(row.alias) === null && dupMatch(row, importOrganism, importCartridges))
          result.set(row.alias, row);
      }

      // Case-insensitive vs stored non-l entries
      const rb = await window.api.db.query(
        `SELECT medscan_id, alias, match, cartridges, organisms, LOWER(alias) AS tok
         FROM exactliteral WHERE ${_EL_ACTIVE} AND (match IS NULL OR match NOT LIKE '%l%') AND LOWER(alias) = ANY($1)`,
        [lowers]
      );
      if (!rb.ok) throw new Error(rb.error);
      const lowToLit = new Map(litAliases.map(a => [a.toLowerCase(), a]));
      for (const row of rb.rows) {
        const orig = lowToLit.get(row.tok);
        if (orig && result.get(orig) === null && dupMatch(row, importOrganism, importCartridges))
          result.set(orig, row);
      }
    }

    // Non-literal incoming aliases ────────────────────────────────────────────
    if (nonLitAliases.length) {
      const tokToAliases = new Map();
      for (const a of nonLitAliases) {
        const lk = a.toLowerCase();
        if (!tokToAliases.has(lk)) tokToAliases.set(lk, []);
        tokToAliases.get(lk).push(a);
      }
      const lowers = [...tokToAliases.keys()];
      const r2 = await window.api.db.query(
        `SELECT medscan_id, alias, match, cartridges, organisms, LOWER(alias) AS tok
         FROM exactliteral WHERE ${_EL_ACTIVE} AND LOWER(alias) = ANY($1)`,
        [lowers]
      );
      if (!r2.ok) throw new Error(r2.error);
      for (const row of r2.rows) {
        for (const orig of (tokToAliases.get(row.tok) || [])) {
          if (result.get(orig) === null && dupMatch(row, importOrganism, importCartridges))
            result.set(orig, row);
        }
      }
    }
  }
  return result;
}

/**
 * Single-alias duplicate check for a known table.
 *
 * Accepts the raw alias string — routing to the correct tokenizer/normalizer for
 * tableName is done internally via normalizeForTable().  Callers must NOT pre-tokenize.
 *
 * For exactliteral delegates to findExactLiteralDup (alias column, not normalized).
 * For all other tables computes the Phase-2 normalized form and queries the normalized column.
 *
 * @param {string}        alias             Raw alias string (not pre-tokenized)
 * @param {string}        tableName
 * @param {string}        matchFlag
 * @param {string|null}   [importOrganism]
 * @param {string[]|null} [importCartridges]
 * @returns {Promise<object|null>}  Matching DB row or null.  Throws on DB error.
 */
export async function checkDuplicate(alias, tableName, matchFlag, importOrganism = null, importCartridges = null) {
  if (tableName === 'exactliteral') {
    return findExactLiteralDup(alias, matchFlag, importOrganism, importCartridges);
  }
  // keywords: the word is stored verbatim in the column "keywords" (no alias / normalized columns), compared case-insensitively
  if (tableName === 'keywords') {
    const kw = await window.api.db.query(
      `SELECT medscan_id, keywords AS alias, match, cartridges, organisms
       FROM keywords WHERE ${_ACTIVE} AND LOWER(keywords) = LOWER($1)`,
      [alias]
    );
    if (!kw.ok) throw new Error(kw.error);
    for (const row of kw.rows) if (dupMatch(row, importOrganism, importCartridges)) return row;
    return null;
  }
  // Compute Phase-2 normalized form using the correct per-table rules
  const normalized = await normalizeForTable(alias, tableName, matchFlag);
  const res = await window.api.db.query(
    `SELECT medscan_id, alias, match, cartridges, organisms
     FROM ${tableName} WHERE ${_ACTIVE} AND LOWER(normalized) = LOWER($1)`,
    [normalized]
  );
  if (!res.ok) throw new Error(res.error);
  for (const row of res.rows) {
    if (dupMatch(row, importOrganism, importCartridges)) return row;
  }
  // Fallback: raw alias match — catches algorithm-mismatch (stored normalized computed
  // with older algorithm) and NULL normalized (pre-backfill). LOWER(alias) is always correct.
  const fb = await window.api.db.query(
    `SELECT medscan_id, alias, match, cartridges, organisms
     FROM ${tableName} WHERE ${_ACTIVE} AND LOWER(alias) = LOWER($1)`,
    [alias]
  );
  if (!fb.ok) throw new Error(fb.error);
  for (const row of fb.rows) {
    if (dupMatch(row, importOrganism, importCartridges)) return row;
  }
  return null;
}

/**
 * Check ALL entity tables for a duplicate of `alias` (single-entry form).
 *
 * Computes the correct tokenized form per table using the pre-loaded xword Sets.
 * Returns { dup: row, dict: tableName } | null
 *
 * @param {string}        alias
 * @param {Set}           xwCurnames
 * @param {Set}           xwCells
 * @param {Set}           xwCas
 * @param {string}        [exactliteralMatchFlag='']
 * @param {Set|null}      [xwComb=null]
 * @param {string|null}   [importOrganism=null]
 * @param {string[]|null} [importCartridges=null]
 * @returns {Promise<{dup: object, dict: string}|null>}
 */
export async function checkDuplicateAllTables(
  alias, xwCurnames, xwCells, xwCas,
  exactliteralMatchFlag = '', xwComb = null,
  importOrganism = null, importCartridges = null,
  separatorSet = null
) {
  const tokCur  = makeXwordNormalizer(xwCurnames, { separatorSet })(alias);
  const tokCell = makeXwordNormalizer(xwCells,    { separatorSet })(alias);
  const tokCas  = makeXwordNormalizer(xwCas,      { stemming: false, separatorSet })(alias);

  const otherChecks = [
    { tbl: 'curnames',       tok: tokCur,  sql: `SELECT medscan_id, alias, match, cartridges, organisms FROM curnames WHERE ${_ACTIVE} AND LOWER(normalized) = LOWER($1)` },
    { tbl: 'celldictionary', tok: tokCell, sql: `SELECT medscan_id, alias, match, cartridges, organisms FROM celldictionary WHERE ${_ACTIVE} AND LOWER(normalized) = LOWER($1)` },
    { tbl: 'casdictionary',  tok: tokCas,  sql: `SELECT medscan_id, alias, match, cartridges, organisms FROM casdictionary WHERE ${_ACTIVE} AND LOWER(normalized) = LOWER($1)` },
    { tbl: 'userdict',       tok: tokCur,  sql: `SELECT medscan_id, alias, match, cartridges, organisms FROM userdict WHERE ${_ACTIVE} AND LOWER(normalized) = LOWER($1)` },
    // combnames intentionally excluded: the same alias can coexist in combnames and any other dict
  ];

  // Helper: query a table by normalized then fall back to raw LOWER(alias) for NULL-normalized rows.
  const queryTable = async (tbl, tok, sql) => {
    const res = await window.api.db.query(sql, [tok]);
    if (!res.ok) throw new Error(res.error);
    for (const row of res.rows) {
      if (dupMatch(row, importOrganism, importCartridges)) return row;
    }
    // Fallback: raw alias match — catches algorithm-mismatch (stored normalized computed
    // with older algorithm) and NULL normalized (pre-backfill). LOWER(alias) is always correct.
    const fb = await window.api.db.query(
      `SELECT medscan_id, alias, match, cartridges, organisms
       FROM ${tbl} WHERE ${_ACTIVE} AND LOWER(alias) = LOWER($1)`,
      [alias]
    );
    if (!fb.ok) throw new Error(fb.error);
    for (const row of fb.rows) {
      if (dupMatch(row, importOrganism, importCartridges)) return row;
    }
    return null;
  };

  // 1. curnames first (most common)
  const curCheck = otherChecks[0];
  const curRow = await queryTable(curCheck.tbl, curCheck.tok, curCheck.sql);
  if (curRow) return { dup: curRow, dict: curCheck.tbl };

  // 2. ExactLiteral via canonical function
  const elRow = await findExactLiteralDup(alias, exactliteralMatchFlag, importOrganism, importCartridges);
  if (elRow) return { dup: elRow, dict: 'exactliteral' };

  // 3. Remaining tables
  for (const { tbl, tok, sql } of otherChecks.slice(1)) {
    const row = await queryTable(tbl, tok, sql);
    if (row) return { dup: row, dict: tbl };
  }
  return null;
}

/**
 * Batch duplicate check — ONE query per table (6 queries total for N aliases).
 *
 * Returns Map<alias, {dup, dict}|null>
 *
 * @param {string[]}          aliases
 * @param {Set}               xwCurnames
 * @param {Set}               xwCells
 * @param {Set}               xwCas
 * @param {string|null}       [limitToTable=null]       Check only this table when set
 * @param {Set|null}          [xwComb=null]
 * @param {string}            [elMatchFlag='l']         Default exactliteral matchFlag
 * @param {Map|null}          [aliasMatchMap=null]       Per-alias matchFlags from file col 3
 * @param {string|null}       [importOrganism=null]      Organism filter
 * @param {string[]|null}     [importCartridges=null]    Cartridge filter
 * @returns {Promise<Map<string, {dup: object, dict: string}|null>>}
 */
export async function batchCheckDuplicates(
  aliases, xwCurnames, xwCells, xwCas,
  limitToTable = null, xwComb = null, elMatchFlag = 'l',
  aliasMatchMap = null, importOrganism = null, importCartridges = null,
  separatorSet = null
) {
  const CHUNK = 8000;
  const result = new Map(aliases.map(a => [a, null]));

  // Phase-2 normalizers per table (for 'normalized' column lookups).
  // separatorSet must match what retokenize uses (union of single-char xwords from ALL tables)
  // so that splitting behaviour is identical and the computed normalized form matches what is
  // stored in the DB.  Without this, a char like straight-apostrophe that is in celldictionary
  // xwords (and therefore in the union separator) would be split when building the DB value but
  // NOT split here, producing a different normalized form and causing false "new alias" hits.
  const normCurnames = makeXwordNormalizer(xwCurnames, { separatorSet });
  const normCells    = makeXwordNormalizer(xwCells,    { separatorSet });
  const normCas      = makeXwordNormalizer(xwCas,      { stemming: false, separatorSet });
  // Phase-1 tokenizers per table (for 'tokenized' column lookups).
  const tokCurnames  = makeXwordTokenizer(xwCurnames, { separatorSet });
  const tokCells     = makeXwordTokenizer(xwCells,    { separatorSet });
  const tokCas       = makeXwordTokenizer(xwCas,      { separatorSet });

  const allChecks = [
    { tbl: 'curnames',       col: 'alias', tokFn: a => normCurnames(a).toLowerCase(), normFn: tokCurnames },
    { tbl: 'exactliteral',   col: 'alias', tokFn: null /* handled below */,            normFn: null },
    { tbl: 'celldictionary', col: 'alias', tokFn: a => normCells(a).toLowerCase(),     normFn: tokCells },
    { tbl: 'casdictionary',  col: 'alias', tokFn: a => normCas(a).toLowerCase(),       normFn: tokCas },
    { tbl: 'userdict',       col: 'alias', tokFn: a => normCurnames(a).toLowerCase(),  normFn: tokCurnames },
    // combnames excluded: same alias may coexist in combnames and any other dict
  ];
  const tableChecks = limitToTable
    ? allChecks.filter(c => c.tbl === limitToTable)
    : allChecks;

  for (const { tbl, col, tokFn, normFn } of tableChecks) {
    const unmatched = [...result.entries()].filter(([, v]) => v === null).map(([a]) => a);
    if (!unmatched.length) break;

    // ── ExactLiteral — delegate to findExactLiteralDupBatch ─────────────────
    if (tbl === 'exactliteral') {
      const getMatchFlag = (a) => {
        if (aliasMatchMap && aliasMatchMap.has(a)) return aliasMatchMap.get(a);
        return elMatchFlag === '__from_file__' ? '' : elMatchFlag;
      };
      const elResult = await findExactLiteralDupBatch(
        unmatched, getMatchFlag, importOrganism, importCartridges
      );
      for (const [a, row] of elResult) {
        if (row !== null && result.get(a) === null)
          result.set(a, { dup: row, dict: 'exactliteral' });
      }
      continue;
    }

    // ── Phase 2: normalized join (case-insensitive, stemmed form) ───────────
    // tokFn here computes the Phase-2 normalized form; queries the 'normalized' column.
    for (let i = 0; i < unmatched.length; i += CHUNK) {
      const chunk = unmatched.slice(i, i + CHUNK);
      const tokToAliases = new Map();
      for (const a of chunk) {
        const tok = tokFn(a);
        if (!tokToAliases.has(tok)) tokToAliases.set(tok, []);
        tokToAliases.get(tok).push(a);
      }
      const tokList = [...tokToAliases.keys()];
      const res = await window.api.db.query(
        `SELECT medscan_id, ${col} AS alias, match, cartridges, organisms, LOWER(normalized) AS tok
         FROM "${tbl}" WHERE LOWER(normalized) = ANY($1) AND ${_ACTIVE}`,
        [tokList]
      );
      if (!res.ok) throw new Error(res.error);
      for (const row of res.rows) {
        for (const origAlias of (tokToAliases.get(row.tok) || [])) {
          if (result.get(origAlias) === null && dupMatch(row, importOrganism, importCartridges))
            result.set(origAlias, { dup: row, dict: tbl });
        }
      }
    }

    // ── Phase 1: tokenized join — only for aliases not yet matched, and only
    //    when Phase-1 form differs from Phase-2 form (stemming changed something).
    // normFn here computes the Phase-1 tokenized form; queries the 'tokenized' column.
    if (normFn) {
      const stillUnmatched = [...result.entries()].filter(([, v]) => v === null).map(([a]) => a);
      // Filter to aliases where Phase-1 ≠ Phase-2 (Phase 1 adds new information)
      const phase1Aliases = stillUnmatched.filter(a => normFn(a) !== tokFn(a));
      for (let i = 0; i < phase1Aliases.length; i += CHUNK) {
        const chunk = phase1Aliases.slice(i, i + CHUNK);
        const normToAliases = new Map();
        for (const a of chunk) {
          const norm = normFn(a);
          if (!normToAliases.has(norm)) normToAliases.set(norm, []);
          normToAliases.get(norm).push(a);
        }
        const normList = [...normToAliases.keys()];
        const res = await window.api.db.query(
          `SELECT medscan_id, ${col} AS alias, match, cartridges, organisms, tokenized AS norm
           FROM "${tbl}" WHERE tokenized = ANY($1) AND ${_ACTIVE}`,
          [normList]
        );
        if (!res.ok) throw new Error(res.error);
        for (const row of res.rows) {
          for (const origAlias of (normToAliases.get(row.norm) || [])) {
            if (result.get(origAlias) === null && dupMatch(row, importOrganism, importCartridges))
              result.set(origAlias, { dup: row, dict: tbl });
          }
        }
      }
    }

    // ── Phase 0: raw alias fallback — catches rows where the stored normalized was
    //    computed with an older algorithm (algorithm mismatch) or is NULL.
    //    Compares LOWER(alias_in_db) = LOWER(alias_from_file) as a last resort.
    {
      const stillUnmatched = [...result.entries()].filter(([, v]) => v === null).map(([a]) => a);
      if (stillUnmatched.length > 0) {
        for (let i = 0; i < stillUnmatched.length; i += CHUNK) {
          const chunk = stillUnmatched.slice(i, i + CHUNK);
          const lowerToAliases = new Map();
          for (const a of chunk) {
            const key = a.toLowerCase();
            if (!lowerToAliases.has(key)) lowerToAliases.set(key, []);
            lowerToAliases.get(key).push(a);
          }
          const lowerList = [...lowerToAliases.keys()];
          const res = await window.api.db.query(
            `SELECT medscan_id, ${col} AS alias, match, cartridges, organisms, LOWER(${col}) AS tok
             FROM "${tbl}" WHERE LOWER(${col}) = ANY($1) AND ${_ACTIVE}`,
            [lowerList]
          );
          if (!res.ok) throw new Error(res.error);
          for (const row of res.rows) {
            for (const origAlias of (lowerToAliases.get(row.tok) || [])) {
              if (result.get(origAlias) === null && dupMatch(row, importOrganism, importCartridges))
                result.set(origAlias, { dup: row, dict: tbl });
            }
          }
        }
      }
    }
  }
  return result;
}

/**
 * Find all tokenized conflicts within a single alias table.
 *
 * Two alias rows conflict when they share the same tokenized form but belong to
 * different medscan_ids.  Organism rule (same as dupMatch / organismMatch):
 *   • If either record has no organisms (NULL or empty array) → global record
 *     → IS a conflict with anything.
 *   • If both records have non-empty, non-overlapping organism sets
 *     → different organisms → NOT a conflict.
 *
 * For exactliteral two separate self-joins are performed:
 *   Part 1  both rows have match LIKE '%l%'  → case-sensitive join on tokenized
 *   Part 2  at least one row is non-literal  → tokenized is already lowercase,
 *           plain equality is sufficient
 *
 * @param {string} table   Alias table to scan:
 *                         curnames | exactliteral | celldictionary | keywords |
 *                         userdict | casdictionary | chemnames | combnames
 * @param {number} [limit=5000]   Maximum number of conflict rows to return.
 * @returns {Promise<Array<{
 *   rowIdNewer:   number,
 *   newerMsId:   number,
 *   newerName:   string,
 *   newerAlias:  string,
 *   newerUpdated: string,
 *   rowIdOlder:   number,
 *   olderMsId:   number,
 *   olderName:   string,
 *   olderAlias:  string,
 *   olderUpdated: string,
 *   tokenized:   string,
 * }>>}  Throws on DB error.
 */
export async function findTableConflicts(table, limit = 5000, filterMsIds = null) {
  // ── rsmap: cross-join conflict detection (protein_name vs curnames/exactliteral alias) ──
  // rsmap has no alias column — conflicts are rows where protein_name matches an alias
  // in curnames or exactliteral but the medscan_id differs.
  if (table === 'rsmap') {
    const msFilter = filterMsIds && filterMsIds.length >= 2
      ? `AND (r.medscan_id = ANY($1) OR c.medscan_id = ANY($1))`
      : '';
    const queryParams = filterMsIds && filterMsIds.length >= 2 ? [filterMsIds] : [];

    // Run curnames and exactliteral joins in parallel — each is an independent query.
    const makeQuery = (srcTable) => `
      SELECT DISTINCT ON (r.medscan_id, c.medscan_id, r.protein_name)
        c.id           AS row_id_newer,
        c.medscan_id   AS newer_ms_id,
        c.alias        AS newer_alias,
        r.id           AS row_id_older,
        r.medscan_id   AS older_ms_id,
        r.protein_name AS older_alias,
        r.hgvs_code    AS hgvs_code,
        r.urn          AS rsmap_urn,
        r.protein_name AS tokenized,
        '${srcTable}'  AS src_table
      FROM rsmap r
      JOIN ${srcTable} c ON c.alias = r.protein_name
      WHERE r.medscan_id <> c.medscan_id
        AND (r.bdeleted IS NULL OR r.bdeleted = FALSE)
        AND (c.bdeleted IS NULL OR c.bdeleted = FALSE)
        ${msFilter}
      ORDER BY r.medscan_id, c.medscan_id, r.protein_name, r.id
      LIMIT ${limit}
    `;

    const [resCur, resExact] = await Promise.all([
      window.api.db.query(makeQuery('curnames'),    queryParams),
      window.api.db.query(makeQuery('exactliteral'), queryParams),
    ]);
    if (!resCur.ok)   throw new Error(resCur.error   || 'findTableConflicts rsmap/curnames query failed');
    if (!resExact.ok) throw new Error(resExact.error || 'findTableConflicts rsmap/exactliteral query failed');

    const mapRow = r => ({
      rowIdNewer:   Number(r.row_id_newer),
      newerMsId:    Number(r.newer_ms_id),
      newerAlias:   r.newer_alias,
      rowIdOlder:   Number(r.row_id_older),
      olderMsId:    Number(r.older_ms_id),
      olderAlias:   r.older_alias,
      hgvsCode:     r.hgvs_code,
      rsmapUrn:     r.rsmap_urn,
      tokenized:    r.tokenized,
      srcTable:     r.src_table,
    });

    // Merge and sort by protein_name then newer_ms_id
    return [...resCur.rows.map(mapRow), ...resExact.rows.map(mapRow)]
      .sort((a, b) => a.tokenized.localeCompare(b.tokenized) || a.newerMsId - b.newerMsId);
  }

  const aliasCol = table === 'keywords' ? 'keywords' : 'alias';
  // Tables that don't have an organisms column — skip the organism-overlap filter
  const NO_ORGANISMS_TABLES = new Set(['chemnames', 'combnames', 'keywords', 'rsmap']);
  // Optional filter: when provided, only return conflicts involving these specific medscan_ids.
  // Used by Edit Record to power the cross-record conflict banner without duplicating logic.
  const msFilter = filterMsIds && filterMsIds.length >= 2
    ? `AND a.medscan_id = ANY($1) AND b.medscan_id = ANY($1)`
    : '';

  // When filterMsIds is provided (Edit Record), restrict the CTE to only those records
  // instead of scanning all of objectnames (which can have 100k+ rows).
  const cteFilter = filterMsIds && filterMsIds.length >= 2
    ? `WHERE medscan_id = ANY($1)`
    : '';
  const cte = `
    WITH ranked_objectnames AS (
      SELECT medscan_id, name, organisms,
             ROW_NUMBER() OVER (PARTITION BY medscan_id ORDER BY id) AS rn
      FROM objectnames ${cteFilter}
    )`;

  const cols = `
      a.id            AS row_id_newer,
      a.medscan_id    AS newer_ms_id,
      obj_a.name      AS newer_name,
      a.${aliasCol}   AS newer_alias,
      a.updated_at    AS newer_updated,
      b.id            AS row_id_older,
      b.medscan_id    AS older_ms_id,
      obj_b.name      AS older_name,
      b.${aliasCol}   AS older_alias,
      b.updated_at    AS older_updated,
      a.normalized    AS tokenized`;

  const joins = `
      LEFT JOIN ranked_objectnames obj_a
             ON obj_a.medscan_id = a.medscan_id AND obj_a.rn = 1
      LEFT JOIN ranked_objectnames obj_b
             ON obj_b.medscan_id = b.medscan_id AND obj_b.rn = 1`;

  // Organism overlap rule — mirrors organisMatch() above:
  // only flag a conflict when the two records could refer to the same
  // real-world entity.  Empty / NULL organisms = global = conflicts with anything.
  // PostgreSQL && operator → true when two text[] arrays share ≥ 1 element.
  //
  // Use the alias-table organisms (a.organisms / b.organisms) rather than
  // objectnames.organisms — the latter is only written on initial record creation
  // and is never updated when organisms are changed later via Edit Record, so it
  // can be stale and cause real conflicts to be silently missed.
  //
  // Tables without an organisms column (chemnames, combnames, rsmap, keywords) skip this filter.
  const orgFilter = NO_ORGANISMS_TABLES.has(table) ? '' : `
      AND (
        a.organisms IS NULL OR a.organisms = '{}'
        OR b.organisms IS NULL OR b.organisms = '{}'
        OR a.organisms && b.organisms
      )`;

  const activeWhere = `
      a.normalized IS NOT NULL AND a.normalized <> ''
      AND (a.bdeleted IS NULL OR a.bdeleted = FALSE)
      AND (b.bdeleted IS NULL OR b.bdeleted = FALSE)
      ${orgFilter}`;

  // exactliteral stores both case-sensitive ('l*' match) and case-insensitive
  // aliases in the same table, so two separate self-joins are needed.
  const sql = table === 'exactliteral' ? `
    ${cte}
    -- Part 1: both rows are literal-match ('l') → CASE-SENSITIVE: they conflict only when the alias text
    -- is identical. Compared on the alias itself, not on the 'normalized' column — normalized is stored
    -- lower-cased by some write paths, which made literal 'ANA' and literal 'ana' look like a conflict
    -- although MedScan treats them as two different case-sensitive patterns.
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  a.alias = b.alias
      AND a.medscan_id > b.medscan_id
      AND a.match LIKE '%l%' AND b.match LIKE '%l%'
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    UNION
    -- Part 2: both rows are non-literal → compare case-insensitively
    -- (one row may store 'ORFAB' verbatim while the other stores 'orfab' lowercased)
    -- Literal rows ('l' match) are intentionally excluded: Medscan resolves them by
    -- alias string, not normalized form, so e.g. literal 'tmx67' and non-literal
    -- 'TMX 67' both normalise to 'tmx 67' but match DIFFERENT text patterns — they
    -- are not NLP duplicates.  Literal-vs-literal conflicts are caught in Part 1.
    -- COALESCE handles NULL match (displayed as "—") — NULL is treated as non-literal.
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  LOWER(a.normalized) = LOWER(b.normalized)
      AND a.medscan_id > b.medscan_id
      AND COALESCE(a.match, '') NOT LIKE '%l%'
      AND COALESCE(b.match, '') NOT LIKE '%l%'
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    UNION
    -- Part 4: one row is literal ('l'), the other non-literal, same alias text ignoring case.
    -- The non-literal alias is case-insensitive, so it also matches the literal's exact text and
    -- would block the literal record (e.g. literal 'ANA' vs non-literal 'ana').
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  LOWER(a.alias) = LOWER(b.alias)
      AND a.medscan_id > b.medscan_id
      AND (   (a.match LIKE '%l%' AND COALESCE(b.match, '') NOT LIKE '%l%')
           OR (b.match LIKE '%l%' AND COALESCE(a.match, '') NOT LIKE '%l%'))
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    UNION
    -- Part 3 (Phase-1): non-literal rows that share the same tokenized form but
    -- different normalized form (stemming hid the relationship from Parts 1 & 2).
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  a.tokenized IS NOT NULL AND b.tokenized IS NOT NULL
      AND a.tokenized = b.tokenized
      AND LOWER(a.normalized) <> LOWER(b.normalized)
      AND a.medscan_id > b.medscan_id
      AND COALESCE(a.match, '') NOT LIKE '%l%'
      AND COALESCE(b.match, '') NOT LIKE '%l%'
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    ORDER BY tokenized, newer_ms_id
    LIMIT ${limit}
  ` : table === 'chemnames' ? `
    ${cte}
    -- chemnames: alias is already a single lowercase token — no normalized/tokenized columns.
    -- Simple alias-equality join; no Phase-1/Phase-2 distinction needed.
    SELECT
      a.id            AS row_id_newer,
      a.medscan_id    AS newer_ms_id,
      obj_a.name      AS newer_name,
      a.alias         AS newer_alias,
      a.updated_at    AS newer_updated,
      b.id            AS row_id_older,
      b.medscan_id    AS older_ms_id,
      obj_b.name      AS older_name,
      b.alias         AS older_alias,
      b.updated_at    AS older_updated,
      a.alias         AS tokenized
    FROM ${table} a
    JOIN ${table} b
      ON  a.alias = b.alias
      AND a.medscan_id > b.medscan_id
      ${msFilter}
    ${joins}
    WHERE
      a.alias IS NOT NULL AND a.alias <> ''
      AND (a.bdeleted IS NULL OR a.bdeleted = FALSE)
      AND (b.bdeleted IS NULL OR b.bdeleted = FALSE)
    ORDER BY tokenized, newer_ms_id
    LIMIT ${limit}
  ` : table === 'combnames' ? `
    ${cte}
    -- combnames: Phase-2 only (normalized join).
    -- Phase-1 (tokenized join) is intentionally omitted: the stored tokenized column
    -- for match='c' rows may have been computed without sign preservation, making
    -- "CCR6+ CD4+ T cell" and "CCR6- CD4+ T cell" share the same tokenized value
    -- while their normalized values correctly differ.  Adding Phase-1 here produces
    -- false conflicts.  The stored normalized column is the authoritative conflict signal.
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  a.normalized = b.normalized
      AND a.medscan_id > b.medscan_id
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    ORDER BY tokenized, newer_ms_id
    LIMIT ${limit}
  ` : `
    ${cte}
    -- Phase-2 (normalized join): rows with same stemmed normalized form
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  a.normalized = b.normalized
      AND a.medscan_id > b.medscan_id
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    UNION
    -- Phase-1 (tokenized join): rows with same pre-stemmed tokenized form but
    -- different normalized form (stemming diverged — e.g. different plural endings)
    SELECT ${cols}
    FROM ${table} a
    JOIN ${table} b
      ON  a.tokenized IS NOT NULL AND b.tokenized IS NOT NULL
      AND a.tokenized = b.tokenized
      AND a.normalized <> b.normalized
      AND a.medscan_id > b.medscan_id
      ${msFilter}
    ${joins}
    WHERE ${activeWhere}
    ORDER BY tokenized, newer_ms_id
    LIMIT ${limit}
  `;

  const queryParams = filterMsIds && filterMsIds.length >= 2 ? [filterMsIds] : [];
  const res = await window.api.db.query(sql, queryParams);
  if (!res.ok) throw new Error(res.error || 'findTableConflicts query failed');

  return res.rows.map(r => ({
    rowIdNewer:   Number(r.row_id_newer),
    newerMsId:    Number(r.newer_ms_id),
    newerName:    r.newer_name || `#${r.newer_ms_id}`,
    newerAlias:   r.newer_alias,
    newerUpdated: r.newer_updated,
    rowIdOlder:   Number(r.row_id_older),
    olderMsId:    Number(r.older_ms_id),
    olderName:    r.older_name || `#${r.older_ms_id}`,
    olderAlias:   r.older_alias,
    olderUpdated: r.older_updated,
    tokenized:    r.tokenized,
  }));
}
