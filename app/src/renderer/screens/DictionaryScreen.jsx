import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { ENTITY_TYPES, resolveEntityType, ENTITY_TO_TABLE } from '../../shared/entityTypes';
import { makeNormalizer, makeTokenizer, makeCombTokenizer, applyTokenRulesComb, normalizeToken as _normalizeToken, TABLE_XWORDS, ALL_XWORDS_TABLES, NO_STEM_TABLES, exactLiteralTokenized, buildSeparatorSet, setSpellingMap, convertGreekToLatin as _convertGreekToLatin, normalizeForTableSync, tokenizeForTableSync, isAbbreviation, isShortAlias, ensureXwordsLoaded, tokenizeAliasSync, normalizeAliasSync } from '../../shared/tokenizer';
import {
  findExactLiteralDup,
  findExactLiteralDupBatch,
  checkDuplicate,
  checkDuplicateAllTables,
  batchCheckDuplicates,
  findTableConflicts,
  normalizeForTable,
  tokenizeForTable,
} from '../../shared/duplicateCheck';
import { callLlm, getLlmRemainingToday } from '../../shared/llm';
import FilePickerModal from '../components/FilePickerModal';
import CentreeImport from '../components/CentreeImport';
import { findAliasesInDb } from '../../shared/dbAliasSearch';
import { addToCasDictionary, ensureChemNamesTokens, bulkInsertAliasTable } from '../../shared/casDictionary';

// ── Greek → Latin conversion ──────────────────────────────────────────────────
// Canonical implementation lives in shared/tokenizer.js and is re-exported here
// so callers in this file (and callers that import from this file) get the same function.
export const convertGreekToLatin = _convertGreekToLatin;

// ── Tokenization ─────────────────────────────────────────────────────────────
// Core logic lives in src/shared/tokenizer.js (imported above).
// The renderer adds Greek → Latin conversion as a pre-step so that "α4" and
// "alpha 4" tokenize identically when the user types Greek letters into the UI.

// Re-export normalizeToken so SettingsScreen can import it from here.
export const normalizeToken = _normalizeToken;

// ── combnames permutation helpers ─────────────────────────────────────────────
// Split a combnames alias into its marker tokens using the combnames rules.
// "Tim-3+PD-1+KLRG1+" → ["Tim-3+", "PD-1+", "KLRG1+"]
function splitCombTokens(alias) {
  return applyTokenRulesComb(alias).split(/\s+/).filter(Boolean);
}

// Generate all permutations of an array (n! results).
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const perm of permutations(rest)) result.push([arr[i], ...perm]);
  }
  return result;
}

// Return all unique permutation strings for a combnames alias.
// Tokens are joined without separator (markers carry their own + suffix).
function combPermutations(alias) {
  const tokens = splitCombTokens(alias);
  if (tokens.length < 2) return [alias]; // nothing to permute
  const seen = new Set();
  const result = [];
  for (const perm of permutations(tokens)) {
    const s = perm.join('');
    if (!seen.has(s)) { seen.add(s); result.push(s); }
  }
  return result;
}

// ── Global xwords cache (loaded once on first use, reused across all calls) ───
// Stores all xwords tables so we can build the separator set without extra queries.
let _allXwCache = null; // { tableName → Set<string> } | null
async function getAllXwCache() {
  if (_allXwCache) return _allXwCache;
  const [entries] = await Promise.all([
    Promise.all(
      ALL_XWORDS_TABLES.map(async tbl => {
        const res = await window.api.db.query(`SELECT xword FROM ${tbl} LIMIT 5000`);
        const set  = res.ok ? new Set(res.rows.map(r => r.xword.toLowerCase())) : new Set();
        return [tbl, set];
      })
    ),
    // Load spelling normalization table in parallel and inject into tokenizer module.
    // Schema: col1 = canonical form, col2 = space-separated variants.
    // e.g. "thiamine" / "thiamin tiamin tiamine"  → thiamin→thiamine, tiamin→thiamine, …
    (async () => {
      const res = await window.api.db.query('SELECT canonical, spellings FROM spelling LIMIT 20000');
      if (!res.ok || res.rows.length === 0) return;
      const map = new Map();
      for (const row of res.rows) {
        const canonical = (row.canonical || '').trim().toLowerCase();
        const variants  = (row.spellings  || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        for (const v of variants) {
          if (v && v !== canonical) map.set(v, canonical);
        }
      }
      setSpellingMap(map);
    })(),
  ]);
  _allXwCache = Object.fromEntries(entries);
  return _allXwCache;
}

// Phase-1 tokenizer wrapper: Greek → Latin then makeTokenizer (split + xwords, no stemming).
// Output corresponds to the 'tokenized' DB column.
export function makeXwordTokenizer(xwordSet, { separatorSet = null } = {}) {
  const tok = makeTokenizer(xwordSet, { separatorSet });
  return (s) => tok(convertGreekToLatin(s));
}

// Phase-2 normalizer wrapper: Greek → Latin then makeNormalizer (full pipeline with stemming).
// Output corresponds to the 'normalized' DB column.
// @param {string} s              Phase-1 tokenized form (or original alias).
// @param {string} [originalAlias]  Original alias before Phase-1 lowercasing — passed through
//   to makeNormalizer so isAbbreviation() can detect ALL-CAPS tokens on original-case tokens.
export function makeXwordNormalizer(xwordSet, { stemming = true, separatorSet = null } = {}) {
  const tok = makeNormalizer(xwordSet, { stemming, separatorSet });
  return (s, originalAlias = null) => tok(
    convertGreekToLatin(s),
    originalAlias != null ? convertGreekToLatin(originalAlias) : null
  );
}

// combnames variant: uses combnames-specific tokenization rules.
// Pass preserveSigns:true for match='c' rows so '-' and '+' survive xwords stripping.
export function makeXwordCombTokenizer(xwordSet, { preserveSigns = false, separatorSet = null } = {}) {
  const tok = makeCombTokenizer(xwordSet, { preserveSigns, separatorSet });
  return (s) => tok(convertGreekToLatin(s));
}

async function computeTokenized(alias, tableName) {
  const svcTable = TABLE_XWORDS[tableName];
  const allXw    = await getAllXwCache();           // cached after first call
  const separatorSet = buildSeparatorSet(allXw);   // union of single-char xwords
  let xwordSet = new Set();
  if (svcTable && allXw[svcTable]) xwordSet = allXw[svcTable];
  const factory = tableName === 'combnames' ? makeXwordCombTokenizer : makeXwordTokenizer;
  return factory(xwordSet, { stemming: !NO_STEM_TABLES.has(tableName), separatorSet })(alias);
}

// exactLiteralTokenized(alias, matchFlag) imported from ../../shared/tokenizer

// ── ExactLiteral duplicate search ────────────────────────────────────────────
// findExactLiteralDup, findExactLiteralDupBatch, checkDuplicate,
// checkDuplicateAllTables, and batchCheckDuplicates are imported from
// ../../shared/duplicateCheck (see import block at top of file).
// They support organism + cartridge filtering — same alias in a different
// organism or cartridge is not treated as a duplicate.

// ── Entity Name / URN helpers ─────────────────────────────────────────────────
// URN format: urn:agi-{urnTag}:{encodeURIComponent(name_lowercase)}
// e.g. "Simian SA11" + Virus → "urn:agi-virus:simian%20sa11"
// The urnTag comes from entityTypes.js (e.g. 'prot', 'smol', 'cellobj', 'protfc', 'gv', …)
export function buildEntityUrn(name, entityTypeOrEt) {
  // '__nlp_ids__' is a batch-import sentinel, not a real entity type — never produce a URN from it.
  if (entityTypeOrEt === '__nlp_ids__') return null;
  const et = typeof entityTypeOrEt === 'string'
    ? resolveEntityType(entityTypeOrEt)
    : entityTypeOrEt;
  const tag = et?.urnTag;
  if (!tag) return null; // unknown entity type — refuse to produce a malformed URN
  return `urn:agi-${tag}:${encodeURIComponent((name || '').toLowerCase())}`;
}

// Returns the default { name, urn } for a new entity.
// name = first alias; urn = buildEntityUrn(name, entityType).
// Used here for Single Entry and will be reused for Batch Import.
export function buildEntityRecord(aliasList, entityType) {
  const name = (aliasList[0] || '').trim();
  return { name, urn: buildEntityUrn(name, entityType) };
}

// ── Next available MedscanID ──────────────────────────────────────────────────
// Queries MAX across ALL entity tables (an alias can only be in one, but
// manually-entered rows or future imports might spread across tables).
const ALL_ENTITY_TABLES = ['curnames', 'exactliteral', 'celldictionary', 'casdictionary', 'chemnames', 'keywords', 'userdict', 'combnames'];

// ── ID gap-finding helpers ──────────────────────────────────────────────────
// Returns sorted array of all medscan_ids currently used in [min, max] across all entity tables.
async function getUsedIdsInRange(min, max) {
  // Include objectnames so IDs that exist there (even with no aliases yet) are
  // never reused — a previous buggy import may have left objectnames rows behind
  // whose aliases were later moved away, making them invisible to alias-table-only checks.
  const ALL_TABLES_WITH_ON = [...ALL_ENTITY_TABLES, 'objectnames'];
  const unions = ALL_TABLES_WITH_ON
    .map(t => `SELECT medscan_id FROM ${t} WHERE medscan_id >= $1 AND medscan_id <= $2`)
    .join(' UNION ');
  const res = await window.api.db.query(
    `SELECT DISTINCT medscan_id FROM (${unions}) t ORDER BY medscan_id`,
    [min, max]
  );
  if (!res.ok) return { ids: null, error: res.error };
  return { ids: res.rows.map(r => Number(r.medscan_id)) };
}

// From a sorted array of used IDs, find the first `count` unused IDs in [min, max].
// IDs that are exact multiples of 1,000,000 (e.g. 1000000, 2000000, 12000000) are
// reserved by NLP for special tokens and are never assigned to new records.
function findGapIds(usedSortedIds, min, max, count) {
  const usedSet = new Set(usedSortedIds);
  const result = [];
  for (let id = min; id <= max && result.length < count; id++) {
    if (id % 1000000 === 0) continue; // reserved NLP special-token boundary
    if (!usedSet.has(id)) result.push(id);
  }
  return result;
}

// Get next available ID within an explicit range (for flat import where entity type is inferred).
async function getNextIdInRange(min, max) {
  const { ids, error } = await getUsedIdsInRange(min, max);
  if (!ids) return { id: null, error };
  const gaps = findGapIds(ids, min, max, 1);
  if (!gaps.length) return { id: null, error: `ID range ${min.toLocaleString()}–${max.toLocaleString()} is exhausted.` };
  return { id: gaps[0] };
}

// Get next single available ID for the given entity type (used by single-entry form).
async function getNextId(_tableName, entityType) {
  const et = resolveEntityType(entityType);
  if (!et) return { id: null, error: `Unknown entity type: ${entityType}` };
  const { ids, error } = await getUsedIdsInRange(et.min, et.max);
  if (!ids) return { id: null, error };
  // If DB has no records in range, check source files for the starting point
  if (ids.length === 0) {
    const fileRes = await window.api.dict.getMaxIdInRange(et.min, et.max);
    if (fileRes.ok && fileRes.maxId !== null) {
      // Start gap search from after file max (files not reflected in DB yet)
      const gaps = findGapIds([], fileRes.maxId + 1, et.max, 1);
      if (!gaps.length) return { id: null, error: `ID range for "${entityType}" is exhausted (max ${et.max.toLocaleString()} reached).` };
      return { id: gaps[0], source: 'files' };
    }
    return { id: et.min, source: 'empty' };
  }
  const gaps = findGapIds(ids, et.min, et.max, 1);
  if (!gaps.length) return { id: null, error: `ID range for "${entityType}" is exhausted (max ${et.max.toLocaleString()} reached).` };
  return { id: gaps[0], source: 'db' };
}

// Get a pool of `count` available IDs for the given entity type (used by batch import).
async function getIdPool(entityType, count) {
  const et = resolveEntityType(entityType);
  if (!et) return { ids: null, error: `Unknown entity type: ${entityType}` };
  const { ids: usedIds, error } = await getUsedIdsInRange(et.min, et.max);
  if (!usedIds) return { ids: null, error };
  const gaps = findGapIds(usedIds, et.min, et.max, count);
  if (gaps.length < count) {
    return { ids: null, error: `ID range for "${entityType}" is exhausted — only ${gaps.length.toLocaleString()} IDs available, need ${count.toLocaleString()}.` };
  }
  return { ids: gaps };
}

// checkDuplicate, checkDuplicateAllTables, and batchCheckDuplicates are
// imported from ../../shared/duplicateCheck — see import block at top of file.

// ── Single Entry Form ─────────────────────────────────────────────────────────
function SingleEntryForm({ cartridges, onSuccess }) {
  const [form, setForm] = useState({
    alias: '', medscanId: '', entityType: '',
    cartridgeList: [], organism: 'Mammal', match: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState(null);
  // pending: { items: [{alias, tokenized, msId, source, status, dup, decision}], tableName, et }
  const [pending, setPending] = useState(null);
  // viewRecord: null | { loading: true, msId } | { msId, entityName, urn, rows }
  const [viewRecord, setViewRecord] = useState(null);
  // matchOpts: { [tableName]: string[] } — distinct match values per entity table
  const [matchOpts, setMatchOpts] = useState({});
  // availableOrganisms: string[] — distinct organisms from the database for autocomplete
  const [availableOrganisms, setAvailableOrganisms] = useState([]);
  // urnConflict: null | { urn, row } — set when submitted URN already exists in ObjectNames
  const [urnConflict, setUrnConflict] = useState(null);

  useEffect(() => {
    const ENTITY_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames']; // chemnames has no match column
    Promise.all(
      ENTITY_TABLES.map(t =>
        window.api.db.query(`SELECT DISTINCT match FROM "${t}" WHERE match IS NOT NULL AND match <> '' ORDER BY match`)
          .then(r => [t, r.ok ? r.rows.map(row => row.match) : []])
      )
    ).then(entries => {
      const result = Object.fromEntries(entries);
      result['chemnames'] = []; // no match column
      setMatchOpts(result);
    });

    // Load distinct organisms for autocomplete
    window.api.db.query(
      `SELECT DISTINCT unnest(organisms) AS org FROM curnames WHERE organisms IS NOT NULL
       UNION
       SELECT DISTINCT unnest(organisms) AS org FROM celldictionary WHERE organisms IS NOT NULL
       ORDER BY org`
    ).then(r => {
      if (r.ok && r.rows.length > 0) {
        setAvailableOrganisms(r.rows.map(row => row.org).filter(Boolean));
      }
    });
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.alias.trim()) { setError('At least one alias is required.'); return; }
    if (!form.entityType) { setError('Please select an Entity Type.'); return; }
    if (form.cartridgeList.length === 0) { setError('Please select at least one cartridge before submitting.'); return; }
    setError(null);
    setSubmitting(true);

    const et = resolveEntityType(form.entityType);
    // tableName used only for getNextId (ID range lookup — queries all tables anyway)
    const tableName = ENTITY_TO_TABLE[et?.rnef] || 'curnames';

    // Parse aliases separated by newlines and/or semicolons
    const aliasList = form.alias.split(/[\n;]/).map(a => a.trim()).filter(Boolean);
    if (aliasList.length === 0) { setError('No valid aliases found.'); setSubmitting(false); return; }

    // Validate manual MedscanID once if provided
    let manualId = null;
    if (form.medscanId) {
      const num = parseInt(form.medscanId);
      if (isNaN(num) || num < et.min || num > et.max) {
        setError(`Elsevier NLP ID ${form.medscanId} is outside valid range ${et.min}–${et.max} for ${form.entityType}.`);
        setSubmitting(false);
        return;
      }
      manualId = num;
    }

    // Compute base auto-ID once — shared by all aliases (same entity)
    let nextAutoId = null, autoSource = 'db';
    if (!manualId) {
      const r = await getNextId(tableName, form.entityType);
      if (r.id === null) { setError(`Could not compute next Elsevier NLP ID: ${r.error}`); setSubmitting(false); return; }
      nextAutoId = r.id;
      autoSource = r.source;
    }

    // Pre-load xwords for all table types once (avoids repeated DB round-trips per alias)
    const loadXw = async (tbl) => {
      const r = await window.api.db.query(`SELECT xword FROM ${tbl} LIMIT 5000`);
      return r.ok ? new Set(r.rows.map(x => x.xword.toLowerCase())) : new Set();
    };
    let xwCurnames, xwCells, xwCas, xwCombAR;
    try {
      [xwCurnames, xwCells, xwCas, xwCombAR] = await Promise.all([
        loadXw('xwords'), loadXw('xwords_cells'), loadXw('xwords_cas'), loadXw('xwords_comb'),
      ]);
    } catch (e) {
      setError(`Could not load xwords: ${e.message}`); setSubmitting(false); return;
    }
    const xwSepAR = buildSeparatorSet({ xwords: xwCurnames, xwords_cells: xwCells, xwords_cas: xwCas, xwords_comb: xwCombAR });

    // Pre-check every alias against ALL entity tables.
    // Routing rule (isShortAlias): < 6 letters/digits → exactliteral · otherwise → curnames
    const items = [];
    const filteredOut = []; // aliases that already exist in some table (different entity)

    for (const alias of aliasList) {
      const dict     = isShortAlias(alias) ? 'exactliteral' : (ENTITY_TO_TABLE[et?.rnef] || 'curnames');   // long alias → the entity type's own dictionary (CellType → celldictionary)
      const matchVal = form.match || '';

      // Phase-1 → 'tokenized' column: split + xwords filter, no stemming, with Greek.
      const _arXwMap = { xwords: xwCurnames, xwords_cells: xwCells, xwords_cas: xwCas, xwords_comb: xwCombAR };
      const tokenized = (dict === 'exactliteral' && (matchVal || '').includes('l'))
        ? alias
        : tokenizeForTableSync(alias, dict, _arXwMap, xwSepAR, matchVal);
      // Phase-2 → 'normalized' column: full pipeline with stemming, with Greek.
      const normalized = dict === 'exactliteral'
        ? exactLiteralTokenized(convertGreekToLatin(alias), matchVal)
        : normalizeForTableSync(alias, dict, _arXwMap, xwSepAR, matchVal);

      const msId   = manualId !== null ? manualId : nextAutoId;
      const source = manualId !== null ? 'manual'  : autoSource;

      const elMatchFlag = dict === 'exactliteral' ? matchVal : '';
      let hit;
      try { hit = await checkDuplicateAllTables(alias, xwCurnames, xwCells, xwCas, elMatchFlag, null, null, null, xwSepAR); }
      catch (e) { setError(`Database error: ${e.message}`); setSubmitting(false); return; }

      if (!hit) {
        // Not found anywhere — new alias
        items.push({ alias, tokenized, normalized, msId, source, status: 'new', dup: null, decision: null, dict, match: matchVal });
      } else if (Number(hit.dup.medscan_id) === msId) {
        // Exists but belongs to the same entity (manual ID) — merge
        items.push({ alias, tokenized, normalized, msId, source, status: 'merge', dup: hit.dup, decision: null, dict: hit.dict, match: matchVal });
      } else {
        // Exists in another entity — filtered out before Confirm
        filteredOut.push({ alias, existingId: hit.dup.medscan_id, existingAlias: hit.dup.alias, inDict: hit.dict });
      }
    }

    if (items.length === 0) {
      const msg = filteredOut.length === 1
        ? `"${filteredOut[0].alias}" already exists in ${filteredOut[0].inDict} (ID ${filteredOut[0].existingId}).`
        : `All ${filteredOut.length} aliases already exist in the dictionary.`;
      setError(msg);
      setSubmitting(false);
      return;
    }

    const hasNew     = items.some(i => i.status === 'new');
    const allAliases = items.map(i => i.alias);
    const { name: entityName, urn: entityUrn } = hasNew
      ? buildEntityRecord(allAliases, form.entityType)
      : { name: '', urn: '' };

    setSubmitting(false);
    setPending({ items, filteredOut, tableName, et, hasNew, entityName, entityUrn, allAliases });
  };

  const handleConfirmedBatch = async () => {
    const { items, tableName, et } = pending;

    // URN uniqueness check — must run before closing the dialog
    if (pending.hasNew && pending.entityUrn) {
      const urnCheck = await window.api.db.query(
        `SELECT medscan_id, name, urn FROM objectnames WHERE urn = $1 LIMIT 1`,
        [pending.entityUrn]
      );
      if (urnCheck.ok && urnCheck.rows.length > 0) {
        setUrnConflict({ urn: pending.entityUrn, row: urnCheck.rows[0] });
        return;
      }
    }
    setUrnConflict(null);

    setPending(null);
    setSubmitting(true);

    // Per-dict counters for the summary
    let nExactLiteral = 0, nCurnames = 0, nCells = 0;
    let nMerged = 0, nOverridden = 0, nSkipped = 0;
    const orgs = [form.organism].filter(Boolean);

    for (const item of items) {
      // Use per-item dict and match (set by the routing rule in handleSubmit)
      const dict     = item.dict     || tableName;
      const matchVal = item.match    ?? form.match ?? null;

      if (item.status === 'new' && dict === 'casdictionary') {
        // CASDictionary: single route (tokenize/normalize + chemNames approval)
        const res = await addToCasDictionary([{ msId: item.msId, alias: item.alias, match: matchVal, cartridges: form.cartridgeList, organisms: orgs, curated: true }]);
        if (!res.ok) { if (!res.cancelled) setError(res.error); setSubmitting(false); return; }
        nCurnames++;
      } else if (item.status === 'new') {
        const aliasCol = dict === 'keywords' ? 'keywords' : 'alias';
        const res = await window.api.db.query(
          `INSERT INTO ${dict} (medscan_id, ${aliasCol}, match, tokenized, normalized, cartridges, organisms, curated, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())`,
          [item.msId, item.alias, matchVal || null, item.tokenized, item.normalized ?? null, form.cartridgeList, orgs]
        );
        if (!res.ok) { setError(res.error); setSubmitting(false); return; }
        if (dict === 'exactliteral') nExactLiteral++; else if (dict === 'celldictionary') nCells++; else nCurnames++;
      } else if (item.status === 'merge') {
        const res = await window.api.db.query(
          `UPDATE ${dict}
           SET cartridges = ARRAY(SELECT DISTINCT unnest(cartridges || $1)),
               organisms  = ARRAY(SELECT DISTINCT unnest(organisms  || $2))
           WHERE medscan_id = $3`,
          [form.cartridgeList, orgs, item.msId]
        );
        if (!res.ok) { setError(res.error); setSubmitting(false); return; }
        nMerged++;
      } else if (item.status === 'conflict') {
        if (item.decision === 'skip') {
          nSkipped++;
        } else {
          // Override: delete old row, compute new ID, insert
          if (dict === 'casdictionary') {
            // Get chemNames approval BEFORE deleting anything
            const pre = await ensureChemNamesTokens([item.alias]);
            if (!pre.ok) { if (!pre.cancelled) setError(pre.error); setSubmitting(false); return; }
          }
          await window.api.db.query(`DELETE FROM ${dict} WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`, [item.dup.medscan_id]);   // bDeleted rows stay
          const { id: newId } = await getNextId(dict, et.display);
          const aliasCol2 = dict === 'keywords' ? 'keywords' : 'alias';
          const res = dict === 'casdictionary'
            ? await addToCasDictionary([{ msId: newId, alias: item.alias, match: matchVal, cartridges: form.cartridgeList, organisms: orgs, curated: true }])
            : await window.api.db.query(
                `INSERT INTO ${dict} (medscan_id, ${aliasCol2}, match, tokenized, normalized, cartridges, organisms, curated, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())`,
                [newId, item.alias, matchVal || null, item.tokenized, item.normalized ?? null, form.cartridgeList, orgs]
              );
          if (!res.ok) { if (!res.cancelled) setError(res.error); setSubmitting(false); return; }
          nOverridden++;
          if (dict === 'exactliteral') nExactLiteral++; else if (dict === 'celldictionary') nCells++; else nCurnames++;
        }
      }
    }

    // Insert ObjectNames entry for the new entity (only if none exists yet)
    if (pending.hasNew && pending.entityName) {
      const newMsId = pending.items.find(i => i.status === 'new')?.msId;
      if (newMsId != null) {
        const check = await window.api.db.query(
          `SELECT 1 FROM objectnames WHERE medscan_id = $1 LIMIT 1`, [newMsId]
        );
        if (check.ok && check.rows.length === 0) {
          await window.api.db.query(
            `INSERT INTO objectnames (medscan_id, name, urn, cartridges, organisms) VALUES ($1,$2,$3,$4,$5)`,
            [newMsId, pending.entityName, pending.entityUrn || null, form.cartridgeList, orgs]
          );
        }
      }
    }

    setSubmitting(false);
    setForm(f => ({ ...f, alias: '', medscanId: '', match: '' }));

    // Build summary with per-dict counts
    const insertParts = [];
    if (nExactLiteral) insertParts.push(`${nExactLiteral} to ExactLiteral`);
    if (nCurnames)     insertParts.push(`${nCurnames} to Curnames`);
    if (nCells)        insertParts.push(`${nCells} to CellDictionary`);
    const parts = [];
    if (insertParts.length) parts.push(`Added: ${insertParts.join(', ')}`);
    if (nMerged)     parts.push(`${nMerged} merged`);
    if (nOverridden) parts.push(`${nOverridden} overridden`);
    if (nSkipped)    parts.push(`${nSkipped} skipped`);
    onSuccess?.(parts.join(' | ') || 'Done');
  };

  const handleViewRecord = async () => {
    const msId = pending.items[0].msId;
    setViewRecord({ loading: true, msId });
    const ALL_ENTITY_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','chemnames','keywords','userdict','combnames'];
    const unionSql = ALL_ENTITY_TABLES
      .map(t => `SELECT ${t === 'keywords' ? 'keywords' : 'alias'} AS alias, '${t}' AS dict FROM ${t} WHERE medscan_id = $1`)
      .join(' UNION ALL ');
    const [nameRes, aliasRes] = await Promise.all([
      window.api.db.query(`SELECT name, urn FROM objectnames WHERE medscan_id = $1 LIMIT 1`, [msId]),
      window.api.db.query(`${unionSql} ORDER BY dict, alias`, [msId]),
    ]);
    const entityName = nameRes.ok && nameRes.rows.length > 0 ? nameRes.rows[0].name : null;
    const urn        = nameRes.ok && nameRes.rows.length > 0 ? nameRes.rows[0].urn  : null;
    const rows       = aliasRes.ok ? aliasRes.rows : [];
    setViewRecord({ msId, entityName, urn, rows });
  };

  // Status badge helper
  const statusBadge = (item) => {
    if (item.status === 'new')      return <span style={{ color: 'var(--success, #2a7)' }}>✓ New (ID: {item.msId.toLocaleString()})</span>;
    if (item.status === 'merge')    return <span style={{ color: 'var(--info, #27a)' }}>↔ Merge into existing (ID: {item.msId.toLocaleString()})</span>;
    if (item.status === 'conflict') return <span style={{ color: 'var(--warning, #b80)' }}>⚠ Conflict — existing ID: {item.dup?.medscan_id}</span>;
    return null;
  };

  const hasSourceWarning = pending?.items.some(i => i.source === 'files' || i.source === 'empty');

  return (
    <div>
      {pending && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 700 }}>

            {/* ── Record view ─────────────────────────────────────────── */}
            {viewRecord ? (
              <>
                <div className="modal-title">Record — Elsevier NLP ID {viewRecord.msId?.toLocaleString()}</div>
                {viewRecord.loading ? (
                  <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /> Loading…</div>
                ) : (
                  <>
                    <table className="data-table" style={{ marginBottom: 16 }}>
                      <tbody>
                        <tr><th style={{ width: 140 }}>Elsevier NLP ID</th><td className="mono">{viewRecord.msId?.toLocaleString()}</td></tr>
                        <tr><th>Entity Name</th><td>{viewRecord.entityName || <span className="text-muted">—</span>}</td></tr>
                        <tr><th>URN</th><td className="mono">{viewRecord.urn || <span className="text-muted">—</span>}</td></tr>
                      </tbody>
                    </table>
                    {viewRecord.rows.length > 0 ? (
                      <table className="data-table" style={{ marginBottom: 16 }}>
                        <thead><tr><th>Alias</th><th>Dictionary</th></tr></thead>
                        <tbody>
                          {viewRecord.rows.map((r, i) => (
                            <tr key={i}><td>{r.alias}</td><td className="mono">{r.dict}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-muted" style={{ marginBottom: 16 }}>No aliases found for this Elsevier NLP ID in any dictionary.</div>
                    )}
                  </>
                )}
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setViewRecord(null)}>← Back to Confirm</button>
                </div>
              </>
            ) : (

            /* ── Confirm view ───────────────────────────────────────── */
            <>
              <div className="modal-title">Confirm Submission</div>

              {hasSourceWarning && (
                <div className="alert alert-info" style={{ marginBottom: 12 }}>
                  ℹ One or more IDs were computed from source files (DB not yet refreshed). Verify IDs below before confirming.
                </div>
              )}

              {pending.filteredOut?.length > 0 && (
                <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                  ⚠ {pending.filteredOut.length} alias{pending.filteredOut.length !== 1 ? 'es' : ''} already exist in the dictionary and were removed:{' '}
                  {pending.filteredOut.map((f, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      <strong>{f.alias}</strong>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> ({f.inDict}, ID {f.existingId})</span>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                ℹ Routing rule: aliases &lt; 6 chars → <strong>ExactLiteral</strong> (Exact match) · 6+ chars → the entity type's dictionary (<strong>Curnames</strong> for Protein, SmallMol …; <strong>CellDictionary</strong> for CellType, Disease, Tissue …)
              </div>
              <table className="data-table" style={{ marginBottom: 16 }}>
                <thead>
                  <tr><th>Alias</th><th style={{ width: 140 }}>Dictionary</th><th>Status</th><th style={{ width: 130 }}>Match</th></tr>
                </thead>
                <tbody>
                  {pending.items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.alias}</td>
                      <td>
                        <select
                          value={item.dict || ''}
                          onChange={e => setPending(p => ({
                            ...p,
                            items: p.items.map((it, j) => j === i ? { ...it, dict: e.target.value } : it),
                          }))}
                          style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, fontFamily: 'monospace',
                                   border: '1px solid var(--border)', background: 'var(--surface)',
                                   color: 'var(--text)', cursor: 'pointer', width: '100%' }}
                        >
                          <option value="curnames">curnames</option>
                          <option value="exactliteral">exactliteral</option>
                          <option value="chemnames">chemnames</option>
                          <option value="celldictionary">celldictionary</option>
                          <option value="casdictionary">casdictionary</option>
                          <option value="keywords">keywords</option>
                          <option value="userdict">userdict</option>
                          <option value="combnames">combnames</option>
                        </select>
                      </td>
                      <td>
                        {statusBadge(item)}
                        {item.status === 'conflict' && (
                          <select
                            className="form-control"
                            style={{ marginTop: 4, padding: '2px 6px', height: 'auto', width: '100%' }}
                            value={item.decision}
                            onChange={e => setPending(p => ({
                              ...p,
                              items: p.items.map((it, j) => j === i ? { ...it, decision: e.target.value } : it),
                            }))}
                          >
                            <option value="skip">Skip</option>
                            <option value="override">Override (delete old, insert new)</option>
                          </select>
                        )}
                      </td>
                      <td>
                        <select
                          value={item.match ?? ''}
                          onChange={e => setPending(p => ({
                            ...p,
                            items: p.items.map((it, j) => j === i ? { ...it, match: e.target.value } : it),
                          }))}
                          style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4,
                                   border: '1px solid var(--border)', background: 'var(--surface)',
                                   color: 'var(--text)', cursor: 'pointer', width: '100%' }}
                        >
                          <option value="">—</option>
                          {(matchOpts[item.dict] || []).map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {pending.hasNew && (
                <div style={{ marginBottom: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>New Entity Record (ObjectNames)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '6px 10px', alignItems: 'center', fontSize: 13 }}>
                    <label>Name</label>
                    <select className="form-control" value={pending.entityName}
                      onChange={e => {
                        const name = e.target.value;
                        setPending(p => ({ ...p, entityName: name, entityUrn: buildEntityUrn(name, p.et) }));
                      }}>
                      {pending.allAliases.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                    <label>URN</label>
                    <input className="form-control" value={pending.entityUrn}
                      onChange={e => { setUrnConflict(null); setPending(p => ({ ...p, entityUrn: e.target.value })); }} />
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Cartridges: {form.cartridgeList.join(', ')} &nbsp;|&nbsp; Organism: {form.organism || '—'}
              </div>

              {urnConflict && (
                <div className="alert alert-danger" style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 6 }}>
                    Cannot add record with URN <code style={{ userSelect: 'all' }}>{urnConflict.urn}</code>.
                    The following record already exists in the dictionary:
                  </div>
                  <table className="data-table" style={{ fontSize: 11 }}>
                    <thead><tr><th>Elsevier NLP ID</th><th>Name</th><th>URN</th></tr></thead>
                    <tbody>
                      <tr>
                        <td className="mono">{urnConflict.row.medscan_id?.toLocaleString()}</td>
                        <td>{urnConflict.row.name}</td>
                        <td className="mono" style={{ wordBreak: 'break-all' }}>{urnConflict.row.urn}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => { setPending(null); setViewRecord(null); setUrnConflict(null); }}>Cancel</button>
                {pending.items[0]?.source === 'manual' && (
                  <button className="btn btn-secondary" onClick={handleViewRecord}>🔍 View Record</button>
                )}
                <button className="btn btn-primary" onClick={handleConfirmedBatch}>✓ Confirm</button>
              </div>
            </>
            )}
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="form-group">
          <label>Aliases *</label>
          <textarea className="form-control" value={form.alias} onChange={e => set('alias', e.target.value)}
            placeholder={"e.g.\np53\ntumor protein p53\nTP53"}
            rows={4} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          <div className="text-xs text-muted mt-4">One alias per line, or separate with semicolons ( ; )</div>
        </div>
        <div className="form-group">
          <label>Entity Type *</label>
          <select className="form-control" value={form.entityType} onChange={e => set('entityType', e.target.value)}>
            <option value="" disabled>— Select entity type —</option>
            {[...ENTITY_TYPES].sort((a, b) => a.display.localeCompare(b.display)).map(t => <option key={t.display} value={t.display}>{t.display} ({t.rnef}) ({t.min.toLocaleString('en-US')}-{t.max.toLocaleString('en-US')})</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Elsevier NLP ID (leave blank to auto-assign)</label>
          <input className="form-control" value={form.medscanId} onChange={e => set('medscanId', e.target.value)} placeholder="Auto" type="number" />
          <div className="text-xs text-muted mt-8">
            Range: {resolveEntityType(form.entityType)?.min?.toLocaleString()} – {resolveEntityType(form.entityType)?.max?.toLocaleString()}
          </div>
        </div>
        <div className="form-group">
          <label>Match Flag</label>
          <select className="form-control" value={form.match} onChange={e => set('match', e.target.value)}>
            <option value="">— none —</option>
            <option value="l">l (exact case for ExactLiteral)</option>
          </select>
        </div>
        <div className="form-group">
          <label>Organism</label>
          <input className="form-control" list="sef-organism-list" value={form.organism} onChange={e => set('organism', e.target.value)} placeholder="e.g. Mammal, Human" />
          <datalist id="sef-organism-list">
            {availableOrganisms.map(org => <option key={org} value={org} />)}
          </datalist>
        </div>
        <div className="form-group">
          <label>Cartridges</label>
          <div className="checkbox-list" style={{ maxHeight: 120 }}>
            {cartridges.length === 0
              ? <div className="text-muted text-sm" style={{ padding: 4 }}>No cartridges found. Configure in Settings.</div>
              : <>
                <label className="checkbox-item" style={{ borderBottom: '1px solid var(--border)', marginBottom: 2, paddingBottom: 2 }}>
                  <input type="checkbox"
                    checked={form.cartridgeList.length === cartridges.length}
                    ref={el => { if (el) el.indeterminate = form.cartridgeList.length > 0 && form.cartridgeList.length < cartridges.length; }}
                    onChange={ev => set('cartridgeList', ev.target.checked ? cartridges.map(c => c.name) : [])}
                  />
                  <strong>Select All</strong>
                </label>
                {cartridges.map(c => (
                  <label key={c.name} className="checkbox-item">
                    <input type="checkbox"
                      checked={form.cartridgeList.includes(c.name)}
                      onChange={ev => set('cartridgeList', ev.target.checked ? [...form.cartridgeList, c.name] : form.cartridgeList.filter(x => x !== c.name))}
                    />
                    {c.name}
                  </label>
                ))}
              </>
            }
          </div>
        </div>
      </div>

      <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting} style={{ marginTop: 8 }}>
        {submitting ? <><span className="spinner" /> Checking…</> : '＋ Submit'}
      </button>
    </div>
  );
}

// ── Batch Import ──────────────────────────────────────────────────────────────
// Detect and revert inverted headings: "X, Y" → "Y X"
// e.g. "corneal dystrophies, hereditary" → "hereditary corneal dystrophies"
function revertInvertedAlias(alias) {
  const idx = alias.indexOf(',');
  if (idx === -1) return null;
  const before = alias.slice(0, idx).trim();
  const after  = alias.slice(idx + 1).trim();
  if (!before || !after) return null;
  return `${after} ${before}`;
}

// Parse a tab-delimited dictionary file.
// Skips lines starting with #; detects the tab-separated header line to identify name/syns columns.
// Syns column may be named: syns, synonyms, aliases, alias, synonym.
// Syns values separated by | or ;.
// Strip a single pair of enclosing double-quotes that CSV exporters add (e.g. "value" → value).
function stripQuotes(s) { return s.replace(/^"|"$/g, ''); }

function parseDictFile(content) {
  const lines = content.split('\n');
  let nameCol = 1, synsCol = 2;
  const rows = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.includes('\t')) {
        const cols = line.replace(/^#+\s*/, '').split('\t').map(s => s.trim().toLowerCase());
        const ni = cols.findIndex(c => c === 'name');
        const si = cols.findIndex(c => ['syns','synonyms','aliases','alias','synonym'].includes(c));
        if (ni >= 0) nameCol = ni;
        if (si >= 0) synsCol = si;
      }
      continue;
    }
    const cols = line.split('\t');
    const name = stripQuotes((cols[nameCol] || '').trim());
    const synsRaw = stripQuotes((cols[synsCol] || '').trim());
    if (!name) continue;
    const syns = synsRaw ? synsRaw.split(/\s*[|;]\s*/).map(s => stripQuotes(s.trim())).filter(Boolean) : [];
    const seen = new Set();
    const aliases = [];
    for (const a of [name, ...syns]) {
      const k = a.toLowerCase();
      if (!seen.has(k)) { seen.add(k); aliases.push(a); }
    }
    rows.push({ name, aliases });
  }
  return rows;
}

// Parse flat dict file (id\talias[\tmatch] per line). Groups by id.
// Returns rows compatible with Aggregated format.
// When a third column is present it is treated as the match flag for that alias
// (e.g. 'l', 'l3', '') and stored in _aliasMatchMap: Map<alias, matchFlag>.
function parseFlatFile(content, isObjectNames = false) {
  const lines = content.split('\n');
  const idMap = new Map(); // id_string → {name, aliases, urn, aliasMatchMap}
  for (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const id  = stripQuotes(cols[0].trim());
    const val = stripQuotes(cols[1].trim());
    if (!id || !val) continue;
    if (!idMap.has(id)) idMap.set(id, { name: null, aliases: [], urn: null, aliasMatchMap: new Map() });
    const entry = idMap.get(id);
    if (isObjectNames) {
      if (!entry.name) { entry.name = val; entry.urn = stripQuotes((cols[2] || '').trim()); }
    } else {
      if (!entry.name) entry.name = val; // first alias becomes name
      if (!entry.aliases.includes(val)) {
        entry.aliases.push(val);
        // Third column, if present, is the match flag for this alias
        if (cols.length >= 3) {
          const mf = stripQuotes(cols[2].trim());
          if (mf !== undefined) entry.aliasMatchMap.set(val, mf);
        }
      }
    }
  }
  const rows = [];
  for (const [id, entry] of idMap) {
    const row = { name: entry.name || id, aliases: entry.aliases, _flatId: Number(id), _flatUrn: entry.urn };
    if (entry.aliasMatchMap.size > 0) row._aliasMatchMap = entry.aliasMatchMap;
    rows.push(row);
  }
  return rows;
}

// Parse {Organism}.{DictTable}.tab.e filename → { organism, dict }
function parseFlatFilename(filepath) {
  const fname = (filepath || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/\.tab$/, '');
  const dictAliases = {
    curnames: 'curnames', casdictionary: 'casdictionary', casdictionaryall: 'casdictionary',
    celldictionary: 'celldictionary', exactliteral: 'exactliteral',
    keywords: 'keywords', chemnames: 'chemnames', objectnames: 'objectnames', combnames: 'combnames',
  };
  const parts = fname.split('.');
  if (parts.length >= 2) {
    const maybeDict = dictAliases[parts[1].toLowerCase()];
    if (maybeDict) return { organism: parts[0], dict: maybeDict };
  }
  const maybeDict0 = dictAliases[parts[0].toLowerCase()];
  if (maybeDict0) return { organism: '', dict: maybeDict0 };
  return { organism: '', dict: '' };
}


// Render a batch-import submit message, splitting off any "could not be imported" warning
// into a separate prominent red alert so partial failures aren't hidden inside a green banner.
function BatchSubmitMsg({ msg }) {
  if (!msg) return null;
  const WARN_MARKER = 'could not be imported';
  const warnIdx = msg.indexOf(WARN_MARKER);
  const isSuccess = msg.startsWith('✓') || msg.startsWith('✅');
  if (isSuccess && warnIdx !== -1) {
    // Split at the sentence boundary just before the warning sentence.
    // The warning sentence starts after the last '. ' before warnIdx.
    const cutRaw = msg.lastIndexOf('. ', warnIdx - 1);
    const cut = cutRaw >= 0 ? cutRaw + 1 : 0; // include the period, exclude the space
    const okPart   = cut > 0 ? msg.slice(0, cut).trim() : '';
    const warnPart = cut > 0 ? msg.slice(cut + 1).trim() : msg;
    return (
      <div style={{ marginBottom: 12 }}>
        {okPart && <div className="alert alert-success" style={{ marginBottom: 6 }}>{okPart}</div>}
        <div className="alert alert-danger" style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>⚠</span>
          <span>{warnPart}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`alert ${isSuccess ? 'alert-success' : 'alert-danger'}`} style={{ marginBottom: 12 }}>
      {msg}
    </div>
  );
}

function BatchImport({ cartridges, onSuccess, onEditRecord }) {
  const [file, setFile]               = useState('');
  const lastImportDir                 = useRef('');   // persisted across file picks within the session
  const [entityType, setEntityType]   = useState('');
  const [cartridgeList, setCartList]  = useState([]);
  const [organism, setOrganism]       = useState('Mammal');
  const [analyzing, setAnalyzing]     = useState(false);
  const [analyzeProgress, setAP]      = useState('');
  const [error, setError]             = useState(null);
  const [results, setResults]         = useState(null); // { newRecords, existingRecords, newAliases, conflicts }
  const [resultTab, setResultTab]     = useState('new');
  const [nrApprovals,    setNrApprovals]    = useState({}); // idx → bool for new records
  const [nrSortKey,      setNrSortKey]      = useState('overlapPct'); // 'id'|'entityType'|'name'|'match'|'newAliasCount'|'existingCount'|'overlapPct'|'dbId'|null
  const [nrSortDir,      setNrSortDir]      = useState('desc');
  const [nrConfirm,      setNrConfirm]      = useState(null); // { mode, aliasCount, recordCount } | null
  const [naApprovals,    setNaApprovals]    = useState({}); // idx → bool for <= 50% new aliases
  const [mnaApprovals,   setMnaApprovals]   = useState({}); // idx → bool for >  50% new aliases
  const [remapApprovals, setRemapApprovals] = useState({}); // idx → bool for remapped records
  // Multi-row selection state (Set of original indices)
  const [nrSelected,  setNrSelected]  = useState(new Set());
  const [naSelected,  setNaSelected]  = useState(new Set());
  const [mnaSelected, setMnaSelected] = useState(new Set());
  const [rmSelected,  setRmSelected]  = useState(new Set());
  const [erSelected,  setErSelected]  = useState(new Set());
  const [erApprovals, setErApprovals] = useState({}); // idx → bool for existing records
  const erLastClick  = useRef(null);
  // Sort state for ≤50% and >50% tabs: { col: 'mappedId'|'flatId'|'entityType'|null, dir: 'asc'|'desc' }
  const [naSort,  setNaSort]  = useState({ col: null, dir: 'asc' });
  const [mnaSort, setMnaSort] = useState({ col: null, dir: 'asc' });
  // Safety check: skip import for any ID not present in ObjectNames
  const [requireObjectNames, setRequireObjectNames] = useState(false);
  const nrLastClick  = useRef(null);
  const naLastClick  = useRef(null);
  const mnaLastClick = useRef(null);
  const rmLastClick  = useRef(null);
  const [onlySameTypeNA,  setOnlySameTypeNA]  = useState(false); // filter ≤50% tab by matching entity type
  const [onlySameIdNA,    setOnlySameIdNA]    = useState(false); // filter ≤50% tab: file ID === matched DB ID
  const [onlySameTypeMNA, setOnlySameTypeMNA] = useState(false); // filter >50% tab by matching entity type
  const [onlySameIdMNA,   setOnlySameIdMNA]   = useState(false); // filter >50% tab: file ID === matched DB ID
  const [minAliasLenNR,       setMinAliasLenNR]       = useState(0); // New Records tab: hide rows where all aliases < N (0 = no filter)
  const [minAliasLenNA,       setMinAliasLenNA]       = useState(0); // ≤50% tab: hide rows where all new aliases ≤ N (0 = no filter)
  const [minAliasLenMNA,      setMinAliasLenMNA]      = useState(0); // >50% tab: same
  const [minMatchLenNA,       setMinMatchLenNA]        = useState(0); // ≤50% tab: hide rows where all matched aliases < N (0 = no filter)
  const [minMatchLenMNA,      setMinMatchLenMNA]       = useState(0); // >50% tab: same
  const [minAliasLenConflict, setMinAliasLenConflict] = useState(0); // Conflicts tab: same
  const [resolveToSameType,   setResolveToSameType]   = useState(false); // Conflicts tab: auto-resolve to same-type match
  const [resolveToLonger,     setResolveToLonger]     = useState(false); // Conflicts tab: auto-resolve to group with longest matched alias
  const [resolveToSameName,   setResolveToSameName]   = useState(false); // Conflicts tab: auto-resolve where DB record name matches file name
  const [resolveToAliasMatch, setResolveToAliasMatch] = useState(false); // Conflicts tab: auto-resolve where a DB alias matches the file record name
  const [minMatchLen,         setMinMatchLen]         = useState(0);     // Conflicts tab: ignore matches shorter than this (0 = no filter)
  const [conflictSort,        setConflictSort]        = useState(null);  // Conflicts tab: null | 'resolved-first' | 'unresolved-first'
  const [onlySameTypeMC,      setOnlySameTypeMC]      = useState(false); // Mapped conflicts tab: show only same-type conflicts
  const [minAliasLenMC,      setMinAliasLenMC]       = useState(0);     // Mapped conflicts tab: hide rows where longest match < this (0 = no filter)
  // CASdictionary chemNames token check state
  const [casChemImporting, setCasChemImporting] = useState(false);
  const [casChemImportMsg, setCasChemImportMsg] = useState(null);
  // Records skipped because their NLP ID has no Name+URN in ObjectNames
  const [noUrnRecords, setNoUrnRecords] = useState([]); // { name, id, aliases, source }[]
  // ObjectNames import mode: { matched: [{id,name,urn}], unmatched: [{id,name,urn}] }
  const [onImportData,   setOnImportData]   = useState(null);
  const [onApprovals,    setOnApprovals]    = useState({}); // idx → bool for objectnames matched rows
  const [onExistingPage, setOnExistingPage] = useState(0);
  // Column widths for ObjectNames conflict tables (percentages). null = equal split.
  const [onColWidthsON, setOnColWidthsON] = useState(null); // 6 cols — Already in ObjectNames
  const [onColWidthsDB, setOnColWidthsDB] = useState(null); // 7 cols — Already in Database
  const onDragRef = useRef(null); // drag state: { colIdx, startX, startWidths }
  const ON_PAGE_SIZE = 200;
  const [conflictExp, setConflictExp] = useState(new Set());
  const [conflictDec, setConflictDec] = useState({}); // rowIdx → { medscan_id → decision }
  const [manualAssign, setManualAssign] = useState({}); // rowIdx → { alias → medscan_id_string | 'new' }
  const [batchLlmResolving, setBatchLlmResolving] = useState(false);
  const [batchLlmProgress,  setBatchLlmProgress]  = useState(null); // { done, total } | null
  const [batchLlmMsg,       setBatchLlmMsg]       = useState(null);
  const [manualAssignOpen, setManualAssignOpen] = useState(null); // { rowIdx, row, groups } | null
  const [aliasCountCache, setAliasCountCache] = useState({}); // medscan_id → N aliases
  const [targetTable, setTargetTable]       = useState('');
  // match flag for ExactLiteral imports: 'l' = case-sensitive (tokenized = alias verbatim),
  // '' = case-insensitive (tokenized = alias.toLowerCase())
  const [elMatchFlag, setElMatchFlag]       = useState('l');
  const [revertInverted, setRevertInverted] = useState(false);
  const [ignoreNumbers, setIgnoreNumbers]   = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [submitMsg, setSubmitMsg]     = useState(null);
  const [pendingSubmit,  setPendingSubmit]  = useState(null); // { kind, aliases, rows, criteria, onProceed }

  // ── Mixed list import state ────────────────────────────────────────────────
  const [mixedText,        setMixedText]       = useState('');
  // No organism box any more: mapping scans ALL organism dictionaries. This default is only used for the
  // LLM annotation prompt and as the organism stored with newly submitted records.
  const mixedOrganism = 'Mammal';
  const [mixedCartList,    setMixedCartList]   = useState([]);
  const [mixedRunning,     setMixedRunning]    = useState(false);
  const [mixedError,       setMixedError]      = useState(null);
  const [mixedResults,     setMixedResults]    = useState(null);
  const [mixedActiveTab,   setMixedActiveTab]  = useState('unmapped');
  const [mixedAnnotated,   setMixedAnnotated]  = useState([]);
  const [mixedLlmRunning,  setMixedLlmRunning] = useState(false);
  const [mixedRowsPerClick, setMixedRowsPerClick] = useState(() => {
    const v = parseInt(localStorage.getItem('mixedLlmRowsPerClick'));
    return v > 0 ? v : 50;
  });
  const [mixedLlmProg,     setMixedLlmProg]   = useState(null);
  const [mixedLlmMsg,      setMixedLlmMsg]    = useState(null);
  const [mixedSubmitting,  setMixedSubmitting] = useState(false);
  const [mixedSubmitMsg,   setMixedSubmitMsg]  = useState(null);
  const [mixedDupMsg,      setMixedDupMsg]     = useState(null); // duplicate-removal notice
  const [mixedFileMsg,     setMixedFileMsg]    = useState(null); // load-file status message for Mixed list
  const [mixedPicker,      setMixedPicker]     = useState(null); // { startDir } while in-app file picker is open
  const [fileIdPreview,  setFileIdPreview]  = useState(null); // { M, N, K, H, onProceed }
  const confirmThen = (kind, aliases, rows, criteria, fn) =>
    setPendingSubmit({ kind, aliases, rows, criteria, onProceed: fn });

  // Pre-check for "Submit with ID in file": query ObjectNames to count valid/skipped IDs,
  // then show a warning dialog before executing. toProcess = [{ id, aliases: string[] }].
  // When requireObjectNames is false, all IDs are treated as valid regardless of ObjectNames.
  const previewFileIdSubmit = async (toProcess, onProceed) => {
    const ids = [...new Set(toProcess.map(r => Number(r.id)).filter(id => !isNaN(id) && id > 0))];
    let validIds;
    if (requireObjectNames) {
      const chk = ids.length
        ? await window.api.db.query(`SELECT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`, [ids])
        : { ok: true, rows: [] };
      validIds = new Set(chk.ok ? chk.rows.map(r => Number(r.medscan_id)) : []);
    } else {
      // All IDs are valid — ObjectNames check is bypassed
      validIds = new Set(ids);
    }
    let N = 0, H = 0, K = 0;
    for (const { id, aliases } of toProcess) {
      K += aliases.length;
      if (validIds.has(Number(id))) N += aliases.length;
      else H += aliases.length;
    }
    const M = validIds.size;
    setFileIdPreview({ M, N, K, H, onProceed, requireObjectNames });
  };

  // Render the file-ID preview warning modal
  const renderFileIdPreviewModal = () => {
    if (!fileIdPreview) return null;
    const { M, N, K, H, onProceed, requireObjectNames: reqON } = fileIdPreview;
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: 'var(--bg, #1e1e2e)', border: '1px solid var(--border, #444)',
                      borderRadius: 10, padding: '28px 32px', maxWidth: 500, width: '90%',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
          <div style={{ fontSize: 14, lineHeight: 1.8, marginBottom: 24 }}>
            <strong>{M.toLocaleString()}</strong> record{M !== 1 ? 's' : ''} will be updated
            with <strong>{N.toLocaleString()}</strong> out of <strong>{K.toLocaleString()}</strong> alias{K !== 1 ? 'es' : ''}.
            {!reqON && (
              <div style={{ marginTop: 10, color: 'var(--text-muted, #888)', fontSize: 12 }}>
                ObjectNames check is bypassed — aliases will be inserted for all IDs from the file.
              </div>
            )}
            {reqON && H > 0 && (
              <div style={{ marginTop: 10, color: 'var(--warning, #e8a000)' }}>
                <strong>{H.toLocaleString()}</strong> alias{H !== 1 ? 'es' : ''} will be ignored because
                they do not have Name and URN in ObjectNames.
              </div>
            )}
            {reqON && M === 0 && (
              <div style={{ marginTop: 10, color: 'var(--danger, #c44)' }}>
                No matching IDs found in ObjectNames — nothing will be imported.
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setFileIdPreview(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={reqON && M === 0}
              onClick={() => { setFileIdPreview(null); onProceed(); }}>Proceed</button>
          </div>
        </div>
      </div>
    );
  };

  // Render the New Records submit confirmation modal (handles both 'new_only' and 'all' modes)
  const renderNrConfirmModal = () => {
    if (!nrConfirm) return null;
    const { mode, aliasCount, recordCount, newAliasCount, existingAliasCount, conflictCount } = nrConfirm;
    const fromFile = entityType === '__nlp_ids__';
    const org = organism || '(no organism)';
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: 'var(--bg, #1e1e2e)', border: '1px solid var(--border, #444)',
                      borderRadius: 10, padding: '28px 32px', maxWidth: 520, width: '90%',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
          <div style={{ fontSize: 14, lineHeight: 1.9, marginBottom: 24 }}>
            {mode === 'new_only' ? (<>
              <strong>{aliasCount.toLocaleString()}</strong> alias{aliasCount !== 1 ? 'es' : ''} for{' '}
              <strong>{recordCount.toLocaleString()}</strong> checked record{recordCount !== 1 ? 's' : ''} will be added
              to the database with new NLP IDs.
              {fromFile && (
                <div style={{ marginTop: 10 }}>
                  If ID in the first column does not exist in the database it will be used for the new record.
                  Otherwise a new database ID will be calculated.
                </div>
              )}
            </>) : (<>
              <div>
                <strong>{newAliasCount.toLocaleString()}</strong> new alias{newAliasCount !== 1 ? 'es' : ''} will be
                added to the existing database record.
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>{existingAliasCount.toLocaleString()}</strong> existing alias{existingAliasCount !== 1 ? 'es' : ''} will be
                annotated with organism <strong>"{org}"</strong>.
              </div>
              {conflictCount > 0 && (
                <div style={{ marginTop: 8, color: 'var(--warning, #c8a92a)' }}>
                  <strong>{conflictCount.toLocaleString()}</strong> conflict{conflictCount !== 1 ? 's' : ''} (rows mapped to
                  more than one database record) will be ignored.
                </div>
              )}
              <div style={{ marginTop: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox"
                    checked={!!nrConfirm.skipOrgAnnotation}
                    onChange={e => setNrConfirm(c => ({ ...c, skipOrgAnnotation: e.target.checked }))} />
                  Do not annotate existing aliases with organism <strong>"{org}"</strong>
                </label>
              </div>
            </>)}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setNrConfirm(null)}>Cancel</button>
            <button className="btn btn-success"
              onClick={() => { const opts = { skipOrgAnnotation: !!nrConfirm.skipOrgAnnotation }; setNrConfirm(null); handleSubmitNewRecords(mode, opts); }}>
              Proceed
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Render the confirmation modal — call this inside any return() branch that has submit buttons
  const renderConfirmModal = () => {
    if (!pendingSubmit) return null;
    const { kind, aliases, rows, criteria, onProceed } = pendingSubmit;
    const et = entityType === '__nlp_ids__' ? 'NLP ID' : (resolveEntityType(entityType)?.display ?? entityType ?? 'entity');
    const pl = (n, singular, plural) => n !== 1 ? (plural ?? singular + 's') : singular;
    let msg;
    const tbl = <strong style={{ color: 'var(--accent, #7aa2f7)' }}>{targetTable}</strong>;
    if (kind === 'matched') {
      msg = (
        <span>
          You are about to add <strong>{aliases}</strong> {pl(aliases, 'alias', 'aliases')} for <strong>{rows}</strong> {et} {pl(rows, 'record')}{' '}
          <span style={{ color: '#2a9', fontWeight: 600 }}>matched</span>
          {criteria && criteria.length > 0 ? <> by <em>{criteria.join(', ')}</em></> : ''}{' '}
          to {tbl} table.
        </span>
      );
    } else if (kind === 'fileid') {
      msg = (
        <span>
          You are about to add <strong>{aliases}</strong> {pl(aliases, 'alias', 'aliases')} for <strong>{rows}</strong> {pl(rows, 'record')} using{' '}
          <span style={{ color: '#2a9', fontWeight: 600 }}>IDs from the file</span>{' '}
          to {tbl} table.
        </span>
      );
    } else {
      msg = (
        <span>
          You are about to submit <strong>{aliases}</strong> {pl(aliases, 'alias', 'aliases')} for <strong>{rows}</strong>{' '}
          <span style={{ color: '#e44', fontWeight: 600 }}>new</span>{' '}
          {et} {pl(rows, 'record')} to {tbl} table.
        </span>
      );
    }
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: 'var(--bg, #1e1e2e)', border: '1px solid var(--border, #444)',
                      borderRadius: 10, padding: '28px 32px', maxWidth: 480, width: '90%',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
          <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>{msg}</div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setPendingSubmit(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { setPendingSubmit(null); onProceed(); }}>Proceed</button>
          </div>
        </div>
      </div>
    );
  };

  const [addOrgMsg,   setAddOrgMsg]    = useState(null); // { ok, text } for "Add organism" result (Existing Records tab)
  const [addOrgONMsg, setAddOrgONMsg]  = useState(null); // { ok, text } for "Add organism" result (Already in ObjectNames tab)
  const [importFormat,   setImportFormat]   = useState('aggregated'); // 'aggregated' | 'flat'
  const [centreeMode,    setCentreeMode]    = useState(false);        // import source CENtree (always Aggregated format; the panel prepares the file)
  const [remapRecords,   setRemapRecords]   = useState([]);           // {origId, newId, name, aliases}[]
  const [dbOrganisms,    setDbOrganisms]    = useState([]);           // distinct organisms from DB
  const [onCache,        setOnCache]        = useState({});           // medscan_id → name from objectnames
  // Cached xword sets populated during analysis, reused during submission
  const xwRef = useRef({ curnames: new Set(), cells: new Set(), cas: new Set() });
  // Load the xwords tables once (shared tokenizer cache) so every tokenization in this screen — file import,
  // Mixed list, conflict resolution — uses the xwords of the dictionary it writes to.
  useEffect(() => { ensureXwordsLoaded().catch(e => console.error('[xwords] load failed:', e)); }, []);
  // Track which conflictDec entries were written by each auto-resolve action (for revert on uncheck)
  const sameTypeUpdatesRef   = useRef({}); // rowIdx → { id → decision } — per-criterion (used for table sort/display)
  const longerUpdatesRef     = useRef({}); // rowIdx → { id → decision }
  const sameNameUpdatesRef   = useRef({}); // rowIdx → { id → decision }
  const aliasMatchUpdatesRef = useRef({}); // rowIdx → { id → decision }
  const autoUpdatesRef       = useRef({}); // rowIdx → { id → decision } — combined intersection (used for revert)

  // Load last-used import directory from persisted settings
  useEffect(() => {
    window.api.settings.get().then(s => {
      if (s?.lastInputDir) lastImportDir.current = s.lastInputDir;
    }).catch(() => {});
  }, []);

  // Load distinct organisms from DB for the combo-box
  useEffect(() => {
    window.api.db.query(
      `SELECT DISTINCT unnest(organisms) AS org FROM curnames WHERE organisms IS NOT NULL ORDER BY org`
    ).then(res => {
      if (res.ok) setDbOrganisms(res.rows.map(r => r.org).filter(Boolean));
    }).catch(() => {});
  }, []);

  // Mixed-import cartridge selection is persisted; default is "Standard" on first use.
  const mixedCartInit = useRef(false);
  useEffect(() => {
    if (!cartridges.length) return;
    const names = cartridges.map(c => c.name);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('mixedImportCartridges')); } catch {}
    let sel = Array.isArray(saved) ? saved.filter(n => names.includes(n)) : null;
    if (sel === null) sel = names.includes('Standard') ? ['Standard'] : names;
    mixedCartInit.current = true;
    setMixedCartList(sel);
  }, [cartridges]);
  useEffect(() => {
    if (mixedCartInit.current) localStorage.setItem('mixedImportCartridges', JSON.stringify(mixedCartList));
  }, [mixedCartList]);

  // Uncheck New Records rows that are hidden by the alias-length filter.
  useEffect(() => {
    if (!results?.newRecords || minAliasLenNR === 0) return;
    setNrApprovals(prev => {
      const next = { ...prev };
      results.newRecords.forEach((row, i) => {
        if (!row.aliases.some(a => a.length >= minAliasLenNR)) {
          next[i] = false;
        }
      });
      return next;
    });
  }, [minAliasLenNR]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch ObjectNames record names for every matched/conflict ID across all result tabs.
  useEffect(() => {
    if (!results) { setOnCache({}); return; }
    const conflictIds = [
      ...(results.conflicts      || []),
      ...(results.mappedConflicts|| []),
    ].flatMap(row => row.mapped.map(m => m.hit.dup.medscan_id));
    const ids = [
      ...(results.newAliases     || []).map(r => r.matchedId),
      ...(results.manyNewAliases || []).map(r => r.matchedId),
      ...conflictIds,
    ].filter((id, i, arr) => id != null && arr.indexOf(id) === i);
    if (!ids.length) { setOnCache({}); return; }
    window.api.db.query(
      `SELECT medscan_id, name FROM objectnames WHERE medscan_id = ANY($1)`, [ids]
    ).then(res => {
      if (res.ok) {
        const cache = {};
        for (const row of res.rows) cache[Number(row.medscan_id)] = row.name;
        setOnCache(cache);
      }
    }).catch(() => {});
  }, [results]);

  const handlePickFile = async () => {
    const filters = importFormat === 'flat'
      ? [
          { name: 'Flat dictionary files', extensions: ['e', 'tab', 'txt', 'tsv', 'csv'] },
          { name: 'All files', extensions: ['*'] },
        ]
      : [{ name: 'Dictionary files', extensions: ['txt', 'tab', 'tsv', 'csv'] }];
    const opts = { filters };
    if (lastImportDir.current) opts.defaultPath = lastImportDir.current;
    const f = await window.api.dialog.openFile(opts);
    if (f) {
      setFile(f); setResults(null); setError(null); setSubmitMsg(null); setAddOrgMsg(null); setAddOrgONMsg(null);
      // Remember the directory for next time
      const dir = f.replace(/[\\/][^\\/]+$/, '');
      lastImportDir.current = dir;
      window.api.settings.set({ lastInputDir: dir }).catch(() => {});
      if (importFormat === 'flat') {
        const parsed = parseFlatFilename(f);
        if (parsed.organism) setOrganism(parsed.organism);
        if (parsed.dict) setTargetTable(parsed.dict);
      }
    }
  };

  const handleAnalyze = async () => {
    if (!file)        { setError('Please select a file.'); return; }
    if (!entityType)  { setError('Please select an entity type.'); return; }
    if (!targetTable) { setError('Please select a target table.'); return; }
    if (cartridgeList.length === 0)  { setError('Please select at least one cartridge.'); return; }
    setError(null); setAnalyzing(true); setResults(null); setSubmitMsg(null); setRemapRecords([]); setOnImportData(null); setAddOrgMsg(null); setAddOrgONMsg(null);
    try {
      const content = await window.api.fs.readFile(file);
      if (!content) { setError('Could not read file.'); return; }

      // ── Format mismatch guard ──────────────────────────────────────────────────
      // Sample up to 10 data lines to detect whether the file looks flat (numeric
      // first column) or aggregated (text first column).  Warn if the user's chosen
      // format disagrees with what the file looks like.
      {
        const sampleLines = [];
        for (const rawLine of content.split('\n')) {
          const line = rawLine.replace(/^﻿/, '').trim();
          if (!line || line.startsWith('#')) continue;
          sampleLines.push(line);
          if (sampleLines.length >= 10) break;
        }
        if (sampleLines.length > 0) {
          const numericFirst = sampleLines.filter(l => {
            const col0 = l.split('\t')[0]?.trim();
            return col0 && !isNaN(Number(col0));
          }).length;
          const looksFlat = numericFirst / sampleLines.length >= 0.7;
          if (importFormat === 'flat' && !looksFlat) {
            setError('Format mismatch: the selected format is "Flat (id → alias)" but this file\'s first column does not look like numeric IDs. Did you mean to use "Aggregated" format?');
            setAnalyzing(false); return;
          }
          if (importFormat === 'aggregated' && looksFlat) {
            setError('Format mismatch: the selected format is "Aggregated" but this file\'s first column looks like numeric IDs. Did you mean to use "Flat (id → alias)" format?');
            setAnalyzing(false); return;
          }
        }
      }
      // ── ObjectNames special import path ─────────────────────────────────────
      // ObjectNames files must be 3-column: ID\tName\tURN.
      // Only rows whose ID already exists in a dictionary table are imported.
      if (importFormat === 'flat' && targetTable === 'objectnames') {
        const lines = content.split('\n');
        const parsed = [];
        const badLines = [];
        for (const rawLine of lines) {
          const line = rawLine.replace(/^﻿/, '').trim();
          if (!line || line.startsWith('#')) continue;
          const cols = line.split('\t');
          if (cols.length < 3) { badLines.push(line.slice(0, 80)); continue; }
          const id  = Number(cols[0].trim());
          const name = cols[1].trim();
          const urn  = cols[2].trim();
          if (isNaN(id) || !name) continue;
          parsed.push({ id, name, urn });
        }
        if (badLines.length > 0) {
          setError(`ObjectNames file must have 3 tab-separated columns (ID, Name, URN). ` +
            `${badLines.length} line${badLines.length !== 1 ? 's' : ''} with fewer than 3 columns found — please fix the file and retry.`);
          return;
        }
        if (!parsed.length) { setError('No valid rows found.'); return; }

        // Check which IDs already exist in ObjectNames (existing records have priority — skip them)
        setAP('Checking IDs against ObjectNames table…');
        const allIds = parsed.map(r => r.id);
        const chkON = await window.api.db.query(
          `SELECT medscan_id, name, urn FROM objectnames WHERE medscan_id = ANY($1)`,
          [allIds]
        );
        // Build a map of existing records for exact-match comparison: id → {id, name, urn}
        const existingONMap = new Map();
        if (chkON.ok) {
          for (const row of chkON.rows)
            existingONMap.set(Number(row.medscan_id), { id: Number(row.medscan_id), name: row.name || '', urn: row.urn || '' });
        }

        // Also detect URN-based conflicts: rows not matched by ID whose URN matches a DB record
        const notMatchedById = parsed.filter(r => !existingONMap.has(r.id));
        const allUrns = notMatchedById.map(r => r.urn).filter(Boolean);
        const existingONByUrn = new Map(); // urn → {id, name, urn}
        if (allUrns.length > 0) {
          setAP('Checking URNs against ObjectNames table…');
          const chkUrn = await window.api.db.query(
            `SELECT medscan_id, name, urn FROM objectnames WHERE urn = ANY($1)`,
            [allUrns]
          );
          if (chkUrn.ok) {
            for (const row of chkUrn.rows)
              existingONByUrn.set(row.urn, { id: Number(row.medscan_id), name: row.name || '', urn: row.urn || '' });
          }
        }

        // Also detect Name-based conflicts against ObjectNames: rows not matched by ID or URN
        const notMatchedByIdOrUrn = notMatchedById.filter(r => !(r.urn && existingONByUrn.has(r.urn)));
        const allNames = notMatchedByIdOrUrn.map(r => r.name).filter(Boolean);
        const existingONByName = new Map(); // lower(name) → {id, name, urn}
        if (allNames.length > 0) {
          setAP('Checking Names against ObjectNames table…');
          const chkName = await window.api.db.query(
            `SELECT medscan_id, name, urn FROM objectnames WHERE lower(name) = ANY($1)`,
            [allNames.map(n => n.toLowerCase())]
          );
          if (chkName.ok) {
            for (const row of chkName.rows)
              existingONByName.set((row.name || '').toLowerCase(), { id: Number(row.medscan_id), name: row.name || '', urn: row.urn || '' });
          }
        }

        // Detect alias-based conflicts in all dictionary tables using normalized matching.
        // For each table, normalize each file name with the same rules as the DB uses,
        // then compare against the 'normalized' column.
        const notMatchedByIdUrnOrONName = notMatchedByIdOrUrn.filter(r => !(r.name && existingONByName.has((r.name || '').toLowerCase())));
        const allNamesForDict = notMatchedByIdUrnOrONName.map(r => r.name).filter(Boolean);
        const existingInDictByName = new Map(); // lower(file name) → {id, alias, table}
        if (allNamesForDict.length > 0) {
          setAP('Loading xwords for normalized dictionary matching…');
          // Ensure the shared tokenizer xwords cache is fully loaded before the loop.
          // This is the single async step; all normalizations below are then synchronous.
          await ensureXwordsLoaded();

          // chemnames is a helper token table for CASdictionary — it has no URNs or ObjectNames records
          const dictTables = ['curnames','celldictionary','casdictionary','userdict','keywords','combnames','exactliteral'];
          for (const tbl of dictTables) {
            setAP(`Checking normalized names against ${tbl}…`);

            // exactliteral stores its 'normalized' via exactLiteralTokenized(), not the standard pipeline.
            // Use lower(alias) comparison instead — correct for case-insensitive exact match.
            if (tbl === 'exactliteral') {
              const loweredNames = [...new Set(allNamesForDict.map(n => n.toLowerCase()))].filter(Boolean);
              if (!loweredNames.length) continue;
              const res = await window.api.db.query(
                `SELECT medscan_id, alias FROM exactliteral WHERE lower(alias) = ANY($1) AND bdeleted = false`,
                [loweredNames]
              );
              if (!res.ok) continue;
              const lowerToDb = new Map();
              for (const row of res.rows) {
                const k = (row.alias || '').toLowerCase();
                if (!lowerToDb.has(k))
                  lowerToDb.set(k, { id: Number(row.medscan_id), alias: row.alias || '', table: tbl });
              }
              for (const name of allNamesForDict) {
                const key = name.toLowerCase();
                if (!existingInDictByName.has(key) && lowerToDb.has(key))
                  existingInDictByName.set(key, lowerToDb.get(key));
              }
              continue;
            }

            // Use the synchronous normalizer — xwords are fully loaded by ensureXwordsLoaded() above.
            // Using the sync version avoids 876 × 6 = ~5000 sequential microtask yields that
            // blocked the UI for ~1 minute when analysis ran on large files.
            const nameToNorm = new Map(); // original name → normalized form for this table
            for (const name of allNamesForDict) {
              const n = normalizeAliasSync(name, tbl);
              if (n) nameToNorm.set(name, n);
            }
            const normalizedValues = [...new Set(nameToNorm.values())].filter(Boolean);
            if (!normalizedValues.length) continue;

            const res = await window.api.db.query(
              `SELECT medscan_id, alias, normalized FROM ${tbl} WHERE normalized = ANY($1) AND bdeleted = false`,
              [normalizedValues]
            );
            if (!res.ok) continue;

            // First match per normalized value wins
            const normToDb = new Map();
            for (const row of res.rows) {
              if (row.normalized && !normToDb.has(row.normalized))
                normToDb.set(row.normalized, { id: Number(row.medscan_id), alias: row.alias || '', table: tbl });
            }

            // Map back to original file names; first table match across tables wins
            for (const [name, normalized] of nameToNorm) {
              const key = name.toLowerCase();
              if (!existingInDictByName.has(key) && normToDb.has(normalized))
                existingInDictByName.set(key, normToDb.get(normalized));
            }
          }

          // Enrich dict matches with URN from objectnames (dict tables don't store URN)
          if (existingInDictByName.size > 0) {
            const dictDbIds = [...new Set([...existingInDictByName.values()].map(v => v.id).filter(Boolean))];
            const urnRes = await window.api.db.query(
              `SELECT medscan_id, urn FROM objectnames WHERE medscan_id = ANY($1)`,
              [dictDbIds]
            );
            if (urnRes.ok) {
              const idToUrn = new Map(urnRes.rows.map(r => [Number(r.medscan_id), r.urn || '']));
              for (const val of existingInDictByName.values())
                val.urn = idToUrn.get(val.id) || '';
            }
          }
        }

        const matchedNew = parsed.filter(r =>
          !existingONMap.has(r.id) &&
          !(r.urn && existingONByUrn.has(r.urn)) &&
          !(r.name && existingONByName.has((r.name || '').toLowerCase())) &&
          !(r.name && existingInDictByName.has((r.name || '').toLowerCase()))
        );
        // Only show in "already in ON" if content differs — identical records are silently ignored
        let identicalCount = 0;
        const alreadyInON = [];
        const alreadyInDB = [];
        for (const r of parsed) {
          const exById = existingONMap.get(r.id);
          if (exById) {
            const isIdentical = exById.name === (r.name || '') && (exById.urn || '') === (r.urn || '');
            if (isIdentical) { identicalCount++; continue; }
            alreadyInON.push({ ...r, _dbRecord: exById, _conflictType: 'id' });
            continue;
          }
          if (r.urn && existingONByUrn.has(r.urn)) {
            alreadyInON.push({ ...r, _dbRecord: existingONByUrn.get(r.urn), _conflictType: 'urn' });
            continue;
          }
          if (r.name && existingONByName.has((r.name || '').toLowerCase())) {
            alreadyInON.push({ ...r, _dbRecord: existingONByName.get((r.name || '').toLowerCase()), _conflictType: 'name' });
            continue;
          }
          if (r.name && existingInDictByName.has((r.name || '').toLowerCase())) {
            alreadyInDB.push({ ...r, _dbRecord: existingInDictByName.get((r.name || '').toLowerCase()) });
          }
        }
        const appr = {};
        matchedNew.forEach((_, i) => { appr[i] = true; });
        setOnApprovals(appr);
        setOnColWidthsON(null); setOnColWidthsDB(null); // reset to equal split for each new import
        setOnImportData({ matched: matchedNew, alreadyInON, alreadyInDB, identicalCount, totalRows: parsed.length });
        setResultTab('on_matched');
        return;
      }
      // ── End ObjectNames path ─────────────────────────────────────────────────

      // Preload xwords once (needed by batchCheckDuplicates regardless of format)
      const loadXw = async tbl => {
        const r = await window.api.db.query(`SELECT xword FROM ${tbl} LIMIT 5000`);
        return r.ok ? new Set(r.rows.map(x => x.xword.toLowerCase())) : new Set();
      };
      const [xwC, xwCells, xwCas, xwComb] = await Promise.all([
        loadXw('xwords'), loadXw('xwords_cells'), loadXw('xwords_cas'),
        loadXw('xwords_comb'),
      ]);
      xwRef.current = { curnames: xwC, cells: xwCells, cas: xwCas, comb: xwComb };
      // Union of single-char xwords from ALL tables — must match what retokenize/computeTokenized
      // uses as separatorSet so that splitting behaviour is identical in duplicate checks.
      const xwSepSet = buildSeparatorSet({ xwords: xwC, xwords_cells: xwCells, xwords_cas: xwCas, xwords_comb: xwComb });

      // Preview IDs — use a real gap pool so preview reflects actual available IDs,
      // not a naive sequential counter that would include already-taken IDs.
      // Pool is pre-fetched once; submission recomputes it fresh anyway.
      let previewPool = null;
      let previewPoolIdx = 0;
      let idCounter = 0; // fallback sequential counter (used only if pool unavailable)
      if (entityType !== '__nlp_ids__') {
        const et0 = resolveEntityType(entityType);
        if (et0) {
          // Request enough IDs to cover any realistic batch (cap at 300k to keep query fast)
          const previewCount = Math.min(et0.max - et0.min, 300000);
          const { ids: pIds } = await getIdPool(entityType, previewCount);
          if (pIds && pIds.length > 0) {
            previewPool = pIds;
          } else {
            // Fallback: find just the first gap for sequential counter
            const nr = await getNextId('curnames', entityType);
            idCounter = nr.id ?? et0.min;
          }
        }
      }

      const newRecords = [], existingRecords = [], newAliases = [], manyNewAliases = [], mappedConflicts = [], conflicts = [];

      // Shared numeric filter predicate
      const isNumericFilter = ignoreNumbers
        ? s => /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s.trim())
        : null;

      // ── Shared classification helper ──────────────────────────────────────────
      // Classifies one parsed row into the correct result bucket based on hitMap.
      const classifyRow = (row, hitMap, hitMapAll = null) => {
        const mapped = [], unmapped = [];
        for (const alias of row.aliases) {
          const hit = hitMap.get(alias) ?? null;
          (hit !== null ? mapped : unmapped).push({ alias, hit });
        }
        if (mapped.length === 0) {
          const flatReusePreview = entityType === '__nlp_ids__' && row._flatId != null;
          const pid = flatReusePreview
            ? row._flatId
            : (previewPool && previewPoolIdx < previewPool.length
                ? previewPool[previewPoolIdx++]
                : idCounter++);
          // Identify aliases that already exist in DB for a different organism:
          // hitMapAll (no organism filter) found a match but hitMap (organism-aware) did not.
          let crossOrgAliases = null;
          if (hitMapAll) {
            const xo = [];
            for (const alias of row.aliases) {
              const hit = hitMapAll.get(alias) ?? null;
              if (hit !== null) xo.push({ alias, dbMsId: Number(hit.dup.medscan_id), dbDict: hit.dict });
            }
            if (xo.length) crossOrgAliases = xo;
          }
          newRecords.push({ name: row.name, aliases: row.aliases, _flatId: row._flatId, _flatUrn: row._flatUrn,
                            previewId: pid, _reusePreview: flatReusePreview,
                            _aliasMatchMap: row._aliasMatchMap || null,
                            crossOrgAliases }); // null when no organism filter or no cross-org matches
        } else if (mapped.length === row.aliases.length) {
          const ids = new Set(mapped.map(m => String(m.hit.dup.medscan_id)));
          const aliasMatches = [...mapped, ...unmapped];
          if (ids.size === 1) {
            existingRecords.push({ ...row, matchedId: Number([...ids][0]), aliasMatches });
          } else {
            mappedConflicts.push({ ...row, aliasMatches, mapped, unmapped });
          }
        } else {
          const idCounts = {};
          for (const m of mapped) { const id = String(m.hit.dup.medscan_id); idCounts[id] = (idCounts[id] || 0) + 1; }
          const [domId, domCount] = Object.entries(idCounts).sort((a, b) => b[1] - a[1])[0];
          const matchedAliases   = mapped.filter(m => String(m.hit.dup.medscan_id) === domId).map(m => m.alias);
          const newAliasesForRow = unmapped.map(m => m.alias);
          if (domCount / row.aliases.length >= 0.5) {
            newAliases.push({ ...row, matchedId: Number(domId), matchedAliases, newAliasesForRow, mapped, unmapped });
          } else {
            const uniqueMatchedIds = new Set(mapped.map(m => String(m.hit.dup.medscan_id)));
            if (uniqueMatchedIds.size === 1) {
              manyNewAliases.push({ ...row, matchedId: Number(domId), matchedAliases, newAliasesForRow, mapped, unmapped });
            } else {
              conflicts.push({ ...row, aliasMatches: [...mapped, ...unmapped], mapped, unmapped });
            }
          }
        }
      };

      if (importFormat === 'flat') {
        // ── Flat format ─────────────────────────────────────────────────────────
        // Must see all lines to group by ID, so parse upfront then process in batches.
        let rows = parseFlatFile(content, false);
        if (!rows.length) { setError('No data rows found.'); return; }
        if (revertInverted) {
          for (const row of rows) {
            const seen = new Set(); const normalized = [];
            for (const alias of row.aliases) {
              const rev = revertInvertedAlias(alias); const canonical = rev ?? alias;
              const k = canonical.toLowerCase();
              if (!seen.has(k)) { seen.add(k); normalized.push(canonical); }
            }
            row.aliases = normalized;
          }
        }
        if (isNumericFilter) {
          rows = rows.filter(row => !isNumericFilter(row.name));
          for (const row of rows) row.aliases = row.aliases.filter(a => !isNumericFilter(a));
        }
        const totalRows = rows.length;
        while (rows.length > 0) {
          const batch = rows.splice(0, 10000);
          setAP(`Checking duplicates… (${(totalRows - rows.length).toLocaleString()} / ${totalRows.toLocaleString()})`);
          const batchAliases = [...new Set(batch.flatMap(r => r.aliases))];
          // Merge per-alias match maps from all rows in the batch
          const batchAMM = batch.some(r => r._aliasMatchMap)
            ? new Map(batch.flatMap(r => r._aliasMatchMap ? [...r._aliasMatchMap] : []))
            : null;
          const [hitMap, hitMapAll] = await Promise.all([
            batchCheckDuplicates(batchAliases, xwC, xwCells, xwCas, null, xwComb, elMatchFlag, batchAMM, organism || null, null, xwSepSet),
            batchCheckDuplicates(batchAliases, xwC, xwCells, xwCas, null, xwComb, elMatchFlag, batchAMM, null,            null, xwSepSet),
          ]);
          for (const row of batch) classifyRow(row, hitMap, hitMapAll);
        }
      } else {
        // ── Dict format: streaming line-batch processing ─────────────────────────
        // Never builds a full rows[] array — parses and classifies one batch of lines
        // at a time so peak V8 heap stays low regardless of file size.
        const lines = content.split('\n');
        let nameCol = 1, synsCol = 2;
        // Detect column positions from header comment lines
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('#') && line.includes('\t')) {
            const cols = line.replace(/^#+\s*/, '').split('\t').map(s => s.trim().toLowerCase());
            const ni = cols.findIndex(c => c === 'name');
            const si = cols.findIndex(c => ['syns','synonyms','aliases','alias','synonym'].includes(c));
            if (ni >= 0) nameCol = ni;
            if (si >= 0) synsCol = si;
          }
          if (!line.startsWith('#')) break; // stop at first data line
        }

        const LINE_BATCH = 20000;
        let totalParsed = 0;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx += LINE_BATCH) {
          // Parse this slice of lines into a small batch of row objects
          const batch = [];
          const end = Math.min(lineIdx + LINE_BATCH, lines.length);
          for (let i = lineIdx; i < end; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;
            const cols = line.split('\t');
            const name = stripQuotes((cols[nameCol] || '').trim());
            if (!name) continue;
            if (isNumericFilter && isNumericFilter(name)) continue;
            const synsRaw = stripQuotes((cols[synsCol] || '').trim());
            const syns = synsRaw ? synsRaw.split(/\s*[|;]\s*/).map(s => stripQuotes(s.trim())).filter(Boolean) : [];
            const seen = new Set();
            const aliases = [];
            for (const a of [name, ...syns]) {
              if (isNumericFilter && isNumericFilter(a)) continue;
              const k = a.toLowerCase();
              if (!seen.has(k)) { seen.add(k); aliases.push(a); }
            }
            if (!aliases.length) continue;
            if (revertInverted) {
              const revSeen = new Set(); const normalized = [];
              for (const alias of aliases) {
                const rev = revertInvertedAlias(alias); const canonical = rev ?? alias;
                const k = canonical.toLowerCase();
                if (!revSeen.has(k)) { revSeen.add(k); normalized.push(canonical); }
              }
              if (normalized.length) batch.push({ name, aliases: normalized });
            } else {
              batch.push({ name, aliases });
            }
          }
          if (!batch.length) continue;
          totalParsed += batch.length;
          setAP(`Checking duplicates… (${totalParsed.toLocaleString()} rows)`);
          const batchAliases = [...new Set(batch.flatMap(r => r.aliases))];
          const [hitMap, hitMapAll] = await Promise.all([
            batchCheckDuplicates(batchAliases, xwC, xwCells, xwCas, null, xwComb, elMatchFlag, null, organism || null, null, xwSepSet),
            batchCheckDuplicates(batchAliases, xwC, xwCells, xwCas, null, xwComb, elMatchFlag, null, null,            null, xwSepSet),
          ]);
          for (const row of batch) classifyRow(row, hitMap, hitMapAll);
        }

        if (!newRecords.length && !existingRecords.length && !newAliases.length &&
            !manyNewAliases.length && !mappedConflicts.length && !conflicts.length) {
          setError('No data rows found.'); return;
        }
      }

      // ── combNames anchor check ─────────────────────────────────────────────────
      // For IDs outside 10,000,000–10,999,999 the NLP ID must exist in at least
      // one of curnames / celldictionary / exactliteral.  If it doesn't, the row
      // has no anchor and is flagged as an "unanchored" conflict.
      if (targetTable === 'combnames') {
        const CELL_TYPE_MIN = 10_000_000, CELL_TYPE_MAX = 10_999_999;
        // Collect candidate IDs from all non-conflict buckets
        const candidateRows = [
          ...newRecords.map(r => ({ bucket: 'newRecords', row: r, id: r._flatId })),
          ...existingRecords.map(r => ({ bucket: 'existingRecords', row: r, id: r._flatId ?? r.matchedId })),
          ...newAliases.map(r => ({ bucket: 'newAliases', row: r, id: r.matchedId })),
          ...manyNewAliases.map(r => ({ bucket: 'manyNewAliases', row: r, id: r.matchedId })),
        ].filter(({ id }) => {
          const n = Number(id);
          return !isNaN(n) && (n < CELL_TYPE_MIN || n > CELL_TYPE_MAX);
        });

        if (candidateRows.length > 0) {
          const outerIds = [...new Set(candidateRows.map(c => Number(c.id)))];
          // Check which IDs exist in any of the three anchor dictionaries
          const anchorRes = await window.api.db.query(
            `SELECT DISTINCT medscan_id FROM curnames    WHERE medscan_id = ANY($1)
             UNION
             SELECT DISTINCT medscan_id FROM celldictionary WHERE medscan_id = ANY($1)
             UNION
             SELECT DISTINCT medscan_id FROM exactliteral   WHERE medscan_id = ANY($1)`,
            [outerIds]
          );
          const anchoredSet = new Set((anchorRes.ok ? anchorRes.rows : []).map(r => Number(r.medscan_id)));
          const unanchoredIds = new Set(outerIds.filter(id => !anchoredSet.has(id)));

          if (unanchoredIds.size > 0) {
            // Move unanchored rows out of their buckets into conflicts
            for (const bucket of ['newRecords', 'existingRecords', 'newAliases', 'manyNewAliases']) {
              const arr = { newRecords, existingRecords, newAliases, manyNewAliases }[bucket];
              const keep = [], moved = [];
              for (const row of arr) {
                const id = Number(row._flatId ?? row.matchedId);
                if (unanchoredIds.has(id)) moved.push(row); else keep.push(row);
              }
              arr.length = 0; arr.push(...keep);
              for (const row of moved) {
                conflicts.push({
                  name: row.name,
                  aliases: row.aliases,
                  mapped: (row.aliases || []).map(alias => ({
                    alias,
                    hit: { dup: { medscan_id: row._flatId ?? row.matchedId }, dict: '(unanchored)' },
                    status: 'unanchored',
                  })),
                  _unanchored: true,
                  _flatId: row._flatId ?? row.matchedId,
                });
              }
            }
          }
        }
      }
      // ── End combNames anchor check ─────────────────────────────────────────────

      // Sort conflicts by number of unique matched DB records ascending (fewest first — easiest to resolve)
      const uniqueIds = row => new Set(row.mapped.map(m => String(m.hit.dup.medscan_id))).size;
      conflicts.sort((a, b) => uniqueIds(a) - uniqueIds(b));
      mappedConflicts.sort((a, b) => uniqueIds(a) - uniqueIds(b));

      // ── CASdictionary: check tokens against chemNames ─────────────────────
      let casChemMissing = [];
      if (targetTable === 'casdictionary') {
        setAP('Checking tokens against chemNames…');
        const tokCas = makeXwordTokenizer(xwCas);
        const aliasEntries = [];
        for (const row of newRecords) {
          for (const alias of row.aliases) {
            if (!isShortAlias(alias)) aliasEntries.push({ row, alias, bucket: 'newRecords' });
          }
        }
        for (const row of newAliases) {
          for (const alias of (row.newAliasesForRow || [])) {
            if (!isShortAlias(alias)) aliasEntries.push({ row, alias, bucket: 'newAliases' });
          }
        }
        if (aliasEntries.length > 0) {
          const allTokensSet = new Set(
            aliasEntries.flatMap(e => tokCas(e.alias).split(/\s+/).filter(Boolean).map(t => t.toLowerCase()).filter(t => /[a-z]/.test(t)))
          );
          const allTokensArr = [...allTokensSet];
          const chkRes = await window.api.db.query(
            `SELECT lower(alias) AS alias FROM chemnames WHERE lower(alias) = ANY($1) AND (bdeleted IS NULL OR bdeleted = FALSE)`,
            [allTokensArr]
          );
          const existingTokens = new Set(chkRes.ok ? chkRes.rows.map(r => r.alias) : []);
          const rowsMissing = new Map();
          for (const { row, alias, bucket } of aliasEntries) {
            const tokens = tokCas(alias).split(/\s+/).filter(Boolean).map(t => t.toLowerCase()).filter(t => /[a-z]/.test(t));
            const missing = tokens.filter(t => !existingTokens.has(t));
            if (missing.length > 0) {
              if (!rowsMissing.has(row)) rowsMissing.set(row, { row, aliasMissing: [], bucket });
              rowsMissing.get(row).aliasMissing.push({ alias, missingTokens: missing });
            }
          }
          if (rowsMissing.size > 0) {
            const missingSet = new Set(rowsMissing.keys());
            const keptNR = newRecords.filter(r => !missingSet.has(r));
            newRecords.length = 0; newRecords.push(...keptNR);
            const keptNA = newAliases.filter(r => !missingSet.has(r));
            newAliases.length = 0; newAliases.push(...keptNA);
            casChemMissing = [...rowsMissing.values()];
          }
        }
      }
      // ── End CASdictionary chemNames check ────────────────────────────────────

      setResults({ newRecords, existingRecords, newAliases, manyNewAliases, mappedConflicts, conflicts, casChemMissing });
      setRequireObjectNames(entityType === '__nlp_ids__');
      const nrApprv = {};
      newRecords.forEach((_, i) => { nrApprv[i] = true; });
      setNrApprovals(nrApprv);
      const approvals = {};
      newAliases.forEach((_, i) => { approvals[i] = true; });
      setNaApprovals(approvals);
      const mnaApprovals = {};
      manyNewAliases.forEach((_, i) => { mnaApprovals[i] = true; });
      setMnaApprovals(mnaApprovals);
      setConflictExp(new Set());
      setManualAssign({});
      // Re-apply auto-resolve checkboxes to the fresh conflicts list immediately,
      // so the state of the checkboxes always matches what is displayed.
      sameTypeUpdatesRef.current   = {};
      longerUpdatesRef.current     = {};
      sameNameUpdatesRef.current   = {};
      aliasMatchUpdatesRef.current = {};
      autoUpdatesRef.current       = {};
      setResolveToSameType(false);
      setResolveToLonger(false);
      setResolveToSameName(false);
      setResolveToAliasMatch(false);
      setMinMatchLen(0);
      setConflictDec({});
      setResultTab('new');
    } catch (e) {
      setError(`Analysis failed: ${e.message}`);
    } finally {
      setAnalyzing(false); setAP('');
    }
  };

  // Tokenize one alias for duplicate-check purposes (case-insensitive, so lowercase for short aliases)
  const tok = alias => isShortAlias(alias)
    ? alias.toLowerCase()
    : makeXwordTokenizer(xwRef.current.curnames)(alias);

  // Determine the correct long-alias dictionary for a given medscan_id
  const dictForId = (msId) => {
    const et = resolveEntityTypeFromId(Number(msId));
    return (et && ENTITY_TO_TABLE[et.rnef]) || 'curnames';
  };
  // Entity-type RNEF for the *input* side of a row (used by "only same type" filter).
  // "Valid NLP IDs in file" mode: infer entity type from the file ID range.
  // Otherwise use the user-selected entityType directly.
  const getInputEtRnef = (row) => {
    if (entityType === '__nlp_ids__' && row._flatId != null)
      return resolveEntityTypeFromId(row._flatId)?.rnef ?? null;
    return resolveEntityType(entityType)?.rnef ?? null;
  };
  const isSameType = (row) => {
    const inputRnef   = getInputEtRnef(row);
    const matchedRnef = resolveEntityTypeFromId(row.matchedId)?.rnef;
    return inputRnef != null && matchedRnef != null && inputRnef === matchedRnef;
  };
  // Phase-1 / Phase-2 tokenizers per dict table. They use the shared tokenizer.js cache
  // (tokenizeAliasSync / normalizeAliasSync): xwords for the dictionary's own xwords table + the global
  // separator set. Callers must have awaited ensureXwordsLoaded() (done at mount and before every write);
  // if not, they THROW instead of silently tokenizing without xwords.
  const xwTokFor = (dict) => (alias) => tokenizeAliasSync(alias, dict);
  const xwNormFor = (dict) => (alias) => normalizeAliasSync(alias, dict);

  const dbInsertAlias = async (msId, alias, cartridges, orgs) => {
    const isShort = isShortAlias(alias);
    // Short aliases always go to exactliteral regardless of entity type
    const dict      = isShort ? 'exactliteral' : dictForId(msId);
    const match     = isShort ? 'l' : null;
    if (dict === 'casdictionary') {
      // CASDictionary: single route (tokenize/normalize + chemNames approval dialog)
      const r = await addToCasDictionary([{ msId, alias, match, cartridges, organisms: orgs }]);
      if (!r.ok) throw new Error(r.cancelled ? `Adding "${alias}" to CASdictionary was cancelled (chemNames tokens not approved).` : r.error);
      return r;
    }
    await ensureXwordsLoaded();
    // Phase-1 → 'tokenized' column.
    const tokenized = (isShort && (match || '').includes('l'))
      ? alias
      : tokenizeAliasSync(alias, dict, match || '');
    // Phase-2 → 'normalized' column.
    const normalized = isShort
      ? exactLiteralTokenized(convertGreekToLatin(alias), match)
      : xwNormFor(dict)(alias);
    return window.api.db.query(
      `INSERT INTO ${dict} (medscan_id, alias, match, tokenized, normalized, cartridges, organisms, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [msId, alias, match, tokenized, normalized, cartridges, orgs]
    );
  };

  const dbInsertObjectNames = (msId, name, cartridges, orgs) => {
    const urn = buildEntityUrn(name, entityType);
    return window.api.db.query(
      `INSERT INTO objectnames (medscan_id, name, urn, cartridges, organisms, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [msId, name, urn, cartridges, orgs]
    );
  };

  // ── TSV export helper ──────────────────────────────────────────────────────
  const downloadTsv = (filename, headers, rowsData) => {
    const escape = v => {
      const s = v == null ? '' : String(v);
      // In TSV, only tabs and newlines need escaping — wrap in quotes if present
      return s.includes('\t') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(escape).join('\t')];
    for (const row of rowsData) lines.push(row.map(escape).join('\t'));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/tab-separated-values' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportNewRecords = () => {
    const filtered = results.newRecords.filter(r =>
      minAliasLenNR === 0 || r.aliases.some(a => a.length >= minAliasLenNR)
    );
    downloadTsv(
      'new_records.tsv',
      ['NLP ID', 'Name', 'Aliases'],
      filtered.map(r => {
        const aliases = minAliasLenNR > 0 ? r.aliases.filter(a => a.length >= minAliasLenNR) : r.aliases;
        return [r._flatId ?? '', r.name, aliases.join('; ')];
      })
    );
  };
  const handleAddOrganism = async () => {
    if (!organism) { setAddOrgMsg({ ok: false, text: 'No organism is specified in the import configuration.' }); return; }
    const ids = results.existingRecords.filter((_, i) => erApprovals[i] !== false).map(r => r.matchedId).filter(Boolean);
    if (!ids.length) return;
    setAddOrgMsg(null);
    setSubmitting(true);
    try {
      const tables = ['curnames', 'exactliteral', 'celldictionary', 'casdictionary', 'keywords', 'userdict', 'combnames'];
      let totalUpdated = 0;
      for (const tbl of tables) {
        const res = await window.api.db.query(
          `UPDATE "${tbl}" SET organisms = array_append(organisms, $1), updated_at = NOW()
           WHERE medscan_id = ANY($2) AND NOT ($1 = ANY(COALESCE(organisms, '{}'::text[])))`,
          [organism, ids]
        );
        if (!res.ok) throw new Error(`${tbl}: ${res.error}`);
        totalUpdated += res.rowCount || 0;
      }
      setAddOrgMsg({ ok: true, text: `✓ Added organism "${organism}" to ${totalUpdated} alias row${totalUpdated !== 1 ? 's' : ''} across ${ids.length} record${ids.length !== 1 ? 's' : ''}.` });
    } catch (e) {
      setAddOrgMsg({ ok: false, text: `✗ ${e.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  // Import existing-records aliases under their _flatId (file ID) rather than the matched DB ID.
  const handleImportExistingWithFileId = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const allExisting = results?.existingRecords ?? [];
      // Skip rows where file ID equals matched DB ID — those are true duplicates, nothing to change
      const eligible = allExisting.filter(r => r._flatId != null && r._flatId !== r.matchedId);
      if (!eligible.length) { setSubmitting(false); return; }
      const aliasRows = [];
      const matchedIds = [];
      for (const row of eligible) {
        for (const alias of row.aliases)
          aliasRows.push({ msId: row._flatId, alias, cartridges: cartridgeList, orgs });
        matchedIds.push(row._flatId);
      }
      const { total: n, byTable: insertedByTable, bDeletedBlocked } = await bulkInsertAliasRows(aliasRows, targetTable);
      if (matchedIds.length) await updateOrganismOnMatched(matchedIds);
      setResults(r => ({ ...r, existingRecords: allExisting.filter(row => row._flatId == null) }));
      let msg = `✓ Added ${n.toLocaleString()} aliases for ${matchedIds.length.toLocaleString()} IDs (using IDs from file)${fmtByTable(insertedByTable)}.`;
      if (bDeletedBlocked > 0)
        msg += ` ${bDeletedBlocked} ${bDeletedBlocked === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.`;
      setSubmitMsg(msg);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  const handleAddOrganismON = async () => {
    if (!organism) { setAddOrgONMsg({ ok: false, text: 'No organism is specified in the import configuration.' }); return; }
    const ids = (onImportData?.alreadyInON ?? []).map(r => r.id).filter(Boolean);
    if (!ids.length) return;
    setAddOrgONMsg(null);
    setSubmitting(true);
    try {
      const res = await window.api.db.query(
        `UPDATE objectnames SET organisms = array_append(organisms, $1), updated_at = NOW()
         WHERE medscan_id = ANY($2) AND NOT ($1 = ANY(COALESCE(organisms, '{}'::text[])))`,
        [organism, ids]
      );
      if (!res.ok) throw new Error(res.error);
      const n = res.rowCount || 0;
      setAddOrgONMsg({ ok: true, text: `✓ Added organism "${organism}" to ${n} ObjectNames row${n !== 1 ? 's' : ''}.` });
    } catch (e) {
      setAddOrgONMsg({ ok: false, text: `✗ ${e.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const exportExistingRecords = () => downloadTsv(
    'existing_records.tsv',
    ['Matched NLP ID', 'Name', 'Aliases'],
    results.existingRecords.map(r => [r.matchedId, r.name, r.aliases.join('; ')])
  );
  const exportNewAliases = () => downloadTsv(
    'new_aliases.tsv',
    ['Matched NLP ID', 'Name', 'Matched Aliases', 'New Aliases'],
    results.newAliases.map(r => [r.matchedId, r.name, r.matchedAliases.join('; '), r.newAliasesForRow.join('; ')])
  );
  const exportManyNewAliases = () => downloadTsv(
    'many_new_aliases.tsv',
    ['Matched NLP ID', 'Name', 'Matched Aliases', 'New Aliases'],
    results.manyNewAliases.map(r => [r.matchedId, r.name, r.matchedAliases.join('; '), r.newAliasesForRow.join('; ')])
  );
  const exportMappedConflicts = () => downloadTsv(
    'mapped_conflicts.tsv',
    ['Name', 'All Aliases', 'Matched IDs', 'Matched Aliases'],
    results.mappedConflicts.map(r => [
      r.name,
      r.aliases.join('; '),
      [...new Set(r.mapped.map(m => String(m.hit.dup.medscan_id)))].join('; '),
      r.mapped.map(m => m.alias).join('; '),
    ])
  );
  const exportConflicts = () => downloadTsv(
    'conflicts.tsv',
    ['Name', 'New Aliases', 'Matched IDs', 'Matched Aliases', 'Note'],
    results.conflicts.map(r => r._unanchored
      ? [r.name, r.aliases?.join('; '), String(r._flatId), '', 'Unanchored — NLP ID not in curnames/cellDictionary/exactliteral']
      : [
          r.name,
          r.unmapped.map(m => m.alias).join('; '),
          [...new Set(r.mapped.map(m => String(m.hit.dup.medscan_id)))].join('; '),
          r.mapped.map(m => m.alias).join('; '),
          '',
        ]
    )
  );

  const handleSubmitCasChemMissing = async () => {
    if (!results?.casChemMissing?.length) return;
    setCasChemImporting(true); setCasChemImportMsg(null);
    const orgs = [organism].filter(Boolean);
    const longAliasTable = targetTable || 'casdictionary';
    try {
      // chemNames tokens are checked/approved/added inside addToCasDictionary (single CASdictionary route)
      const allMissing = [...new Set(
        results.casChemMissing.flatMap(e => e.aliasMissing.flatMap(a => a.missingTokens))
      )];

      // Import the rows (similar to handleSubmitNewRecords but only for casChemMissing rows)
      const longAliasRows = [], exactliteralRows = [], objectnamesRows = [];
      const missingRows = results.casChemMissing;

      // Fetch ID pool — CAS entries are always SmallMol, so fall back to SmallMol when the
      // import mode is "NLP IDs from file" (sentinel) which has no resolvable entity type range.
      const casEntityType = (entityType === '__nlp_ids__' || !resolveEntityType(entityType))
        ? 'SmallMol' : entityType;
      const { ids: poolIds, error: poolErr } = await getIdPool(casEntityType, missingRows.length);
      if (!poolIds) throw new Error(`Could not get IDs: ${poolErr}`);
      let idPoolIdx = 0;

      for (const { row } of missingRows) {
        const msId = poolIds[idPoolIdx++];
        if (!msId) throw new Error('Ran out of available IDs.');
        const { name: entityName, urn: entityUrn } = buildEntityRecord(row.aliases, entityType);
        objectnamesRows.push([msId, entityName, entityUrn || null, cartridgeList, orgs]);
        for (const alias of row.aliases) {
          if (isShortAlias(alias)) {
            exactliteralRows.push([msId, alias, 'l', alias, alias, cartridgeList, orgs]);
          } else {
            longAliasRows.push([msId, alias, null, null, null, cartridgeList, orgs]);
          }
        }
      }

      // Insert — CASDictionary only through addToCasDictionary (approval dialog for missing chemNames tokens)
      const casRes = await addToCasDictionary(longAliasRows.map(([msId, alias, match, , , carts, orgsArr]) => ({ msId, alias, match, cartridges: carts, organisms: orgsArr })));
      if (!casRes.ok) {
        if (casRes.cancelled) { setCasChemImporting(false); setCasChemImportMsg({ ok: false, text: 'Cancelled — chemNames tokens were not approved; nothing was imported.' }); return; }
        throw new Error(casRes.error);
      }
      for (const [msId, alias, match, tok, norm, carts, orgsArr] of exactliteralRows) {
        await window.api.db.query(
          `INSERT INTO exactliteral (medscan_id, alias, match, tokenized, normalized, cartridges, organisms, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) ON CONFLICT DO NOTHING`,
          [msId, alias, match, tok, norm, carts, orgsArr]
        );
      }
      for (const [msId, name, urn, carts, orgsArr] of objectnamesRows) {
        await window.api.db.query(
          `INSERT INTO objectnames (medscan_id, name, urn, cartridges, organisms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [msId, name, urn, carts, orgsArr]
        );
      }

      const nAdded = missingRows.length;
      const nTokens = allMissing.length;
      setCasChemImportMsg({ ok: true, text: `✓ Imported ${nAdded} record${nAdded !== 1 ? 's' : ''} and added ${nTokens} token${nTokens !== 1 ? 's' : ''} to chemNames.` });
      setResults(r => ({ ...r, casChemMissing: [] }));
    } catch (e) {
      setCasChemImportMsg({ ok: false, text: `✗ ${e.message}` });
    } finally {
      setCasChemImporting(false);
    }
  };

  // mode: 'new_only' — only insert truly new aliases (skip cross-org)
  //       'all'      — insert new aliases AND (unless skipOrgAnnotation) add organism to existing cross-org alias rows
  const handleSubmitNewRecords = async (mode = 'new_only', { skipOrgAnnotation = false } = {}) => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const now = new Date().toISOString();
      // Use user-selected target table (defaults to entity-type routing)
      const longAliasTable = targetTable || 'curnames';
      const tokLong = xwTokFor(longAliasTable);

      const longAliasRows = [], exactliteralRows = [], objectnamesRows = [];

      let approvedNewRecords = results.newRecords.filter((_, i) => nrApprovals[i] !== false);

      // If "Import only if ID exists in ObjectNames" is on and we're in flatReuseMode,
      // skip records whose file ID is not registered in ObjectNames.
      let nrOnSkipped = 0;
      if (requireObjectNames && entityType === '__nlp_ids__') {
        const flatIds = approvedNewRecords.map(r => r._flatId).filter(id => id != null);
        const validIds = await getOnValidIds(flatIds);
        if (validIds) {
          const skipped = approvedNewRecords.filter(r => r._flatId != null && !validIds.has(r._flatId));
          approvedNewRecords = approvedNewRecords.filter(r => r._flatId == null || validIds.has(r._flatId));
          nrOnSkipped = skipped.length;
          if (skipped.length > 0) {
            setNoUrnRecords(prev => [
              ...prev,
              ...skipped.map(r => ({
                name:    r.name || '',
                id:      r._flatId,
                aliases: (r.aliases || []).join('; '),
                source:  'New Records',
              })),
            ]);
          }
        }
      }

      // "Valid NLP IDs in file" mode: derive IDs per-record from file, check for collisions.
      // All other modes: pre-fetch a pool of gap IDs for the whole batch up front.
      const flatReuseMode = entityType === '__nlp_ids__';
      let idPool = [];
      let idPoolIdx = 0;
      {
        // Count how many records will need a new assigned ID
        const needCount = flatReuseMode
          ? 0  // IDs come from file; collision fallback pools fetched per entity type below
          : approvedNewRecords.length;
        if (needCount > 0) {
          setAP(`Finding ${needCount.toLocaleString()} available IDs in range…`);
          const { ids: poolIds, error: poolErr } = await getIdPool(entityType, needCount);
          if (!poolIds) throw new Error(`Could not get IDs: ${poolErr}`);
          idPool = poolIds;
        }
      }

      // "Valid NLP IDs in file": check which file IDs already exist in DB
      let existingFlatIds = new Set();
      if (flatReuseMode) {
        const flatIds = approvedNewRecords.map(r => r._flatId).filter(id => id != null && !isNaN(id));
        if (flatIds.length > 0) {
          // Check alias tables only (not objectnames) — an ID that exists only in objectnames
          // means names/URNs were pre-imported and should be reused, not treated as a collision.
          const aliasUnions = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames']
            .map(t => `SELECT medscan_id FROM ${t}`)
            .join(' UNION ');
          const chkRes = await window.api.db.query(
            `SELECT DISTINCT medscan_id FROM (${aliasUnions}) _a WHERE medscan_id = ANY($1)`,
            [flatIds]
          );
          if (chkRes.ok) existingFlatIds = new Set(chkRes.rows.map(r => Number(r.medscan_id)));
        }
      }

      // In flatReuseMode, track IDs that already have ObjectNames entries so we don't overwrite their URNs.
      // Also build a content map (id → {name, urn}) for identical-record detection on ObjectNames imports.
      let existingOnIds = new Set();
      let existingOnContentMap = new Map(); // id → { name, urn }
      if (flatReuseMode) {
        const flatIds = approvedNewRecords.map(r => r._flatId).filter(id => id != null && !isNaN(id));
        if (flatIds.length > 0) {
          const onRes = await window.api.db.query(
            `SELECT medscan_id, name, urn FROM objectnames WHERE medscan_id = ANY($1)`,
            [flatIds]
          );
          if (onRes.ok) {
            for (const r of onRes.rows) {
              const id = Number(r.medscan_id);
              existingOnIds.add(id);
              existingOnContentMap.set(id, { name: r.name || '', urn: r.urn || '' });
            }
          }
        }
      }

      // Per-entity-type fallback ID pool (collision case: file ID already in DB → assign new gap ID).
      // Pre-count per entity type then fetch the full pool at once to avoid repeated single-ID fetches.
      const fallbackPoolCache = {}; // et.rnef → { ids: number[], idx: number }
      if (flatReuseMode && existingFlatIds.size > 0) {
        // Count collisions per entity type
        const collisionCountByEt = {};
        for (const row of approvedNewRecords) {
          if (row._flatId != null && !isNaN(row._flatId) && existingFlatIds.has(row._flatId)) {
            const inferredEt = resolveEntityTypeFromId(row._flatId);
            if (inferredEt) {
              collisionCountByEt[inferredEt.rnef] = (collisionCountByEt[inferredEt.rnef] || 0) + 1;
            }
          }
        }
        // Fetch a full pool for each entity type that has collisions
        for (const [rnef, count] of Object.entries(collisionCountByEt)) {
          const et2 = ENTITY_TYPES.find(e => e.rnef === rnef);
          if (et2) {
            setAP(`Finding ${count} available IDs in ${et2.display} range…`);
            const { ids: poolIds } = await getIdPool(rnef, count);
            fallbackPoolCache[rnef] = { ids: poolIds || [], idx: 0 };
          }
        }
      }

      const remapArray = [];
      // Collect cross-org alias updates for 'all' mode: { dict, alias, msId }
      const crossOrgUpdates = [];
      let nOnIdenticalSkipped = 0;
      for (const row of approvedNewRecords) {
        let msId;
        let skipObjectNames = false;

        if (mode === 'all' && (row.crossOrgAliases || []).length > 0) {
          // Add-to-existing-record mode: target the existing DB record's medscan_id
          // rather than allocating a new gap ID, so new aliases land on the right record.
          const dbMsIds = [...new Set(row.crossOrgAliases.map(x => x.dbMsId))];
          // Collect cross-org aliases for organism annotation regardless of conflicts.
          for (const xo of row.crossOrgAliases) crossOrgUpdates.push(xo);
          if (dbMsIds.length > 1) {
            continue; // Conflict — multiple DB records matched; skip new alias insertion.
          }
          msId = dbMsIds[0]; // Single existing record — add new aliases directly to it.
          skipObjectNames = true; // ObjectNames entry already exists for this ID.
        } else if (flatReuseMode && row._flatId != null && !isNaN(row._flatId)) {
          if (targetTable === 'objectnames') {
            // ObjectNames import: never remap by alias-table collision.
            // If the exact same record (same name + URN) already exists → skip silently.
            const onEx = existingOnContentMap.get(row._flatId);
            if (onEx &&
                onEx.name === (row.name || '') &&
                onEx.urn  === (row._flatUrn || '')) {
              nOnIdenticalSkipped++;
              continue; // identical existing record — nothing to do
            }
            // Otherwise use the original ID (whether it exists in alias tables or not).
            msId = row._flatId;
          } else if (!existingFlatIds.has(row._flatId)) {
            msId = row._flatId;
          } else {
            // Flat ID collision — assign a new gap ID inferred from the file ID range
            const inferredEt = resolveEntityTypeFromId(row._flatId);
            if (inferredEt) {
              const fc = fallbackPoolCache[inferredEt.rnef];
              msId = fc ? (fc.ids[fc.idx++] ?? inferredEt.min) : inferredEt.min;
            } else {
              msId = idPool[idPoolIdx++];
            }
            // Save full record context for deferred submission from "Remapped records" tab
            remapArray.push({ origId: row._flatId, newId: msId, name: row.name, aliases: minAliasLenNR > 0 ? row.aliases.filter(a => a.length >= minAliasLenNR) : row.aliases,
              cartridgeList, orgs, longAliasTable, entityType, elMatchFlag,
              _aliasMatchMap: row._aliasMatchMap || null });
            continue; // Don't insert now — user reviews and submits from Remapped Records tab
          }
        } else {
          msId = idPool[idPoolIdx++];
        }
        // Cross-org aliases already exist in DB under a different organism — never insert
        // them as new rows (that would create duplicates). In 'all' mode, collect them for
        // an organism UPDATE on the existing rows instead. (Already collected above when
        // skipObjectNames=true, so only run here for the remaining case.)
        const crossOrgSet = new Set((row.crossOrgAliases || []).map(x => x.alias));
        if (mode === 'all' && row.crossOrgAliases && !skipObjectNames) {
          for (const xo of row.crossOrgAliases) crossOrgUpdates.push(xo);
        }
        const aliasesToImport = (minAliasLenNR > 0
          ? row.aliases.filter(a => a.length >= minAliasLenNR)
          : row.aliases
        ).filter(a => !crossOrgSet.has(a)); // always exclude cross-org aliases from new inserts
        if (aliasesToImport.length === 0) continue; // nothing new — skip new-row + ObjectNames logic
        for (const alias of aliasesToImport) {
          const isShort = isShortAlias(alias);
          if (targetTable === 'exactliteral') {
            // All aliases go to exactliteral when that is the target table.
            // Per-alias match flag from file's 3rd column overrides the global elMatchFlag.
            // '__from_file__' means use per-alias map, fall back to 'l' when absent.
            // Tokenized: match 'l*' → verbatim (case-sensitive); other → lowercase. No xwords stripping.
            const fileMf = row._aliasMatchMap?.get(alias);
            const mf = fileMf !== undefined ? fileMf
              : elMatchFlag === '__from_file__' ? '' : elMatchFlag;
            exactliteralRows.push([msId, alias, mf || null, exactLiteralTokenized(alias, mf), exactLiteralTokenized(alias, mf), cartridgeList, orgs, now, now]);
          } else if (isShort) {
            exactliteralRows.push([msId, alias, 'l', exactLiteralTokenized(alias, 'l'), exactLiteralTokenized(alias, 'l'), cartridgeList, orgs, now, now]);
          } else {
            longAliasRows.push([msId, alias, null, tokLong(alias), xwNormFor(longAliasTable)(alias), cartridgeList, orgs, now, now]);
          }
        }
        // In flatReuseMode (__nlp_ids__): skip insert if the record already has a valid ObjectNames
        // entry (its URN was pre-imported and must not be overwritten). For new IDs, derive the
        // entity type from the ID range so the URN is correct rather than "urn:agi-__nlp_ids__:...".
        if (!skipObjectNames && (!flatReuseMode || !existingOnIds.has(msId))) {
          const inferredEt = flatReuseMode ? resolveEntityTypeFromId(msId) : null;
          const urn = inferredEt
            ? buildEntityUrn(row.name, inferredEt)
            : buildEntityUrn(row.name, entityType);
          objectnamesRows.push([msId, row.name, urn, cartridgeList, orgs, now, now]);
        }
      }

      const aliasColumns = ['medscan_id', 'alias', 'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'created_at', 'updated_at'];
      const nameColumns  = ['medscan_id', 'name', 'urn', 'cartridges', 'organisms', 'created_at', 'updated_at'];

      setAP(`Inserting ${objectnamesRows.length.toLocaleString()} records into ${longAliasTable}…`);
      // CASDictionary first (approval dialog may appear; declining aborts before anything else is written)
      const r1pre = (longAliasRows.length && longAliasTable === 'casdictionary')
        ? await bulkInsertAliasTable({ table: longAliasTable, columns: aliasColumns, rows: longAliasRows })
        : null;
      if (r1pre && !r1pre.ok) throw new Error(`${longAliasTable}: ${r1pre.error}`);
      const [r1, r2, r3] = await Promise.all([
        r1pre ? r1pre : longAliasRows.length ? bulkInsertAliasTable({ table: longAliasTable,  columns: aliasColumns, rows: longAliasRows })    : { ok: true },
        exactliteralRows.length ? window.api.db.bulkInsert({ table: 'exactliteral',  columns: aliasColumns, rows: exactliteralRows }) : { ok: true },
        objectnamesRows.length  ? window.api.db.bulkInsert({ table: 'objectnames', columns: nameColumns, rows: objectnamesRows }) : { ok: true },
      ]);
      if (!r1.ok) throw new Error(`${longAliasTable}: ${r1.error}`);
      if (!r2.ok) throw new Error(`exactliteral: ${r2.error}`);
      if (!r3.ok) throw new Error(`objectnames: ${r3.error}`);

      // 'all' mode: add import organism to existing cross-org alias rows (unless user opted out)
      let nCrossOrgUpdated = 0;
      if (mode === 'all' && !skipOrgAnnotation && crossOrgUpdates.length > 0 && organism) {
        setAP(`Adding organism to ${crossOrgUpdates.length.toLocaleString()} existing aliases…`);
        // Group by dict table
        const byDict = {};
        for (const xo of crossOrgUpdates) {
          if (!byDict[xo.dbDict]) byDict[xo.dbDict] = [];
          byDict[xo.dbDict].push(xo);
        }
        for (const [dict, updates] of Object.entries(byDict)) {
          const aliasCol = dict === 'keywords' ? 'keywords' : 'alias';
          const msIds   = updates.map(u => u.dbMsId);
          const aliases = updates.map(u => u.alias);
          // Batch UPDATE via unnest — add organism only if not already present
          const res = await window.api.db.query(
            `UPDATE "${dict}" d
             SET organisms = array_append(d.organisms, $1), updated_at = NOW()
             FROM unnest($2::bigint[], $3::text[]) AS v(msid, al)
             WHERE d.medscan_id = v.msid AND LOWER(d.${aliasCol}) = LOWER(v.al)
               AND NOT ($1 = ANY(COALESCE(d.organisms, '{}'::text[])))`,
            [organism, msIds, aliases]
          );
          if (!res.ok) throw new Error(`organism update (${dict}): ${res.error}`);
          nCrossOrgUpdated += res.rowCount ?? 0;
        }
      }

      // Refresh planner stats
      setAP('Updating statistics…');
      await window.api.db.analyze([longAliasTable, 'exactliteral', 'objectnames']);

      const aliasCount = longAliasRows.length + exactliteralRows.length;
      // Count distinct IDs that received at least one alias (col 0 = medscan_id)
      const n = new Set([...longAliasRows, ...exactliteralRows].map(r => r[0])).size;
      let nrMsg = `✓ Imported ${aliasCount.toLocaleString()} new aliases for ${n.toLocaleString()} IDs.`;
      if (nCrossOrgUpdated > 0)
        nrMsg += ` Added organism "${organism}" to ${nCrossOrgUpdated.toLocaleString()} existing alias row${nCrossOrgUpdated !== 1 ? 's' : ''}.`;
      if (nOnIdenticalSkipped > 0)
        nrMsg += ` ${nOnIdenticalSkipped.toLocaleString()} ObjectNames record${nOnIdenticalSkipped !== 1 ? 's' : ''} already existed with identical content and were skipped.`;
      if (nrOnSkipped > 0)
        nrMsg += ` ${nrOnSkipped} record${nrOnSkipped !== 1 ? 's' : ''} could not be imported because they do not have corresponding Name and URN values in ObjectNames.`;
      setSubmitMsg(nrMsg);
      // Keep only the rows the user did NOT check (unchecked = skipped this time).
      // Re-index nrApprovals so remaining rows start as checked.
      setResults(r => ({
        ...r,
        newRecords: r.newRecords.filter((_, i) => nrApprovals[i] === false),
      }));
      setNrApprovals({});
      if (remapArray.length > 0) {
        setRemapRecords(remapArray);
        const appr = {};
        remapArray.forEach((_, i) => { appr[i] = true; });
        setRemapApprovals(appr);
        // Auto-switch when nothing was inserted directly (all records remapped for review).
        if (longAliasRows.length === 0 && exactliteralRows.length === 0 && objectnamesRows.length === 0) {
          setResultTab('remap');
        }
      }
      onSuccess?.(`Batch import: ${n} new records.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); setAP(null); }
  };

  // Submit approved remapped records (flat import ID collisions held for user review)
  const handleSubmitRemapped = async () => {
    setSubmitting(true); setSubmitMsg(null);
    try {
      const approved = remapRecords.filter((_, i) => remapApprovals[i] !== false);
      if (approved.length === 0) { setSubmitting(false); return; }

      const now = new Date().toISOString();
      const byLongTable = {}; // table → rows[]
      const exactliteralRows = [];
      const objectnamesRows  = [];

      // For remapped records in __nlp_ids__ mode, check which new IDs already have ObjectNames entries.
      const remapNewIds = approved
        .filter(r => r.entityType === '__nlp_ids__')
        .map(r => r.newId)
        .filter(id => id != null && !isNaN(id));
      let remapExistingOnIds = new Set();
      if (remapNewIds.length > 0) {
        const onRes = await window.api.db.query(
          `SELECT DISTINCT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`,
          [remapNewIds]
        );
        if (onRes.ok) remapExistingOnIds = new Set(onRes.rows.map(r => Number(r.medscan_id)));
      }

      for (const rec of approved) {
        const tbl        = rec.longAliasTable || 'curnames';
        const recElMatch = rec.elMatchFlag ?? 'l';
        const tokFn      = xwTokFor(tbl);
        for (const alias of rec.aliases) {
          if (tbl === 'exactliteral') {
            const fileMf = rec._aliasMatchMap?.get(alias);
            const mf = fileMf !== undefined ? fileMf
              : recElMatch === '__from_file__' ? '' : recElMatch;
            exactliteralRows.push([rec.newId, alias, mf || null, exactLiteralTokenized(alias, mf), exactLiteralTokenized(alias, mf), rec.cartridgeList, rec.orgs, now, now]);
          } else if (isShortAlias(alias)) {
            exactliteralRows.push([rec.newId, alias, 'l', exactLiteralTokenized(alias, 'l'), exactLiteralTokenized(alias, 'l'), rec.cartridgeList, rec.orgs, now, now]);
          } else {
            if (!byLongTable[tbl]) byLongTable[tbl] = [];
            byLongTable[tbl].push([rec.newId, alias, null, tokFn(alias), xwNormFor(tbl)(alias), rec.cartridgeList, rec.orgs, now, now]);
          }
        }
        // Skip ObjectNames insert if the ID already has a valid entry.
        // For __nlp_ids__ mode, derive entity type from ID range to get a proper URN.
        if (!remapExistingOnIds.has(rec.newId)) {
          const inferredEt = rec.entityType === '__nlp_ids__' ? resolveEntityTypeFromId(rec.newId) : null;
          const urn = inferredEt
            ? buildEntityUrn(rec.name, inferredEt)
            : buildEntityUrn(rec.name, rec.entityType);
          objectnamesRows.push([rec.newId, rec.name, urn, rec.cartridgeList, rec.orgs, now, now]);
        }
      }

      const aliasColumns = ['medscan_id', 'alias', 'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'created_at', 'updated_at'];
      const nameColumns  = ['medscan_id', 'name', 'urn', 'cartridges', 'organisms', 'created_at', 'updated_at'];

      // CASDictionary first (approval dialog may appear; declining aborts before anything else is written)
      if (byLongTable.casdictionary?.length) {
        const rc = await bulkInsertAliasTable({ table: 'casdictionary', columns: aliasColumns, rows: byLongTable.casdictionary });
        if (!rc.ok) throw new Error(rc.error);
      }
      const inserts = Object.entries(byLongTable).filter(([tbl]) => tbl !== 'casdictionary').map(([tbl, rows]) =>
        window.api.db.bulkInsert({ table: tbl, columns: aliasColumns, rows })
      );
      if (exactliteralRows.length) inserts.push(window.api.db.bulkInsert({ table: 'exactliteral', columns: aliasColumns, rows: exactliteralRows }));
      inserts.push(window.api.db.bulkInsert({ table: 'objectnames', columns: nameColumns, rows: objectnamesRows }));

      const results2 = await Promise.all(inserts);
      for (const r of results2) { if (!r.ok) throw new Error(r.error); }

      // Remove submitted records; keep deselected ones for potential re-review
      const remaining = remapRecords.filter((_, i) => remapApprovals[i] === false);
      setRemapRecords(remaining);
      const newAppr = {};
      remaining.forEach((_, i) => { newAppr[i] = false; });
      setRemapApprovals(newAppr);
      setRmSelected(new Set());

      const n = objectnamesRows.length;
      const aliasCount = exactliteralRows.length + Object.values(byLongTable).reduce((s, rows) => s + rows.length, 0);
      setSubmitMsg(`✓ Imported ${aliasCount.toLocaleString()} aliases for ${n.toLocaleString()} IDs (remapped).`);
      onSuccess?.(`Batch import: ${n} remapped records.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // Submit remapped records using original file ID (origId) — bypasses the gap-ID remap.
  // Only imports rows whose origId already exists in ObjectNames.
  const handleSubmitRemappedWithFileId = async () => {
    setSubmitting(true); setSubmitMsg(null);
    try {
      const approved = remapRecords.map((row, i) => ({ row, i })).filter(({ i }) => remapApprovals[i] !== false);
      if (!approved.length) { setSubmitting(false); return; }

      // Verify origIds exist in ObjectNames (skipped when requireObjectNames is false)
      const origIds = [...new Set(approved.map(({ row }) => row.origId).filter(id => id != null))];
      let importable, skippedCount;
      if (requireObjectNames) {
        const chk = origIds.length
          ? await window.api.db.query(`SELECT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`, [origIds])
          : { ok: true, rows: [] };
        const validIds = new Set(chk.ok ? chk.rows.map(r => Number(r.medscan_id)) : []);
        importable   = approved.filter(({ row }) => validIds.has(Number(row.origId)));
        skippedCount = approved.length - importable.length;
      } else {
        importable   = approved;
        skippedCount = 0;
      }

      const now = new Date().toISOString();
      const byLongTable = {};
      const exactliteralRows = [];

      for (const { row } of importable) {
        const tbl        = row.longAliasTable || 'curnames';
        const recElMatch = row.elMatchFlag ?? 'l';
        const tokFn      = xwTokFor(tbl);
        for (const alias of row.aliases) {
          if (tbl === 'exactliteral') {
            const fileMf = row._aliasMatchMap?.get(alias);
            const mf = fileMf !== undefined ? fileMf
              : recElMatch === '__from_file__' ? '' : recElMatch;
            exactliteralRows.push([row.origId, alias, mf || null, exactLiteralTokenized(alias, mf), exactLiteralTokenized(alias, mf), row.cartridgeList, row.orgs, now, now]);
          } else if (isShortAlias(alias)) {
            exactliteralRows.push([row.origId, alias, 'l', exactLiteralTokenized(alias, 'l'), exactLiteralTokenized(alias, 'l'), row.cartridgeList, row.orgs, now, now]);
          } else {
            if (!byLongTable[tbl]) byLongTable[tbl] = [];
            byLongTable[tbl].push([row.origId, alias, null, tokFn(alias), xwNormFor(tbl)(alias), row.cartridgeList, row.orgs, now, now]);
          }
        }
      }

      const aliasColumns = ['medscan_id', 'alias', 'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'created_at', 'updated_at'];
      // CASDictionary first (approval dialog may appear; declining aborts before anything else is written)
      if (byLongTable.casdictionary?.length) {
        const rc = await bulkInsertAliasTable({ table: 'casdictionary', columns: aliasColumns, rows: byLongTable.casdictionary });
        if (!rc.ok) throw new Error(rc.error);
      }
      const inserts = Object.entries(byLongTable).filter(([tbl]) => tbl !== 'casdictionary').map(([tbl, rows]) =>
        window.api.db.bulkInsert({ table: tbl, columns: aliasColumns, rows })
      );
      if (exactliteralRows.length) inserts.push(window.api.db.bulkInsert({ table: 'exactliteral', columns: aliasColumns, rows: exactliteralRows }));
      const results2 = await Promise.all(inserts);
      for (const r of results2) { if (!r.ok) throw new Error(r.error); }

      const importedSet = new Set(importable.map(({ i }) => i));
      const remaining = remapRecords.filter((_, i) => !importedSet.has(i));
      setRemapRecords(remaining);
      const newAppr = {};
      remaining.forEach((_, i) => { newAppr[i] = remapApprovals[i] ?? true; });
      setRemapApprovals(newAppr);
      setRmSelected(new Set());

      const aliasCount = exactliteralRows.length + Object.values(byLongTable).reduce((s, rows) => s + rows.length, 0);
      let msg = `✓ Added ${aliasCount.toLocaleString()} aliases for ${importable.length.toLocaleString()} IDs (using IDs from file).`;
      if (skippedCount > 0)
        msg += ` ${skippedCount} record${skippedCount !== 1 ? 's' : ''} skipped (origId not found in ObjectNames).`;
      setSubmitMsg(msg);
      onSuccess?.(`Batch import: ${aliasCount} aliases added (file IDs, remapped).`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // Submit approved ObjectNames rows (IDs verified to exist in dict tables)
  const handleSubmitObjectNames = async () => {
    if (!onImportData) return;
    setSubmitting(true); setSubmitMsg(null);
    try {
      const approved = onImportData.matched.filter((_, i) => onApprovals[i] !== false);
      if (!approved.length) { setSubmitting(false); return; }

      // INSERT only — existing objectnames records were already excluded during analysis
      const orgs  = organism ? [organism] : [];
      const carts = cartridgeList.length ? cartridgeList : [];
      for (const rec of approved) {
        await window.api.db.query(
          `INSERT INTO objectnames (medscan_id, name, urn, organisms, cartridges) VALUES ($1, $2, $3, $4, $5)`,
          [rec.id, rec.name, rec.urn || null, orgs, carts]
        );
      }

      // Remove submitted rows
      const remaining = onImportData.matched.filter((_, i) => onApprovals[i] === false);
      setOnImportData(d => ({ ...d, matched: remaining }));
      const newAppr = {};
      remaining.forEach((_, i) => { newAppr[i] = false; });
      setOnApprovals(newAppr);

      const n = approved.length;
      const rejected = onImportData.alreadyInON?.length ?? 0;
      let onMsg = `✓ Created ${n.toLocaleString()} record${n !== 1 ? 's' : ''} in ObjectNames${organism ? ` with organism "${organism}"` : ''}.`;
      if (rejected > 0)
        onMsg += ` ${rejected.toLocaleString()} record${rejected !== 1 ? 's' : ''} rejected (already existed in ObjectNames).`;
      setSubmitMsg(onMsg);
      onSuccess?.(`Batch import: ${n} objectnames records.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  const [remappingUrns,     setRemappingUrns]     = useState(false);
  const [remappingNames,    setRemappingNames]    = useState(false);
  const [importingNewIds,   setImportingNewIds]   = useState(false);
  const [newIdsCreated,     setNewIdsCreated]     = useState([]); // [{newId, name, urn}] — shown after "Import with new IDs"

  // Insert alreadyInON records as brand-new ObjectNames entries with new IDs allocated from the entity pool.
  const handleImportWithNewIds = async () => {
    const rows = onImportData?.alreadyInON ?? [];
    if (!rows.length) return;
    if (!window.confirm(
      `This will create ${rows.length} new ObjectNames record${rows.length !== 1 ? 's' : ''} with new allocated IDs ` +
      `(the conflicting file IDs will not be used). Continue?`
    )) return;
    setImportingNewIds(true); setSubmitMsg(null); setNewIdsCreated([]);
    try {
      // Allocate IDs from the entity type pool (fall back to SmallMol for ObjectNames imports)
      const poolType = (entityType && entityType !== '__nlp_ids__' && resolveEntityType(entityType))
        ? entityType : 'SmallMol';
      const { ids: newIds, error: poolErr } = await getIdPool(poolType, rows.length);
      if (!newIds) throw new Error(`Could not allocate IDs: ${poolErr}`);

      const orgs  = organism ? [organism] : [];
      const carts = cartridgeList.length ? cartridgeList : [];
      const created = [];
      for (let i = 0; i < rows.length; i++) {
        const rec = rows[i];
        // Use the file URN if present; otherwise generate one from the name + the entity
        // type inferred from the newly-allocated ID (file URNs can be empty for some imports).
        const inferredEt = resolveEntityTypeFromId(newIds[i]);
        const urn = rec.urn || (inferredEt ? buildEntityUrn(rec.name, inferredEt) : null);
        const res = await window.api.db.query(
          `INSERT INTO objectnames (medscan_id, name, urn, organisms, cartridges) VALUES ($1, $2, $3, $4, $5) RETURNING medscan_id`,
          [newIds[i], rec.name || null, urn, orgs, carts]
        );
        if (res.ok && res.rows.length) created.push({ newId: newIds[i], name: rec.name || '', urn: urn || '' });
        else if (!res.ok) throw new Error(res.error);
      }
      // Remove imported rows from the alreadyInON list and show results table
      setOnImportData(d => ({ ...d, alreadyInON: [] }));
      setNewIdsCreated(created);
      setSubmitMsg(`✓ Created ${created.length.toLocaleString()} new ObjectNames record${created.length !== 1 ? 's' : ''} with new IDs${organism ? ` and organism "${organism}"` : ''}.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setImportingNewIds(false); }
  };

  const REMAP_BATCH = 5000;

  const handleRemapUrns = async () => {
    const rows = onImportData?.alreadyInON ?? [];
    if (!rows.length) return;
    setRemappingUrns(true); setSubmitMsg(null);
    try {
      let totalUpdated = 0;
      for (let i = 0; i < rows.length; i += REMAP_BATCH) {
        const batch = rows.slice(i, i + REMAP_BATCH);
        const urns  = batch.map(r => r.urn || null);
        const msIds = batch.map(r => Number(r.id));
        const res = await window.api.db.query(
          `UPDATE objectnames AS o
           SET urn = data.new_urn
           FROM unnest($1::text[], $2::bigint[]) AS data(new_urn, medscan_id)
           WHERE o.medscan_id = data.medscan_id`,
          [urns, msIds]
        );
        if (!res.ok) throw new Error(res.error);
        totalUpdated += res.rowCount ?? 0;
      }
      setOnImportData(d => ({
        ...d,
        alreadyInON: d.alreadyInON.map(r => ({ ...r, _dbRecord: { ...r._dbRecord, urn: r.urn || '' } })),
      }));
      setSubmitMsg(`✓ Updated URNs for ${totalUpdated.toLocaleString()} record${totalUpdated !== 1 ? 's' : ''} in ObjectNames.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setRemappingUrns(false); }
  };

  const handleRemapNames = async () => {
    const rows = onImportData?.alreadyInON ?? [];
    if (!rows.length) return;
    setRemappingNames(true); setSubmitMsg(null);
    try {
      let totalUpdated = 0;
      for (let i = 0; i < rows.length; i += REMAP_BATCH) {
        const batch = rows.slice(i, i + REMAP_BATCH);
        const names = batch.map(r => r.name);
        const msIds = batch.map(r => Number(r.id));
        const res = await window.api.db.query(
          `UPDATE objectnames AS o
           SET name = data.new_name
           FROM unnest($1::text[], $2::bigint[]) AS data(new_name, medscan_id)
           WHERE o.medscan_id = data.medscan_id`,
          [names, msIds]
        );
        if (!res.ok) throw new Error(res.error);
        totalUpdated += res.rowCount ?? 0;
      }
      setOnImportData(d => ({
        ...d,
        alreadyInON: d.alreadyInON.map(r => ({ ...r, _dbRecord: { ...r._dbRecord, name: r.name } })),
      }));
      setSubmitMsg(`✓ Updated names for ${totalUpdated.toLocaleString()} record${totalUpdated !== 1 ? 's' : ''} in ObjectNames.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setRemappingNames(false); }
  };

  const [addingUrnsDB,   setAddingUrnsDB]   = useState(false);
  const [addUrnsDBMsg,   setAddUrnsDBMsg]   = useState(null);

  // Fills URN in objectnames for matched dict records that currently have no URN.
  // Uses DB NLP ID (r._dbRecord.id — the dict table's medscan_id).
  // Step 1: UPDATE existing objectnames rows that have no URN.
  // Step 2: INSERT a new objectnames row for dict entries that have no objectnames row at all
  //         (these are missed by the UPDATE since there is no row to match against).
  const handleAddUrnsFromDB = async () => {
    const rows = (onImportData?.alreadyInDB ?? []).filter(r => r._dbRecord && !r._dbRecord.urn && r.urn);
    if (!rows.length) { setAddUrnsDBMsg({ ok: false, text: 'No records with missing URN found.' }); return; }
    setAddingUrnsDB(true); setAddUrnsDBMsg(null);
    try {
      let totalUpdated = 0;
      let totalInserted = 0;
      for (let i = 0; i < rows.length; i += REMAP_BATCH) {
        const batch = rows.slice(i, i + REMAP_BATCH);
        const urns   = batch.map(r => r.urn);
        const names  = batch.map(r => r.name || '');
        const msIds  = batch.map(r => Number(r._dbRecord.id)); // DB NLP ID from dict table

        // Step 1: UPDATE rows that already exist in objectnames but have no URN
        const upd = await window.api.db.query(
          `UPDATE objectnames AS o
           SET urn = data.new_urn, updated_at = NOW()
           FROM unnest($1::text[], $2::bigint[]) AS data(new_urn, medscan_id)
           WHERE o.medscan_id = data.medscan_id
             AND (o.urn IS NULL OR o.urn = '')`,
          [urns, msIds]
        );
        if (!upd.ok) throw new Error(upd.error);
        totalUpdated += upd.rowCount ?? 0;

        // Step 2: INSERT for dict entries that have NO objectnames row at all.
        // objectnames has no UNIQUE constraint on medscan_id so we guard with NOT EXISTS.
        const ins = await window.api.db.query(
          `INSERT INTO objectnames (medscan_id, name, urn, created_at, updated_at)
           SELECT data.medscan_id, data.name, data.new_urn, NOW(), NOW()
           FROM unnest($1::bigint[], $2::text[], $3::text[]) AS data(medscan_id, name, new_urn)
           WHERE NOT EXISTS (
             SELECT 1 FROM objectnames o2 WHERE o2.medscan_id = data.medscan_id
           )`,
          [msIds, names, urns]
        );
        if (!ins.ok) throw new Error(ins.error);
        totalInserted += ins.rowCount ?? 0;
      }
      // Reflect new URNs in the view so the button count drops to 0
      setOnImportData(d => ({
        ...d,
        alreadyInDB: d.alreadyInDB.map(r => {
          if (r._dbRecord && !r._dbRecord.urn && r.urn)
            return { ...r, _dbRecord: { ...r._dbRecord, urn: r.urn } };
          return r;
        }),
      }));
      const total = totalUpdated + totalInserted;
      const detail = totalInserted > 0
        ? ` (${totalUpdated} updated, ${totalInserted} inserted)`
        : '';
      setAddUrnsDBMsg({ ok: true, text: `✓ Added URNs to ${total.toLocaleString()} record${total !== 1 ? 's' : ''}${detail}.` });
    } catch (e) { setAddUrnsDBMsg({ ok: false, text: `✗ ${e.message}` }); }
    finally { setAddingUrnsDB(false); }
  };

  // Shared helper: bulk-insert alias rows collected from newAliases / manyNewAliases tabs
  // tableOverride: if set, all long aliases go here instead of the per-ID default.
  // Tables where (medscan_id, tokenized) must be unique — duplicates are silently skipped
  const TOKENIZED_DEDUP_TABLES = new Set(['curnames', 'celldictionary', 'chemnames', 'casdictionary', 'combnames']);

  const bulkInsertAliasRows = async (aliasRows, tableOverride) => {
    await ensureXwordsLoaded();
    const now = new Date().toISOString();
    // rsmap: each row is protein_name (alias) + hgvs_code (match) + optional urn; bypass standard path.
    if (tableOverride === 'rsmap') {
      let inserted = 0;
      for (const row of aliasRows) {
        await window.api.db.query(
          `INSERT INTO rsmap (medscan_id, protein_name, hgvs_code, urn, normalized, created_at, updated_at)
           VALUES ($1, $2, $3, $4, lower($2 || ' ' || $3), NOW(), NOW())
           ON CONFLICT (medscan_id, protein_name, hgvs_code) DO NOTHING`,
          [row.msId, row.alias, row.match || '', row.urn || null]
        );
        inserted++;
      }
      return { total: inserted, byTable: { rsmap: inserted }, bDeletedBlocked: 0 };
    }
    const byTable = {}; // table → rows[]  (col order: msId,alias,match,tokenized,normalized,cartridges,orgs,created_at,updated_at)
    const exactliteralRows = [];
    for (const { msId, alias, cartridges, orgs } of aliasRows) {
      const isShort = isShortAlias(alias);
      if (isShort) {
        // exactliteral: normalized = lower(alias), tokenized = exactLiteralTokenized
        exactliteralRows.push([msId, alias, 'l', exactLiteralTokenized(alias, 'l'), exactLiteralTokenized(alias, 'l'), cartridges, orgs, now, now]);
      } else {
        const tbl = tableOverride || dictForId(msId);
        if (!byTable[tbl]) byTable[tbl] = [];
        byTable[tbl].push([msId, alias, null, xwTokFor(tbl)(alias), xwNormFor(tbl)(alias), cartridges, orgs, now, now]);
      }
    }

    // For dedup tables, remove rows whose (medscan_id, tokenized) already exist as ACTIVE in the DB.
    // bdeleted rows are NOT treated as blockers — track them separately for reporting.
    let bDeletedBlockedCount = 0;
    for (const [tbl, rows] of Object.entries(byTable)) {
      if (!TOKENIZED_DEDUP_TABLES.has(tbl)) continue;
      const msIds = [...new Set(rows.map(r => r[0]))];
      const toks  = [...new Set(rows.map(r => r[3]).filter(Boolean))];
      if (!msIds.length || !toks.length) continue;
      const res = await window.api.db.query(
        `SELECT medscan_id, tokenized, (bdeleted IS TRUE) AS is_bdeleted FROM ${tbl} WHERE medscan_id = ANY($1) AND tokenized = ANY($2)`,
        [msIds, toks]
      );
      if (res.ok && res.rows.length) {
        const activeKeys   = new Set(res.rows.filter(r => !r.is_bdeleted).map(r => `${r.medscan_id}\0${r.tokenized}`));
        const bdeletedKeys = new Set(res.rows.filter(r =>  r.is_bdeleted).map(r => `${r.medscan_id}\0${r.tokenized}`));
        // Count rows blocked only by a bdeleted entry (no active duplicate)
        bDeletedBlockedCount += rows.filter(r => !activeKeys.has(`${r[0]}\0${r[3]}`) && bdeletedKeys.has(`${r[0]}\0${r[3]}`)).length;
        // Only exclude rows with an active (non-deleted) duplicate
        byTable[tbl] = rows.filter(r => !activeKeys.has(`${r[0]}\0${r[3]}`));
      }
    }

    const cols = ['medscan_id', 'alias', 'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'created_at', 'updated_at'];
    // CASDictionary goes through addToCasDictionary FIRST (may show the chemNames approval dialog;
    // if declined nothing at all is written).
    if (byTable.casdictionary?.length) {
      const casRes = await addToCasDictionary(byTable.casdictionary.map(r => ({ msId: r[0], alias: r[1], match: r[2], cartridges: r[5], organisms: r[6] })));
      if (!casRes.ok) throw new Error(casRes.cancelled ? 'Adding to CASdictionary was cancelled — chemNames tokens were not approved. Nothing was imported.' : casRes.error);
    }
    const inserts = Object.entries(byTable)
      .filter(([tbl, rows]) => rows.length > 0 && tbl !== 'casdictionary')
      .map(([tbl, rows]) => window.api.db.bulkInsert({ table: tbl, columns: cols, rows }));
    if (exactliteralRows.length)
      inserts.push(window.api.db.bulkInsert({ table: 'exactliteral', columns: cols, rows: exactliteralRows }));
    const results2 = await Promise.all(inserts);
    for (const r of results2) if (!r.ok) throw new Error(r.error);
    // Build per-table counts for display in success messages
    const insertedByTable = {};
    for (const [tbl, rows] of Object.entries(byTable)) {
      if (rows.length > 0) insertedByTable[tbl] = rows.length;
    }
    if (exactliteralRows.length) insertedByTable['exactliteral'] = (insertedByTable['exactliteral'] ?? 0) + exactliteralRows.length;
    return { total: aliasRows.length, byTable: insertedByTable, bDeletedBlocked: bDeletedBlockedCount };
  };

  // Format per-table breakdown for success messages, e.g. " [curnames: 120,000; exactliteral: 43,613]"
  const fmtByTable = (byTable) => {
    const entries = Object.entries(byTable).filter(([, n]) => n > 0);
    if (entries.length <= 1) return '';
    return ' [' + entries.map(([t, n]) => `${t}: ${n.toLocaleString()}`).join('; ') + ']';
  };

  const updateOrganismOnMatched = async (matchedIds) => {
    if (!organism || !matchedIds.length) return;
    const tables = ['curnames', 'exactliteral', 'celldictionary', 'casdictionary', 'keywords', 'userdict', 'combnames'];
    for (const tbl of tables) {
      await window.api.db.query(
        `UPDATE "${tbl}" SET organisms = array_append(organisms, $1), updated_at = NOW()
         WHERE medscan_id = ANY($2) AND NOT ($1 = ANY(COALESCE(organisms, '{}'::text[])))`,
        [organism, matchedIds]
      );
    }
  };

  // Returns a Set of valid IDs (those in ObjectNames) when requireObjectNames is on, or null (no restriction).
  const getOnValidIds = async (ids) => {
    if (!requireObjectNames || !ids.length) return null;
    const res = await window.api.db.query(
      `SELECT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`, [ids]
    );
    return new Set(res.ok ? res.rows.map(r => Number(r.medscan_id)) : []);
  };

  // Sort helper for NA/MNA tabs
  const applySort = (items, sort) => {
    if (!sort.col) return items;
    return [...items].sort((a, b) => {
      let av, bv;
      if (sort.col === 'mappedId') {
        av = a.row.matchedId ?? Infinity;
        bv = b.row.matchedId ?? Infinity;
      } else if (sort.col === 'flatId') {
        av = a.row._flatId ?? Infinity;
        bv = b.row._flatId ?? Infinity;
      } else if (sort.col === 'entityType') {
        av = resolveEntityTypeFromId(a.row.matchedId)?.rnef ?? '￿';
        bv = resolveEntityTypeFromId(b.row.matchedId)?.rnef ?? '￿';
      }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ?  1 : -1;
      return 0;
    });
  };

  const makeSortToggle = (setSort) => (col) =>
    setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });

  const SortTh = ({ col, sort, onSort, style, children }) => {
    const active = sort.col === col;
    return (
      <th style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
          onClick={() => onSort(col)}>
        {children}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇕'}
      </th>
    );
  };

  // Multi-row selection helpers
  const makeRowClickHandler = (visibleItems, selected, setSelected, lastClickRef) => (e, visIdx) => {
    if (e.target.type === 'checkbox' || e.target.tagName === 'BUTTON' || e.target.closest?.('button')) return;
    const origIdx = visibleItems[visIdx]?.i ?? visIdx;
    if (e.shiftKey && lastClickRef.current !== null) {
      const from = Math.min(lastClickRef.current, visIdx);
      const to   = Math.max(lastClickRef.current, visIdx);
      setSelected(prev => {
        const next = new Set(prev);
        for (let k = from; k <= to; k++) next.add(visibleItems[k]?.i ?? k);
        return next;
      });
    } else if (e.ctrlKey || e.metaKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(origIdx)) next.delete(origIdx); else next.add(origIdx);
        return next;
      });
      lastClickRef.current = visIdx;
    } else {
      setSelected(new Set([origIdx]));
      lastClickRef.current = visIdx;
    }
  };

  const toggleSelectedApprovals = (selected, approvals, setApprovals) => {
    if (!selected.size) return;
    const allChecked = [...selected].every(i => approvals[i] !== false);
    setApprovals(prev => {
      const next = { ...prev };
      for (const i of selected) next[i] = !allChecked;
      return next;
    });
  };

  const isVisibleNA = (row) => {
    if (onlySameTypeNA && !isSameType(row)) return false;
    if (onlySameIdNA && Number(row._flatId) !== Number(row.matchedId)) return false;
    if (minAliasLenNA > 0 && !row.newAliasesForRow.some(a => a.length >= minAliasLenNA)) return false;
    if (minMatchLenNA > 0 && !row.matchedAliases.some(a => a.length >= minMatchLenNA)) return false;
    return true;
  };

  // chemNames tokens for CASdictionary are checked / approved / added inside addToCasDictionary()
  // (called from bulkInsertAliasRows & the other write paths), so no pre-step is needed here.

  const handleSubmitNewAliases = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const candidates = [];
      for (let i = 0; i < results.newAliases.length; i++) {
        if (naApprovals[i] === false) continue;
        const row = results.newAliases[i];
        if (!isVisibleNA(row)) continue;
        candidates.push({ i, row });
      }
      const validIds = await getOnValidIds(candidates.map(({ row }) => row.matchedId));
      const aliasRows = [];
      const matchedIds = [];
      const skippedIndices = new Set();
      for (const { i, row } of candidates) {
        if (validIds && !validIds.has(row.matchedId)) {
          skippedIndices.add(i);
          setNoUrnRecords(prev => [...prev, {
            name:    row.name || '',
            id:      String(row.matchedId),
            aliases: (row.newAliasesForRow || []).join('; '),
            source:  '≤50% new aliases',
          }]);
          continue;
        }
        const eligible = minAliasLenNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenNA) : row.newAliasesForRow;
        for (const alias of eligible)
          aliasRows.push({ msId: row.matchedId, alias, cartridges: cartridgeList, orgs });
        matchedIds.push(row.matchedId);
      }
      const chemTokensAdded = 0;
      const { total: n, byTable: insertedByTable, bDeletedBlocked } = await bulkInsertAliasRows(aliasRows, targetTable);
      await updateOrganismOnMatched(matchedIds);
      const remainingWithIdx = results.newAliases
        .map((row, i) => ({ row, i }))
        .filter(({ row, i }) => naApprovals[i] === false || !isVisibleNA(row) || skippedIndices.has(i));
      const remaining = remainingWithIdx.map(({ row }) => row);
      const newAppr = {};
      remainingWithIdx.forEach(({ i: oldI }, newI) => { if (naApprovals[oldI] === false) newAppr[newI] = false; });
      setResults(r => ({ ...r, newAliases: remaining }));
      setNaApprovals(newAppr);
      setNaSelected(new Set());
      let msg = `✓ Added ${n.toLocaleString()} new aliases for ${matchedIds.length.toLocaleString()} IDs${organism ? ` and assigned organism "${organism}"` : ''}${fmtByTable(insertedByTable)}.`;
      if (chemTokensAdded > 0)
        msg += ` ${chemTokensAdded} missing chemNames token${chemTokensAdded !== 1 ? 's' : ''} added automatically.`;
      if (skippedIndices.size > 0)
        msg += ` ${skippedIndices.size} record${skippedIndices.size !== 1 ? 's' : ''} could not be imported because they do not have corresponding Name and URN values in ObjectNames.`;
      if (bDeletedBlocked > 0)
        msg += ` ${bDeletedBlocked} ${bDeletedBlocked === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.`;
      setSubmitMsg(msg);
      onSuccess?.(`Batch import: ${n} new aliases added.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  const isVisibleMNA = (row) => {
    if (onlySameTypeMNA && !isSameType(row)) return false;
    if (onlySameIdMNA && Number(row._flatId) !== Number(row.matchedId)) return false;
    if (minAliasLenMNA > 0 && !row.newAliasesForRow.some(a => a.length >= minAliasLenMNA)) return false;
    if (minMatchLenMNA > 0 && !row.matchedAliases.some(a => a.length >= minMatchLenMNA)) return false;
    return true;
  };

  const handleSubmitManyNewAliases = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const candidates = [];
      for (let i = 0; i < results.manyNewAliases.length; i++) {
        if (mnaApprovals[i] === false) continue;
        const row = results.manyNewAliases[i];
        if (!isVisibleMNA(row)) continue;
        candidates.push({ i, row });
      }
      const validIds = await getOnValidIds(candidates.map(({ row }) => row.matchedId));
      const aliasRows = [];
      const matchedIds = [];
      const skippedIndices = new Set();
      for (const { i, row } of candidates) {
        if (validIds && !validIds.has(row.matchedId)) {
          skippedIndices.add(i);
          setNoUrnRecords(prev => [...prev, {
            name:    row.name || '',
            id:      String(row.matchedId),
            aliases: (row.newAliasesForRow || []).join('; '),
            source:  '>50% new aliases',
          }]);
          continue;
        }
        const eligible = minAliasLenMNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenMNA) : row.newAliasesForRow;
        for (const alias of eligible)
          aliasRows.push({ msId: row.matchedId, alias, cartridges: cartridgeList, orgs });
        matchedIds.push(row.matchedId);
      }
      const chemTokensAdded = 0;
      const { total: n, byTable: insertedByTable, bDeletedBlocked } = await bulkInsertAliasRows(aliasRows, targetTable);
      await updateOrganismOnMatched(matchedIds);
      const remainingWithIdx = results.manyNewAliases
        .map((row, i) => ({ row, i }))
        .filter(({ row, i }) => mnaApprovals[i] === false || !isVisibleMNA(row) || skippedIndices.has(i));
      const remaining = remainingWithIdx.map(({ row }) => row);
      const newAppr = {};
      remainingWithIdx.forEach(({ i: oldI }, newI) => { if (mnaApprovals[oldI] === false) newAppr[newI] = false; });
      setResults(r => ({ ...r, manyNewAliases: remaining }));
      setMnaApprovals(newAppr);
      setMnaSelected(new Set());
      let msg = `✓ Added ${n.toLocaleString()} new aliases for ${matchedIds.length.toLocaleString()} IDs${organism ? ` and assigned organism "${organism}"` : ''}${fmtByTable(insertedByTable)}.`;
      if (chemTokensAdded > 0)
        msg += ` ${chemTokensAdded} missing chemNames token${chemTokensAdded !== 1 ? 's' : ''} added automatically.`;
      if (skippedIndices.size > 0)
        msg += ` ${skippedIndices.size} record${skippedIndices.size !== 1 ? 's' : ''} could not be imported because they do not have corresponding Name and URN values in ObjectNames.`;
      if (bDeletedBlocked > 0)
        msg += ` ${bDeletedBlocked} ${bDeletedBlocked === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.`;
      setSubmitMsg(msg);
      onSuccess?.(`Batch import: ${n} new aliases added.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // ── Confirmation helpers (defined here so they close over isVisibleNA/isVisibleMNA) ──
  const countNA = () => {
    const rows = (results?.newAliases || []).filter((r, i) => naApprovals[i] !== false && isVisibleNA(r));
    const aliases = rows.reduce((s, r) => s + (minAliasLenNA > 0 ? r.newAliasesForRow.filter(a => a.length >= minAliasLenNA) : r.newAliasesForRow).length, 0);
    return { rows: rows.length, aliases };
  };
  const countMNA = () => {
    const rows = (results?.manyNewAliases || []).filter((r, i) => mnaApprovals[i] !== false && isVisibleMNA(r));
    const aliases = rows.reduce((s, r) => s + (minAliasLenMNA > 0 ? r.newAliasesForRow.filter(a => a.length >= minAliasLenMNA) : r.newAliasesForRow).length, 0);
    return { rows: rows.length, aliases };
  };
  const countConflictsResolved = () => {
    const conflicts = results?.conflicts || [];
    let aliasCount = 0, rowCount = 0;
    conflicts.forEach((row, rowIdx) => {
      if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return;
      const dec = conflictDec[rowIdx] || {};
      const ids = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
      const ma = manualAssign[rowIdx];
      const manualDone = ma && row.unmapped.some(m => ma[m.alias]);
      const resolved = dec.__new__ === 'newRecord' || manualDone || (ids.filter(id => dec[id]).length === ids.length && ids.some(id => dec[id] !== 'ignore'));
      if (!resolved) return;
      const eligible = row.unmapped.filter(m => minAliasLenConflict === 0 || m.alias.length >= minAliasLenConflict);
      aliasCount += eligible.length; rowCount++;
    });
    return { rows: rowCount, aliases: aliasCount };
  };
  const countConflictsVisible = () => {
    const conflicts = results?.conflicts || [];
    let aliasCount = 0, rowCount = 0;
    conflicts.forEach(row => {
      if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return;
      const eligible = row.unmapped.filter(m => minAliasLenConflict === 0 || m.alias.length >= minAliasLenConflict);
      aliasCount += eligible.length; rowCount++;
    });
    return { rows: rowCount, aliases: aliasCount };
  };

  const naCriteria    = () => [...(onlySameTypeNA  ? ['same type'] : []), ...(onlySameIdNA ? ['same ID'] : []), ...(minAliasLenNA  > 0 ? [`alias length ≥ ${minAliasLenNA}`]  : []), ...(minMatchLenNA  > 0 ? [`match length ≥ ${minMatchLenNA}`]  : [])];
  const mnaCriteria   = () => [...(onlySameTypeMNA ? ['same type'] : []), ...(onlySameIdMNA ? ['same ID'] : []), ...(minAliasLenMNA > 0 ? [`alias length ≥ ${minAliasLenMNA}`] : []), ...(minMatchLenMNA > 0 ? [`match length ≥ ${minMatchLenMNA}`] : [])];
  const conflictCriteria = () => [
    ...(resolveToSameType   ? ['same type']   : []),
    ...(resolveToLonger     ? ['longer alias'] : []),
    ...(resolveToSameName   ? ['same name']   : []),
    ...(resolveToAliasMatch ? ['alias match'] : []),
    ...(Object.keys(manualAssign).length > 0 ? ['manual'] : []),
  ];
  // ── End confirmation helpers ──

  // Submit checked visible rows as brand-new NLP records (ignore the matched ID entirely).
  // Each row gets a freshly allocated ID; newAliasesForRow are imported under it.
  const handleSubmitAsNewRecords = async (resultsKey, resultsArr, setResultsFn, approvals, setApprovals, setSelected, isVisibleFn, minAliasLen = 0) => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const candidates = [];
      for (let i = 0; i < resultsArr.length; i++) {
        if (approvals[i] === false) continue;
        const row = resultsArr[i];
        if (!isVisibleFn(row)) continue;
        candidates.push({ i, row });
      }
      let createdCount = 0;
      const submittedIndices = new Set();
      for (const { i, row } of candidates) {
        const { id: newId } = await getNextId('curnames', entityType);
        if (newId === null) continue;
        const eligibleAliases = minAliasLen > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLen) : row.newAliasesForRow;
        for (const alias of eligibleAliases)
          await dbInsertAlias(newId, alias, cartridgeList, orgs);
        await dbInsertObjectNames(newId, row.name, cartridgeList, orgs);
        createdCount++;
        submittedIndices.add(i);
      }
      const remainingWithIdx = resultsArr
        .map((row, i) => ({ row, i }))
        .filter(({ row, i }) => approvals[i] === false || !isVisibleFn(row) || !submittedIndices.has(i));
      const remaining = remainingWithIdx.map(({ row }) => row);
      const newAppr = {};
      remainingWithIdx.forEach(({ i: oldI }, newI) => { if (approvals[oldI] === false) newAppr[newI] = false; });
      setResultsFn(r => ({ ...r, [resultsKey]: remaining }));
      setApprovals(newAppr);
      setSelected(new Set());
      setSubmitMsg(`✓ Created ${createdCount.toLocaleString()} new record${createdCount !== 1 ? 's' : ''}${organism ? ` with organism "${organism}"` : ''}.`);
      onSuccess?.(`Batch import: ${createdCount} new records created.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // Submit new aliases using the ID specified in the input file (_flatId).
  // Only imports rows whose _flatId already exists in ObjectNames.
  const handleSubmitWithFileId = async (resultsKey, resultsArr, setResultsFn, approvals, setApprovals, setSelected, isVisibleFn, minAliasLen = 0) => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      // Collect checked visible rows that have a _flatId
      const toProcess = [];
      for (let i = 0; i < resultsArr.length; i++) {
        if (approvals[i] === false) continue;
        const row = resultsArr[i];
        if (!isVisibleFn(row)) continue;
        if (row._flatId == null) continue;
        toProcess.push({ i, row });
      }

      // Check which _flatIds exist in ObjectNames (skipped when requireObjectNames is false)
      const flatIds = [...new Set(toProcess.map(({ row }) => row._flatId))];
      let importable, skippedCount;
      if (requireObjectNames) {
        const chk = flatIds.length
          ? await window.api.db.query(`SELECT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`, [flatIds])
          : { ok: true, rows: [] };
        const validIds = new Set(chk.ok ? chk.rows.map(r => Number(r.medscan_id)) : []);
        importable   = toProcess.filter(({ row }) => validIds.has(row._flatId));
        skippedCount = toProcess.length - importable.length;
      } else {
        importable   = toProcess;
        skippedCount = 0;
      }

      // Import aliases under _flatId
      const aliasRows = [];
      const matchedIds = [];
      for (const { row } of importable) {
        const eligible = minAliasLen > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLen) : row.newAliasesForRow;
        for (const alias of eligible)
          aliasRows.push({ msId: row._flatId, alias, cartridges: cartridgeList, orgs });
        matchedIds.push(row._flatId);
      }
      const { total: n, byTable: insertedByTable, bDeletedBlocked } = await bulkInsertAliasRows(aliasRows, targetTable);
      if (matchedIds.length) await updateOrganismOnMatched(matchedIds);

      // Remove imported rows; keep skipped, unapproved, and filter-hidden rows
      const importedSet = new Set(importable.map(({ i }) => i));
      const remainingWithIdx = resultsArr
        .map((row, i) => ({ row, i }))
        .filter(({ row, i }) => {
          if (!isVisibleFn(row)) return true;        // hidden by filter — keep
          if (approvals[i] === false) return true;   // explicitly rejected — keep
          if (row._flatId == null) return true;      // no file ID — keep
          return !importedSet.has(i);                // keep only skipped (no ObjectNames entry)
        });
      const remaining = remainingWithIdx.map(({ row }) => row);
      const newAppr = {};
      remainingWithIdx.forEach(({ i: oldI }, newI) => { if (approvals[oldI] === false) newAppr[newI] = false; });

      setResults(r => ({ ...r, [resultsKey]: remaining }));
      setApprovals(newAppr);
      setSelected(new Set());

      let msg = `✓ Added ${n.toLocaleString()} new aliases for ${matchedIds.length.toLocaleString()} IDs (using IDs from file)${fmtByTable(insertedByTable)}.`;
      if (skippedCount > 0)
        msg += ` ${skippedCount} record${skippedCount !== 1 ? 's' : ''} could not be imported because they do not have Name and URN values in ObjectNames.`;
      if (bDeletedBlocked > 0)
        msg += ` ${bDeletedBlocked} ${bDeletedBlocked === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.`;
      setSubmitMsg(msg);
      onSuccess?.(`Batch import: ${n} new aliases added (file IDs).`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // ── Resolve batch-import conflicts by LLM ─────────────────────────────────────
  // The LLM receives a per-alias table: one row per incoming alias, one column per
  // conflicting DB record. It fills in Yes/No for each cell.
  // • Homogeneous result (all aliases → same record) → sets conflictDec (addToThis/ignore)
  // • Heterogeneous result (aliases split across records) → sets manualAssign (per-alias)
  const handleBatchConflictsResolveLlm = async () => {
    const conflicts = results?.conflicts || [];
    if (!conflicts.length) return;
    setBatchLlmResolving(true);
    setBatchLlmProgress(null);
    setBatchLlmMsg(null);

    const ALL_ALIAS_TABLES = [
      { t: 'curnames',       col: 'alias' },
      { t: 'exactliteral',   col: 'alias' },
      { t: 'celldictionary', col: 'alias' },
      { t: 'userdict',       col: 'alias' },
      { t: 'casdictionary',  col: 'alias' },
      { t: 'chemnames',      col: 'alias' },
      { t: 'combnames',      col: 'alias' },
    ];

    const fetchAllAliases = async (msId) => {
      const res = await Promise.all(
        ALL_ALIAS_TABLES.map(({ t, col }) =>
          window.api.db.query(`SELECT ${col} AS alias FROM ${t} WHERE medscan_id = $1`, [msId])
        )
      );
      return [...new Set(res.flatMap(r => r.ok ? r.rows.map(row => row.alias) : []))];
    };

    const fetchName = async (msId) => {
      const cached = onCache[Number(msId)];
      if (cached) return cached;
      const r = await window.api.db.query(
        `SELECT name FROM objectnames WHERE medscan_id = $1 LIMIT 1`, [msId]
      );
      if (r.ok && r.rows.length > 0) return r.rows[0].name;
      return null;
    };

    const isRateLimit  = (msg) => {
      const m = (msg || '').toLowerCase();
      return m.includes('429') || m.includes('rate limit') || m.includes('rate_limit') ||
             m.includes('ratelimit') || m.includes('too many requests') ||
             m.includes('request rate') || m.includes('request speed') ||
             m.includes('hit rate') || m.includes('quota exceeded') ||
             m.includes('quota limit') || m.includes('throttl');
    };
    const isFatalError = (msg) => {
      const m = (msg || '').toLowerCase();
      return (
        m.includes('not configured') || m.includes('401') || m.includes('403') ||
        // 429 is handled separately — triggers sequential retry, not permanent abort
        m.includes('model not found') || m.includes('model_not_found') ||
        m.includes('no such model') || m.includes('does not exist') ||
        m.includes('not active') || m.includes('decommissioned') || m.includes('deprecated')
      );
    };

    // Only unresolved rows with eligible aliases
    const candidates = conflicts
      .map((row, rowIdx) => ({ row, rowIdx }))
      .filter(({ row, rowIdx }) => {
        if (row._unanchored) return false;
        if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return false;
        const dec = conflictDec[rowIdx] || {};
        if (dec.__new__ === 'newRecord') return false;
        const ids = [...new Set((row.mapped || []).map(m => String(m.hit.dup.medscan_id)))];
        if (ids.length > 0 && ids.every(id => dec[id]) && ids.some(id => dec[id] !== 'ignore')) return false;
        return true;
      });

    const total = candidates.length;
    if (!total) {
      setBatchLlmResolving(false);
      setBatchLlmMsg('🤖 LLM: No unresolved conflicts to process.');
      return;
    }

    const s = await window.api.settings.get();
    const dailyLimit = Math.max(1, s?.llmMaxRequestsPerDay ?? 1000);
    const cappedTotal = Math.min(total, dailyLimit);
    if (cappedTotal < total)
      setBatchLlmMsg(`🤖 LLM: processing first ${cappedTotal} of ${total} (daily limit ${dailyLimit}). Increase in Settings → LLM Connector.`);
    const CONC = Math.min(25, cappedTotal);
    setBatchLlmProgress({ done: 0, total: cappedTotal });

    let queueIdx = 0;
    let nHomogeneous = 0, nHeterogeneous = 0, nUnresolved = 0, errCount = 0;
    let firstError = null;
    let aborted = false;

    try {
      let retryQueue = []; // candidate indices that hit rate limit — retried sequentially

      const processOne = async (localIdx, addDelay = false, inRetry = false) => {
        if (addDelay) await new Promise(r => setTimeout(r, 1000));
        const { row, rowIdx } = candidates[localIdx];

        // Build unique groups (one per conflicting DB record)
        const idGroups = {};
        for (const m of row.mapped) {
          const key = String(m.hit.dup.medscan_id);
          if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, aliases: [], hit: m.hit };
          idGroups[key].aliases.push(m.alias);
        }
        const groups   = Object.values(idGroups);
        const allMsIds = groups.map(g => g.id);

        // Eligible incoming aliases (apply length filter)
        const incomingAliases = row.unmapped
          .filter(m => minAliasLenConflict === 0 || m.alias.length >= minAliasLenConflict)
          .map(m => m.alias);

        if (!incomingAliases.length) {
          nUnresolved++;
          setBatchLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
          return;
        }

        // Fetch names and existing aliases for all conflicting records in parallel
        const [names, aliasLists] = await Promise.all([
          Promise.all(allMsIds.map(id => fetchName(id))),
          Promise.all(allMsIds.map(id => fetchAllAliases(id))),
        ]);
        const nameFor = (idx) => names[idx] || groups[idx].hit.dup.alias || String(allMsIds[idx]);

        // ── Build the table prompt ────────────────────────────────────────────
        // Header: "Input Alias \t ID 1002748 (liquiritigenin) \t ID 1014146 (dihydroxyflavanone)"
        const colHeaders = allMsIds.map((id, idx) => `ID ${id} (${nameFor(idx)})`);
        const headerRow  = ['Input Alias', ...colHeaders].join('\t');
        const dataRows   = incomingAliases.map(a => [a, ...allMsIds.map(() => '???')].join('\t'));
        const tableTemplate = [headerRow, ...dataRows].join('\n');

        // Context block: existing aliases for each record
        const recordContext = allMsIds.map((msId, idx) =>
          `• ID ${msId} "${nameFor(idx)}": ${aliasLists[idx].slice(0, 30).join('; ') || '(none)'}`
        ).join('\n');

        const messages = [
          {
            role: 'system',
            content:
              'You are a biomedical nomenclature expert (UniProt, NCBI Gene, EcoCyc, HGNC, MGI, etc.).\n' +
              'Incoming aliases are being imported into a database. They conflict with multiple existing records.\n' +
              'For each incoming alias, decide which existing record it canonically belongs to.\n\n' +
              'Rules:\n' +
              '  • Fill the table below: replace each ??? with "Yes" (alias belongs to this record) or "No" (it does not).\n' +
              '  • Each row must have exactly one "Yes" — or all "No" if the alias belongs to none of the listed records.\n' +
              '  • Return ONLY the completed table — no preamble, no explanation, no extra text.\n' +
              '  • Preserve the tab-separated format and all column headers exactly.',
          },
          {
            role: 'user',
            content:
              `Incoming record name from file: "${row.name || ''}"\n\n` +
              `Existing conflict records and their current aliases:\n${recordContext}\n\n` +
              `Complete the table by replacing each ??? with Yes or No:\n\n` +
              tableTemplate,
          },
        ];

        try {
          const rawReply = (await callLlm(messages, { fn: 'dict.batchConflicts', temperature: 0 })).trim();
          console.log(`[BatchLLM] row="${row.name}" raw reply:`, JSON.stringify(rawReply));

          // ── Parse the reply table ─────────────────────────────────────────
          const aliasAssignment = new Map(); // alias → winning msId string, or null

          const replyLines = rawReply.split('\n').map(l => l.trim()).filter(Boolean);
          // Detect actual column order from the header line in the reply (LLM may reorder)
          let colOrder = allMsIds.map(id => String(id)); // default: original order
          for (const line of replyLines) {
            if (/input\s+alias/i.test(line)) {
              const parts = line.split('\t');
              const detected = [];
              for (let ci = 1; ci < parts.length; ci++) {
                const cell = parts[ci];
                const matched = allMsIds.find(id => cell.includes(String(id)));
                detected.push(matched ? String(matched) : null);
              }
              if (detected.some(d => d !== null)) colOrder = detected;
              break;
            }
          }

          for (const alias of incomingAliases) {
            const aliasLow = alias.toLowerCase();
            let winner = null;
            for (const line of replyLines) {
              const parts = line.split('\t');
              if (parts.length < 2) continue;
              if (!parts[0].toLowerCase().includes(aliasLow) && !aliasLow.includes(parts[0].toLowerCase().trim())) continue;
              for (let ci = 1; ci < parts.length && ci - 1 < colOrder.length; ci++) {
                if (/\byes\b/i.test(parts[ci])) { winner = colOrder[ci - 1]; break; }
              }
              break;
            }
            aliasAssignment.set(alias, winner);
          }

          // ── Determine homogeneous vs heterogeneous ────────────────────────
          const anyUnresolved = [...aliasAssignment.values()].some(v => v === null);
          const assignedAliases = [...aliasAssignment.entries()].filter(([, v]) => v !== null);
          const uniqueTargets   = new Set(assignedAliases.map(([, v]) => v));

          if (assignedAliases.length === 0) {
            nUnresolved++;
          } else if (!anyUnresolved && uniqueTargets.size === 1) {
            const winnerId = [...uniqueTargets][0];
            const newDec = {};
            for (const g of groups) {
              newDec[String(g.id)] = String(g.id) === winnerId ? 'addToThis' : 'ignore';
            }
            setConflictDec(d => ({ ...d, [rowIdx]: { ...(d[rowIdx] || {}), ...newDec } }));
            nHomogeneous++;
          } else {
            const manual = {};
            for (const [alias, targetId] of aliasAssignment) {
              manual[alias] = targetId !== null ? targetId : 'ignore';
            }
            setManualAssign(d => ({ ...d, [rowIdx]: { ...(d[rowIdx] || {}), ...manual } }));
            nHeterogeneous++;
          }
        } catch (e) {
          if (isRateLimit(e.message) && !inRetry) {
            // First pass: queue for sequential retry — don't count as error yet
            retryQueue.push(localIdx);
            aborted = true;
          } else {
            // Retry pass (or non-rate-limit error): count as error and move on
            errCount++;
            if (!firstError) firstError = e.message;
            nUnresolved++;
            if (!isRateLimit(e.message) && isFatalError(e.message)) { aborted = true; }
          }
        }

        setBatchLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
      };

      const worker = async () => {
        while (!aborted && queueIdx < cappedTotal) { await processOne(queueIdx++); }
      };

      await Promise.all(Array.from({ length: CONC }, worker));

      // ── Sequential retry after rate limit ─────────────────────────────────
      if (retryQueue.length > 0) {
        const skipped = Array.from({ length: Math.max(0, cappedTotal - queueIdx) }, (_, i) => queueIdx + i);
        const toRetry = [...new Set([...retryQueue, ...skipped])].sort((a, b) => a - b);
        aborted = false; firstError = null;
        setBatchLlmProgress({ done: 0, total: toRetry.length });
        // Wait 1 s before the first retry so the LLM's rate-limit window can reset.
        await new Promise(r => setTimeout(r, 1000));
        for (const idx of toRetry) {
          if (aborted) break;
          await processOne(idx, /* addDelay */ true, /* inRetry */ true);
        }
      }

      const parts = [];
      if (nHomogeneous > 0)   parts.push(`${nHomogeneous} resolved (uniform)`);
      if (nHeterogeneous > 0) parts.push(`${nHeterogeneous} resolved (split — check Assign manually)`);
      if (nUnresolved - errCount > 0) parts.push(`${nUnresolved - errCount} unresolved`);
      if (errCount > 0)       parts.push(`${errCount} API error${errCount !== 1 ? 's' : ''}`);
      if (retryQueue.length > 0) parts.push('retried sequentially after rate limit');
      if (aborted)            parts.push('aborted early');
      let msg = `🤖 LLM: ${parts.join(', ') || 'Nothing resolved'}.`;
      if (firstError) msg += `  Error: ${firstError}`;
      setBatchLlmMsg(msg);
    } catch (e) {
      setBatchLlmMsg(`🤖 LLM error: ${e.message}`);
    } finally {
      setBatchLlmResolving(false);
      setBatchLlmProgress(null);
    }
  };

  const handleSubmitConflicts = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    let n = 0;
    let conflictOnSkipped = 0;
    const resolvedIndices = new Set();

    // Pre-fetch valid ObjectNames IDs for safety check
    let conflictValidIds = null;
    if (requireObjectNames) {
      const allTargetIds = [];
      for (let rowIdx = 0; rowIdx < results.conflicts.length; rowIdx++) {
        const dec = conflictDec[rowIdx] || {};
        for (const [id, decision] of Object.entries(dec))
          if (decision === 'addToThis') allTargetIds.push(String(id));
      }
      conflictValidIds = await getOnValidIds(allTargetIds);
    }

    try {
      for (let rowIdx = 0; rowIdx < results.conflicts.length; rowIdx++) {
        const row = results.conflicts[rowIdx];
        const dec = conflictDec[rowIdx] || {};

        // Build groups (one per unique matched medscan_id) — mirrors what the render does
        const idGroups = {};
        for (const m of row.mapped) {
          const key = String(m.hit.dup.medscan_id);
          if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, aliases: [], hit: m.hit };
          idGroups[key].aliases.push(m.alias);
        }
        const groups = Object.values(idGroups);

        const ma = manualAssign[rowIdx] || {};
        // Apply alias length filter: only import aliases that meet the minimum length requirement
        const eligibleUnmapped = minAliasLenConflict > 0
          ? row.unmapped.filter(m => m.alias.length >= minAliasLenConflict)
          : row.unmapped;
        const hasManualAssign = eligibleUnmapped.length > 0 && eligibleUnmapped.some(m => ma[m.alias]);
        const perIdResolved = dec.__new__ === 'newRecord' || groups.every(g => dec[String(g.id)]);

        // Skip if neither resolution path is complete
        if (!hasManualAssign && !perIdResolved) continue;
        resolvedIndices.add(rowIdx);

        if (hasManualAssign) {
          // Manual assignment path: each unmapped alias goes to its specified NLP ID (or new record)
          // Group unmapped aliases by their assignment
          const byTarget = {};
          for (const m of eligibleUnmapped) {
            const target = ma[m.alias]; // medscan_id string | 'new' | 'ignore' — skip if unassigned
            if (!target || target === 'ignore') continue;
            if (!byTarget[target]) byTarget[target] = [];
            byTarget[target].push(m.alias);
          }
          // Handle 'new' group — create a new record
          if (byTarget['new']) {
            const { id: newId } = await getNextId('curnames', entityType);
            if (newId !== null) {
              for (const alias of byTarget['new'])
                await dbInsertAlias(newId, alias, cartridgeList, orgs);
              await dbInsertObjectNames(newId, row.name, cartridgeList, orgs);
            }
            delete byTarget['new'];
          }
          // Handle explicit NLP ID targets
          for (const [targetId, aliases] of Object.entries(byTarget)) {
            for (const alias of aliases)
              await dbInsertAlias(Number(targetId), alias, cartridgeList, orgs);
          }
          // Also process per-ID decisions for matched aliases (if any)
          if (perIdResolved) {
            for (const g of groups) {
              if (dec[String(g.id)] === 'override') {
                const { id: msId } = await getNextId('curnames', entityType);
                if (msId !== null) {
                  for (const alias of g.aliases) {
                    await window.api.db.query(
                      `DELETE FROM ${g.hit.dict} WHERE LOWER(tokenized) = LOWER($1) AND medscan_id = $2 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
                      [tok(alias), g.id]
                    );
                    await dbInsertAlias(msId, alias, cartridgeList, orgs);
                  }
                }
              }
            }
          }
        } else if (dec.__new__ === 'newRecord') {
          // New record path: create a fresh record and add all unmapped aliases to it
          const { id: newId } = await getNextId('curnames', entityType);
          if (newId === null) continue;
          for (const alias of eligibleUnmapped.map(m => m.alias))
            await dbInsertAlias(newId, alias, cartridgeList, orgs);
          if (row.name) await dbInsertObjectNames(newId, row.name, cartridgeList, orgs);
        } else {
          // Standard resolution path
          const addToThisGroup = groups.find(g => dec[String(g.id)] === 'addToThis');
          if (addToThisGroup) {
            const targetId = addToThisGroup.id;
            if (conflictValidIds && !conflictValidIds.has(String(targetId))) {
              conflictOnSkipped++;
              setNoUrnRecords(prev => [...prev, {
                name:    row.name || '',
                id:      String(targetId),
                aliases: eligibleUnmapped.map(m => m.alias).join('; '),
                source:  'Conflicts',
              }]);
              continue; // skip — target ID not in ObjectNames
            }
            for (const alias of eligibleUnmapped.map(m => m.alias))
              await dbInsertAlias(targetId, alias, cartridgeList, orgs);
          } else {
            const { id: msId } = await getNextId('curnames', entityType);
            if (msId === null) continue;
            for (const alias of eligibleUnmapped.map(m => m.alias))
              await dbInsertAlias(msId, alias, cartridgeList, orgs);
            for (const g of groups) {
              if (dec[String(g.id)] === 'override') {
                for (const alias of g.aliases) {
                  await window.api.db.query(
                    `DELETE FROM ${g.hit.dict} WHERE LOWER(tokenized) = LOWER($1) AND medscan_id = $2 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
                    [tok(alias), g.id]
                  );
                  await dbInsertAlias(msId, alias, cartridgeList, orgs);
                }
              }
              // 'ignore': skip these conflicting aliases
            }
            await dbInsertObjectNames(msId, row.name, cartridgeList, orgs);
          }
        }
        n++;
      }
      const remainingConflicts = results.conflicts.filter((_, i) => !resolvedIndices.has(i));
      setResults(r => ({ ...r, conflicts: remainingConflicts }));
      // Re-apply auto-resolve on the remaining conflicts (indices shifted after removal).
      // Manual assignments are also remapped to new indices.
      const oldToNew = {};
      let ni = 0;
      for (let i = 0; i < results.conflicts.length; i++) {
        if (!resolvedIndices.has(i)) { oldToNew[i] = ni; ni++; }
      }
      const newManual = {};
      for (const [oldI, v] of Object.entries(manualAssign)) {
        if (oldToNew[oldI] !== undefined) newManual[oldToNew[oldI]] = v;
      }
      setManualAssign(newManual);
      // Recompute intersected auto-decisions for remaining conflicts from scratch.
      {
        const criteriaResults = [];
        sameTypeUpdatesRef.current   = {};
        longerUpdatesRef.current     = {};
        sameNameUpdatesRef.current   = {};
        aliasMatchUpdatesRef.current = {};
        if (resolveToSameType)   { const u = computeSameTypeUpdates(remainingConflicts, minMatchLen);   sameTypeUpdatesRef.current = u;   criteriaResults.push(u); }
        if (resolveToLonger)     { const u = computeLongerUpdates(remainingConflicts, minMatchLen);     longerUpdatesRef.current = u;     criteriaResults.push(u); }
        if (resolveToSameName)   { const u = computeSameNameUpdates(remainingConflicts, minMatchLen);   sameNameUpdatesRef.current = u;   criteriaResults.push(u); }
        if (resolveToAliasMatch) { const u = computeAliasMatchUpdates(remainingConflicts, minMatchLen); aliasMatchUpdatesRef.current = u; criteriaResults.push(u); }
        const newDec = {};
        if (criteriaResults.length > 0) {
          remainingConflicts.forEach((row, rowIdx) => {
            if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return;
            const activeDecs = criteriaResults.map(u => u[rowIdx]).filter(Boolean);
            if (activeDecs.length === 0) return;
            const winnerStr = activeDecs.map(d => Object.entries(d).find(([, v]) => v === 'addToThis')?.[0]);
            if (!winnerStr[0] || !winnerStr.every(w => w === winnerStr[0])) return;
            if (resolveToSameType) {
              const inputRnef = getInputEtRnef(row);
              const winnerRnef = resolveEntityTypeFromId(Number(winnerStr[0]))?.rnef;
              if (!inputRnef || winnerRnef !== inputRnef) return;
            }
            const allGroupIds = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
            const fullDec = {};
            for (const id of allGroupIds) fullDec[id] = id === winnerStr[0] ? 'addToThis' : 'ignore';
            newDec[rowIdx] = fullDec;
          });
        }
        autoUpdatesRef.current = newDec;
        setConflictDec(newDec);
      }
      setConflictExp(new Set());
      let conflictMsg = `✓ Resolved ${n} conflict rows.`;
      if (conflictOnSkipped > 0)
        conflictMsg += ` ${conflictOnSkipped} record${conflictOnSkipped !== 1 ? 's' : ''} could not be imported because they do not have corresponding Name and URN values in ObjectNames.`;
      setSubmitMsg(conflictMsg);
      onSuccess?.(`Batch import: ${n} conflicts resolved.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // Create a brand-new NLP record for each visible conflict row, importing unmapped aliases under it.
  const handleSubmitConflictsAsNewRecords = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const conflicts = results?.conflicts || [];
      const candidates = conflicts
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => {
          if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return false;
          return true;
        });

      let createdCount = 0;
      const submittedIndices = new Set();
      for (const { i, row } of candidates) {
        const { id: newId } = await getNextId('curnames', entityType);
        if (newId === null) continue;
        const eligible = row.unmapped
          .map(m => m.alias)
          .filter(a => minAliasLenConflict === 0 || a.length >= minAliasLenConflict);
        for (const alias of eligible)
          await dbInsertAlias(newId, alias, cartridgeList, orgs);
        await dbInsertObjectNames(newId, row.name, cartridgeList, orgs);
        createdCount++;
        submittedIndices.add(i);
      }

      const remaining = conflicts.filter((_, i) => !submittedIndices.has(i));
      const oldToNew = {};
      let ni = 0;
      for (let i = 0; i < conflicts.length; i++) {
        if (!submittedIndices.has(i)) { oldToNew[i] = ni; ni++; }
      }
      const newManual = {};
      for (const [oldI, v] of Object.entries(manualAssign)) {
        if (oldToNew[oldI] !== undefined) newManual[oldToNew[oldI]] = v;
      }
      setManualAssign(newManual);
      setResults(r => ({ ...r, conflicts: remaining }));
      setConflictDec({});
      autoUpdatesRef.current = {};
      setConflictExp(new Set());

      setSubmitMsg(`✓ Created ${createdCount.toLocaleString()} new record${createdCount !== 1 ? 's' : ''}${organism ? ` with organism "${organism}"` : ''}.`);
      onSuccess?.(`Batch import: ${createdCount} new records created from conflict rows.`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  // Submit conflict rows using the ID from the input file, bypassing conflict resolution.
  // Imports only the unmapped (new) aliases for each row; unmapped aliases that collided are irrelevant here.
  const handleSubmitConflictsWithFileId = async () => {
    setSubmitting(true); setSubmitMsg(null);
    const orgs = [organism].filter(Boolean);
    try {
      const conflicts = results?.conflicts || [];
      // Collect rows that have a _flatId and are not hidden by the alias length filter
      const toProcess = conflicts
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => {
          if (row._flatId == null) return false;
          if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return false;
          return true;
        });

      // Check which _flatIds exist in ObjectNames (skipped when requireObjectNames is false)
      const flatIds = [...new Set(toProcess.map(({ row }) => row._flatId))];
      let importable, skippedCount;
      if (requireObjectNames) {
        const chk = flatIds.length
          ? await window.api.db.query(`SELECT medscan_id FROM objectnames WHERE medscan_id = ANY($1)`, [flatIds])
          : { ok: true, rows: [] };
        const validIds = new Set(chk.ok ? chk.rows.map(r => Number(r.medscan_id)) : []);
        importable   = toProcess.filter(({ row }) => validIds.has(row._flatId));
        skippedCount = toProcess.length - importable.length;
      } else {
        importable   = toProcess;
        skippedCount = 0;
      }

      const aliasRows = [];
      const importedSet = new Set();
      for (const { row, i } of importable) {
        const eligible = row.unmapped
          .map(m => m.alias)
          .filter(a => minAliasLenConflict === 0 || a.length >= minAliasLenConflict);
        for (const alias of eligible)
          aliasRows.push({ msId: row._flatId, alias, cartridges: cartridgeList, orgs });
        importedSet.add(i);
      }
      const { total: n, byTable: insertedByTable, bDeletedBlocked } = await bulkInsertAliasRows(aliasRows, targetTable);

      // Remove imported rows from conflicts list; remap manual assignments
      const remaining = conflicts.filter((_, i) => !importedSet.has(i));
      const oldToNew  = {};
      let ni = 0;
      for (let i = 0; i < conflicts.length; i++) {
        if (!importedSet.has(i)) { oldToNew[i] = ni; ni++; }
      }
      const newManual = {};
      for (const [oldI, v] of Object.entries(manualAssign)) {
        if (oldToNew[oldI] !== undefined) newManual[oldToNew[oldI]] = v;
      }
      setManualAssign(newManual);
      setResults(r => ({ ...r, conflicts: remaining }));
      setConflictDec({});
      autoUpdatesRef.current = {};
      setConflictExp(new Set());

      let msg = `✓ Imported ${n.toLocaleString()} aliases for ${importable.length.toLocaleString()} conflict rows (using IDs from file)${fmtByTable(insertedByTable)}.`;
      if (skippedCount > 0)
        msg += ` ${skippedCount} row${skippedCount !== 1 ? 's' : ''} skipped — no ObjectNames entry for file ID.`;
      if (bDeletedBlocked > 0)
        msg += ` ${bDeletedBlocked} ${bDeletedBlocked === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.`;
      setSubmitMsg(msg);
      onSuccess?.(`Batch import: ${n} aliases added from conflict rows (file IDs).`);
    } catch (e) { setSubmitMsg(`✗ ${e.message}`); }
    finally { setSubmitting(false); }
  };

  const toggleConflictExp = async (idx) => {
    setConflictExp(s => {
      const next = new Set(s);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
    // Fetch alias counts for all matched IDs in this row (lazy, cached)
    if (results?.conflicts?.[idx]) {
      const ids = [...new Set(results.conflicts[idx].mapped.map(m => m.hit.dup.medscan_id))];
      const uncached = ids.filter(id => aliasCountCache[id] === undefined);
      if (uncached.length > 0) {
        const counts = await Promise.all(uncached.map(async id => {
          const res = await window.api.db.query(
            `SELECT SUM(cnt) AS total FROM (
               SELECT COUNT(*) AS cnt FROM curnames       WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM exactliteral          WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM celldictionary        WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM casdictionary         WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM keywords              WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM userdict              WHERE medscan_id = $1
               UNION ALL
               SELECT COUNT(*) FROM combnames             WHERE medscan_id = $1
             ) t`,
            [id]
          );
          return [id, res.ok ? Number(res.rows[0]?.total ?? 0) : 0];
        }));
        setAliasCountCache(c => ({ ...c, ...Object.fromEntries(counts) }));
      }
    }
  };
  const setAliasDec = (rowIdx, alias, val) =>
    setConflictDec(d => ({ ...d, [rowIdx]: { ...(d[rowIdx] || {}), [alias]: val } }));

  // Remove keys that were written by an auto-resolve action (keyed by ref).
  const revertAutoDecisions = (updatesRef) => {
    const updates = updatesRef.current;
    updatesRef.current = {};
    if (!Object.keys(updates).length) return;
    setConflictDec(d => {
      const next = { ...d };
      for (const [rowIdx, dec] of Object.entries(updates)) {
        if (!next[rowIdx]) continue;
        const rowDec = { ...next[rowIdx] };
        for (const id of Object.keys(dec)) delete rowDec[id];
        if (Object.keys(rowDec).length === 0) delete next[rowIdx];
        else next[rowIdx] = rowDec;
      }
      return next;
    });
  };

  // Pure compute helpers — accept a conflicts array so they can be called both from
  // checkbox handlers (using results.conflicts) and from handleAnalyze (using the
  // freshly-built conflicts array before it is committed to state).

  const computeSameTypeUpdates = (conflictsArr, minML = 0) => {
    const updates = {};
    conflictsArr.forEach((row, rowIdx) => {
      const inputRnef = getInputEtRnef(row);
      if (!inputRnef) return;
      const idGroups = {};
      for (const m of row.mapped) {
        if (minML > 0 && m.alias.length < minML) continue;
        const key = String(m.hit.dup.medscan_id);
        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id };
      }
      const groups = Object.values(idGroups);
      const sameType = groups.filter(g => resolveEntityTypeFromId(g.id)?.rnef === inputRnef);
      if (sameType.length === 1) {
        const winId = String(sameType[0].id);
        const dec = {};
        for (const g of groups) dec[String(g.id)] = String(g.id) === winId ? 'addToThis' : 'ignore';
        updates[rowIdx] = dec;
      }
    });
    return updates;
  };

  const computeLongerUpdates = (conflictsArr, minML = 0) => {
    const updates = {};
    conflictsArr.forEach((row, rowIdx) => {
      const idGroups = {};
      for (const m of row.mapped) {
        if (minML > 0 && m.alias.length < minML) continue;
        const key = String(m.hit.dup.medscan_id);
        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, aliases: [] };
        idGroups[key].aliases.push(m.alias);
      }
      const groups = Object.values(idGroups);
      if (groups.length < 2) return;
      const withMax = groups.map(g => ({ id: g.id, maxLen: Math.max(...g.aliases.map(a => a.length)) }));
      const best = Math.max(...withMax.map(g => g.maxLen));
      const winners = withMax.filter(g => g.maxLen === best);
      if (winners.length === 1) {
        const winId = String(winners[0].id);
        const dec = {};
        for (const g of groups) dec[String(g.id)] = String(g.id) === winId ? 'addToThis' : 'ignore';
        updates[rowIdx] = dec;
      }
      // Tie → leave unresolved
    });
    return updates;
  };

  const computeSameNameUpdates = (conflictsArr, minML = 0) => {
    // Pick the tokenizer based on each row's entity type → default dict table
    // (mirrors the batch import target table selection in configuration).
    // ENTITY_TO_TABLE: Protein/SmallMol/FunctionalClass/… → curnames
    //                  CellObject/CellProcesses/Tissue/…   → celldictionary
    const tokForRow = (row) => {
      const rnef  = getInputEtRnef(row);
      const table = (rnef && ENTITY_TO_TABLE[rnef]) || 'curnames';
      return xwTokFor(table);
    };
    const updates = {};
    conflictsArr.forEach((row, rowIdx) => {
      const tok      = tokForRow(row);
      const fileName = tok((row.name || '').trim()).toLowerCase();
      if (!fileName) return;
      if (minML > 0 && fileName.length < minML) return;
      const idGroups = {};
      for (const m of row.mapped) {
        const key = String(m.hit.dup.medscan_id);
        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id };
      }
      const groups = Object.values(idGroups);
      // Match groups whose tokenized DB name equals the tokenized file record name
      const sameNameGroups = groups.filter(g => {
        const dbName = tok((onCache[g.id] ?? '').trim()).toLowerCase();
        return dbName && dbName === fileName;
      });
      if (sameNameGroups.length === 1) {
        const winId = String(sameNameGroups[0].id);
        const dec = {};
        for (const g of groups) dec[String(g.id)] = String(g.id) === winId ? 'addToThis' : 'ignore';
        updates[rowIdx] = dec;
      }
    });
    return updates;
  };

  const applyResolveToSameName = () => {
    if (!results?.conflicts) return;
    const updates = computeSameNameUpdates(results.conflicts);
    sameNameUpdatesRef.current = updates;
    if (Object.keys(updates).length > 0) applyConflictDecUpdates(updates);
  };

  // Resolve to the DB group that has an alias matching the file record name after tokenization.
  // Each alias is tokenized using the rules for its own dict table:
  //   exactliteral → alias verbatim (case-sensitive if match 'l', else case-insensitive)
  //   all others   → xword-tokenized via xwTokFor(dict)
  const computeAliasMatchUpdates = (conflictsArr, minML = 0) => {
    const updates = {};
    conflictsArr.forEach((row, rowIdx) => {
      const rawFileName = (row.name || '').trim();
      if (!rawFileName) return;
      if (minML > 0 && rawFileName.length < minML) return;
      const idGroups = {};
      for (const m of row.mapped) {
        const key = String(m.hit.dup.medscan_id);
        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, hits: [] };
        idGroups[key].hits.push(m.hit);
      }
      const groups = Object.values(idGroups);
      if (groups.length < 2) return;
      const matchingGroups = groups.filter(g =>
        g.hits.some(hit => {
          const dict = hit.dict;
          const dbAlias = (hit.dup.alias || '').trim();
          if (dict === 'exactliteral') {
            // ExactLiteral: compare alias verbatim, not tokenized.
            // Respect match flag: 'l' → case-sensitive, otherwise case-insensitive.
            const mf = hit.dup.match || '';
            return mf.includes('l')
              ? dbAlias === rawFileName
              : dbAlias.toLowerCase() === rawFileName.toLowerCase();
          }
          // All other tables: compare tokenized forms
          const tok = xwTokFor(dict);
          return tok(dbAlias).toLowerCase() === tok(rawFileName).toLowerCase();
        })
      );
      if (matchingGroups.length === 1) {
        const winId = String(matchingGroups[0].id);
        const dec = {};
        for (const g of groups) dec[String(g.id)] = String(g.id) === winId ? 'addToThis' : 'ignore';
        updates[rowIdx] = dec;
      }
    });
    return updates;
  };

  const applyResolveToAliasMatch = () => {
    if (!results?.conflicts) return;
    const updates = computeAliasMatchUpdates(results.conflicts);
    aliasMatchUpdatesRef.current = updates;
    if (Object.keys(updates).length > 0) applyConflictDecUpdates(updates);
  };

  // Unified AND-intersection of all active auto-resolve criteria + alias length filter.
  // Replaces any prior auto decisions in conflictDec with the new intersection result.
  const computeAndApplyAutoDecisions = (flags, conflictsArr) => {
    const { sameType, longer, sameName, aliasMatch, minLen, minML = 0 } = flags;

    // Recompute per-criterion results (kept in refs for the table sort/display).
    sameTypeUpdatesRef.current   = {};
    longerUpdatesRef.current     = {};
    sameNameUpdatesRef.current   = {};
    aliasMatchUpdatesRef.current = {};
    const criteriaResults = [];
    if (sameType)   { const u = computeSameTypeUpdates(conflictsArr, minML);   sameTypeUpdatesRef.current = u;   criteriaResults.push(u); }
    if (longer)     { const u = computeLongerUpdates(conflictsArr, minML);     longerUpdatesRef.current = u;     criteriaResults.push(u); }
    if (sameName)   { const u = computeSameNameUpdates(conflictsArr, minML);   sameNameUpdatesRef.current = u;   criteriaResults.push(u); }
    if (aliasMatch) { const u = computeAliasMatchUpdates(conflictsArr, minML); aliasMatchUpdatesRef.current = u; criteriaResults.push(u); }

    // Intersect: a row is resolved only if all criteria that *have* a decision agree on the same winner.
    // Criteria that produce no decision for a row are neutral — they don't block resolution.
    // Exception: "same type" is a hard constraint — the winner must be the same type as the input,
    // regardless of whether computeSameTypeUpdates produced a decision (covers the case where
    // none of the DB candidates are the same type as the input record).
    const newAuto = {};
    if (criteriaResults.length > 0) {
      conflictsArr.forEach((row, rowIdx) => {
        // Alias length gate: row must have at least one unmapped alias >= minLen.
        if (minLen > 0 && !row.unmapped.some(m => m.alias.length >= minLen)) return;
        const activeDecs = criteriaResults.map(u => u[rowIdx]).filter(Boolean);
        if (activeDecs.length === 0) return; // no criterion resolved this row
        const winnerStr = activeDecs.map(d => Object.entries(d).find(([, v]) => v === 'addToThis')?.[0]);
        if (!winnerStr[0] || !winnerStr.every(w => w === winnerStr[0])) return; // active criteria disagree
        // "same type" hard constraint: winner must be the same entity type as the input record.
        if (sameType) {
          const inputRnef = getInputEtRnef(row);
          const winnerRnef = resolveEntityTypeFromId(Number(winnerStr[0]))?.rnef;
          if (!inputRnef || winnerRnef !== inputRnef) return;
        }
        // Build a complete decision covering ALL groups in the row (not just those
        // visible to individual criteria, which may have filtered some out via minML).
        const allGroupIds = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
        const fullDec = {};
        for (const id of allGroupIds) fullDec[id] = id === winnerStr[0] ? 'addToThis' : 'ignore';
        newAuto[rowIdx] = fullDec;
      });
    }

    const oldAuto = autoUpdatesRef.current;
    autoUpdatesRef.current = newAuto;

    setConflictDec(d => {
      const next = { ...d };
      // Remove old auto decisions
      for (const [rowIdx, dec] of Object.entries(oldAuto)) {
        if (!next[rowIdx]) continue;
        const rowDec = { ...next[rowIdx] };
        for (const id of Object.keys(dec)) delete rowDec[id];
        if (Object.keys(rowDec).length === 0) delete next[rowIdx];
        else next[rowIdx] = rowDec;
      }
      // Apply new intersection decisions
      for (const [rowIdx, dec] of Object.entries(newAuto))
        next[rowIdx] = { ...(next[rowIdx] || {}), ...dec };
      return next;
    });
  };

  // Merge multiple updates dicts into one conflictDec map and commit to state.
  const applyConflictDecUpdates = (decMap) => {
    setConflictDec(d => {
      const next = { ...d };
      for (const [rowIdx, dec] of Object.entries(decMap))
        next[rowIdx] = { ...(next[rowIdx] || {}), ...dec };
      return next;
    });
  };

  const applyResolveToSameType = () => {
    if (!results?.conflicts) return;
    const updates = computeSameTypeUpdates(results.conflicts);
    sameTypeUpdatesRef.current = updates;
    if (Object.keys(updates).length > 0) applyConflictDecUpdates(updates);
  };

  const applyResolveToLonger = () => {
    if (!results?.conflicts) return;
    const updates = computeLongerUpdates(results.conflicts);
    longerUpdatesRef.current = updates;
    if (Object.keys(updates).length > 0) applyConflictDecUpdates(updates);
  };

  // ── ObjectNames resizable columns ───────────────────────────────────────────
  // Renders a resizable fixed-layout table for the ON conflict tabs.
  //   labels       — column header strings; col 3 gets the separator border
  //   rows         — data array passed to renderRow
  //   renderRow    — (row, idx) → <tr>
  //   widthsState  — [widths, setWidths] where widths is null (equal split) or number[]
  const renderOnTable = (labels, rows, renderRow, widthsState) => {
    const [colWidths, setColWidths] = widthsState;
    const nCols  = labels.length;
    const colPct = colWidths || Array(nCols).fill(100 / nCols);
    let tableEl  = null;

    const startResize = (e, colIdx) => {
      e.preventDefault();
      if (!tableEl) return;
      const tableWidth = tableEl.getBoundingClientRect().width;
      if (!tableWidth) return;
      const startX      = e.clientX;
      const startWidths = [...colPct];
      const onMove = (ev) => {
        const dPct = ((ev.clientX - startX) / tableWidth) * 100;
        const next = [...startWidths];
        next[colIdx]     = Math.max(4, startWidths[colIdx]     + dPct);
        next[colIdx + 1] = Math.max(4, startWidths[colIdx + 1] - dPct);
        setColWidths(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    };

    return (
      <table
        className="data-table"
        ref={el => { tableEl = el; }}
        style={{ tableLayout: 'fixed', width: '100%' }}
      >
        <colgroup>
          {colPct.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}
        </colgroup>
        <thead><tr>
          {labels.map((label, i) => (
            <th key={i} style={{
              position: 'sticky', top: 0, zIndex: 2,
              background: 'var(--bg-card, #1a1d2e)',
              overflow: 'hidden', userSelect: 'none',
              ...(i === 3 ? { borderLeft: '2px solid var(--border)' } : {}),
            }}>
              {label}
              {i < nCols - 1 && (
                <div
                  onMouseDown={e => startResize(e, i)}
                  style={{
                    position: 'absolute', right: 0, top: 0, bottom: 0,
                    width: 6, cursor: 'col-resize', zIndex: 1,
                  }}
                />
              )}
            </th>
          ))}
        </tr></thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    );
  };

  // ── ObjectNames results view ─────────────────────────────────────────────────
  if (onImportData) {
    const { matched, alreadyInON = [], alreadyInDB = [], identicalCount = 0, totalRows } = onImportData;
    const onCheckedCount = matched.filter((_, i) => onApprovals[i] !== false).length;
    const onAllChecked   = onCheckedCount === matched.length;
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn btn-secondary" onClick={() => { setOnImportData(null); setSubmitMsg(null); }}>← Back</button>
          <span style={{ fontWeight: 600 }}>ObjectNames Import — {file.split(/[\\/]/).pop()}</span>
          {totalRows != null && (
            <span className="text-xs" style={{ color: 'var(--success, #2a9)', fontWeight: 600 }}>
              {totalRows.toLocaleString()} rows in file
              {identicalCount > 0 && <> · {identicalCount.toLocaleString()} identical (skipped)</>}
            </span>
          )}
        </div>

        <BatchSubmitMsg msg={submitMsg} />
        {alreadyInON.length > 0 && (
          <div className="alert alert-info" style={{ marginBottom: 12 }}>
            ℹ {alreadyInON.length} ID{alreadyInON.length !== 1 ? 's' : ''} already exist in ObjectNames with different content — shown in "Already in ObjectNames" tab.
          </div>
        )}

        <div className="tabs">
          <div className={`tab ${resultTab === 'on_matched' ? 'active' : ''}`} onClick={() => setResultTab('on_matched')}>
            New — will import ({matched.length})
          </div>
          <div className={`tab ${resultTab === 'on_existing' ? 'active' : ''}`} onClick={() => setResultTab('on_existing')}>
            Already in ObjectNames ({alreadyInON.length})
          </div>
          <div className={`tab ${resultTab === 'on_in_db' ? 'active' : ''}`} onClick={() => setResultTab('on_in_db')}>
            Already in Database ({alreadyInDB.length})
          </div>
        </div>

        {resultTab === 'on_matched' && (
          <div style={{ marginTop: 12 }}>
            {matched.length === 0 ? (
              submitMsg
                ? null  // success message already shown in header — no need for a second notice
                : <div className="text-muted" style={{ marginTop: 8 }}>No records pending import.</div>
            ) : (<>
              <div style={{ marginBottom: 6, display: 'flex', gap: 10 }}>
                <button className="btn btn-xs btn-secondary" onClick={() => {
                  const a = {}; matched.forEach((_, i) => { a[i] = true; }); setOnApprovals(a);
                }}>Select All</button>
                <button className="btn btn-xs btn-secondary" onClick={() => {
                  const a = {}; matched.forEach((_, i) => { a[i] = false; }); setOnApprovals(a);
                }}>Deselect All</button>
                <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>{onCheckedCount} of {matched.length} selected</span>
              </div>
              <div className="table-wrap" style={{ maxHeight: 440 }}>
                <table className="data-table">
                  <thead><tr>
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={onAllChecked} onChange={e => {
                        const a = {}; matched.forEach((_, i) => { a[i] = e.target.checked; }); setOnApprovals(a);
                      }} />
                    </th>
                    <th style={{ width: 130 }}>NLP ID in file</th>
                    <th style={{ width: 260 }}>Name in file</th>
                    <th>URN in file</th>
                  </tr></thead>
                  <tbody>
                    {matched.map((r, i) => {
                      const checked = onApprovals[i] !== false;
                      return (
                        <tr key={i} style={{ opacity: checked ? 1 : 0.45 }}>
                          <td><input type="checkbox" checked={checked} onChange={e =>
                            setOnApprovals(prev => ({ ...prev, [i]: e.target.checked }))
                          } /></td>
                          <td className="mono">{r.id.toLocaleString()}</td>
                          <td>{r.name}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{r.urn || <span className="text-muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
                <button className="btn btn-primary" onClick={handleSubmitObjectNames} disabled={submitting || onCheckedCount === 0}>
                  {submitting ? <><span className="spinner" /> Importing…</> : `⬆ Submit ${onCheckedCount} Record${onCheckedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            </>)}
          </div>
        )}

        {resultTab === 'on_existing' && (
          <div style={{ marginTop: 12 }}>
            {alreadyInON.length === 0 ? (
              <div className="text-muted">No IDs from this file already exist in ObjectNames.</div>
            ) : (<>
              <div className="alert alert-info" style={{ marginBottom: 10 }}>
                These IDs already exist in ObjectNames with different Name or URN values. Use Remap buttons below to overwrite DB values with file values.
              </div>
              <div style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={handleRemapUrns} disabled={remappingUrns || remappingNames || alreadyInON.length === 0}>
                  {remappingUrns ? <><span className="spinner" /> Working…</> : `🔁 Remap URNs (${alreadyInON.length})`}
                </button>
                <span className="text-xs text-muted">Overwrites the DB record with the value from the file</span>
                <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={handleRemapNames} disabled={remappingUrns || remappingNames || alreadyInON.length === 0}>
                  {remappingNames ? <><span className="spinner" /> Working…</> : `🔁 Remap Names (${alreadyInON.length})`}
                </button>
                <button className="btn btn-success" onClick={handleImportWithNewIds} disabled={importingNewIds || remappingUrns || remappingNames || alreadyInON.length === 0}
                  title="Insert these records into ObjectNames with fresh auto-generated IDs instead of the conflicting file IDs">
                  {importingNewIds ? <><span className="spinner" /> Importing…</> : `＋ Import with new IDs (${alreadyInON.length})`}
                </button>
                <button className="btn btn-primary" onClick={handleAddOrganismON} disabled={submitting || !organism}>
                  {submitting ? <><span className="spinner" /> Updating…</> : `＋ Add organism "${organism || '—'}" to ${alreadyInON.length} record${alreadyInON.length !== 1 ? 's' : ''}`}
                </button>
                <button className="btn btn-secondary" onClick={() => {
                  downloadTsv(
                    'objectnames_conflicts.tsv',
                    ['NLP ID in file','Name in file','URN in file','DB NLP ID','DB Name','DB URN'],
                    alreadyInON.map(r => {
                      const db = r._dbRecord;
                      return [r.id, r.name, r.urn || '', db?.id ?? '', db?.name ?? '', db?.urn ?? ''];
                    })
                  );
                }}>⬇ Export TSV</button>
                {addOrgONMsg && (
                  <span style={{ fontSize: 12, color: addOrgONMsg.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
                    {addOrgONMsg.text}
                  </span>
                )}
              </div>

              {/* Results table shown after "Import with new IDs" */}
              {newIdsCreated.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      New records created ({newIdsCreated.length.toLocaleString()})
                    </span>
                    <button className="btn btn-secondary btn-sm" onClick={() => {
                      downloadTsv(
                        'new_objectnames_ids.tsv',
                        ['New NLP ID', 'Name', 'URN'],
                        newIdsCreated.map(r => [r.newId, r.name, r.urn])
                      );
                    }}>⬇ Export TSV</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setNewIdsCreated([])}>✕ Clear</button>
                  </div>
                  <div className="table-wrap" style={{ maxHeight: 300 }}>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th style={{ textAlign: 'left', padding: '3px 8px', whiteSpace: 'nowrap' }}>New NLP ID</th>
                          <th style={{ textAlign: 'left', padding: '3px 8px' }}>Name</th>
                          <th style={{ textAlign: 'left', padding: '3px 8px' }}>URN</th>
                        </tr>
                      </thead>
                      <tbody>
                        {newIdsCreated.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle, #333)' }}>
                            <td className="mono" style={{ padding: '2px 8px', whiteSpace: 'nowrap' }}>{r.newId.toLocaleString()}</td>
                            <td style={{ padding: '2px 8px' }}>{r.name}</td>
                            <td className="mono" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--text-muted)' }}>{r.urn || <span style={{ opacity: 0.4 }}>—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="table-wrap" style={{ maxHeight: 440 }}>
                {(() => {
                  const totalPages = Math.ceil(alreadyInON.length / ON_PAGE_SIZE);
                  const pageRows   = alreadyInON.slice(onExistingPage * ON_PAGE_SIZE, (onExistingPage + 1) * ON_PAGE_SIZE);
                  return (<>
                    {totalPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12 }}>
                        <button className="btn btn-secondary btn-sm" disabled={onExistingPage === 0} onClick={() => setOnExistingPage(0)}>«</button>
                        <button className="btn btn-secondary btn-sm" disabled={onExistingPage === 0} onClick={() => setOnExistingPage(p => p - 1)}>‹</button>
                        <span className="text-muted">Page {onExistingPage + 1} / {totalPages} ({alreadyInON.length.toLocaleString()} rows)</span>
                        <button className="btn btn-secondary btn-sm" disabled={onExistingPage >= totalPages - 1} onClick={() => setOnExistingPage(p => p + 1)}>›</button>
                        <button className="btn btn-secondary btn-sm" disabled={onExistingPage >= totalPages - 1} onClick={() => setOnExistingPage(totalPages - 1)}>»</button>
                      </div>
                    )}
                    {renderOnTable(
                      ['NLP ID in file','Name in file','URN in file','DB NLP ID','DB Name','DB URN'],
                      pageRows,
                      (r, i) => {
                        const db = r._dbRecord;
                        const ct = r._conflictType;
                        const idStyle   = ct === 'id'   ? {} : (db && db.id   !== r.id              ? { color: '#e5a000' } : {});
                        const nameStyle = ct === 'name' ? {} : (db && db.name !== (r.name || '')     ? { color: '#e5a000' } : {});
                        const urnStyle  = ct === 'urn'  ? {} : (db && (db.urn||'') !== (r.urn||'')  ? { color: '#e5a000' } : {});
                        return (
                          <tr key={i}>
                            <td className="mono" style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.id.toLocaleString()}</td>
                            <td style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</td>
                            <td className="mono" style={{ fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.urn || <span className="text-muted">—</span>}</td>
                            <td className="mono" style={{ borderLeft:'2px solid var(--border)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', ...idStyle }}>
                              {db ? db.id.toLocaleString() : <span className="text-muted">—</span>}
                            </td>
                            <td style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', ...nameStyle }}>
                              {db ? (db.name || <span className="text-muted">—</span>) : <span className="text-muted">—</span>}
                            </td>
                            <td className="mono" style={{ fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', ...urnStyle }}>
                              {db ? (db.urn || <span className="text-muted">—</span>) : <span className="text-muted">—</span>}
                            </td>
                          </tr>
                        );
                      },
                      [onColWidthsON, setOnColWidthsON]
                    )}
                  </>);
                })()}
              </div>
            </>)}
          </div>
        )}

        {resultTab === 'on_in_db' && (
          <div style={{ marginTop: 12 }}>
            {alreadyInDB.length === 0 ? (
              <div className="text-muted">No names from this file match aliases in any dictionary table.</div>
            ) : (<>
              <div className="alert alert-info" style={{ marginBottom: 10 }}>
                These ObjectNames names match existing aliases in dictionary tables (case-insensitive). The matching alias is shown in white; differing DB values are highlighted in yellow.
              </div>
              {(() => {
                const canAddUrns = alreadyInDB.filter(r => r._dbRecord && !r._dbRecord.urn && r.urn).length;
                return (
                  <div style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" onClick={handleAddUrnsFromDB}
                      disabled={addingUrnsDB || canAddUrns === 0}
                      title="Sets URN in ObjectNames for matched records that currently have no URN">
                      {addingUrnsDB ? <><span className="spinner" /> Adding URNs…</> : `＋ Add URNs (${canAddUrns})`}
                    </button>
                    <span className="text-xs text-muted">Fills URN from file into ObjectNames records that currently have no URN</span>
                    {addUrnsDBMsg && (
                      <span style={{ fontSize: 12, color: addUrnsDBMsg.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
                        {addUrnsDBMsg.text}
                        <button onClick={() => setAddUrnsDBMsg(null)}
                          style={{ background:'none', border:'none', cursor:'pointer', fontSize:14, lineHeight:1, color:'inherit', opacity:0.55, padding:'0 0 0 4px' }}>×</button>
                      </span>
                    )}
                  </div>
                );
              })()}
              <div className="table-wrap" style={{ maxHeight: 480 }}>
                {renderOnTable(
                  ['NLP ID in file','Name in file','URN in file','DB NLP ID','DB Alias','DB URN','DB Table'],
                  alreadyInDB,
                  (r, i) => {
                    const db = r._dbRecord;
                    const idDiffers  = db && db.id  !== r.id;
                    const urnDiffers = db && (db.urn || '') !== (r.urn || '');
                    const td = (extra = {}) => ({ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', ...extra });
                    return (
                      <tr key={i}>
                        <td className="mono" style={td()}>{r.id.toLocaleString()}</td>
                        <td style={td()}>{r.name}</td>
                        <td className="mono" style={td({ fontSize:11 })}>{r.urn || <span className="text-muted">—</span>}</td>
                        <td className="mono" style={td({ borderLeft:'2px solid var(--border)', ...(idDiffers  ? { color:'#e5a000' } : {}) })}>
                          {db ? db.id.toLocaleString() : <span className="text-muted">—</span>}
                        </td>
                        <td style={td()}>{db ? db.alias : <span className="text-muted">—</span>}</td>
                        <td className="mono" style={td({ fontSize:11, ...(urnDiffers ? { color:'#e5a000' } : {}) })}>
                          {db ? (db.urn || <span className="text-muted">—</span>) : <span className="text-muted">—</span>}
                        </td>
                        <td className="mono" style={td({ fontSize:11, color:'var(--text-muted)' })}>
                          {db ? db.table : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    );
                  },
                  [onColWidthsDB, setOnColWidthsDB]
                )}
              </div>
            </>)}
          </div>
        )}

      </div>
    );
  }

  // ── Mixed list helpers ────────────────────────────────────────────────────
  const parseMixedInput = (text) => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.map((line, i) => {
      if (line.includes('\t')) {
        const tabIdx = line.indexOf('\t');
        const id = line.slice(0, tabIdx).trim();
        return { id: id || String(i + 1), alias: line.slice(tabIdx + 1).trim() };
      }
      return { id: String(i + 1), alias: line };
    });
  };

  // Load a 1-column (alias) or 2-column (id ⇥ alias) text file into the Aliases textbox
  // Open the in-app picker (native Open dialog was oversized/unresizable) at the last used folder.
  const handleMixedLoadFile = async () => {
    const sFile = await window.api.settings.get();
    setMixedPicker({ startDir: sFile?.mixedImportDir || '' });
  };
  // Remember the last folder permanently (stored with the other app settings) — also when cancelled.
  const rememberMixedDir = (dir) => { if (dir) window.api.settings.set({ mixedImportDir: dir }); };
  const loadMixedFile = async (f, dir) => {
    setMixedPicker(null);
    rememberMixedDir(dir);
    const content = await window.api.fs.readFile(f);
    if (content == null) { setMixedFileMsg(`⚠ Could not read ${f}`); return; }
    const lines = content.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setMixedFileMsg(`⚠ ${f.split(/[\\/]/).pop()} is empty.`); return; }
    const twoCol = lines.filter(l => l.includes('\t')).length;
    setMixedText(lines.join('\n'));
    // Previous mapping/annotation results no longer match the textbox
    setMixedResults(null); setMixedAnnotated([]); setMixedLlmMsg(null); setMixedSubmitMsg(null); setMixedError(null);
    setMixedFileMsg(`Loaded ${lines.length.toLocaleString()} line${lines.length !== 1 ? 's' : ''} from ${f.split(/[\\/]/).pop()} (${twoCol > lines.length / 2 ? '2-column' : '1-column'}).`);
  };

  const mixedDictFor = (entityType) => {
    if (['Protein', 'FunctionalClass', 'Complex', 'Treatment', 'GeneticVariant', 'MedicalProcedure'].includes(entityType)) return 'curnames';
    if (entityType === 'SmallMol') return 'casdictionary';
    return 'celldictionary';
  };

  // All available organisms (service table organisms_lookup), alphabetical.
  const getAllOrganisms = async () => {
    const res = await window.api.db.query(`SELECT name FROM organisms_lookup WHERE name IS NOT NULL AND name <> '' ORDER BY name`);
    return res.ok ? res.rows.map(r => r.name) : [];
  };

  const handleMixedRun = async () => {
    setMixedError(null); setMixedResults(null); setMixedAnnotated([]); setMixedLlmMsg(null); setMixedSubmitMsg(null); setMixedDupMsg(null);
    const rawAliases = parseMixedInput(mixedText);
    if (rawAliases.length === 0) { setMixedError('Please paste at least one alias.'); return; }
    // Deduplicate by alias text (case-insensitive), preserving first occurrence
    const seenAliases = new Set();
    const aliases = [];
    for (const item of rawAliases) {
      const key = item.alias.toLowerCase().trim();
      if (key && !seenAliases.has(key)) { seenAliases.add(key); aliases.push(item); }
    }
    const dupCount = rawAliases.length - aliases.length;
    if (dupCount > 0) setMixedDupMsg(`${dupCount} duplicate alias${dupCount !== 1 ? 'es' : ''} removed before mapping.`);
    setMixedRunning(true);
    try {
      const s = await window.api.settings.get();
      const cartridgeNames = mixedCartList.length ? mixedCartList : cartridges.map(c => c.name);
      const selectedCarts = cartridges.filter(c => cartridgeNames.includes(c.name) && typeof c.path === 'string' && c.path);
      if (selectedCarts.length === 0) { setMixedError('No cartridges with a valid path found. Check Settings.'); setMixedRunning(false); return; }

      // Every organism dictionary (<Organism>.msbatch in the cartridge folder) is scanned.
      // All (cartridge × organism) locscan runs execute in parallel; each has its own input file and stdout.
      // Organism list = organisms_lookup, limited to those with a compiled dictionary in the cartridge.
      const lookupOrgs = await getAllOrganisms();
      const orgLists = await Promise.all(selectedCarts.map(async cart => {
        const available = await window.api.medscan.listOrganisms(cart.path);
        const wanted = lookupOrgs.length ? available.filter(o => lookupOrgs.includes(o)) : available;
        return wanted.length ? wanted : available;
      }));
      const jobs = selectedCarts.flatMap((cart, ci) =>
        (orgLists[ci]?.length ? orgLists[ci] : ['Mammal']).map(org => ({ cart, org }))
      );
      const cartResults = await Promise.all(jobs.map(({ cart, org }) =>
        window.api.medscan.mapDict({
          aliases,
          organism:         org,
          license:          s?.medscanLicense || '',
          cartridgeBinPath: cart.path,
        })
      ));

      // Debug: always log full invocation details for each cartridge/organism run
      cartResults.forEach((r, ci) => {
        const name = `${jobs[ci].cart.name} / ${jobs[ci].org}`;
        const d = r._debug;
        console.group(`[mapDict] cartridge/organism: ${name}  ok=${r.ok}`);
        if (d) {
          console.log('EXE :', d.exe);
          console.log('CMD :', d.cmdLine);
          console.log('CWD :', d.cwd);
          console.log('INPUT FILE (first 5 lines):\n' + (d.inputFileSample || '(empty)'));
          console.log('OUTPUT (first 10 lines):\n' + (d.outputSample || '(empty)'));
          if (d.stderr) console.warn('STDERR:\n' + d.stderr);
        }
        if (!r.ok) console.error('ERROR:', r.error);
        console.groupEnd();
      });

      const errors = cartResults.filter(r => !r.ok);
      if (errors.length === jobs.length) { setMixedError(`MedScan error: ${errors[0].error}`); return; }

      // Merge: alias is mapped if recognised by at least one cartridge/organism run
      const mappedByAlias = new Map();
      for (let ci = 0; ci < cartResults.length; ci++) {
        const r = cartResults[ci];
        if (!r.ok) continue;
        for (const m of r.mapped) {
          const key = m.alias.toLowerCase();
          if (!mappedByAlias.has(key)) mappedByAlias.set(key, { alias: m.alias, msIds: [], cartridges: [], organisms: [] });
          const entry = mappedByAlias.get(key);
          const cartName = jobs[ci].cart.name;
          if (cartName && !entry.cartridges.includes(cartName)) entry.cartridges.push(cartName);
          const orgName = jobs[ci].org;
          if (orgName && !entry.organisms.includes(orgName)) entry.organisms.push(orgName);
          for (const id of m.msIds) { if (!entry.msIds.includes(id)) entry.msIds.push(id); }
        }
        if (r.warn) setMixedDupMsg(prev => (prev ? prev + ' ' : '') + r.warn);
      }

      // 1) Mapped by NLP (MedScan)
      const mapped   = [...mappedByAlias.values()];
      const unmappedByNlp = aliases.filter(a => !mappedByAlias.has(a.alias.toLowerCase()));

      // 2) Aliases MedScan did not recognise → database search (tokenized, then case-insensitive fallback)
      let dbFound = [];
      if (unmappedByNlp.length) {
        const hits = await findAliasesInDb(unmappedByNlp.map(a => a.alias));
        dbFound = unmappedByNlp
          .filter(a => hits.has(a.alias.toLowerCase()))
          .map(a => ({ ...hits.get(a.alias.toLowerCase()), id: a.id }));
      }
      const foundSet = new Set(dbFound.map(r => r.alias.toLowerCase()));

      // 3) Remaining aliases are new
      const unmapped = unmappedByNlp.filter(a => !foundSet.has(a.alias.toLowerCase()));

      setMixedResults({ mapped, dbFound, unmapped });
      setMixedActiveTab(unmapped.length > 0 ? 'unmapped' : dbFound.length > 0 ? 'db' : 'mapped');
    } catch (e) {
      setMixedError(e.message);
    } finally {
      setMixedRunning(false);
    }
  };

  // Flags rows whose URN already exists in objectnames (urnExists) — used for row colouring
  const markExistingUrns = async (rowsArr) => {
    const urns = [...new Set(rowsArr.map(r => r.urn).filter(Boolean))];
    if (!urns.length) return rowsArr.map(r => ({ ...r, urnExists: false }));
    try {
      const res = await window.api.db.query(`SELECT urn FROM objectnames WHERE urn = ANY($1)`, [urns]);
      if (!res.ok) return rowsArr;
      const found = new Set(res.rows.map(x => x.urn));
      return rowsArr.map(r => ({ ...r, urnExists: found.has(r.urn) }));
    } catch { return rowsArr; }
  };
  const recheckMixedRowUrn = async (idx) => {
    const row = mixedAnnotated.find(r => r.idx === idx);
    if (!row) return;
    const [m] = await markExistingUrns([row]);
    setMixedAnnotated(prev => prev.map(r => r.idx === idx ? { ...r, urnExists: m.urnExists } : r));
  };

  const handleMixedAnnotateLlm = async () => {
    const allUnmapped = mixedResults?.unmapped || [];
    if (!allUnmapped.length) return;
    // Respect Settings → "Max LLM requests per day": total requests per day (one per alias), not per click
    const { limit: dailyLimit, used: usedToday, remaining } = await getLlmRemainingToday();
    if (remaining <= 0) {
      setMixedLlmMsg(`⚠ Daily LLM request limit reached (${usedToday}/${dailyLimit}). Increase it in Settings → LLM Connector.`);
      return;
    }
    // Annotate in batches: only aliases not annotated yet, at most "Number of rows" per click
    const existingRows = mixedAnnotated;
    const doneSet = new Set(existingRows.map(r => r.alias.toLowerCase()));
    const pending = allUnmapped.filter(a => !doneSet.has(a.alias.toLowerCase()));
    if (!pending.length) return;
    const perClick = Math.max(1, parseInt(mixedRowsPerClick) || 1);
    const unmapped = pending.slice(0, Math.min(perClick, remaining));
    const skipped = pending.length - unmapped.length;
    setMixedLlmRunning(true); setMixedLlmProg({ done: 0, total: unmapped.length }); setMixedLlmMsg(null); setMixedSubmitMsg(null);
    const ENTITY_TYPE_LIST = ['Protein','SmallMol','CellObject','Complex','CellProcesses','Virus','Tissue','Organism','Organ','Diseases','CellType','CellLineName','FunctionalClass','Treatment','ClinicalParameter','MedicalProcedure','GeneticVariant','Pathogen'];
    const rows = new Array(unmapped.length);
    let errCount = 0, firstErr = null, doneCount = 0, nextI = 0;
    const annotateOne = async (i) => {
      const { alias } = unmapped[i];
      const prompt = `You are a biomedical curation expert.\n\nAlias: "${alias}"\nOrganism context: ${mixedOrganism || 'Mammal'} (for "Mammal" assume Homo sapiens when searching NCBI)\n\nIdentify this biomedical entity and assign identifiers.\n\nEntity type options: ${ENTITY_TYPE_LIST.join(', ')}\n\nURN rules per type:\n- Protein: NCBI Entrez Gene ID → "urn:agi-llid:<GENE_ID>"; else UniProt → "urn:agi-gbprot:<ID>"; else "urn:agi-prot:<encodeURIComponent(name)>"\n- SmallMol: CAS → "urn:agi-cas:<CAS>"; else PubChem CID → "urn:agi-pccid:<CID>"; else "urn:agi-smol:<encodeURIComponent(name)>"\n- CellObject: exact GO cellular component → "urn:agi-gocellobj:GO:<GO_ID>"; else "urn:agi-cellobj:<encodeURIComponent(name)>"\n- Complex: exact GO cellular component → "urn:agi-gocomplex:GO:<GO_ID>"; else "urn:agi-complex:<encodeURIComponent(name)>"\n- CellProcesses: exact GO biological process → "urn:agi-gocellproc:GO:<GO_ID>"; else "urn:agi-cellproc:<encodeURIComponent(name)>"\n- Virus: NCBI Taxonomy ID → "urn:agi-taxid:<TAX_ID>"; else "urn:agi-virus:<encodeURIComponent(name)>"\n- Tissue: NCI Metathesaurus → "urn:agi-ncimorgan:<NCIM_ID>"; else "urn:agi-tissue:<encodeURIComponent(name)>"\n- Organism: NCBI Taxonomy ID → "urn:agi-taxid:<TAX_ID>"; else "urn:agi-organism:<encodeURIComponent(name)>"\n- Organ: NCI Metathesaurus → "urn:agi-ncimorgan:<NCIM_ID>"; else "urn:agi-organ:<encodeURIComponent(name)>"\n- Diseases: exact NCBI MeSH term → "urn:agi-disease:<encodeURIComponent(MeSH_name)>"; else "urn:agi-disease:<encodeURIComponent(name)>"\n- CellType: NCI Metathesaurus → "urn:agi-ncimorgan:<NCIM_ID>"; else "urn:agi-celltype:<encodeURIComponent(name)>"\n- CellLineName: "urn:agi-celllinename:<encodeURIComponent(name)>"\n- FunctionalClass: exact GO molecular function → "urn:agi-go:GO:<GO_ID>"; else "urn:agi-protfc:<encodeURIComponent(name)>"\n- Treatment: "urn:agi-treatment:<encodeURIComponent(name)>"\n- ClinicalParameter: "urn:agi-clnpar:<encodeURIComponent(name)>"\n- MedicalProcedure: "urn:agi-medproc:<encodeURIComponent(name)>"\n- GeneticVariant: "urn:agi-gv:<encodeURIComponent(name)>"\n- Pathogen: NCBI Taxonomy ID → "urn:agi-taxid:<TAX_ID>"; else "urn:agi-pathogen:<encodeURIComponent(name)>"\n\nIMPORTANT: Use encodeURIComponent() with lowercase name for fallback URNs. Do NOT hallucinate IDs.\n\nReturn ONLY valid JSON (no markdown):\n{\n  "entityType": "Protein",\n  "urn": "urn:agi-llid:1956",\n  "name": "EGFR",\n  "synonyms": ["Epidermal growth factor receptor", "HER1"],\n  "reasoning": "one sentence"\n}`;
      try {
        // Goes through the configured LLM connector (Settings → LLM Connector)
        const raw = await callLlm([{ role: 'user', content: prompt }], { fn: 'dict.mixedAnnotate', temperature: 0 });
        const m = String(raw || '').match(/\{[\s\S]*\}/);   // tolerate markdown fences / extra prose
        const parsed = JSON.parse(m ? m[0] : '');
        const et = ENTITY_TYPE_LIST.includes(parsed?.entityType) ? parsed.entityType : 'Protein';
        const dict = mixedDictFor(et);
        rows[i] = { idx: existingRows.length + i, alias, entityType: et, urn: parsed?.urn || buildEntityUrn(alias, et) || '', name: parsed?.name || alias, synonyms: (Array.isArray(parsed?.synonyms) ? parsed.synonyms : []).join('; '), dict, nlpId: null, urnExists: false };
      } catch (e) {
        errCount++; if (!firstErr) firstErr = e.message || String(e);
        const et = 'Protein';
        rows[i] = { idx: existingRows.length + i, alias, entityType: et, urn: buildEntityUrn(alias, et) || '', name: alias, synonyms: '', dict: 'curnames', nlpId: null, urnExists: false, llmFailed: true };
      }
      setMixedLlmProg({ done: ++doneCount, total: unmapped.length });
    };
    const worker = async () => { while (nextI < unmapped.length) await annotateOne(nextI++); };
    await Promise.all(Array.from({ length: Math.min(5, unmapped.length) }, worker));
    const markedRows = await markExistingUrns(rows);
    setMixedAnnotated([...existingRows, ...markedRows]);
    setMixedLlmRunning(false);
    const usedNow = usedToday + rows.length;
    setMixedLlmMsg(
      `✓ Annotated ${rows.length - errCount} of ${rows.length} alias${rows.length !== 1 ? 'es' : ''} (${existingRows.length + rows.length} total; ${skipped} still to annotate). LLM requests today: ${usedNow}/${dailyLimit}. Review and edit, then click Preview.` +
      (errCount ? ` ⚠ ${errCount} failed (defaulted to Protein): ${firstErr}` : '')
    );
  };

  const handleMixedPreview = async () => {
    setMixedSubmitMsg(null);
    const urns = mixedAnnotated.filter(r => r.dict !== 'ignore').map(r => r.urn).filter(Boolean);
    let urnToId = {};
    if (urns.length) {
      const res = await window.api.db.query(`SELECT medscan_id, urn FROM objectnames WHERE urn = ANY($1)`, [urns]);
      if (res.ok) { for (const row of res.rows) urnToId[row.urn] = Number(row.medscan_id); }
    }
    const newByRange = {};
    for (const row of mixedAnnotated) {
      if (row.dict === 'ignore') continue;
      if (urnToId[row.urn]) continue;
      const et = ENTITY_TYPES.find(e => e.rnef === row.entityType || e.display === row.entityType);
      if (!et) continue;
      const key = `${et.min}:${et.max}`;
      if (!newByRange[key]) newByRange[key] = { min: et.min, max: et.max, rows: [] };
      newByRange[key].rows.push(row);
    }
    const nextIds = {};
    for (const { min, max, rows: rangeRows } of Object.values(newByRange)) {
      const { ids: usedIds } = await getUsedIdsInRange(min, max);
      const gaps = usedIds ? findGapIds(usedIds, min, max, rangeRows.length) : [];
      rangeRows.forEach((r, i) => { nextIds[r.idx] = gaps[i] ?? null; });
    }
    setMixedAnnotated(prev => prev.map(r => r.dict === 'ignore'
      ? { ...r, urnExists: false, nlpId: null }
      : {
          ...r,
          urnExists: !!urnToId[r.urn],
          nlpId: urnToId[r.urn] || nextIds[r.idx] || null,
        }));
    setMixedSubmitMsg('✓ NLP IDs assigned. Review, then Submit.');
  };

  const handleMixedSubmit = async () => {
    const rows = mixedAnnotated.filter(r => r.nlpId && r.alias && r.dict !== 'ignore');
    if (!rows.length) { setMixedSubmitMsg('Run Preview first to assign NLP IDs.'); return; }
    setMixedSubmitting(true); setMixedSubmitMsg(null);
    try {
      const cartArr = mixedCartList.length ? mixedCartList : cartridges.map(c => c.name);
      // New aliases are added to ALL organisms by default — the list comes from the organisms_lookup table.
      const orgs = await getAllOrganisms();
      if (!orgs.length) orgs.push(mixedOrganism);
      let inserted = 0;

      // CASdictionary: ask for chemNames approval ONCE for all CAS aliases before writing anything
      // (the per-row addToCasDictionary calls below then find all tokens present).
      let chemTokensAdded = 0;
      const casAliases = rows
        .filter(r => (r.dict || 'curnames') === 'casdictionary')
        .flatMap(r => [r.alias, ...(r.synonyms || '').split(';').map(s => s.trim()).filter(Boolean)])
        .filter(a => !isShortAlias(a));   // short aliases go to ExactLiteral — never checked against chemNames
      if (casAliases.length) {
        const pre = await ensureChemNamesTokens(casAliases);
        if (!pre.ok) {
          if (pre.cancelled) { setMixedSubmitMsg('Cancelled — chemNames tokens were not approved; nothing was submitted.'); return; }
          throw new Error(pre.error);
        }
        chemTokensAdded = pre.tokensAdded;
      }

      for (const row of rows) {
        const msId = row.nlpId;
        const dict  = row.dict || 'curnames';
        const allAliases = [row.alias, ...(row.synonyms || '').split(';').map(s => s.trim()).filter(Boolean)];
        // Write Name + URN to objectnames: UPDATE if the record exists, otherwise INSERT.
        // (No ON CONFLICT target — it fails silently when medscan_id has no unique constraint.)
        const name = (row.name || row.alias || '').trim();
        const urn  = (row.urn || '').trim() || null;
        const upd = await window.api.db.query(
          `UPDATE objectnames SET name=$2, urn=$3, updated_at=NOW() WHERE medscan_id=$1`,
          [msId, name, urn]
        );
        if (!upd.ok) throw new Error(`objectnames update failed for ${msId}: ${upd.error}`);
        if (!upd.rowCount) {
          const ins = await window.api.db.query(
            `INSERT INTO objectnames (medscan_id, name, urn, cartridges, organisms, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
            [msId, name, urn, cartArr, orgs]
          );
          if (!ins.ok) throw new Error(`objectnames insert failed for ${msId}: ${ins.error}`);
        }
        for (const al of allAliases) {
          const isShort = isShortAlias(al);
          const tbl  = isShort ? 'exactliteral' : dict;
          const match = isShort ? 'l' : null;
          if (tbl === 'casdictionary') {
            const cr = await addToCasDictionary([{ msId, alias: al, match, cartridges: cartArr, organisms: orgs }]);
            if (!cr.ok) throw new Error(cr.cancelled ? `Adding "${al}" to CASdictionary was cancelled.` : cr.error);
            continue;
          }
          // tokenizeForTable / normalizeForTable load the xwords tables themselves. The old xwTokFor/xwNormFor
          // read xwords that only the file-import "Analyze" step loads — in the Mixed list flow they were EMPTY,
          // so aliases were stored without xwords filtering / separator splitting (e.g. "ih- 901", "c-k").
          const tokenized  = isShort ? al : await tokenizeForTable(al, tbl, match || '');
          const normalized = isShort ? exactLiteralTokenized(al, 'l') : await normalizeForTable(al, tbl, match || '');
          const ar = await window.api.db.query(
            `INSERT INTO "${tbl}" (medscan_id, alias, match, tokenized, normalized, cartridges, organisms, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) ON CONFLICT DO NOTHING`,
            [msId, al, match, tokenized, normalized, cartArr, orgs]
          );
          if (!ar.ok) throw new Error(`${tbl} insert failed for "${al}": ${ar.error}`);
        }
        inserted++;
      }
      // Remove processed rows (submitted + ignored) so the next "Annotate by LLM" click continues with the next batch
      const processed = new Set(mixedAnnotated.filter(r => r.dict === 'ignore' || (r.nlpId && r.alias)).map(r => r.alias.toLowerCase()));
      const nIgnored = mixedAnnotated.filter(r => r.dict === 'ignore').length;
      setMixedAnnotated(prev => prev.filter(r => !processed.has(r.alias.toLowerCase())).map((r, i) => ({ ...r, idx: i })));
      setMixedResults(prev => prev ? { ...prev, unmapped: prev.unmapped.filter(a => !processed.has(a.alias.toLowerCase())) } : prev);
      setMixedLlmMsg(null);
      setMixedSubmitMsg(`✓ Submitted ${inserted} record${inserted !== 1 ? 's' : ''} to database${nIgnored ? ` (${nIgnored} ignored)` : ''}${chemTokensAdded ? `; ${chemTokensAdded} missing chemNames token${chemTokensAdded !== 1 ? 's' : ''} added` : ''}. Click "Annotate by LLM" to process the next batch.`);
    } catch (e) {
      setMixedSubmitMsg(`Error: ${e.message}`);
    } finally {
      setMixedSubmitting(false);
    }
  };

  // ── Results view ────────────────────────────────────────────────────────────
  if (results) {
    const { newRecords, existingRecords, newAliases, manyNewAliases, mappedConflicts, conflicts } = results;
    const isRowResolved = (row, rowIdx) => {
      const dec = conflictDec[rowIdx] || {};
      // Option A: new record creation
      if (dec.__new__ === 'newRecord') return true;
      // Option B: per-ID decisions (all groups decided)
      const ids = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
      if (ids.length > 0 && ids.every(id => dec[id]) && ids.some(id => dec[id] !== 'ignore')) return true;
      // Option C: manual per-alias assignment (all unmapped aliases assigned)
      const ma = manualAssign[rowIdx];
      if (ma && row.unmapped.length > 0 && row.unmapped.every(m => ma[m.alias])) return true;
      return false;
    };
    const resolvedCount = conflicts.filter((row, rowIdx) => isRowResolved(row, rowIdx)).length;
    const anyResolved = resolvedCount > 0;
    const tabCounts = { new: newRecords.length, existing: existingRecords.length, newaliases: newAliases.length, manynewaliases: manyNewAliases.length, mappedconflicts: mappedConflicts.length, conflicts: conflicts.length };

    return (
      <div>
        {renderConfirmModal()}
        {renderFileIdPreviewModal()}
        {renderNrConfirmModal()}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn btn-secondary" onClick={() => { setResults(null); setSubmitMsg(null); setNoUrnRecords([]); }}>← Back</button>
          <button className="btn btn-secondary" onClick={handleAnalyze} disabled={analyzing} title="Re-run mapping against current database state">
            {analyzing ? <><span className="spinner" /> Refreshing…</> : '↺ Refresh'}
          </button>
          <span style={{ fontWeight: 600 }}>Mapping Results — {file.split(/[\\/]/).pop()}</span>
          {organism && <span className="text-muted" style={{ fontSize: 13 }}>Organism: {organism}</span>}
          <span className="text-muted" style={{ fontSize: 13 }}>
            {entityType === '__nlp_ids__' ? 'NLP IDs from file' : `Entity type: ${resolveEntityType(entityType)?.display ?? entityType}`}
          </span>
        </div>

        <BatchSubmitMsg msg={submitMsg} />

        <div style={{ marginBottom: 8 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={requireObjectNames} onChange={e => setRequireObjectNames(e.target.checked)} />
            Import only if ID exists in ObjectNames
          </label>
        </div>

        <div className="tabs">
          {[
            { key: 'new',             label: 'New Records' },
            { key: 'newaliases',      label: '≤ 50% new aliases' },
            { key: 'manynewaliases',  label: '> 50% new aliases' },
            { key: 'conflicts',       label: 'Conflicts' },
            { key: 'mappedconflicts', label: 'Mapped conflicts' },
            { key: 'existing',        label: 'Existing Records' },
          ].map(t => (
            <div key={t.key} className={`tab ${resultTab === t.key ? 'active' : ''}`} onClick={() => setResultTab(t.key)}>
              {t.label}{' '}
              {t.key === 'conflicts'
                ? <span style={{ whiteSpace: 'nowrap' }}>
                    ({tabCounts[t.key]},&nbsp;
                    <span style={{ color: resolvedCount > 0 ? 'var(--success, #2a7)' : 'var(--text-muted)' }}>
                      {resolvedCount} resolved
                    </span>)
                  </span>
                : `(${tabCounts[t.key]})`}
            </div>
          ))}
          <div className={`tab ${resultTab === 'remap' ? 'active' : ''}`} onClick={() => setResultTab('remap')}>
            Remapped records {remapRecords.length > 0 ? `(${remapRecords.length})` : ''}
          </div>
          {results?.casChemMissing?.length > 0 && (
            <div className={`tab ${resultTab === 'cas_chem_missing' ? 'active' : ''}`}
              onClick={() => setResultTab('cas_chem_missing')}>
              No token in chemNames ({results.casChemMissing.length})
            </div>
          )}
          {noUrnRecords.length > 0 && (
            <div className={`tab ${resultTab === 'no_urn' ? 'active' : ''}`}
              style={{ color: 'var(--danger, #e05)' }}
              onClick={() => setResultTab('no_urn')}>
              No URN records ({noUrnRecords.length})
            </div>
          )}
        </div>

        {/* ── New Records ── */}
        {resultTab === 'new' && (
          <div style={{ marginTop: 12 }}>
            {newRecords.length === 0 ? <div className="text-muted">No new records.</div> : (() => {
              const nrCheckedCount = newRecords.filter((_, i) => nrApprovals[i] !== false).length;
              const nrAllChecked   = nrCheckedCount === newRecords.length;
              // nrVisibleItems and nrRowClick are built after displayRows so that
              // shift-click ranges follow the sorted/filtered display order, not the original.
              return (<>
                <div style={{ marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; newRecords.forEach((_, i) => { a[i] = true; }); setNrApprovals(a);
                  }}>Select All</button>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; newRecords.forEach((_, i) => { a[i] = false; }); setNrApprovals(a);
                  }}>Deselect All</button>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                    Alias length &gt;=
                    <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                      value={minAliasLenNR} onChange={e => setMinAliasLenNR(Number(e.target.value))}>
                      <option value={0}>any</option>
                      {[2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  {nrSelected.size > 0 && (
                    <button className="btn btn-xs btn-secondary" onClick={() => toggleSelectedApprovals(nrSelected, nrApprovals, setNrApprovals)}>
                      Check/Uncheck {nrSelected.size} selected
                    </button>
                  )}
                  <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>{nrCheckedCount} of {newRecords.length} selected</span>
                  {minAliasLenNR > 0 && <span className="text-muted" style={{ fontSize: 12 }}>Showing {newRecords.filter(r => r.aliases.some(a => a.length >= minAliasLenNR)).length} of {newRecords.length} rows</span>}
                </div>
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="data-table">
                    {(() => {
                      // ── Sort helpers ────────────────────────────────────────
                      const nrSortHdr = (key, label, width) => {
                        const active = nrSortKey === key;
                        return (
                          <th style={{ width, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                            onClick={() => {
                              if (active) setNrSortDir(d => d === 'asc' ? 'desc' : 'asc');
                              else { setNrSortKey(key); setNrSortDir('asc'); }
                            }}>
                            {label} <span style={{ fontSize: 10, opacity: active ? 1 : 0.35 }}>
                              {active ? (nrSortDir === 'asc' ? '▲' : '▼') : '⇅'}
                            </span>
                          </th>
                        );
                      };
                      // helper: effective match flag for a single alias
                      const getEffMf = (row, a) => {
                        const fileMf = row._aliasMatchMap?.get(a);
                        return fileMf !== undefined ? fileMf : (elMatchFlag === '__from_file__' ? '' : elMatchFlag);
                      };
                      const rowMatchLabel = (row) => {
                        if (targetTable !== 'exactliteral') return '';
                        return [...new Set(row.aliases.map(a => getEffMf(row, a)))].join(',');
                      };
                      // per-row derived values used for both sorting and rendering
                      const lenOk = (a) => minAliasLenNR === 0 || a.length >= minAliasLenNR;
                      const withDerived = newRecords.map((row, i) => {
                        const et       = resolveEntityTypeFromId(row.previewId);
                        const crossSet = new Set((row.crossOrgAliases || []).map(x => x.alias));
                        const newAls   = row.aliases.filter(a => !crossSet.has(a) && lenOk(a));
                        const xoAls    = (row.crossOrgAliases || []).filter(x => lenOk(x.alias));
                        const dbIds      = [...new Set(xoAls.map(x => x.dbMsId))];
                        const total      = newAls.length + xoAls.length;
                        const overlapPct = total > 0 ? (xoAls.length / total) * 100 : 0;
                        return { row, i, et, crossSet, newAls, xoAls, dbIds, overlapPct };
                      });
                      let displayRows = withDerived
                        .filter(({ newAls, xoAls }) => newAls.length > 0 || xoAls.length > 0);
                      if (nrSortKey) {
                        displayRows = [...displayRows].sort((a, b) => {
                          let va, vb;
                          switch (nrSortKey) {
                            case 'id':              va = a.row.previewId ?? 0;             vb = b.row.previewId ?? 0;             break;
                            case 'entityType':      va = (a.et?.rnef ?? '').toLowerCase(); vb = (b.et?.rnef ?? '').toLowerCase(); break;
                            case 'name':            va = (a.row.name ?? '').toLowerCase(); vb = (b.row.name ?? '').toLowerCase(); break;
                            case 'match':           va = rowMatchLabel(a.row);             vb = rowMatchLabel(b.row);             break;
                            case 'newAliasCount':   va = a.newAls.length;                  vb = b.newAls.length;                  break;
                            case 'existingCount':   va = a.xoAls.length;                   vb = b.xoAls.length;                   break;
                            case 'overlapPct':      va = a.overlapPct;                     vb = b.overlapPct;                     break;
                            case 'dbId':            va = a.dbIds[0] ?? 0;                  vb = b.dbIds[0] ?? 0;                  break;
                            default:                return 0;
                          }
                          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                          return nrSortDir === 'asc' ? cmp : -cmp;
                        });
                      }
                      const nrVisibleItems = displayRows.map((d, visIdx) => ({ row: d.row, i: d.i }));
                      const nrRowClick = makeRowClickHandler(nrVisibleItems, nrSelected, setNrSelected, nrLastClick);
                      return (<>
                        <thead><tr>
                          <th style={{ width: 32 }}>
                            <input type="checkbox" checked={nrAllChecked} onChange={e => {
                              const a = {}; newRecords.forEach((_, i) => { a[i] = e.target.checked; }); setNrApprovals(a);
                            }} />
                          </th>
                          {nrSortHdr('id', entityType === '__nlp_ids__' ? 'NLP ID (from file)' : 'New NLP ID', 130)}
                          {nrSortHdr('entityType', 'Entity type', 140)}
                          {nrSortHdr('name', 'Name', 220)}
                          {targetTable === 'exactliteral' && nrSortHdr('match', 'Match', 80)}
                          {nrSortHdr('newAliasCount', 'New aliases', null)}
                          {nrSortHdr('existingCount', 'Existing aliases (other organism)', null)}
                          {nrSortHdr('overlapPct', 'Overlap%', 80)}
                          {nrSortHdr('dbId', 'DB NLP ID', 110)}
                        </tr></thead>
                        <tbody>
                          {displayRows.map(({ row, i, et, newAls, xoAls, dbIds, overlapPct }, displayIdx) => {
                            const checked    = nrApprovals[i] !== false;
                            const isSel      = nrSelected.has(i);
                            const matchLabel = rowMatchLabel(row);
                            return (
                              <tr key={i}
                                onClick={e => nrRowClick(e, displayIdx)}
                                style={{ opacity: checked ? 1 : 0.45, cursor: 'pointer',
                                  background: isSel ? 'var(--selection, rgba(100,150,255,0.25))' : undefined }}>
                                <td>
                                  <input type="checkbox" checked={checked} onChange={e =>
                                    setNrApprovals(prev => ({ ...prev, [i]: e.target.checked }))
                                  } />
                                </td>
                                <td className="mono" title={row._reusePreview ? 'ID from file — will be reused' : 'Provisional ID'}>
                                  {row.previewId?.toLocaleString()}
                                  {row._reusePreview && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--success, #2a9)' }}>✓</span>}
                                </td>
                                <td style={{ fontSize: 12 }}>{et ? et.rnef : <span className="text-muted">—</span>}</td>
                                <td>{row.name}</td>
                                {targetTable === 'exactliteral' && (
                                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: matchLabel ? 'var(--text)' : 'var(--text-muted)' }}>
                                    {matchLabel || <span style={{ fontSize: 10 }}>(none)</span>}
                                  </td>
                                )}
                                <td style={{ fontSize: 12 }}>
                                  {newAls.length
                                    ? <span style={{ color: '#7ec8a0' }}>{newAls.join('; ')}</span>
                                    : <span className="text-muted">—</span>}
                                </td>
                                <td style={{ fontSize: 12 }}>
                                  {xoAls.length
                                    ? <span style={{ color: 'var(--warning, #c8a92a)' }}>{xoAls.map(x => x.alias).join('; ')}</span>
                                    : <span className="text-muted">—</span>}
                                </td>
                                <td style={{ fontSize: 12, textAlign: 'right', paddingRight: 8,
                                  color: overlapPct === 0 ? 'var(--text-muted)' : overlapPct === 100 ? 'var(--warning, #c8a92a)' : 'var(--text)' }}>
                                  {overlapPct === 0 ? '—' : `${Math.round(overlapPct)}%`}
                                </td>
                                <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                                  {dbIds.length
                                    ? <button className="link-btn mono"
                                        onClick={e => { e.stopPropagation(); onEditRecord?.(dbIds.length === 1 ? dbIds[0] : dbIds); }}
                                        title="Open all in Edit Record">
                                        {dbIds.map(id => id.toLocaleString()).join(', ')}
                                      </button>
                                    : <span className="text-muted">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </>);
                    })()}
                  </table>
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button className="btn btn-success" disabled={submitting || nrCheckedCount === 0}
                    onClick={() => {
                      const checked = newRecords.filter((_, i) => nrApprovals[i] !== false);
                      let aliasCount = 0, recordCount = 0;
                      for (const r of checked) {
                        const crossSet = new Set((r.crossOrgAliases || []).map(x => x.alias));
                        const newAls = r.aliases.filter(a => !crossSet.has(a));
                        if (newAls.length > 0) { aliasCount += newAls.length; recordCount++; }
                      }
                      setNrConfirm({ mode: 'new_only', aliasCount, recordCount });
                    }}>
                    {submitting ? <><span className="spinner" /> Importing…</> : '⬆ Submit as new records'}
                  </button>
                  <button className="btn btn-primary" disabled={submitting || nrCheckedCount === 0}
                    onClick={() => {
                      const checked = newRecords.filter((_, i) => nrApprovals[i] !== false);
                      let newAliasCount = 0, existingAliasCount = 0, conflictCount = 0;
                      for (const r of checked) {
                        const crossSet = new Set((r.crossOrgAliases || []).map(x => x.alias));
                        newAliasCount      += r.aliases.filter(a => !crossSet.has(a)).length;
                        existingAliasCount += (r.crossOrgAliases || []).length;
                        const dbIds = [...new Set((r.crossOrgAliases || []).map(x => x.dbMsId))];
                        if (dbIds.length > 1) conflictCount++;
                      }
                      setNrConfirm({ mode: 'all', newAliasCount, existingAliasCount, conflictCount, recordCount: checked.length });
                    }}>
                    ⬆ Add to existing record
                  </button>
                  <button className="btn btn-secondary" onClick={exportNewRecords}>⬇ Export TSV</button>
                  <span className="text-xs text-muted">IDs shown are provisional; final IDs assigned at import time.</span>
                </div>
              </>);
            })()}
          </div>
        )}

        {/* ── Mapped Conflicts ── */}
        {resultTab === 'mappedconflicts' && (
          <div style={{ marginTop: 12 }}>
            {mappedConflicts.length === 0 ? <div className="text-muted">No mapped conflicts.</div> : (<>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={onlySameTypeMC} onChange={e => setOnlySameTypeMC(e.target.checked)} />
                  Same type matches only
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Allowed match length ≥
                  <input type="number" min={0} className="form-control"
                    style={{ width: 60, padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minAliasLenMC || ''}
                    placeholder="any"
                    onChange={e => setMinAliasLenMC(Math.max(0, Number(e.target.value) || 0))} />
                </label>
                {(onlySameTypeMC || minAliasLenMC > 0) && (() => {
                  const vis = mappedConflicts.filter(row => {
                    if (onlySameTypeMC) {
                      const inputRnef = getInputEtRnef(row);
                      if (inputRnef) {
                        const ids = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
                        if (!ids.every(id => resolveEntityTypeFromId(Number(id))?.rnef === inputRnef)) return false;
                      }
                    }
                    if (minAliasLenMC > 0) {
                      const longMapped = row.mapped.filter(m => m.alias.length >= minAliasLenMC);
                      const remainingIds = new Set(longMapped.map(m => String(m.hit.dup.medscan_id)));
                      if (remainingIds.size < 2) return false;
                    }
                    return true;
                  }).length;
                  return <span className="text-muted" style={{ fontSize: 12 }}>Showing {vis} of {mappedConflicts.length} rows</span>;
                })()}
                <button className="btn btn-secondary btn-sm" onClick={exportMappedConflicts}>⬇ Export TSV</button>
              </div>
              <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
                <table className="data-table" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 200, position: 'sticky', top: 0, zIndex: 3,
                                    background: 'var(--surface-3, #2a2d3e)', color: 'var(--text)' }}>Name</th>
                      <th style={{ position: 'sticky', top: 0, zIndex: 3,
                                   background: 'var(--surface-3, #2a2d3e)', color: 'var(--text)' }}>Mapped aliases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappedConflicts.map((row, rowIdx) => {
                      if (onlySameTypeMC) {
                        const inputRnef = getInputEtRnef(row);
                        if (inputRnef) {
                          const ids = [...new Set(row.mapped.map(m => String(m.hit.dup.medscan_id)))];
                          if (!ids.every(id => resolveEntityTypeFromId(Number(id))?.rnef === inputRnef)) return null;
                        }
                      }
                      if (minAliasLenMC > 0) {
                        // Keep only aliases that meet the length threshold, then check if a real conflict remains
                        const longMapped = row.mapped.filter(m => m.alias.length >= minAliasLenMC);
                        const remainingIds = new Set(longMapped.map(m => String(m.hit.dup.medscan_id)));
                        // Hide if no long aliases exist, or all long aliases point to the same single ID (no real conflict)
                        if (remainingIds.size < 2) return null;
                      }
                      const isExp = conflictExp.has(`mc_${rowIdx}`);
                      const accentColors = ['rgba(80,120,200,0.18)', 'rgba(80,170,120,0.18)', 'rgba(200,140,80,0.18)'];
                      const rowBg = accentColors[rowIdx % accentColors.length];
                      const idGroups = {};
                      for (const m of row.mapped) {
                        const key = String(m.hit.dup.medscan_id);
                        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, aliases: [], hit: m.hit };
                        idGroups[key].aliases.push(m.alias);
                      }
                      const groups = Object.values(idGroups);
                      const N = groups.length;
                      return (
                        <React.Fragment key={rowIdx}>
                          <tr style={{ background: rowBg }}>
                            <td>{row.name}</td>
                            <td style={{ fontSize: 12 }}>
                              <button className="btn btn-secondary btn-sm"
                                onClick={async () => {
                                  setConflictExp(s => {
                                    const next = new Set(s);
                                    next.has(`mc_${rowIdx}`) ? next.delete(`mc_${rowIdx}`) : next.add(`mc_${rowIdx}`);
                                    return next;
                                  });
                                  // Fetch alias counts for all matched IDs in this row (lazy, cached)
                                  const ids = [...new Set(row.mapped.map(m => m.hit.dup.medscan_id))];
                                  const uncached = ids.filter(id => aliasCountCache[id] === undefined);
                                  if (uncached.length > 0) {
                                    const counts = await Promise.all(uncached.map(async id => {
                                      const res = await window.api.db.query(
                                        `SELECT SUM(cnt) AS total FROM (
                                           SELECT COUNT(*) AS cnt FROM curnames       WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM exactliteral  WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM celldictionary WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM casdictionary  WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM keywords        WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM userdict        WHERE medscan_id = $1
                                           UNION ALL SELECT COUNT(*) FROM combnames       WHERE medscan_id = $1
                                         ) t`,
                                        [id]
                                      );
                                      return [id, res.ok ? Number(res.rows[0]?.total ?? 0) : 0];
                                    }));
                                    setAliasCountCache(c => ({ ...c, ...Object.fromEntries(counts) }));
                                  }
                                }}>
                                {N} conflict{N !== 1 ? 's' : ''} {isExp ? '▲' : '▼'}
                              </button>
                            </td>
                          </tr>
                          {isExp && (
                            <tr style={{ background: rowBg }}>
                              <td colSpan={2} style={{ padding: '8px 12px' }}>
                                <table className="data-table" style={{ fontSize: 12 }}>
                                  <thead>
                                    <tr>
                                      <th>Matched aliases</th>
                                      <th>
                                        <button className="link-btn" title="Open all matched records in Edit Record"
                                          onClick={() => onEditRecord?.(groups.map(g => g.id))}
                                          style={{ fontWeight: 600, fontSize: 'inherit' }}>
                                          Match NLP ID ↗
                                        </button>
                                      </th>
                                      <th>Existing record has</th>
                                      <th>Record name</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.map((g, gi) => (
                                      <tr key={gi}>
                                        <td>{g.aliases.join('; ')}</td>
                                        <td className="mono">
                                          <button className="link-btn mono" onClick={() => onEditRecord?.(g.id)}>
                                            {g.id}
                                          </button>
                                        </td>
                                        <td style={{ whiteSpace: 'nowrap' }}>
                                          {aliasCountCache[g.id] !== undefined
                                            ? `${aliasCountCache[g.id]} aliases`
                                            : <span className="text-muted" onClick={async () => {
                                                const res = await window.api.db.query(
                                                  `SELECT SUM(cnt) AS total FROM (
                                                     SELECT COUNT(*) AS cnt FROM curnames WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM exactliteral WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM celldictionary WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM casdictionary WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM keywords WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM userdict WHERE medscan_id=$1
                                                     UNION ALL SELECT COUNT(*) FROM combnames WHERE medscan_id=$1
                                                   ) t`, [g.id]
                                                );
                                                if (res.ok) setAliasCountCache(c => ({ ...c, [g.id]: Number(res.rows[0]?.total ?? 0) }));
                                              }} style={{ cursor: 'pointer' }}>…</span>}
                                        </td>
                                        <td>
                                          <button className="link-btn" title={g.hit.dup.alias} onClick={() => onEditRecord?.(g.id)}>
                                            {onCache[g.id] ?? g.hit.dup.alias}
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>)}
          </div>
        )}

        {/* ── Existing Records ── */}
        {resultTab === 'existing' && (
          <div style={{ marginTop: 12 }}>
            {existingRecords.length === 0 ? <div className="text-muted">No fully-matched existing records.</div> : (() => {
              const erCheckedCount = existingRecords.filter((_, i) => erApprovals[i] !== false).length;
              const erAllChecked   = erCheckedCount === existingRecords.length;
              const erVisibleItems = existingRecords.map((row, i) => ({ row, i }));
              const erRowClick = makeRowClickHandler(erVisibleItems, erSelected, setErSelected, erLastClick);
              return (<>
                <div style={{ marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; existingRecords.forEach((_, i) => { a[i] = true; }); setErApprovals(a);
                  }}>Select All</button>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; existingRecords.forEach((_, i) => { a[i] = false; }); setErApprovals(a);
                  }}>Deselect All</button>
                  {erSelected.size > 0 && (
                    <button className="btn btn-xs btn-secondary"
                      onClick={() => toggleSelectedApprovals(erSelected, erApprovals, setErApprovals)}>
                      Check/Uncheck {erSelected.size} selected
                    </button>
                  )}
                  <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>{erCheckedCount} of {existingRecords.length} selected</span>
                </div>
                <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={handleAddOrganism} disabled={submitting || !organism || erCheckedCount === 0}>
                    {submitting ? <><span className="spinner" /> Updating…</> : `＋ Add organism "${organism || '—'}" to ${erCheckedCount} record${erCheckedCount !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn btn-secondary" onClick={exportExistingRecords}>⬇ Export TSV</button>
                  {addOrgMsg && (
                    <span style={{ fontSize: 12, color: addOrgMsg.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
                      {addOrgMsg.text}
                    </span>
                  )}
                  {entityType === '__nlp_ids__' && (
                    <button className="btn btn-secondary" style={{ marginLeft: 'auto' }}
                      onClick={() => previewFileIdSubmit(
                        existingRecords.filter((r, i) => erApprovals[i] !== false && r._flatId != null && r._flatId !== r.matchedId).map(r => ({ id: r._flatId, aliases: r.aliases })),
                        handleImportExistingWithFileId
                      )}
                      disabled={submitting || existingRecords.every((r, i) => erApprovals[i] === false || r._flatId == null || r._flatId === r.matchedId)}>
                      ⬆ Import using ID in file
                    </button>
                  )}
                </div>
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="data-table">
                    <thead><tr>
                      <th style={{ width: 32 }}>
                        <input type="checkbox" checked={erAllChecked} onChange={e => {
                          const a = {}; existingRecords.forEach((_, i) => { a[i] = e.target.checked; }); setErApprovals(a);
                        }} />
                      </th>
                      <th style={{ width: 130 }}>Matched NLP ID</th>
                      {entityType === '__nlp_ids__' && <th style={{ width: 130 }}>NLP ID in file</th>}
                      <th style={{ width: 140 }}>Entity type</th>
                      <th style={{ width: 220 }}>Name</th>
                      <th>Aliases</th>
                    </tr></thead>
                    <tbody>
                      {existingRecords.map((row, i) => {
                        const et      = resolveEntityTypeFromId(row.matchedId);
                        const checked = erApprovals[i] !== false;
                        const isSel   = erSelected.has(i);
                        return (
                          <tr key={i}
                            onClick={e => erRowClick(e, i)}
                            style={{ opacity: checked ? 1 : 0.45, cursor: 'pointer',
                              background: isSel ? 'var(--selection, rgba(100,150,255,0.25))' : undefined }}>
                            <td>
                              <input type="checkbox" checked={checked} onChange={e =>
                                setErApprovals(prev => ({ ...prev, [i]: e.target.checked }))
                              } />
                            </td>
                            <td className="mono">
                              <button className="link-btn mono" onClick={e => { e.stopPropagation(); onEditRecord?.(row.matchedId); }}>
                                {row.matchedId?.toLocaleString()}
                              </button>
                            </td>
                            {entityType === '__nlp_ids__' && (
                              <td className="mono" style={{ color: row._flatId !== row.matchedId ? 'var(--warning, #e8a000)' : undefined }}>
                                {row._flatId != null ? row._flatId.toLocaleString() : <span className="text-muted">—</span>}
                              </td>
                            )}
                            <td style={{ fontSize: 12 }}>{et ? et.rnef : <span className="text-muted">—</span>}</td>
                            <td>{row.name}</td>
                            <td style={{ fontSize: 12 }}>{row.aliases.join('; ')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>);
            })()}
          </div>
        )}

        {/* ── Remap ── */}
        {resultTab === 'remap' && (
          <div style={{ marginTop: 12 }}>
            {remapRecords.length === 0 ? <div className="text-muted">No remapped records.</div> : (() => {
              const rmCheckedCount = remapRecords.filter((_, i) => remapApprovals[i] !== false).length;
              const rmAllChecked   = rmCheckedCount === remapRecords.length;
              const rmVisibleItems = remapRecords.map((row, i) => ({ row, i }));
              const rmRowClick = makeRowClickHandler(rmVisibleItems, rmSelected, setRmSelected, rmLastClick);
              return (<>
                <div className="alert alert-info" style={{ marginBottom: 10 }}>
                  These records could not reuse their original IDs (already existed in DB). New gap IDs were assigned.
                  Review and submit the ones you want to import.
                </div>
                <div style={{ marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; remapRecords.forEach((_, i) => { a[i] = true; }); setRemapApprovals(a);
                  }}>Select All</button>
                  <button className="btn btn-xs btn-secondary" onClick={() => {
                    const a = {}; remapRecords.forEach((_, i) => { a[i] = false; }); setRemapApprovals(a);
                  }}>Deselect All</button>
                  {rmSelected.size > 0 && (
                    <button className="btn btn-xs btn-secondary" onClick={() => toggleSelectedApprovals(rmSelected, remapApprovals, setRemapApprovals)}>
                      Check/Uncheck {rmSelected.size} selected
                    </button>
                  )}
                  <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>{rmCheckedCount} of {remapRecords.length} selected</span>
                </div>
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="data-table">
                    <thead><tr>
                      <th style={{ width: 32 }}>
                        <input type="checkbox" checked={rmAllChecked} onChange={e => {
                          const a = {}; remapRecords.forEach((_, i) => { a[i] = e.target.checked; }); setRemapApprovals(a);
                        }} />
                      </th>
                      <th style={{ width: 130 }}>Original NLP ID</th>
                      <th style={{ width: 130 }}>New NLP ID</th>
                      <th style={{ width: 220 }}>Name</th>
                      <th>Aliases</th>
                    </tr></thead>
                    <tbody>
                      {rmVisibleItems.map(({ row: r, i }, visIdx) => {
                        const checked = remapApprovals[i] !== false;
                        const isSel   = rmSelected.has(i);
                        return (
                          <tr key={i}
                            onClick={e => rmRowClick(e, visIdx)}
                            style={{ opacity: checked ? 1 : 0.45, cursor: 'pointer',
                                     background: isSel ? 'var(--row-selected, rgba(99,102,241,0.18))' : undefined }}>
                            <td>
                              <input type="checkbox" checked={checked} onChange={e =>
                                setRemapApprovals(prev => ({ ...prev, [i]: e.target.checked }))
                              } />
                            </td>
                            <td className="mono">{r.origId?.toLocaleString()}</td>
                            <td className="mono">{r.newId?.toLocaleString()}</td>
                            <td>{r.name}</td>
                            <td style={{ fontSize: 12 }}>{r.aliases.join('; ')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={handleSubmitRemapped} disabled={submitting || rmCheckedCount === 0}>
                    {submitting ? <><span className="spinner" /> Importing…</> : `⬆ Submit ${rmCheckedCount} Remapped Record${rmCheckedCount !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn btn-secondary" onClick={() => {
                    downloadTsv(
                      'new_records_remap.tsv',
                      ['Original NLP ID', 'New NLP ID', 'Name', 'Aliases'],
                      remapRecords.map(r => [r.origId, r.newId, r.name, r.aliases.join('; ')])
                    );
                  }}>⬇ Export TSV</button>
                  <button className="btn btn-secondary" style={{ marginLeft: 'auto' }}
                    disabled={submitting || rmCheckedCount === 0 || entityType !== '__nlp_ids__'}
                    title={entityType !== '__nlp_ids__' ? 'Only available when "Valid NLP IDs in file" is selected' : 'Import aliases under the original ID from the file, skipping any records whose original ID is not in ObjectNames'}
                    onClick={() => {
                      const approved = remapRecords.map((row, i) => ({ row, i })).filter(({ i }) => remapApprovals[i] !== false);
                      const toProcess = approved.map(({ row }) => ({ id: row.origId, aliases: row.aliases }));
                      previewFileIdSubmit(toProcess, handleSubmitRemappedWithFileId);
                    }}>
                    ⬆ Submit with ID in file
                  </button>
                </div>
              </>);
            })()}
          </div>
        )}

        {/* ── No token in chemNames ── */}
        {resultTab === 'cas_chem_missing' && results?.casChemMissing?.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="alert alert-warning" style={{ marginBottom: 10 }}>
              These records have aliases whose tokens are missing from chemNames. Without those tokens, the CASdictionary alias cannot be matched by NLP.
            </div>
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn btn-primary" onClick={handleSubmitCasChemMissing}
                disabled={casChemImporting}>
                {casChemImporting
                  ? <><span className="spinner" /> Importing…</>
                  : `⬆ Import to CASDictionary/Update chemNames (${results.casChemMissing.length})`}
              </button>
              {casChemImportMsg && (
                <span style={{ fontSize: 12, color: casChemImportMsg.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
                  {casChemImportMsg.text}
                </span>
              )}
            </div>
            <div className="table-wrap" style={{ maxHeight: 440 }}>
              <table className="data-table">
                <thead><tr>
                  <th>Name</th>
                  <th>Alias</th>
                  <th>Missing tokens</th>
                </tr></thead>
                <tbody>
                  {results.casChemMissing.flatMap((entry, i) =>
                    entry.aliasMissing.map((am, j) => (
                      <tr key={`${i}-${j}`}>
                        {j === 0 && <td rowSpan={entry.aliasMissing.length} style={{ verticalAlign: 'top' }}>{entry.row.name}</td>}
                        <td style={{ fontWeight: 500 }}>{am.alias}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{am.missingTokens.join(', ')}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── No URN Records ── */}
        {resultTab === 'no_urn' && noUrnRecords.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="alert alert-danger" style={{ marginBottom: 10 }}>
              These records could not be imported because their NLP ID has no corresponding Name and URN in the ObjectNames table.
              They accumulate across all submit operations in this session. Use "← Back" to clear.
            </div>
            <div style={{ marginBottom: 8, display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => {
                downloadTsv(
                  'no_urn_records.tsv',
                  ['Name', 'NLP ID', 'Aliases', 'Source'],
                  noUrnRecords.map(r => [r.name, r.id, r.aliases, r.source])
                );
              }}>⬇ Export TSV</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setNoUrnRecords([])}>✕ Clear</button>
            </div>
            <div className="table-wrap" style={{ maxHeight: 480, overflowY: 'auto' }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>NLP ID</th>
                    <th>Aliases (incoming)</th>
                    <th>Source tab</th>
                  </tr>
                </thead>
                <tbody>
                  {noUrnRecords.map((r, i) => (
                    <tr key={i}>
                      <td style={{ maxWidth: 220, wordBreak: 'break-word' }}>{r.name}</td>
                      <td className="mono">
                        <button className="link-btn mono" onClick={() => onEditRecord?.(r.id)}>
                          {r.id}
                        </button>
                      </td>
                      <td style={{ maxWidth: 480, wordBreak: 'break-word', color: 'var(--text-muted)' }}>{r.aliases}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11 }}>{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── New Aliases ── */}
        {resultTab === 'newaliases' && (
          <div style={{ marginTop: 12 }}>
            {newAliases.length === 0 ? <div className="text-muted">No partial-match records.</div> : (() => {
              const visibleNA = applySort(
                newAliases.map((row, i) => ({ row, i })).filter(({ row }) => isVisibleNA(row)),
                naSort
              );
              const naSortToggle = makeSortToggle(setNaSort);
              const naRowClick = makeRowClickHandler(visibleNA, naSelected, setNaSelected, naLastClick);
              return (<>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={onlySameTypeNA} onChange={e => {
                    setOnlySameTypeNA(e.target.checked);
                    if (e.target.checked) {
                      // Uncheck all, then check only same-type rows that pass other filters
                      const newAppr = {};
                      newAliases.forEach((row, i) => {
                        const sameType   = isSameType(row);
                        const sameId     = !onlySameIdNA || Number(row._flatId) === Number(row.matchedId);
                        const passLen    = minAliasLenNA === 0 || row.newAliasesForRow.some(a => a.length >= minAliasLenNA);
                        const passMatch  = minMatchLenNA === 0 || row.matchedAliases.some(a => a.length >= minMatchLenNA);
                        newAppr[i] = sameType && sameId && passLen && passMatch;
                      });
                      setNaApprovals(newAppr);
                      setNaSelected(new Set());
                    }
                  }} />
                  Only same type matches
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={onlySameIdNA} onChange={e => {
                    setOnlySameIdNA(e.target.checked);
                    if (e.target.checked) {
                      // Auto-check rows where file ID === matched DB ID (and pass other filters)
                      const newAppr = {};
                      newAliases.forEach((row, i) => {
                        const sameId    = Number(row._flatId) === Number(row.matchedId);
                        const sameType  = !onlySameTypeNA || isSameType(row);
                        const passLen   = minAliasLenNA === 0 || row.newAliasesForRow.some(a => a.length >= minAliasLenNA);
                        const passMatch = minMatchLenNA === 0 || row.matchedAliases.some(a => a.length >= minMatchLenNA);
                        newAppr[i] = sameId && sameType && passLen && passMatch;
                      });
                      setNaApprovals(newAppr);
                      setNaSelected(new Set());
                    }
                  }} />
                  Only same ID matches
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Alias length &gt;=
                  <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minAliasLenNA} onChange={e => setMinAliasLenNA(Number(e.target.value))}>
                    <option value={0}>any</option>
                    {[2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Allowed match length ≥
                  <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minMatchLenNA} onChange={e => setMinMatchLenNA(Number(e.target.value))}>
                    <option value={0}>any</option>
                    {[3,4,5,6,7].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                {naSelected.size > 0 && (
                  <button className="btn btn-xs btn-secondary" onClick={() => toggleSelectedApprovals(naSelected, naApprovals, setNaApprovals)}>
                    Check/Uncheck {naSelected.size} selected
                  </button>
                )}
                {(onlySameTypeNA || onlySameIdNA || minAliasLenNA > 0 || minMatchLenNA > 0) && <span className="text-muted" style={{ fontSize: 12 }}>Showing {visibleNA.length} of {newAliases.length} rows</span>}
              </div>
              <div className="table-wrap" style={{ maxHeight: 420 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32, textAlign: 'center' }}>
                        <input type="checkbox" title="Select all"
                          checked={visibleNA.length > 0 && visibleNA.every(({ i }) => naApprovals[i] !== false)}
                          onChange={e => { const a = { ...naApprovals }; visibleNA.forEach(({ i }) => { a[i] = e.target.checked; }); setNaApprovals(a); }}
                        />
                      </th>
                      <SortTh col="mappedId" sort={naSort} onSort={naSortToggle} style={{ width: 130 }}>Mapped ID</SortTh>
                      <SortTh col="flatId"   sort={naSort} onSort={naSortToggle} style={{ width: 110 }}>ID in file</SortTh>
                      <SortTh col="entityType" sort={naSort} onSort={naSortToggle} style={{ width: 140 }}>Entity type</SortTh>
                      <th style={{ width: 180 }}>Name in File</th>
                      <th style={{ width: 180 }}>Record name</th>
                      <th>Matched aliases</th>
                      <th>New aliases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleNA.map(({ row, i }, visIdx) => {
                      const et    = resolveEntityTypeFromId(row.matchedId);
                      const isSel = naSelected.has(i);
                      return (
                      <tr key={i}
                        onClick={e => naRowClick(e, visIdx)}
                        style={{ cursor: 'pointer', background: isSel ? 'var(--selection, rgba(100,150,255,0.25))' : undefined }}>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox"
                            checked={naApprovals[i] !== false}
                            onChange={e => setNaApprovals(a => ({ ...a, [i]: e.target.checked }))}
                          />
                        </td>
                        <td className="mono">
                          <button className="link-btn mono" onClick={() => onEditRecord?.(row.matchedId)}>
                            {row.matchedId?.toLocaleString()}
                          </button>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{row._flatId != null ? row._flatId : <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12 }}>{et ? et.rnef : <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12 }}>{row.name}</td>
                        <td style={{ fontSize: 12 }}>{onCache[row.matchedId] ?? <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12, color: 'var(--danger, #e05)' }}>{row.matchedAliases.join('; ')}</td>
                        <td style={{ fontSize: 12, color: '#7ec8a0' }}>
                          {(minAliasLenNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenNA) : row.newAliasesForRow).join('; ')}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10, flex: 1 }}>
                  <button className="btn btn-primary" disabled={submitting}
                    onClick={() => { const { aliases, rows } = countNA(); confirmThen('matched', aliases, rows, naCriteria(), handleSubmitNewAliases); }}>
                    {submitting ? <><span className="spinner" /> Importing…</> : `⬆ Submit ${newAliases.filter((_, i) => naApprovals[i] !== false).length} Approved Rows`}
                  </button>
                  <button className="btn btn-secondary" onClick={exportNewAliases}>⬇ Export TSV</button>
                </div>
                <button className="btn btn-success" style={{ flexShrink: 0 }}
                  disabled={submitting}
                  title="Create a new NLP record for each approved row, ignoring the matched ID"
                  onClick={() => { const { aliases, rows } = countNA(); confirmThen('new', aliases, rows, [], () => handleSubmitAsNewRecords('newAliases', results.newAliases, setResults, naApprovals, setNaApprovals, setNaSelected, isVisibleNA, minAliasLenNA)); }}>
                  ⬆ Submit as new records
                </button>
                <div style={{ display: 'flex', gap: 10, flex: 1, justifyContent: 'flex-end' }}>
                  <button className="btn btn-secondary"
                    disabled={submitting || entityType !== '__nlp_ids__'}
                    title={entityType !== '__nlp_ids__' ? 'Only available when "Valid NLP IDs in file" is selected' : 'Import aliases under the ID specified in the input file'}
                    onClick={() => {
                      const toProcess = [];
                      for (let i = 0; i < results.newAliases.length; i++) {
                        if (naApprovals[i] === false) continue;
                        const row = results.newAliases[i];
                        if (!isVisibleNA(row) || row._flatId == null) continue;
                        const eligible = minAliasLenNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenNA) : row.newAliasesForRow;
                        toProcess.push({ id: row._flatId, aliases: eligible });
                      }
                      previewFileIdSubmit(toProcess, () => handleSubmitWithFileId('newAliases', results.newAliases, null, naApprovals, setNaApprovals, setNaSelected, isVisibleNA, minAliasLenNA));
                    }}>
                    ⬆ Submit with ID in file
                  </button>
                </div>
              </div>
            </>);
            })()}
          </div>
        )}

        {/* ── > 50% New Aliases ── */}
        {resultTab === 'manynewaliases' && (
          <div style={{ marginTop: 12 }}>
            {manyNewAliases.length === 0 ? <div className="text-muted">No records in this category.</div> : (() => {
              const visibleMNA = applySort(
                manyNewAliases.map((row, i) => ({ row, i })).filter(({ row }) => isVisibleMNA(row)),
                mnaSort
              );
              const mnaSortToggle = makeSortToggle(setMnaSort);
              const mnaRowClick = makeRowClickHandler(visibleMNA, mnaSelected, setMnaSelected, mnaLastClick);
              return (<>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={onlySameTypeMNA} onChange={e => {
                    setOnlySameTypeMNA(e.target.checked);
                    if (e.target.checked) {
                      const newAppr = {};
                      manyNewAliases.forEach((row, i) => {
                        const sameType  = isSameType(row);
                        const sameId    = !onlySameIdMNA || Number(row._flatId) === Number(row.matchedId);
                        const passLen   = minAliasLenMNA === 0 || row.newAliasesForRow.some(a => a.length >= minAliasLenMNA);
                        const passMatch = minMatchLenMNA === 0 || row.matchedAliases.some(a => a.length >= minMatchLenMNA);
                        newAppr[i] = sameType && sameId && passLen && passMatch;
                      });
                      setMnaApprovals(newAppr);
                      setMnaSelected(new Set());
                    }
                  }} />
                  Only same type matches
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={onlySameIdMNA} onChange={e => {
                    setOnlySameIdMNA(e.target.checked);
                    if (e.target.checked) {
                      const newAppr = {};
                      manyNewAliases.forEach((row, i) => {
                        const sameId    = Number(row._flatId) === Number(row.matchedId);
                        const sameType  = !onlySameTypeMNA || isSameType(row);
                        const passLen   = minAliasLenMNA === 0 || row.newAliasesForRow.some(a => a.length >= minAliasLenMNA);
                        const passMatch = minMatchLenMNA === 0 || row.matchedAliases.some(a => a.length >= minMatchLenMNA);
                        newAppr[i] = sameId && sameType && passLen && passMatch;
                      });
                      setMnaApprovals(newAppr);
                      setMnaSelected(new Set());
                    }
                  }} />
                  Only same ID matches
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Alias length &gt;=
                  <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minAliasLenMNA} onChange={e => setMinAliasLenMNA(Number(e.target.value))}>
                    <option value={0}>any</option>
                    {[2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Allowed match length ≥
                  <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minMatchLenMNA} onChange={e => setMinMatchLenMNA(Number(e.target.value))}>
                    <option value={0}>any</option>
                    {[3,4,5,6,7].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                {mnaSelected.size > 0 && (
                  <button className="btn btn-xs btn-secondary" onClick={() => toggleSelectedApprovals(mnaSelected, mnaApprovals, setMnaApprovals)}>
                    Check/Uncheck {mnaSelected.size} selected
                  </button>
                )}
                {(onlySameTypeMNA || onlySameIdMNA || minAliasLenMNA > 0 || minMatchLenMNA > 0) && <span className="text-muted" style={{ fontSize: 12 }}>Showing {visibleMNA.length} of {manyNewAliases.length} rows</span>}
              </div>
              <div className="table-wrap" style={{ maxHeight: 420 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32, textAlign: 'center' }}>
                        <input type="checkbox" title="Select all"
                          checked={visibleMNA.length > 0 && visibleMNA.every(({ i }) => mnaApprovals[i] !== false)}
                          onChange={e => { const a = { ...mnaApprovals }; visibleMNA.forEach(({ i }) => { a[i] = e.target.checked; }); setMnaApprovals(a); }}
                        />
                      </th>
                      <SortTh col="mappedId"   sort={mnaSort} onSort={mnaSortToggle} style={{ width: 130 }}>Mapped ID</SortTh>
                      <SortTh col="flatId"     sort={mnaSort} onSort={mnaSortToggle} style={{ width: 110 }}>ID in file</SortTh>
                      <SortTh col="entityType" sort={mnaSort} onSort={mnaSortToggle} style={{ width: 140 }}>Entity type</SortTh>
                      <th style={{ width: 180 }}>Name in File</th>
                      <th style={{ width: 180 }}>Record name</th>
                      <th>Matched aliases</th>
                      <th>New aliases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMNA.map(({ row, i }, visIdx) => {
                      const et    = resolveEntityTypeFromId(row.matchedId);
                      const isSel = mnaSelected.has(i);
                      return (
                      <tr key={i}
                        onClick={e => mnaRowClick(e, visIdx)}
                        style={{ cursor: 'pointer', background: isSel ? 'var(--selection, rgba(100,150,255,0.25))' : undefined }}>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox"
                            checked={mnaApprovals[i] !== false}
                            onChange={e => setMnaApprovals(a => ({ ...a, [i]: e.target.checked }))}
                          />
                        </td>
                        <td className="mono">
                          <button className="link-btn mono" onClick={() => onEditRecord?.(row.matchedId)}>
                            {row.matchedId?.toLocaleString()}
                          </button>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{row._flatId != null ? row._flatId : <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12 }}>{et ? et.rnef : <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12 }}>{row.name}</td>
                        <td style={{ fontSize: 12 }}>{onCache[row.matchedId] ?? <span className="text-muted">—</span>}</td>
                        <td style={{ fontSize: 12, color: 'var(--danger, #e05)' }}>{row.matchedAliases.join('; ')}</td>
                        <td style={{ fontSize: 12, color: '#7ec8a0' }}>
                          {(minAliasLenMNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenMNA) : row.newAliasesForRow).join('; ')}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10, flex: 1 }}>
                  <button className="btn btn-primary" disabled={submitting}
                    onClick={() => { const { aliases, rows } = countMNA(); confirmThen('matched', aliases, rows, mnaCriteria(), handleSubmitManyNewAliases); }}>
                    {submitting ? <><span className="spinner" /> Importing…</> : `⬆ Submit ${manyNewAliases.filter((_, i) => mnaApprovals[i] !== false).length} Approved Rows`}
                  </button>
                  <button className="btn btn-secondary" onClick={exportManyNewAliases}>⬇ Export TSV</button>
                </div>
                <button className="btn btn-success" style={{ flexShrink: 0 }}
                  disabled={submitting}
                  title="Create a new NLP record for each approved row, ignoring the matched ID"
                  onClick={() => { const { aliases, rows } = countMNA(); confirmThen('new', aliases, rows, [], () => handleSubmitAsNewRecords('manyNewAliases', results.manyNewAliases, setResults, mnaApprovals, setMnaApprovals, setMnaSelected, isVisibleMNA, minAliasLenMNA)); }}>
                  ⬆ Submit as new records
                </button>
                <div style={{ display: 'flex', gap: 10, flex: 1, justifyContent: 'flex-end' }}>
                  <button className="btn btn-secondary"
                    disabled={submitting || entityType !== '__nlp_ids__'}
                    title={entityType !== '__nlp_ids__' ? 'Only available when "Valid NLP IDs in file" is selected' : 'Import aliases under the ID specified in the input file'}
                    onClick={() => {
                      const toProcess = [];
                      for (let i = 0; i < results.manyNewAliases.length; i++) {
                        if (mnaApprovals[i] === false) continue;
                        const row = results.manyNewAliases[i];
                        if (!isVisibleMNA(row) || row._flatId == null) continue;
                        const eligible = minAliasLenMNA > 0 ? row.newAliasesForRow.filter(a => a.length >= minAliasLenMNA) : row.newAliasesForRow;
                        toProcess.push({ id: row._flatId, aliases: eligible });
                      }
                      previewFileIdSubmit(toProcess, () => handleSubmitWithFileId('manyNewAliases', results.manyNewAliases, null, mnaApprovals, setMnaApprovals, setMnaSelected, isVisibleMNA, minAliasLenMNA));
                    }}>
                    ⬆ Submit with ID in file
                  </button>
                </div>
              </div>
            </>);
            })()}
          </div>
        )}

        {/* ── Conflicts ── */}
        {resultTab === 'conflicts' && (
          <div style={{ marginTop: 12 }}>
            {conflicts.length === 0 ? <div className="text-muted">No conflicts.</div> : (<>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={resolveToSameType} onChange={e => {
                    const v = e.target.checked; setResolveToSameType(v);
                    computeAndApplyAutoDecisions({ sameType: v, longer: resolveToLonger, sameName: resolveToSameName, aliasMatch: resolveToAliasMatch, minLen: minAliasLenConflict, minML: minMatchLen }, results?.conflicts || []);
                  }} />
                  Resolve to same type match
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={resolveToLonger} onChange={e => {
                    const v = e.target.checked; setResolveToLonger(v);
                    computeAndApplyAutoDecisions({ sameType: resolveToSameType, longer: v, sameName: resolveToSameName, aliasMatch: resolveToAliasMatch, minLen: minAliasLenConflict, minML: minMatchLen }, results?.conflicts || []);
                  }} />
                  Resolve to longer match
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={resolveToSameName} onChange={e => {
                    const v = e.target.checked; setResolveToSameName(v);
                    computeAndApplyAutoDecisions({ sameType: resolveToSameType, longer: resolveToLonger, sameName: v, aliasMatch: resolveToAliasMatch, minLen: minAliasLenConflict, minML: minMatchLen }, results?.conflicts || []);
                  }} />
                  Resolve to same name
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={resolveToAliasMatch} onChange={e => {
                    const v = e.target.checked; setResolveToAliasMatch(v);
                    computeAndApplyAutoDecisions({ sameType: resolveToSameType, longer: resolveToLonger, sameName: resolveToSameName, aliasMatch: v, minLen: minAliasLenConflict, minML: minMatchLen }, results?.conflicts || []);
                  }} />
                  Resolve to name in aliases
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Alias length &gt;=
                  <input type="number" min={0} className="form-control"
                    style={{ width: 60, padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minAliasLenConflict || ''}
                    placeholder="any"
                    onChange={e => {
                      const newLen = Math.max(0, Number(e.target.value) || 0);
                      setMinAliasLenConflict(newLen);
                      if (resolveToSameType || resolveToLonger || resolveToSameName || resolveToAliasMatch)
                        computeAndApplyAutoDecisions({ sameType: resolveToSameType, longer: resolveToLonger, sameName: resolveToSameName, aliasMatch: resolveToAliasMatch, minLen: newLen, minML: minMatchLen }, results?.conflicts || []);
                    }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, userSelect: 'none' }}>
                  Allowed match length ≥
                  <select className="form-control" style={{ width: 'auto', padding: '1px 6px', fontSize: 12, height: 24 }}
                    value={minMatchLen} onChange={e => {
                      const newML = Number(e.target.value);
                      setMinMatchLen(newML);
                      if (resolveToSameType || resolveToLonger || resolveToSameName || resolveToAliasMatch)
                        computeAndApplyAutoDecisions({ sameType: resolveToSameType, longer: resolveToLonger, sameName: resolveToSameName, aliasMatch: resolveToAliasMatch, minLen: minAliasLenConflict, minML: newML }, results?.conflicts || []);
                    }}>
                    <option value={0}>any</option>
                    {[3,4,5,6,7].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                {minAliasLenConflict > 0 && (() => {
                  const vis = conflicts.filter(row => row.unmapped.some(m => m.alias.length >= minAliasLenConflict)).length;
                  return <span className="text-muted" style={{ fontSize: 12 }}>Showing {vis} of {conflicts.length} rows</span>;
                })()}
              </div>
              {batchLlmMsg && (
                <div className="alert alert-secondary" style={{ marginBottom: 6, fontSize: 13 }}>{batchLlmMsg}</div>
              )}
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 10, flex: 1 }}>
                  <button className="btn btn-primary" disabled={submitting || !anyResolved}
                    onClick={() => { const { aliases, rows } = countConflictsResolved(); confirmThen('matched', aliases, rows, conflictCriteria(), handleSubmitConflicts); }}>
                    {submitting ? <><span className="spinner" /> Importing…</> : `⬆ Submit ${resolvedCount} Resolved Conflict${resolvedCount !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn btn-secondary" onClick={exportConflicts}>⬇ Export TSV</button>
                  <button className="btn btn-secondary" onClick={handleBatchConflictsResolveLlm}
                    disabled={batchLlmResolving || submitting}
                    title="Ask the configured LLM to assign each incoming alias to a conflicting record. Returns a per-alias table (Input Alias | Record 1 | Record 2 …). Uniform assignments set the dropdown; split assignments populate Assign Manually. Runs up to 25 rows in parallel.">
                    {batchLlmResolving
                      ? <><span className="spinner" />{batchLlmProgress ? ` ${batchLlmProgress.done}/${batchLlmProgress.total}` : ' Resolving…'}</>
                      : '🤖 Resolve by LLM'}
                  </button>
                </div>
                <button className="btn btn-success" style={{ flexShrink: 0 }}
                  disabled={submitting}
                  title="Create a new NLP record for each conflict row, ignoring matched IDs"
                  onClick={() => { const { aliases, rows } = countConflictsVisible(); confirmThen('new', aliases, rows, [], handleSubmitConflictsAsNewRecords); }}>
                  ⬆ Submit as new records
                </button>
                <div style={{ display: 'flex', gap: 10, flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <span className="text-xs text-muted" style={{ maxWidth: 160, textAlign: 'right' }}>
                    Only fully-resolved rows will be imported; others are silently skipped.
                  </span>
                  <button className="btn btn-secondary"
                    disabled={submitting || entityType !== '__nlp_ids__'}
                    title={entityType !== '__nlp_ids__' ? 'Only available when "Valid NLP IDs in file" is selected' : 'Import new aliases under the ID from the input file, bypassing conflict resolution'}
                    onClick={() => { const { aliases, rows } = countConflictsVisible(); confirmThen('fileid', aliases, rows, [], handleSubmitConflictsWithFileId); }}>
                    ⬆ Submit with ID in file
                  </button>
                </div>
              </div>
              <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
                <table className="data-table" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 200, position: 'sticky', top: 0, zIndex: 3,
                                    background: 'var(--surface-3, #2a2d3e)', color: 'var(--text)' }}>Name</th>
                      <th style={{ position: 'sticky', top: 0, zIndex: 3,
                                   background: 'var(--surface-3, #2a2d3e)', color: 'var(--text)' }}>New aliases</th>
                      <th style={{ width: 200, position: 'sticky', top: 0, zIndex: 3,
                                   background: 'var(--surface-3, #2a2d3e)', color: 'var(--text)', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => setConflictSort(s => s === 'resolved-first' ? 'unresolved-first' : s === 'unresolved-first' ? null : 'resolved-first')}
                          title="Click to sort by resolution status">
                        Action {conflictSort === 'resolved-first' ? '▲' : conflictSort === 'unresolved-first' ? '▼' : '⇅'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const anyAutoResolve = resolveToSameType || resolveToLonger || resolveToSameName || resolveToAliasMatch;
                      const isRowResolved = (rowIdx) => {
                        const row = conflicts[rowIdx];
                        if (row._unanchored) return false;
                        const dec = conflictDec[rowIdx] || {};
                        if (dec.__new__ === 'newRecord') return true;
                        const ma = manualAssign[rowIdx];
                        if (ma && row.unmapped?.length > 0 && row.unmapped.some(m => ma[m.alias])) return true;
                        const ids = [...new Set((row.mapped || []).map(m => String(m.hit.dup.medscan_id)))];
                        if (ids.length === 0) return false;
                        return ids.every(id => dec[id]) && ids.some(id => dec[id] !== 'ignore');
                      };
                      const conflictCount = (rowIdx) =>
                        conflicts[rowIdx]._unanchored ? 0 :
                        new Set((conflicts[rowIdx].mapped || []).map(m => String(m.hit.dup.medscan_id))).size;
                      const sortedIndices = conflictSort
                        ? [...conflicts.keys()].sort((a, b) => {
                            const aRes = isRowResolved(a), bRes = isRowResolved(b);
                            const statusDiff = conflictSort === 'resolved-first'
                              ? (bRes ? 1 : 0) - (aRes ? 1 : 0)
                              : (aRes ? 1 : 0) - (bRes ? 1 : 0);
                            return statusDiff !== 0 ? statusDiff : conflictCount(a) - conflictCount(b);
                          })
                        : anyAutoResolve
                          ? [...conflicts.keys()].sort((a, b) =>
                              (!!autoUpdatesRef.current[b] ? 1 : 0) - (!!autoUpdatesRef.current[a] ? 1 : 0)
                            )
                          : [...conflicts.keys()];
                      return sortedIndices.map(rowIdx => {
                      const row = conflicts[rowIdx];
                      // ── Unanchored combnames row — NLP ID not in any other dict ──
                      if (row._unanchored) {
                        return (
                          <tr key={rowIdx} style={{ background: 'rgba(200,60,60,0.08)', borderBottom: '1px solid var(--border)' }}>
                            <td style={{ fontSize: 12, color: '#c44' }}>⚠ Unanchored</td>
                            <td style={{ fontSize: 12 }}>{row.aliases?.join('; ')}</td>
                            <td colSpan={3} style={{ fontSize: 12, color: '#c44' }}>
                              NLP ID {Number(row._flatId).toLocaleString()} has no aliases in curnames / cellDictionary / ExactLiteral — skipped
                            </td>
                          </tr>
                        );
                      }
                      if (minAliasLenConflict > 0 && !row.unmapped.some(m => m.alias.length >= minAliasLenConflict)) return null;
                      const dec = conflictDec[rowIdx] || {};
                      const isExp = conflictExp.has(rowIdx);
                      const accentColors = ['rgba(80,120,200,0.18)', 'rgba(80,170,120,0.18)', 'rgba(200,140,80,0.18)'];
                      const rowBg = accentColors[rowIdx % accentColors.length];

                      // Group conflicting aliases by matched medscan_id — one sub-row per DB record
                      const idGroups = {};
                      for (const m of row.mapped) {
                        const key = String(m.hit.dup.medscan_id);
                        if (!idGroups[key]) idGroups[key] = { id: m.hit.dup.medscan_id, aliases: [], hit: m.hit };
                        idGroups[key].aliases.push(m.alias);
                      }
                      const autoDecForRow = autoUpdatesRef.current[rowIdx] || {};
                      const groups   = Object.values(idGroups).sort((a, b) =>
                        (autoDecForRow[String(b.id)] === 'addToThis' ? 1 : 0) - (autoDecForRow[String(a.id)] === 'addToThis' ? 1 : 0)
                      );
                      const N        = groups.length; // number of distinct conflicting records
                      const decCount = groups.filter(g => dec[String(g.id)]).length;
                      const ma       = manualAssign[rowIdx];
                      const manualDone = ma && row.unmapped.length > 0 && row.unmapped.some(m => ma[m.alias]);
                      const allRes   = dec.__new__ === 'newRecord' || (decCount === N && groups.some(g => dec[String(g.id)] !== 'ignore')) || manualDone;

                      return (
                        <React.Fragment key={rowIdx}>
                          <tr style={{ background: rowBg }}>
                            <td>
                              {row.name}
                              {entityType === '__nlp_ids__' && row._flatId != null && (
                                <span className="mono" style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)', userSelect: 'all' }}>
                                  [{row._flatId}]
                                </span>
                              )}
                            </td>
                            <td style={{ fontSize: 12, color: '#7ec8a0' }}>
                              {row.unmapped
                                .filter(m => minAliasLenConflict === 0 || m.alias.length >= minAliasLenConflict)
                                .map(m => m.alias).join('; ')}
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <button className="btn btn-secondary btn-sm" onClick={() => toggleConflictExp(rowIdx)}
                                  style={allRes ? { borderColor: 'var(--success, #2a7)', color: 'var(--success, #2a7)' } : {}}>
                                  {allRes ? '✓' : `${decCount}/${N}`} resolved {isExp ? '▲' : '▼'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isExp && (
                            <tr style={{ background: rowBg }}>
                              <td colSpan={3} style={{ padding: '8px 12px' }}>
                                <table className="data-table" style={{ fontSize: 12 }}>
                                  <thead>
                                    <tr>
                                      <th>Matched aliases</th>
                                      <th>
                                        <button
                                          className="link-btn"
                                          title="Open all matched records in Edit Record"
                                          onClick={() => onEditRecord?.(groups.map(g => g.id))}
                                          style={{ fontWeight: 600, fontSize: 'inherit' }}
                                        >
                                          Match NLP ID ↗
                                        </button>
                                      </th>
                                      <th>Existing record has</th>
                                      <th>Record name</th>
                                      <th style={{ width: 180 }}>Resolve</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.map((g, gi) => (
                                      <tr key={gi} style={dec[String(g.id)] === 'addToThis' ? { color: 'var(--danger, #e05)' } : undefined}>
                                        <td>{g.aliases.join('; ')}</td>
                                        <td className="mono">
                                          <button className="link-btn mono" onClick={() => onEditRecord?.(g.id)}>
                                            {g.id}
                                          </button>
                                        </td>
                                        <td style={{ whiteSpace: 'nowrap' }}>
                                          {aliasCountCache[g.id] !== undefined
                                            ? `${aliasCountCache[g.id]} aliases`
                                            : <span className="text-muted">…</span>}
                                        </td>
                                        <td>
                                          <button className="link-btn" title={g.hit.dup.alias} onClick={() => onEditRecord?.(g.id)}>
                                            {onCache[g.id] ?? g.hit.dup.alias}
                                          </button>
                                        </td>
                                        <td>
                                          <select value={dec.__new__ === 'newRecord' ? 'newRecord' : (dec[String(g.id)] || '')}
                                            onChange={e => {
                                              const val = e.target.value;
                                              if (val === 'newRecord') {
                                                // Clear per-group decisions and flag row for new record creation
                                                setConflictDec(d => ({ ...d, [rowIdx]: { __new__: 'newRecord' } }));
                                              } else if (val === 'addToThis') {
                                                const updated = { __new__: undefined };
                                                for (const grp of groups) {
                                                  updated[String(grp.id)] = String(grp.id) === String(g.id) ? 'addToThis' : 'ignore';
                                                }
                                                setConflictDec(d => ({ ...d, [rowIdx]: { ...(d[rowIdx] || {}), ...updated } }));
                                              } else {
                                                setConflictDec(d => {
                                                  const cur = { ...(d[rowIdx] || {}) };
                                                  delete cur.__new__;
                                                  cur[String(g.id)] = val;
                                                  return { ...d, [rowIdx]: cur };
                                                });
                                              }
                                            }}
                                            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, width: '100%',
                                                     border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
                                            <option value="">— Select —</option>
                                            <option value="ignore">Ignore</option>
                                            <option value="override">Override</option>
                                            <option value="addToThis">Add all to this record</option>
                                            <option value="newRecord">New record</option>
                                          </select>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {/* Assign manually button + summary */}
                                {row.unmapped.length > 0 && (
                                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <button className="btn btn-secondary btn-sm"
                                      onClick={() => setManualAssignOpen({ rowIdx, row, groups })}>
                                      ✎ Assign manually
                                    </button>
                                    {manualDone && (() => {
                                      const assigned = row.unmapped.filter(m => ma[m.alias]);
                                      const skipped  = row.unmapped.length - assigned.length;
                                      // Assign a distinct color per target ID so aliases going to different
                                      // records are immediately visually distinguishable.
                                      const TARGET_COLORS = [
                                        '#4fc3a1', // teal-green
                                        '#e07b54', // coral-orange
                                        '#7ec8e3', // sky-blue
                                        '#c9a84c', // amber
                                        '#b57bee', // lavender
                                        '#e06c75', // rose
                                      ];
                                      // Build color palette only for non-ignore targets
                                      const activeTargets = [...new Set(
                                        assigned.map(m => ma[m.alias]).filter(a => a !== 'ignore')
                                      )];
                                      const colorFor = (targetId) => {
                                        if (targetId === 'ignore') return 'var(--text-muted)';
                                        const idx = activeTargets.indexOf(targetId);
                                        return TARGET_COLORS[idx % TARGET_COLORS.length];
                                      };
                                      return (
                                        <span style={{ fontSize: 11 }}>
                                          ✓ {assigned.map((m, i) => {
                                            const a = ma[m.alias];
                                            const g = groups.find(g => String(g.id) === a);
                                            const label = a === 'ignore'
                                              ? `"${m.alias}" → ignored`
                                              : a === 'new'
                                                ? `"${m.alias}" → new record`
                                                : `"${m.alias}" → ID ${a}${g ? ' ('+g.hit.dup.alias+')' : ''}`;
                                            return (
                                              <span key={i} style={{ color: colorFor(a) }}>
                                                {i > 0 && <span style={{ color: 'var(--text-muted)' }}>, </span>}
                                                {label}
                                              </span>
                                            );
                                          })}
                                          {skipped > 0 && <span style={{ color: 'var(--text-muted)' }}> · {skipped} alias{skipped !== 1 ? 'es' : ''} skipped</span>}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </>)}
          </div>
        )}
        {/* Manual Assign Dialog */}
        {manualAssignOpen && (() => {
          const { rowIdx: mRowIdx, row: mRow, groups: mGroups } = manualAssignOpen;
          const curMA = manualAssign[mRowIdx] || {};
          // If a record was already chosen via "Add all aliases to this record", use it as default
          const addToThisId = Object.entries(conflictDec[mRowIdx] || {}).find(([, v]) => v === 'addToThis')?.[0] ?? '';
          // Effective value per alias: explicit manual choice > addToThis default > empty
          const effectiveVal = (alias) => curMA[alias] || addToThisId || '';
          const saveAndClose = (updated) => {
            setManualAssign(ma => ({ ...ma, [mRowIdx]: updated }));
            setManualAssignOpen(null);
          };
          return (
            <div className="modal-backdrop" style={{ zIndex: 1200 }}>
              <div className="modal" style={{ maxWidth: 560, width: '96vw' }}>
                <div className="modal-title">Assign manually — new aliases</div>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Assign each new alias to an existing NLP record or create a new record for it.
                  {addToThisId && <span style={{ color: 'var(--success, #2a7)' }}> Defaulting to record {addToThisId} from current resolution.</span>}
                </p>
                <table className="data-table" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>New alias</th>
                      <th>Assign to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mRow.unmapped.map((m, i) => (
                      <tr key={i}>
                        <td className="mono">{m.alias}</td>
                        <td>
                          <select
                            value={effectiveVal(m.alias)}
                            onChange={e => {
                              const next = { ...curMA, [m.alias]: e.target.value };
                              setManualAssign(ma => ({ ...ma, [mRowIdx]: next }));
                            }}
                            style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, width: '100%',
                                     border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                          >
                            <option value="">— Select —</option>
                            {mGroups.map(g => (
                              <option key={g.id} value={String(g.id)}>
                                ID {g.id} — {onCache[g.id] ?? g.hit.dup.alias}
                              </option>
                            ))}
                            <option value="new">New record</option>
                            <option value="ignore">Ignore</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="modal-actions" style={{ marginTop: 14 }}>
                  <button className="btn btn-secondary" onClick={() => setManualAssignOpen(null)}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    disabled={!mRow.unmapped.some(m => effectiveVal(m.alias))}
                    onClick={() => {
                      // Save only aliases that have an explicit assignment; empty = skip on import
                      const finalMA = Object.fromEntries(
                        mRow.unmapped
                          .map(m => [m.alias, effectiveVal(m.alias)])
                          .filter(([, v]) => v)
                      );
                      saveAndClose(finalMA);
                    }}
                  >
                    Save assignments
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ── Form view ───────────────────────────────────────────────────────────────
  return (
    <div>
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="form-group">
        <label>Import format</label>
        <div style={{ display: 'flex', gap: 20, marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" value="aggregated" checked={!centreeMode && importFormat === 'aggregated'}
              onChange={() => { setCentreeMode(false); setImportFormat('aggregated'); if (targetTable === 'objectnames') setTargetTable(''); }} />
            <strong>Aggregated</strong>
            <span className="text-xs text-muted">tab-delimited: id ⇥ name ⇥ synonyms</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" value="flat" checked={!centreeMode && importFormat === 'flat'}
              onChange={() => {
                setCentreeMode(false);
                setImportFormat('flat');
                if (file) {
                  const parsed = parseFlatFilename(file);
                  if (parsed.organism) setOrganism(parsed.organism);
                  if (parsed.dict) setTargetTable(parsed.dict);
                }
              }} />
            <strong>Flat</strong>
            <span className="text-xs text-muted">id ⇥ alias (or id ⇥ name ⇥ urn for ObjectNames)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" value="mixed" checked={!centreeMode && importFormat === 'mixed'}
              onChange={() => { setCentreeMode(false); setImportFormat('mixed'); setResults(null); setMixedResults(null); setMixedAnnotated([]); setMixedLlmMsg(null); setMixedSubmitMsg(null); }} />
            <strong>Mixed list</strong>
            <span className="text-xs text-muted">paste aliases → MedScan mapping + LLM annotation</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" value="centree" checked={centreeMode}
              onChange={() => { setCentreeMode(true); setImportFormat('aggregated'); setResults(null); setError(null); }} />
            <strong>CENtree</strong>
            <span className="text-xs text-muted">records created or updated since a date</span>
          </label>
        </div>
        <div style={{ display: centreeMode ? 'block' : 'none', marginTop: 8 }}>
          <CentreeImport onReady={({ file: f }) => { setFile(f); setImportFormat('aggregated'); setResults(null); setError(null); setSubmitMsg(null); }} />
        </div>
        {importFormat !== 'mixed' && !centreeMode && (
          <div className="input-group">
            <input className="form-control" value={file} readOnly placeholder={importFormat === 'flat' ? 'Select .tab.e, .txt, .tab, or .tsv file…' : 'Select .txt, .tab, or .tsv file…'} />
            <button className="btn btn-secondary" onClick={handlePickFile}>Browse</button>
          </div>
        )}
        {importFormat === 'aggregated' && !centreeMode && (
          <div className="text-xs text-muted mt-4">
            Lines starting with # are comments. The header row (e.g.&nbsp;<code>#id&nbsp;&nbsp;name&nbsp;&nbsp;syns</code>) identifies columns.
            Synonyms column accepts: syns, synonyms, aliases, alias. Values separated by | or ;.
          </div>
        )}
      </div>
      {importFormat !== 'mixed' && (<>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
        <div className="form-group">
          <label>Entity Type *</label>
          <select className="form-control" value={entityType} onChange={e => {
            setEntityType(e.target.value);
            const et = resolveEntityType(e.target.value);
            setTargetTable('');
          }}>
            <option value="" disabled>— Select entity type —</option>
            <option value="__nlp_ids__">Valid NLP IDs in file (infer type from ID range)</option>
            {[...ENTITY_TYPES].sort((a, b) => a.rnef.localeCompare(b.rnef)).map(t => (
              <option key={t.display} value={t.display}>{t.rnef} ({t.min}–{t.max}): {t.display.toLowerCase()}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Organism</label>
          <input
            className="form-control"
            list="bi-organism-list"
            value={organism}
            onChange={e => setOrganism(e.target.value)}
            placeholder="e.g. Mammal"
          />
          <datalist id="bi-organism-list">
            {dbOrganisms.map(org => <option key={org} value={org} />)}
          </datalist>
        </div>
      </div>
      <div className="form-group">
        <label>Target table</label>
        <select className="form-control" value={targetTable} onChange={e => setTargetTable(e.target.value)}>
          <option value="">— select target table —</option>
          {['curnames', 'exactliteral', 'celldictionary', 'casdictionary', 'chemnames', 'userdict', 'keywords', ...(importFormat !== 'aggregated' ? ['objectnames'] : []), 'combnames', 'rsmap'].map(t => {
            const et = resolveEntityType(entityType);
            const def = (et && ENTITY_TO_TABLE[et.rnef]) || 'curnames';
            return <option key={t} value={t}>{t}{t === def ? ' (default)' : ''}</option>;
          })}
        </select>
        {targetTable === 'exactliteral' ? (
          <div className="text-xs text-muted mt-4">
            All aliases import into <code>exactliteral</code> using ExactLiteral tokenization (no xwords stripping).
          </div>
        ) : targetTable !== 'objectnames' && (
          <div className="text-xs text-muted mt-4">
            Long aliases (≥6 chars) go here. Short aliases always go to <code>exactliteral</code>.
          </div>
        )}
        {targetTable === 'exactliteral' && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span className="text-sm" style={{ whiteSpace: 'nowrap' }}>Match flag:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="elMatchFlag" value="l" checked={elMatchFlag === 'l'}
                onChange={() => setElMatchFlag('l')} />
              <strong>l</strong>&nbsp;<span className="text-muted">— case-sensitive (tokenized = alias verbatim)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="elMatchFlag" value="" checked={elMatchFlag === ''}
                onChange={() => setElMatchFlag('')} />
              <em>none</em>&nbsp;<span className="text-muted">— case-insensitive (tokenized = lowercase)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="elMatchFlag" value="__from_file__" checked={elMatchFlag === '__from_file__'}
                onChange={() => setElMatchFlag('__from_file__')} />
              <span style={{ color: 'var(--accent, #7aa2f7)' }}>From file's 3rd column</span>&nbsp;<span className="text-muted">— per-alias match type, empty when absent</span>
            </label>
          </div>
        )}
      </div>
      <div className="form-group">
        <label>Cartridges *</label>
        {cartridges.length === 0
          ? <div className="text-muted text-sm" style={{ padding: 4 }}>No cartridges found. Configure in Settings.</div>
          : <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px' }}>
              <label className="checkbox-item" style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={cartridgeList.length === cartridges.length}
                  ref={el => { if (el) el.indeterminate = cartridgeList.length > 0 && cartridgeList.length < cartridges.length; }}
                  onChange={ev => setCartList(ev.target.checked ? cartridges.map(c => c.name) : [])}
                />
                <strong>Select All</strong>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '3px 0' }}>
                {cartridges.map(c => (
                  <label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, padding: '2px 0', userSelect: 'none' }}>
                    <input type="checkbox"
                      checked={cartridgeList.includes(c.name)}
                      onChange={ev => setCartList(ev.target.checked ? [...cartridgeList, c.name] : cartridgeList.filter(x => x !== c.name))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
        }
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="checkbox-item" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={revertInverted} onChange={e => setRevertInverted(e.target.checked)} />
          Revert inverted headings
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>
            (e.g. "corneal dystrophies, hereditary" → "hereditary corneal dystrophies")
          </span>
        </label>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="checkbox-item" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={ignoreNumbers} onChange={e => setIgnoreNumbers(e.target.checked)} />
          Ignore numbers
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>
            (exclude aliases that are plain numbers, e.g. "1234", "1,567", "4.789")
          </span>
        </label>
      </div>
      <button className="btn btn-primary" onClick={handleAnalyze} disabled={analyzing || !file}>
        {analyzing
          ? <><span className="spinner" /> {analyzeProgress || 'Analyzing…'}</>
          : '🔍 Analyze File'
        }
      </button>
      </>)}
      {importFormat === 'mixed' && (
        <div style={{ marginTop: 8 }}>
          <p className="text-xs text-muted" style={{ marginBottom: 8 }}>
            Paste one alias per line, or <code>id ⇥ alias</code> (2-col tab-separated). Then map with MedScan and annotate unmatched aliases with LLM.
          </p>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              Aliases
              <button type="button" className="btn btn-secondary" style={{ padding: '1px 10px', fontSize: 12 }} onClick={handleMixedLoadFile}>
                📂 Load file
              </button>
              <span className="text-xs" style={{ fontWeight: 'normal', color: 'var(--text-muted)' }}>
                {mixedText.trim() ? `${mixedText.split('\n').filter(l => l.trim()).length.toLocaleString()} rows` : '0 rows'}
              </span>
              {mixedFileMsg && <span className="text-xs text-muted" style={{ fontWeight: 'normal' }}>{mixedFileMsg}</span>}
            </label>
            {mixedPicker && (
              <FilePickerModal
                title="Load aliases file"
                startDir={mixedPicker.startDir}
                extensions={['.txt', '.tsv', '.tab', '.csv', '.lst']}
                onSelect={loadMixedFile}
                onCancel={(dir) => { setMixedPicker(null); rememberMixedDir(dir); }}
              />
            )}
            <textarea
              className="form-control"
              rows={8}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              value={mixedText}
              onChange={e => { setMixedText(e.target.value); setMixedFileMsg(null); }}
              placeholder={'EGFR\nTNF\nTP53\n...'}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Cartridges</label>
              <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox"
                    checked={mixedCartList.length === cartridges.length}
                    ref={el => { if (el) el.indeterminate = mixedCartList.length > 0 && mixedCartList.length < cartridges.length; }}
                    onChange={ev => setMixedCartList(ev.target.checked ? cartridges.map(c => c.name) : [])}
                  />
                  <strong>ALL</strong>
                </label>
                {cartridges.map(c => (
                  <label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox"
                      checked={mixedCartList.includes(c.name)}
                      onChange={ev => setMixedCartList(ev.target.checked ? [...mixedCartList, c.name] : mixedCartList.filter(x => x !== c.name))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {mixedError && <div className="alert alert-danger" style={{ marginBottom: 8 }}>{mixedError}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleMixedRun} disabled={mixedRunning || !mixedText.trim()}>
              {mixedRunning ? <><span className="spinner" /> Mapping…</> : '🔍 Map aliases'}
            </button>
            {mixedDupMsg && (
              <span className="text-xs" style={{ color: 'var(--warning, #e8a000)' }}>
                ⚠ {mixedDupMsg}
              </span>
            )}
          </div>
          {mixedResults && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
                <button
                  className={`btn btn-sm ${mixedActiveTab === 'mapped' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMixedActiveTab('mapped')}
                >
                  Mapped by NLP ({mixedResults.mapped?.length ?? 0})
                </button>
                <button
                  className={`btn btn-sm ${mixedActiveTab === 'db' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMixedActiveTab('db')}
                >
                  Found in DB ({mixedResults.dbFound?.length ?? 0})
                </button>
                <button
                  className={`btn btn-sm ${mixedActiveTab === 'unmapped' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMixedActiveTab('unmapped')}
                >
                  New aliases ({mixedResults.unmapped?.length ?? 0})
                </button>
              </div>
              {mixedActiveTab === 'mapped' && (
                <div>
                  {mixedResults.mapped.length === 0
                    ? <div className="text-muted text-sm">No aliases were recognised by any cartridge.</div>
                    : <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Alias</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>NLP ID</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Cartridges</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Organisms</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(mixedResults.mapped || []).map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle, #333)' }}>
                              <td style={{ padding: '3px 6px' }}>{row.alias}</td>
                              <td style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'monospace' }}>
                                {(row.msIds || []).map((id, k) => (
                                  <React.Fragment key={id}>
                                    {k > 0 && ', '}
                                    <button className="link-btn mono" title="Open in Edit Record" onClick={() => onEditRecord?.(id)}>{id}</button>
                                  </React.Fragment>
                                ))}
                              </td>
                              <td style={{ padding: '3px 6px', fontSize: 12 }}>
                                {(row.cartridges || []).join(', ')}
                              </td>
                              <td style={{ padding: '3px 6px', fontSize: 12 }}>
                                {(row.organisms || []).join(', ')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                  }
                </div>
              )}
              {mixedActiveTab === 'db' && (
                <div>
                  {(mixedResults.dbFound || []).length === 0
                    ? <div className="text-muted text-sm">No unmapped aliases were found in the database.</div>
                    : <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Alias</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>NLP ID</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Name</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Dictionaries</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Matched DB alias</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mixedResults.dbFound.map((row, i) => {
                            const ids = [...new Set(row.hits.map(h => h.msId))];
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle, #333)', verticalAlign: 'top' }}>
                                <td style={{ padding: '3px 6px' }}>{row.alias}</td>
                                <td style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'monospace' }}>
                                  {ids.map((id, k) => (
                                    <React.Fragment key={id}>
                                      {k > 0 && ', '}
                                      <button className="link-btn mono" title="Open in Edit Record" onClick={() => onEditRecord?.(id)}>{id}</button>
                                    </React.Fragment>
                                  ))}
                                </td>
                                <td style={{ padding: '3px 6px', fontSize: 12 }}>
                                  {[...new Set(row.hits.map(h => h.name).filter(Boolean))].join('; ')}
                                </td>
                                <td style={{ padding: '3px 6px', fontSize: 12 }}>{[...new Set(row.hits.map(h => h.table))].join(', ')}</td>
                                <td style={{ padding: '3px 6px', fontSize: 12 }}>
                                  {[...new Set(row.hits.map(h => h.dbAlias))].slice(0, 5).join('; ')}
                                </td>
                                <td style={{ padding: '3px 6px', fontSize: 11, color: 'var(--text-muted)' }}>
                                  {row.hits.some(h => h.via === 'tokenized') ? 'tokenized' : 'alias (case-insens.)'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                  }
                </div>
              )}
              {mixedActiveTab === 'unmapped' && (
                <div>
                  {(mixedResults?.unmapped?.length ?? 0) > mixedAnnotated.length && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary" onClick={handleMixedAnnotateLlm}
                          disabled={mixedLlmRunning || !(mixedResults?.unmapped?.length)}>
                          {mixedLlmRunning
                            ? <><span className="spinner" /> Annotating{mixedLlmProg ? ` ${mixedLlmProg.done}/${mixedLlmProg.total}` : '…'}</>
                            : '✨ Annotate by LLM'}
                        </button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                          title="Maximum number of rows (LLM requests) processed per click">
                          Number of rows
                          <input type="number" min={1} className="form-control" style={{ width: 90, padding: '2px 6px' }}
                            value={mixedRowsPerClick}
                            disabled={mixedLlmRunning}
                            onChange={e => {
                              const v = Math.max(1, parseInt(e.target.value) || 1);
                              setMixedRowsPerClick(v);
                              localStorage.setItem('mixedLlmRowsPerClick', String(v));
                            }} />
                        </label>
                        <span className="text-muted" style={{ fontSize: 12 }}>
                          {(mixedResults?.unmapped?.length ?? 0) - mixedAnnotated.length} aliases left to annotate
                        </span>
                      </div>
                      {mixedLlmRunning && mixedLlmProg && (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ background: 'var(--border)', borderRadius: 4, overflow: 'hidden', height: 6 }}>
                            <div style={{ background: 'var(--accent, #7aa2f7)', width: `${(mixedLlmProg.done / mixedLlmProg.total) * 100}%`, height: '100%', transition: 'width 0.2s' }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {mixedLlmMsg && <div className="alert alert-success" style={{ marginBottom: 8 }}>{mixedLlmMsg}</div>}
                  {mixedAnnotated.length === 0 && mixedSubmitMsg && <div className="alert alert-success" style={{ marginBottom: 8 }}>{mixedSubmitMsg}</div>}
                  {mixedAnnotated.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <div style={{ fontSize: 12, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 14 }}>
                        <span><span style={{ display: 'inline-block', width: 12, height: 12, background: 'rgba(70,150,255,0.45)', borderRadius: 2, verticalAlign: 'middle', marginRight: 5 }} />URN already exists in database ({mixedAnnotated.filter(r => r.urnExists && r.dict !== 'ignore').length})</span>
                        <span><span style={{ display: 'inline-block', width: 12, height: 12, border: '1px solid var(--border)', borderRadius: 2, verticalAlign: 'middle', marginRight: 5 }} />New ({mixedAnnotated.filter(r => !r.urnExists && r.dict !== 'ignore').length})</span>
                      </div>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 800 }}>
                        <thead>
                          <tr style={{ borderBottom: '2px solid var(--border)' }}>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>NLP ID</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>Alias</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>Entity Type</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>Name</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>URN</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>Synonyms</th>
                            <th style={{ padding: '4px 6px', textAlign: 'left' }}>Dict</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mixedAnnotated.map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle, #eee)', background: row.urnExists ? 'rgba(70,150,255,0.22)' : undefined, opacity: row.dict === 'ignore' ? 0.45 : 1 }}>
                              <td style={{ padding: '3px 6px', fontFamily: 'monospace' }}>{row.nlpId ?? '—'}</td>
                              <td style={{ padding: '3px 6px' }}>{row.alias}</td>
                              <td style={{ padding: '3px 6px' }}>
                                <select style={{ fontSize: 12, padding: '1px 2px' }} value={row.entityType}
                                  onChange={async e => {
                                    const newEt = e.target.value;
                                    // Regenerate the URN for the new entity type (fallback form: urn:agi-<tag>:<name>)
                                    const newUrn = buildEntityUrn(row.name || row.alias, newEt) || row.urn;
                                    setMixedAnnotated(prev => prev.map((r, j) => j === i ? { ...r, entityType: newEt, urn: newUrn, nlpId: null, dict: r.dict === 'ignore' ? 'ignore' : mixedDictFor(newEt) } : r));
                                    const [m] = await markExistingUrns([{ ...row, urn: newUrn }]);
                                    setMixedAnnotated(prev => prev.map(r => r.idx === row.idx ? { ...r, urnExists: m.urnExists } : r));
                                  }}>
                                  {['Protein','SmallMol','CellObject','Complex','CellProcesses','Virus','Tissue','Organism','Organ','Diseases','CellType','CellLineName','FunctionalClass','Treatment','ClinicalParameter','MedicalProcedure','GeneticVariant','Pathogen'].sort((a, b) => a.localeCompare(b)).map(et => (
                                    <option key={et} value={et}>{et}</option>
                                  ))}
                                </select>
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <input style={{ fontSize: 12, padding: '1px 4px', width: '100%', minWidth: 80 }} value={row.name}
                                  onChange={e => setMixedAnnotated(prev => prev.map((r, j) => j === i ? { ...r, name: e.target.value } : r))} />
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <input style={{ fontSize: 11, padding: '1px 4px', width: '100%', minWidth: 160, fontFamily: 'monospace' }} value={row.urn}
                                  onChange={e => setMixedAnnotated(prev => prev.map((r, j) => j === i ? { ...r, urn: e.target.value } : r))}
                                  onBlur={() => recheckMixedRowUrn(row.idx)} />
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <input style={{ fontSize: 12, padding: '1px 4px', width: '100%', minWidth: 100 }} value={row.synonyms}
                                  onChange={e => setMixedAnnotated(prev => prev.map((r, j) => j === i ? { ...r, synonyms: e.target.value } : r))} />
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <select style={{ fontSize: 12, padding: '1px 2px' }} value={row.dict}
                                  onChange={e => setMixedAnnotated(prev => prev.map((r, j) => j === i ? { ...r, dict: e.target.value } : r))}>
                                  {['curnames','casdictionary','celldictionary','exactliteral','chemnames','userdict','ignore'].map(d => (
                                    <option key={d} value={d}>{d === 'ignore' ? 'Ignore' : d}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary" onClick={handleMixedPreview} disabled={mixedSubmitting}>
                          Preview
                        </button>
                        <button className="btn btn-primary" onClick={handleMixedSubmit} disabled={mixedSubmitting || !mixedAnnotated.some(r => r.nlpId && r.dict !== 'ignore')}>
                          {mixedSubmitting ? <><span className="spinner" /> Submitting…</> : 'Submit'}
                        </button>
                        {mixedSubmitMsg && (
                          <span style={{ fontSize: 13, color: mixedSubmitMsg.startsWith('Error') ? 'var(--danger, red)' : 'var(--success, green)' }}>
                            {mixedSubmitMsg}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {mixedAnnotated.length === 0 && (
                    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th style={{ textAlign: 'left', padding: '4px 6px' }}>Alias</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(mixedResults.unmapped || []).map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle, #eee)' }}>
                            <td style={{ padding: '3px 6px' }}>{row.alias}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dictionary Browser ────────────────────────────────────────────────────────
// Main Browse tabs — shown as buttons in the specified order
const DICT_TABLES = [
  { label: 'curNames',       table: 'curnames'       },
  { label: 'ExactLiteral',   table: 'exactliteral'   },
  { label: 'cellDictionary', table: 'celldictionary' },
  { label: 'combNames',      table: 'combnames'      },
  { label: 'CASDictionary',  table: 'casdictionary'  },
  { label: 'chemNames',      table: 'chemnames'      },
  { label: 'UserDict',       table: 'userdict'       },
  { label: 'ObjectNames',    table: 'objectnames'    },
  { label: 'rsmap',          table: 'rsmap'          },
];

// Tables included in the cross-table Statistics view (entity alias tables + keywords)
const STATS_TABLES = [
  ...DICT_TABLES,
  { label: 'keywords', table: 'keywords' },
];

// Term Control Tables — shown in the dropdown at the bottom
const TERM_CONTROL_TABLES = [
  { label: 'keywords',    table: 'keywords'     },
  { label: 'xwords',      table: 'xwords'       },
  { label: 'xwords_cells',table: 'xwords_cells' },
  { label: 'xwords_CAS',  table: 'xwords_cas'   },
  { label: 'xwords_comb', table: 'xwords_comb'  },
  { label: 'bracketstop', table: 'bracketstop'  },
  { label: 'spelling',    table: 'spelling'     },
  { label: 'Ontology',    table: 'ontology'     },
];

// Service lookup tables (derived caches — read-only, no id/bdeleted/curated columns)
const SERVICE_LOOKUP_TABLES = [
  { label: 'organisms_lookup',   table: 'organisms_lookup'   },
  { label: 'cartridges_lookup',  table: 'cartridges_lookup'  },
  { label: 'match_opts_lookup',  table: 'match_opts_lookup'  },
];

// ── Record Editor ─────────────────────────────────────────────────────────────
function resolveEntityTypeFromId(msId) {
  return ENTITY_TYPES.find(et => Number(msId) >= et.min && Number(msId) <= et.max) || null;
}

// chemnames is excluded: all 324k rows share medscan_id=1000001 (flat chemical list),
// so it's useless for per-entity editing and would hang fetchRecord.
const ALL_EDIT_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames','rsmap'];

// Match options per dictionary
const MATCH_OPTIONS = {
  exactliteral: [
    { value: '',  label: 'Exact (case-insensitive)' },
    { value: 'l', label: 'Literal (case-sensitive)' },
  ],
  _default: [{ value: '', label: '—' }],
};

function matchLabel(dict, match) {
  if (dict !== 'exactliteral') return '—';
  return match?.includes('l') ? 'Literal' : 'Exact';
}

// Helpers for editing array columns as comma-separated strings
const arrToStr = (arr) => (arr || []).join(', ');
const strToArr = (str) => str.split(',').map(s => s.trim()).filter(Boolean);

function AddAliasDialog({ record, cartridges = [], onAdd, onClose }) {
  const _et = resolveEntityTypeFromId(record.msId);
  const _defaultDict = (() => {
    const rnef = _et?.rnef;
    if (['Protein', 'Complex', 'FunctionalClass', 'Treatment'].includes(rnef)) return 'curnames';
    if (rnef === 'SmallMol') return 'casdictionary';
    return 'celldictionary';
  })();

  const [alias,      setAlias]      = useState('');
  const [dict,       setDict]       = useState(_defaultDict);
  const [match,      setMatch]      = useState('');
  const [matchOpts,  setMatchOpts]  = useState([]);
  const [loadingM,   setLoadingM]   = useState(false);
  const [checking,   setChecking]   = useState(false);
  const [result,     setResult]     = useState(null); // { added: n, rejected: n } | null
  // Cache xwords sets so they are loaded at most once per dialog mount, not per alias
  const xwCacheRef = React.useRef(null);

  // Cartridges: all selected by default
  const allCartridgeNames = cartridges.map(c => c.name);
  const [selectedCartridges, setSelectedCartridges] = useState(allCartridgeNames);
  // Keep in sync if cartridges prop loads after mount
  useEffect(() => {
    setSelectedCartridges(cartridges.map(c => c.name));
  }, [cartridges.length]);

  // combNames is used only by the CellEffect cartridge: selecting that table unselects every other
  // cartridge (the earlier selection is restored when another table is chosen again).
  const COMB_CARTRIDGE = 'CellEffect';
  const prevCartsRef = React.useRef(null);
  useEffect(() => {
    if (dict === 'combnames') {
      setSelectedCartridges(prev => {
        if (prevCartsRef.current === null) prevCartsRef.current = prev;
        return allCartridgeNames.includes(COMB_CARTRIDGE) ? [COMB_CARTRIDGE] : prev;
      });
    } else if (prevCartsRef.current !== null) {
      setSelectedCartridges(prevCartsRef.current);
      prevCartsRef.current = null;
    }
  }, [dict]);

  // Organisms: collect distinct values from record's existing aliases, all selected by default
  const recordOrganisms = [...new Set(
    record.aliases.flatMap(a => (!a._deleted ? (a.organisms || []) : []))
  )].filter(Boolean).sort();
  const defaultOrganisms = recordOrganisms.length > 0 ? recordOrganisms : ['Mammal'];
  const [selectedOrganisms, setSelectedOrganisms] = useState(defaultOrganisms);
  const [newOrganism, setNewOrganism] = useState('');

  const toggleOrganism = (org) =>
    setSelectedOrganisms(s => s.includes(org) ? s.filter(o => o !== org) : [...s, org]);

  const addOrganism = () => {
    const v = newOrganism.trim();
    if (!v) return;
    if (!selectedOrganisms.includes(v)) setSelectedOrganisms(s => [...s, v]);
    setNewOrganism('');
  };

  // Load distinct match values for selected dict
  useEffect(() => {
    if (dict === 'chemnames') { // chemnames has no match column
      setMatchOpts([]);
      setMatch('');
      setLoadingM(false);
      return;
    }
    setLoadingM(true);
    const matchQ = dict === 'rsmap'
      ? `SELECT DISTINCT hgvs_code AS match FROM rsmap WHERE hgvs_code IS NOT NULL AND hgvs_code <> '' ORDER BY hgvs_code`
      : `SELECT DISTINCT match FROM "${dict}" WHERE match IS NOT NULL AND match <> '' ORDER BY match`;
    window.api.db.query(matchQ).then(r => {
      const vals = r.ok ? r.rows.map(row => row.match) : [];
      setMatchOpts(vals);
      setMatch('');
      setLoadingM(false);
    });
  }, [dict]);

  const aliasList = alias.split(/[\n;]/).map(s => s.trim()).filter(Boolean);

  const handleConfirm = async () => {
    if (aliasList.length === 0 || checking) return;
    setChecking(true);
    setResult(null);

    // Load xwords once for the selected dict (cached across calls within this dialog mount)
    if (!xwCacheRef.current) {
      const xwordsTableMap = {
        curnames: 'xwords', keywords: 'xwords', userdict: 'xwords',
        celldictionary: 'xwords_cells', casdictionary: 'xwords_cas',
        combnames: 'xwords_comb',
      };
      const svcTable = xwordsTableMap[dict];
      let xwordSet = new Set();
      if (svcTable) {
        const r = await window.api.db.query(`SELECT xword FROM ${svcTable} LIMIT 5000`);
        if (r.ok) xwordSet = new Set(r.rows.map(row => row.xword.toLowerCase()));
      }
      xwCacheRef.current = { table: dict, xwordSet };
    }
    // If dict changed since last cache, re-fetch
    if (xwCacheRef.current.table !== dict) {
      const xwordsTableMap = {
        curnames: 'xwords', keywords: 'xwords', userdict: 'xwords',
        celldictionary: 'xwords_cells', casdictionary: 'xwords_cas',
        combnames: 'xwords_comb',
      };
      const svcTable = xwordsTableMap[dict];
      let xwordSet = new Set();
      if (svcTable) {
        const r = await window.api.db.query(`SELECT xword FROM ${svcTable} LIMIT 5000`);
        if (r.ok) xwordSet = new Set(r.rows.map(row => row.xword.toLowerCase()));
      }
      xwCacheRef.current = { table: dict, xwordSet };
    }
    // Phase-1 tokenizer for intra-batch deduplication — matches against 'tokenized' column.
    const tokenize = makeXwordTokenizer(xwCacheRef.current.xwordSet);
    const tokenizeAlias = (a) => {
      if (dict === 'exactliteral' && (match || '').includes('l')) return a; // literal: verbatim
      return tokenize(a);
    };

    // For exactliteral, tokenized is already the canonical comparison key
    // (verbatim for match='l', lowercased for match='').
    // Do NOT additionally lowercase it — that would collapse 'GZMK' and 'Gzmk'
    // which are distinct under case-sensitive (l) matching.
    const setKey = (tok) => dict === 'exactliteral' ? (tok || '') : (tok || '').toLowerCase();

    // Collect tokenized forms already present in the record for this dict (synchronous now)
    const existingTokenized = new Set();
    for (const a of record.aliases) {
      if (a._deleted || a.dict !== dict) continue;
      const tok = a.tokenized || tokenizeAlias(a.alias);
      if (tok) existingTokenized.add(setKey(tok));
    }

    const accepted = [];
    const rejected = [];
    const invalidKeywords = []; // non-alphabetic aliases rejected before dup check
    const seenInBatch = new Set();

    for (const a of aliasList) {
      // Keywords must contain only letters (a–z); hyphens, digits, etc. are not allowed.
      if (dict === 'keywords' && !/^[a-zA-Z\s]+$/.test(a)) {
        invalidKeywords.push(a);
        continue;
      }

      const tok = tokenizeAlias(a);
      const tokKey = setKey(tok || a);

      if (existingTokenized.has(tokKey) || seenInBatch.has(tokKey)) {
        rejected.push({ alias: a, msId: record.msId }); continue;
      }

      // Use shared checkDuplicate with organism + cartridge filtering.
      // Same alias in a different organism/cartridge is NOT a duplicate.
      // For single organism selected: filter by it. For 0 or 2+ organisms: no filter (conservative).
      // Pass the raw alias — checkDuplicate routes to the correct normalizer for `dict` internally.
      let dupRow = null;
      try {
        // keywords are control terms: the same keyword may belong to several records, so only this record is checked (above)
        if (dict === 'keywords') {
          // the column "keywords" holds a comma-separated list: look for the word inside the lists of THIS record (LIKE, then exact comparison of the list items)
          const kwLc = a.trim().toLowerCase();
          const items = (s) => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
          let found = record.aliases.some(x => !x._deleted && x.dict === 'keywords' && items(x.alias).includes(kwLc));
          if (!found && record.msId != null) {
            const kr = await window.api.db.query(
              `SELECT keywords FROM keywords WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE) AND keywords ILIKE $2`,
              [record.msId, '%' + kwLc.replace(/[\\%_]/g, '\\$&') + '%']
            );
            if (!kr.ok) throw new Error(kr.error);
            found = kr.rows.some(r => items(r.keywords).includes(kwLc));
          }
          if (found) dupRow = { medscan_id: record.msId };
        } else dupRow = await checkDuplicate(
          a,
          dict, match,
          selectedOrganisms.length === 1 ? selectedOrganisms[0] : null,
          selectedCartridges.length > 0 ? selectedCartridges : null
        );
      } catch (e) {
        // never leave the dialog on "Checking…": show the database error and let the user retry
        setChecking(false);
        alert('Duplicate check failed: ' + (e?.message || e));
        return;
      }
      const isDup = dupRow !== null;
      const dupMsId = isDup ? dupRow.medscan_id : null;
      if (isDup) {
        rejected.push({ alias: a, msId: dupMsId });
      } else {
        accepted.push({ alias: a, tokenized: tok });
        seenInBatch.add(tokKey);
        existingTokenized.add(tokKey);
      }
    }

    setChecking(false);

    if (accepted.length > 0) {
      onAdd(accepted.map(({ alias: a, tokenized: tok }) => ({
        alias:      a,
        match:      match || '',
        dict,
        tokenized:  tok || '',
        cartridges: selectedCartridges,
        organisms:  selectedOrganisms,
        _orig: null, _origDict: null, _origMatch: null, _deleted: false,
      })));
    }

    if (invalidKeywords.length === 0 && rejected.length === 0) {
      onClose();
    } else {
      setResult({ added: accepted.length, rejected: rejected.length, rejectedItems: rejected, invalidKeywords });
    }
  };

  const inp = { fontSize: 12, padding: '4px 8px' };
  const lbl = { fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' };
  const chkList = { maxHeight: 110, overflowY: 'auto', border: '1px solid var(--border)',
                    borderRadius: 4, padding: '4px 6px', background: 'var(--surface)' };

  return (
    <div className="modal-backdrop" style={{ zIndex: 1100 }}>
      <div className="modal" style={{ maxWidth: 520, width: '96vw' }}>
        <div className="modal-title">Add Alias</div>

        <div className="form-group">
          <label style={lbl}>{dict === 'rsmap' ? 'Protein Name' : 'Alias text'}</label>
          <textarea className="form-control" style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}
            autoFocus rows={3}
            value={alias} onChange={e => { setAlias(e.target.value); setResult(null); }}
            placeholder={dict === 'rsmap' ? 'One protein name per line' : 'One alias per line, or separate with semicolons ( ; )'} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span className="text-xs text-muted">
              One alias per line, or semicolon-separated&nbsp;( ; ){aliasList.length > 1 && !result && <> — <strong>{aliasList.length} aliases</strong> will be checked</>}
            </span>
            {dict === 'combnames' && alias.trim() && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}
                title="Generate all permutations of this marker expression and add them all"
                onClick={() => {
                  // Take only the first alias from the textarea for permutation
                  const base = aliasList[0];
                  if (!base) return;
                  const perms = combPermutations(base);
                  setAlias(perms.join('\n'));
                  setResult(null);
                }}>
                ⇄ Permute
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={lbl}>Dictionary</label>
            <select className="form-control" style={inp} value={dict}
              onChange={e => { setDict(e.target.value); setResult(null); }}>
              {ALL_EDIT_TABLES.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={lbl}>{dict === 'rsmap' ? 'HGVS Code' : 'Match type'}</label>
            {dict === 'rsmap' ? (
              <input className="form-control" style={{ ...inp, minWidth: 180 }} value={match}
                onChange={e => setMatch(e.target.value)} placeholder="e.g. 1003G>A" />
            ) : (
              <>
                <select className="form-control" style={inp} value={match}
                  onChange={e => setMatch(e.target.value)} disabled={loadingM}>
                  <option value="">— (default) —</option>
                  {matchOpts.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {loadingM && <span className="text-xs text-muted">Loading…</span>}
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          {/* Cartridges */}
          <div>
            <label style={lbl}>
              Cartridges
              <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                ({selectedCartridges.length}/{allCartridgeNames.length})
              </span>
              {dict === 'combnames' && (
                <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  combNames is used only by {COMB_CARTRIDGE}
                </span>
              )}
            </label>
            <div style={chkList}>
              {allCartridgeNames.length === 0 ? (
                <span className="text-xs text-muted">No cartridges configured</span>
              ) : (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
                                  borderBottom: '1px solid var(--border)', paddingBottom: 3, marginBottom: 3 }}>
                    <input type="checkbox"
                      checked={selectedCartridges.length === allCartridgeNames.length}
                      disabled={dict === 'combnames'}
                      ref={el => { if (el) el.indeterminate = selectedCartridges.length > 0 && selectedCartridges.length < allCartridgeNames.length; }}
                      onChange={ev => setSelectedCartridges(ev.target.checked ? allCartridgeNames : [])} />
                    <strong>Select All</strong>
                  </label>
                  {allCartridgeNames.map(name => (
                    <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                      <input type="checkbox"
                        checked={selectedCartridges.includes(name)}
                        disabled={dict === 'combnames' && name !== COMB_CARTRIDGE}
                        onChange={ev => setSelectedCartridges(s =>
                          ev.target.checked ? [...s, name] : s.filter(x => x !== name)
                        )} />
                      {name}
                    </label>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Organisms */}
          <div>
            <label style={lbl}>
              Organisms
              <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                ({selectedOrganisms.length} selected)
              </span>
            </label>
            <div style={chkList}>
              {defaultOrganisms.map(org => (
                <label key={org} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <input type="checkbox"
                    checked={selectedOrganisms.includes(org)}
                    onChange={() => toggleOrganism(org)} />
                  {org}
                </label>
              ))}
              {/* organisms added this session but not in defaultOrganisms */}
              {selectedOrganisms.filter(o => !defaultOrganisms.includes(o)).map(org => (
                <label key={org} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <input type="checkbox" checked
                    onChange={() => toggleOrganism(org)} />
                  {org}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input className="form-control" style={{ ...inp, flex: 1 }}
                value={newOrganism} onChange={e => setNewOrganism(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addOrganism()}
                placeholder="Add organism…" />
              <button className="btn btn-secondary" style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={addOrganism} disabled={!newOrganism.trim()}>+</button>
            </div>
          </div>
        </div>

        {result && (
          <div className={`alert ${result.added === 0 ? 'alert-danger' : 'alert-info'}`}
               style={{ marginBottom: 0 }}>
            {result.added > 0 && (
              <span>✓ {result.added} alias{result.added !== 1 ? 'es' : ''} added.{' '}</span>
            )}
            {result.rejected > 0 && (
              <span>⚠ {result.rejected} alias{result.rejected !== 1 ? 'es' : ''} rejected — duplicate tokenized form:{' '}
                {result.rejectedItems.map((r, i) => (
                  <span key={i}>
                    {i > 0 && ', '}
                    <strong>"{r.alias}"</strong>
                    {r.msId != null && <> (NLP ID {Number(r.msId).toLocaleString()})</>}
                  </span>
                ))}
              </span>
            )}
            {result.invalidKeywords?.length > 0 && (
              <span style={{ color: 'var(--error, #f38ba8)' }}>
                ✕ {result.invalidKeywords.length} alias{result.invalidKeywords.length !== 1 ? 'es' : ''} rejected — keywords may only contain letters:{' '}
                {result.invalidKeywords.map(k => `"${k}"`).join(', ')}
              </span>
            )}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-secondary" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button className="btn btn-primary" onClick={handleConfirm}
              disabled={aliasList.length === 0 || checking}>
              {checking
                ? <><span className="spinner" /> Checking…</>
                : aliasList.length > 1 ? `✓ Add ${aliasList.length} aliases` : '✓ Add'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Module-level drag payload — shared between RecordSection instances for cross-record DnD
let _crossDragPayload = null;

// Shows all ObjectNames rows for an NLP ID when there are conflicts, with delete buttons.
function ObjectNamesConflictPanel({ primary, extras, onDelete }) {
  const [deletingId, setDeletingId] = React.useState(null);
  const allRows = [primary, ...extras]; // primary first
  const handleDelete = async (id) => {
    if (!window.confirm(`Delete this ObjectNames row?\n\nName: ${allRows.find(r => r.id === id)?.name}\nURN:  ${allRows.find(r => r.id === id)?.urn}`)) return;
    setDeletingId(id);
    await onDelete(id);
    setDeletingId(null);
  };
  return (
    <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)',
                  background: 'rgba(229,160,0,0.07)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning, #e5a000)', marginBottom: 4 }}>
        ⚠ Multiple ObjectNames rows for this NLP ID — delete the bogus one:
      </div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)' }}>
            <th style={{ textAlign: 'left', paddingRight: 8, fontWeight: 500, whiteSpace: 'nowrap' }}>Name</th>
            <th style={{ textAlign: 'left', paddingRight: 8, fontWeight: 500 }}>URN</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {allRows.map((row, i) => (
            <tr key={row.id ?? i}>
              <td style={{ paddingRight: 8, paddingBottom: 2, whiteSpace: 'nowrap' }}>
                {i === 0 && <span style={{ color: 'var(--text-muted)', marginRight: 4 }} title="Currently shown above as Name/URN">▶</span>}
                {row.name}
              </td>
              <td style={{ paddingRight: 8, paddingBottom: 2, fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                {row.urn}
              </td>
              <td style={{ paddingBottom: 2, whiteSpace: 'nowrap' }}>
                <button
                  className="btn btn-danger"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  disabled={deletingId != null}
                  onClick={() => handleDelete(row.id)}
                >
                  {deletingId === row.id ? '…' : '🗑 Delete'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Chip list backed by a dropdown of known options
const DropdownChipList = ({ values, options, onChange, placeholder }) => {
  const selected = new Set(values || []);
  const available = options.filter(o => !selected.has(o));
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
      {(values || []).map((val) => (
        <span key={val} style={{ display: 'inline-flex', alignItems: 'center', gap: 1,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 3, padding: '1px 4px', fontSize: 11 }}>
          {val}
          <button title="Remove"
            style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer',
                     fontSize: 12, lineHeight: 1, padding: '0 1px', marginLeft: 1 }}
            onClick={() => onChange((values).filter(v => v !== val))}>×</button>
        </span>
      ))}
      {available.length > 0 && (
        <select
          value=""
          style={{ fontSize: 11, padding: '1px 3px', borderRadius: 3,
                   border: '1px dashed var(--border)', background: 'var(--surface)',
                   color: 'var(--text-muted)', cursor: 'pointer' }}
          onChange={e => {
            if (!e.target.value) return;
            if (e.target.value === '__all__') onChange([...new Set([...(values || []), ...available])]);
            else onChange([...(values || []), e.target.value]);
          }}>
          <option value="">{placeholder}</option>
          <option value="__all__">— all —</option>
          {available.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
    </div>
  );
};


function RecordSection({ record, onChange, onSave, saving, isDirty, cartridges = [], onRemove, onFindLiterature, recIdx, onCrossDrop, clipboard, setClipboard, onDiscardClipboard, sharedMatchOpts, sharedOrganisms }) {
  const et = resolveEntityTypeFromId(record.msId);
  const [view, setView] = useState('dict'); // 'dict' | 'alias'
  // clipboard is lifted to RecordEditor so it survives record navigation
  // newDictRow: { dict, match } | null  — "Add dictionary" pending row
  const [newDictRow, setNewDictRow] = useState(null);
  // addAliasOpen: show AddAliasDialog
  const [addAliasOpen, setAddAliasOpen] = useState(false);
  // matchOptsLoaded: { [tableName]: string[] } — distinct match values per dict, loaded on record mount.
  // Kept local to RecordSection (not lifted to RecordEditor) so it only runs when a record is loaded,
  // not when the Edit Record tab is first opened.
  const [matchOptsLoaded, setMatchOptsLoaded] = useState(sharedMatchOpts || {});
  // drag-and-drop state
  const [draggedI,       setDraggedI]       = useState(null); // _i of alias being dragged (within this record)
  const [dragOverDict,   setDragOverDict]   = useState(null); // dict name hovered (same-record drop target)
  const [crossDragOver,  setCrossDragOver]  = useState(null); // dict name hovered (cross-record drop target)
  // Collapsed dict sections — Set of dict names. Auto-collapses groups >1 alias on record load.
  const [collapsedDicts, setCollapsedDicts] = useState(new Set());
  // Large dict groups: show only first N rows until user clicks "Show all".
  const LARGE_DICT_THRESHOLD = 10;
  const [largeDictExpanded, setLargeDictExpanded] = useState(new Set());
  // rsmap rows are shown in a separate modal, not inline in the dict table.
  const [rsmapModalOpen, setRsmapModalOpen] = useState(false);
  const knownOrganisms = sharedOrganisms || [];   // distinct organisms from DB, fetched once by parent
  // Row-level copy/paste clipboard for cartridges + organisms
  const [rowCopyClip,    setRowCopyClip]    = useState(null); // { cartridges, organisms } | null

  // Local state for Name/URN so keystrokes don't trigger expensive parent re-renders on every character.
  // Parent record is updated only on blur (onBlur) or when record.msId changes (load of new record).
  const [localName, setLocalName] = useState(record.entityName);
  const [localUrn,  setLocalUrn]  = useState(record.urn);
  const [typeChanging, setTypeChanging] = useState(false);
  const [typeError,    setTypeError]    = useState(null);
  // Keep local state in sync if parent updates from external source (e.g. record saved → fetchRecord)
  const prevMsId = React.useRef(record.msId);
  useEffect(() => {
    if (record.msId !== prevMsId.current) {
      prevMsId.current = record.msId;
      setLocalName(record.entityName);
      setLocalUrn(record.urn);
    }
  }, [record.msId, record.entityName, record.urn]);
  // Sync local fields when LLM applies values (record._llmName / _llmUrn set by parent)
  useEffect(() => {
    if (record._llmName) setLocalName(record.entityName);
  }, [record._llmName, record.entityName]);
  useEffect(() => {
    if (record._llmUrn) setLocalUrn(record.urn);
  }, [record._llmUrn, record.urn]);

  // Auto-collapse dict groups with >1 alias when a new record loads.
  // Groups with ≤1 alias are always shown expanded.
  useEffect(() => {
    const counts = new Map();
    for (const a of record.aliases) {
      if (a._deleted || a.bdeleted) continue;
      counts.set(a.dict, (counts.get(a.dict) ?? 0) + 1);
    }
    const toCollapse = new Set();
    for (const [dict, count] of counts) {
      if (count > 1) toCollapse.add(dict);
    }
    setCollapsedDicts(toCollapse);
    setLargeDictExpanded(new Set()); // reset large-group "show all" state for new record
  }, [record.msId]); // reset only when a different record is loaded

  // Fetch match options from the lookup table (tiny — populated at startup).
  // Single query instead of 8 per-table full-table scans.
  useEffect(() => {
    window.api.db.query(
      `SELECT table_name, match_value FROM match_opts_lookup ORDER BY table_name, match_value`
    ).then(r => {
      if (!r.ok) return;
      const map = {};
      for (const { table_name, match_value } of r.rows) {
        if (!map[table_name]) map[table_name] = [];
        map[table_name].push(match_value);
      }
      setMatchOptsLoaded(map);
    });
  }, []); // [] — run once per RecordSection mount

  const sel = { fontSize: 12, padding: '2px 4px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' };

  const [showDeleted, setShowDeleted] = useState(false);

  // Build groups: dict → [{ ...alias, _i }]
  // Memoized so that typing in the Name/URN fields (localName/localUrn state changes)
  // does NOT trigger an O(n-aliases) rebuild on every keystroke.
  const [groups, hasDeletedAliases, rsmapAliases] = useMemo(() => {
    const g = new Map();
    const rsmap = [];
    record.aliases.forEach((a, i) => {
      if (a._deleted) return; // pending in-memory delete — never show
      if (a.bdeleted && !showDeleted) return; // soft-deleted — hide unless toggle is on
      if (a.dict === 'rsmap') { rsmap.push({ ...a, _i: i }); return; } // rsmap shown in separate modal
      if (!g.has(a.dict)) g.set(a.dict, []);
      g.get(a.dict).push({ ...a, _i: i });
    });
    const hasDeleted = record.aliases.some(a => a.bdeleted && !a._deleted);
    return [g, hasDeleted, rsmap];
  }, [record.aliases, showDeleted]);

  const updateAlias = (i, patch) =>
    onChange({ ...record, aliases: record.aliases.map((x, j) => j === i ? { ...x, ...patch } : x) });

  // Ontology rows (table ontology) of this record: shown in the dictionary table like the keywords, edited in place, saved with the record
  const ontology = record.ontology || [];
  const updateOntology = (i, patch) => onChange({ ...record, ontology: ontology.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const removeOntology = (i) => onChange({ ...record, ontology: ontology[i]._id == null ? ontology.filter((_, j) => j !== i) : ontology.map((x, j) => (j === i ? { ...x, _deleted: true } : x)) });
  const addOntology = () => onChange({ ...record, ontology: [...ontology, { _id: null, class: '', urn: '', _origClass: null, _origUrn: null, _deleted: false }] });
  const ontologyShown = ontology.filter(o => !o._deleted || showDeleted);
  const ontologyRows = ontologyShown.map((o, k) => {
    const i = ontology.indexOf(o);
    return (
      <tr key={`ont-${i}`} style={{ background: 'rgba(60,180,200,0.07)', ...(k === 0 ? { borderTop: '2px solid var(--border)' } : {}), ...(o._deleted ? { textDecoration: 'line-through', color: 'var(--danger, #c44)', opacity: 0.7 } : {}) }}>
        <td className="mono" style={{ fontSize: 12, verticalAlign: 'middle', color: k === 0 ? 'var(--text)' : 'var(--text-muted)', opacity: k === 0 ? 1 : 0 }}>ontology</td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input className="form-control" list="ontology-classes" placeholder="class" title="Ontology class, e.g. Receptors, Ligands" value={o.class} disabled={o._deleted}
              style={{ padding: '1px 5px', width: 190 }} onChange={e => updateOntology(i, { class: e.target.value })} />
            <input className="form-control mono" placeholder="urn" title="URN" value={o.urn} disabled={o._deleted}
              style={{ padding: '1px 5px', fieldSizing: 'content', width: 'auto', minWidth: 220 }} onChange={e => updateOntology(i, { urn: e.target.value })} />
            {o._deleted
              ? <button title="Restore" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14 }} onClick={() => updateOntology(i, { _deleted: false })}>↩</button>
              : <button title="Remove this ontology row (on Save)" style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 15 }} onClick={() => removeOntology(i)}>×</button>}
          </div>
        </td>
        <td />
      </tr>
    );
  });

  const handleAddAlias = (newAlias) => {
    const toAdd = (Array.isArray(newAlias) ? newAlias : [newAlias]).map(a =>
      a.dict === 'keywords' ? { ...a, alias: a.alias.toLowerCase() } : a
    );
    // keywords: a record has ONE keywords row holding a comma-separated list, so a new keyword is appended to that list (like editing the row by hand) and not added as a row of its own
    let aliases = [...record.aliases];
    for (const a of toAdd) {
      const k = a.dict === 'keywords' ? aliases.findIndex(x => x.dict === 'keywords' && !x._deleted) : -1;
      if (k < 0) { aliases.push(a); continue; }       // no keywords row yet: this one becomes it (the next keywords of the batch join it)
      const have = String(aliases[k].alias || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!have.some(s => s.toLowerCase() === a.alias.trim().toLowerCase())) aliases[k] = { ...aliases[k], alias: [...have, a.alias.trim()].join(',') };
    }
    onChange({ ...record, aliases });
  };

  // × next to an alias = cut to clipboard
  const handleCut = (item) => {
    // _id / srcDict identify the DB row: it is hard-deleted when the paste is saved (a move),
    // or soft-deleted (bdeleted = TRUE) ONLY by the Discard button.
    setClipboard({ alias: item.alias, match: item.match, _id: item._id ?? null, srcDict: item._origDict || item.dict });
    updateAlias(item._i, { _deleted: true });
  };

  // Change match for entire dict group (updates every alias in that group)
  const handleMatchChange = (dict, newMatch) => {
    const updated = record.aliases.map(a =>
      (!a._deleted && a.dict === dict) ? { ...a, match: newMatch } : a
    );
    onChange({ ...record, aliases: updated });
  };

  // Organisms of the record: read only, the union over the aliases (each alias has its own set).
  // Memoized so typing in Name/URN does not re-scan all aliases on every keystroke.
  const recordOrganisms = useMemo(() => [...new Set(
    record.aliases.filter(a => !a._deleted && !a.bdeleted).flatMap(a => a.organisms || [])
  )], [record.aliases]);

  // Cartridges of the record: read only, the union over the aliases.
  const recordCartridges = useMemo(() => [...new Set(
    record.aliases.filter(a => !a._deleted && !a.bdeleted).flatMap(a => a.cartridges || [])
  )], [record.aliases]);

  // Paste clipboard into the new dict row
  const handlePaste = () => {
    if (!clipboard || !newDictRow) return;
    const pasteDict  = newDictRow.dict;
    const pasteMatch = newDictRow.match || clipboard.match ||
                       (pasteDict === 'exactliteral' ? 'l' : '');
    onChange({
      ...record,
      aliases: [...record.aliases, {
        alias: clipboard.alias,
        match: pasteMatch,
        dict: pasteDict,
        _orig: null, _origDict: null, _origMatch: null, _deleted: false,
        // completing the move: the source DB row is hard-deleted when this record is saved
        _moveFrom: clipboard._id != null ? { id: clipboard._id, dict: clipboard.srcDict } : null,
      }],
    });
    setClipboard(null);
    setNewDictRow(null);
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {addAliasOpen && (
        <AddAliasDialog
          record={record}
          cartridges={cartridges}
          onAdd={handleAddAlias}
          onClose={() => setAddAliasOpen(false)}
        />
      )}

      {/* Header */}
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <span style={{ fontWeight: 700 }}>
          Elsevier NLP ID: {Number(record.msId).toLocaleString()}
          {et && <span style={{ fontWeight: 400, fontSize: 12, marginLeft: 10, opacity: 0.7 }}>({et.display} / {et.rnef})</span>}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ display: 'flex', borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <button
              style={{ fontSize: 11, padding: '2px 10px', border: 'none', cursor: 'pointer',
                background: view === 'dict' ? 'var(--accent)' : 'var(--surface)',
                color:      view === 'dict' ? '#fff'          : 'var(--text)' }}
              onClick={() => setView('dict')}>Dictionary view</button>
            <button
              style={{ fontSize: 11, padding: '2px 10px', border: 'none', borderLeft: '1px solid var(--border)', cursor: 'pointer',
                background: view === 'alias' ? 'var(--accent)' : 'var(--surface)',
                color:      view === 'alias' ? '#fff'           : 'var(--text)' }}
              onClick={() => setView('alias')}>Alias view</button>
          </div>
          {hasDeletedAliases && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
              Show deleted
            </label>
          )}
          <button className="btn btn-primary"
            style={{ padding: '3px 16px', fontSize: 12, opacity: (!isDirty && !saving) ? 0.4 : 1 }}
            onClick={onSave} disabled={saving || !isDirty}>
            {saving ? <><span className="spinner" /> Saving…</> : '💾 Save'}
          </button>
        </div>
      </div>

      {/* Name, URN, Organisms */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)',
                    display: 'grid', gridTemplateColumns: '70px 1fr', gap: '5px 8px', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Name</span>
        <input className="form-control" value={localName}
          onChange={e => { setLocalName(e.target.value); onChange({ ...record, entityName: e.target.value, _llmName: false }); }}
          onBlur={() => onChange({ ...record, entityName: localName, urn: localUrn })}
          style={record._llmName ? { background: 'rgba(255,190,30,0.18)', border: '1px solid rgba(255,190,30,0.7)' } : undefined}
          title={record._llmName ? '🤖 Suggested by LLM — review and save to keep' : undefined} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>URN</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input className="form-control" value={localUrn}
            onChange={e => { setLocalUrn(e.target.value); onChange({ ...record, urn: e.target.value, _llmUrn: false }); }}
            onBlur={() => onChange({ ...record, entityName: localName, urn: localUrn })}
            style={record._llmUrn ? { background: 'rgba(255,190,30,0.18)', border: '1px solid rgba(255,190,30,0.7)' } : undefined}
            title={record._llmUrn ? '🤖 Suggested by LLM — review and save to keep' : undefined} />
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}
            title="Generate URN from current name"
            onClick={() => {
              const newUrn = et ? buildEntityUrn(localName, et) : localUrn;
              setLocalUrn(newUrn);
              onChange({ ...record, entityName: localName, urn: newUrn });
            }}>
            ↺ Generate URN
          </button>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Type</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select className="form-control" style={{ width: 'auto' }}
            value={et?.rnef ?? ''}
            disabled={typeChanging}
            onChange={async (e) => {
              const targetRnef = e.target.value;
              const targetEt = ENTITY_TYPES.find(x => x.rnef === targetRnef);
              if (!targetEt || targetRnef === et?.rnef) return;
              setTypeChanging(true); setTypeError(null);
              const { id: newId, error } = await getNextIdInRange(targetEt.min, targetEt.max);
              setTypeChanging(false);
              if (error || newId == null) { setTypeError(error || 'No available ID in target range.'); return; }
              const newUrn = buildEntityUrn(record.entityName || localName, targetEt);
              setLocalUrn(newUrn);
              onChange({ ...record, msId: newId, entityName: record.entityName || localName, urn: newUrn });
            }}>
            {ENTITY_TYPES.map(x => <option key={x.rnef} value={x.rnef}>{x.display} ({x.min.toLocaleString('en-US')}-{x.max.toLocaleString('en-US')})</option>)}
          </select>
          {typeChanging && <span className="spinner" />}
          {typeError   && <span style={{ color: 'var(--danger, #c33)', fontSize: 12 }}>{typeError}</span>}
          {/* Curated badge */}
          <span style={{
            fontSize: 11, padding: '1px 7px', borderRadius: 10,
            background: record.isCurated ? 'rgba(166,227,161,0.18)' : 'rgba(127,127,127,0.12)',
            border: `1px solid ${record.isCurated ? '#a6e3a1' : 'var(--border)'}`,
            color: record.isCurated ? '#a6e3a1' : 'var(--text-muted)',
            userSelect: 'none',
          }} title={record.isCurated ? 'This record has been manually curated' : 'Not yet curated'}>
            {record.isCurated ? '✓ Curated' : 'Not curated'}
          </span>
          {/* Latest updated_at */}
          {record.latestUpdatedAt && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}
              title="Last modification date of any alias">
              Updated: {new Date(record.latestUpdatedAt).toLocaleString()}
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, alignSelf: 'start', paddingTop: 4 }}>Organisms</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', minHeight: 26 }}>
          {/* read only: the union of the organisms of the aliases below — each alias has its own set (edit them per alias) */}
          {recordOrganisms.map((x, i) => (
            <span key={i} title="Union of the organisms of all aliases (read only) — edit them on the aliases" style={{ display: 'inline-flex', alignItems: 'center', background: 'var(--surface-2, #2a2d3e)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>{x}</span>
          ))}
          {recordOrganisms.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>none</span>}
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, alignSelf: 'start', paddingTop: 4 }}>Cartridges</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', minHeight: 26 }}>
          {/* read only: the union of the cartridges of the aliases below */}
          {recordCartridges.map((x, i) => (
            <span key={i} title="Union of the cartridges of all aliases (read only) — edit them on the aliases" style={{ display: 'inline-flex', alignItems: 'center', background: 'var(--surface-2, #2a2d3e)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>{x}</span>
          ))}
          {recordCartridges.length === 0 && <span style={{ fontSize: 11, color: 'var(--danger, #f38ba8)' }}>none — required to save</span>}
        </div>
      </div>

      {/* ObjectNames conflict rows — shown when this NLP ID has multiple entries in objectnames */}
      {record.extraObjectNames?.length > 0 && (
        <ObjectNamesConflictPanel
          primary={{ id: record.objectNamesId, name: record.entityName, urn: record.urn }}
          extras={record.extraObjectNames}
          onDelete={async (deletedId) => {
            const res = await window.api.db.query(
              `DELETE FROM objectnames WHERE id = $1`, [deletedId]
            );
            if (!res.ok) { alert('Delete failed: ' + res.error); return; }
            // Update record in memory: if primary deleted, promote first extra; else remove from extras
            if (deletedId === record.objectNamesId) {
              const [promoted, ...remaining] = record.extraObjectNames;
              onChange({
                ...record,
                entityName: promoted.name, _origEntityName: promoted.name,
                urn: promoted.urn,        _origUrn: promoted.urn,
                objectNamesId: promoted.id,
                extraObjectNames: remaining,
              });
            } else {
              onChange({
                ...record,
                extraObjectNames: record.extraObjectNames.filter(x => x.id !== deletedId),
              });
            }
          }}
        />
      )}

      {/* Clipboard banner */}
      {clipboard && (
        <div style={{ padding: '6px 12px', background: 'rgba(124,106,247,0.1)',
                      borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span>✂ Clipboard: <strong>{clipboard.alias}</strong></span>
          <span style={{ color: 'var(--text-muted)' }}>
            {newDictRow ? '— choose dictionary and click Paste' : '— click "Add dictionary" to paste'}
          </span>
          <button style={{ ...sel, cursor: 'pointer', color: '#c33', marginLeft: 'auto' }}
            onClick={() => {
              setNewDictRow(null);
              // Discard is the ONLY place that sets bdeleted = TRUE (see RecordEditor.discardClipboard)
              onDiscardClipboard?.();
            }}>✕ SoftDelete</button>
        </div>
      )}

      {/* ── Alias view — one row per alias ───────────────────────────── */}
      {view === 'alias' && (() => {
        const active = record.aliases.map((a, i) => ({ ...a, _i: i })).filter(a => a.dict !== 'rsmap' && !a._deleted && (!a.bdeleted || showDeleted));   // rsmap records (thousands for some genes) are edited in their own dialog of the Dictionary view

        const cartridgeNames = cartridges.map(c => c.name);

        return (<>
          {rowCopyClip && (
            <div style={{ marginBottom: 6, padding: '3px 8px', background: 'var(--surface-2)', borderRadius: 4,
              fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>📋 Clipboard: <strong>{rowCopyClip.cartridges.join(', ') || '—'}</strong>
                {rowCopyClip.organisms.length > 0 && <> · organisms: <strong>{rowCopyClip.organisms.join(', ')}</strong></>}
              </span>
              <button style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 12 }}
                onClick={() => setRowCopyClip(null)}>✕ Clear</button>
            </div>
          )}
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Dictionary</th>
                <th>Alias</th>
                <th style={{ width: 160 }}>Tokenized</th>
                <th style={{ width: 75 }}>Match</th>
                <th>Cartridges</th>
                <th>Organisms</th>
                <th style={{ width: 90, whiteSpace: 'nowrap' }}>
                  {rowCopyClip && (() => {
                    const targets = active.filter(a => !a.bdeleted);
                    return (
                      <button disabled={!targets.length}
                        title={`Paste to ALL ${targets.length} alias(es) below: cartridges [${rowCopyClip.cartridges.join(', ')}] + organisms [${rowCopyClip.organisms.join(', ')}] replace their current values`}
                        style={{ background: 'none', border: '1px solid var(--accent)', borderRadius: 3, cursor: 'pointer', fontSize: 11, padding: '1px 6px', color: 'var(--accent)' }}
                        onClick={() => {
                          const idx = new Set(targets.map(a => a._i));
                          onChange({ ...record, aliases: record.aliases.map((x, j) => idx.has(j) ? { ...x, cartridges: [...rowCopyClip.cartridges], organisms: [...rowCopyClip.organisms] } : x) });
                        }}>⬇ All ({targets.length})</button>
                    );
                  })()}
                </th>
              </tr>
            </thead>
            <tbody>
              {active.length === 0 && (
                <tr><td colSpan={7} style={{ color: 'var(--text-muted)', fontSize: 12 }}>No aliases.</td></tr>
              )}
              {active.map(item => {
                const matchVals = matchOptsLoaded[item.dict] || [];
                return (
                  <tr key={item._i}
                    style={item._llmSource ? { background: 'rgba(255,190,30,0.10)', outline: '1px solid rgba(255,190,30,0.45)' } : undefined}
                    title={item._llmSource ? '🤖 Suggested by LLM — review and save to keep' : undefined}>
                    <td>
                      <select style={sel} value={item.dict}
                        onChange={e => {
                          const newDict = e.target.value;
                          // exactliteral always requires a match flag; default to 'l' (case-sensitive).
                          // For all other tables reset to '' so the group match dropdown controls it.
                          const newMatch = newDict === 'exactliteral' ? 'l' : '';
                          updateAlias(item._i, { dict: newDict, match: newMatch });
                        }}>
                        {ALL_EDIT_TABLES.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                    <td style={{ maxWidth: 200, whiteSpace: item.dict === 'keywords' ? 'normal' : undefined,
                        wordBreak: item.dict === 'keywords' ? 'break-word' : undefined }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                        {item.dict === 'keywords'
                          ? <span style={{ fontSize: 12, flex: 1 }}>{item.alias}</span>
                          : <input className="form-control"
                              value={item.alias}
                              style={{ padding: '1px 5px', width: `${Math.max((item.alias||'').length + 2, 8)}ch`, minWidth: 60 }}
                              onChange={e => updateAlias(item._i, { alias: e.target.value })} />
                        }
                        <button title="Cut alias"
                          style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 15, padding: '0 2px', flexShrink: 0 }}
                          onClick={() => handleCut(item)}>×</button>
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: item.dict === 'keywords' ? 'normal' : 'nowrap',
                        wordBreak: item.dict === 'keywords' ? 'break-word' : undefined }}
                        title={item.normalized ? `normalized (medscan):\n${item.normalized}` : (item.tokenized ? `tokenized:\n${item.tokenized}` : undefined)}>
                      {item.normalized || item.tokenized || '—'}
                    </td>
                    <td>
                      <select style={sel} value={item.match || ''}
                        onChange={e => updateAlias(item._i, { match: e.target.value })}>
                        <option value="">—</option>
                        {matchVals.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                    <td>
                      <DropdownChipList
                        values={item.cartridges || []}
                        options={cartridgeNames}
                        onChange={next => updateAlias(item._i, { cartridges: next })}
                        placeholder="+ cartridge"
                      />
                    </td>
                    <td>
                      <DropdownChipList
                        values={item.organisms || []}
                        options={knownOrganisms}
                        onChange={next => updateAlias(item._i, { organisms: next })}
                        placeholder="+ organism"
                      />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        title="Copy cartridges + organisms from this row"
                        style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3,
                          cursor: 'pointer', fontSize: 11, padding: '1px 5px', color: 'var(--text-muted)' }}
                        onClick={() => setRowCopyClip({ cartridges: item.cartridges || [], organisms: item.organisms || [] })}>
                        📋
                      </button>
                      {rowCopyClip && (
                        <button
                          title={`Paste: cartridges [${rowCopyClip.cartridges.join(', ')}] + organisms [${rowCopyClip.organisms.join(', ')}]`}
                          style={{ background: 'none', border: '1px solid var(--accent)', borderRadius: 3,
                            cursor: 'pointer', fontSize: 11, padding: '1px 5px', color: 'var(--accent)', marginLeft: 3 }}
                          onClick={() => updateAlias(item._i, { cartridges: [...rowCopyClip.cartridges], organisms: [...rowCopyClip.organisms] })}>
                          ⬇
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '6px 12px', display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-success" style={{ fontSize: 11 }}
              onClick={() => setAddAliasOpen(true)}>
              + Add alias
            </button>
            <button className="btn btn-sm btn-danger" style={{ fontSize: 11, marginLeft: 'auto' }}
              onClick={onRemove}>
              🗑 Remove record
            </button>
          </div>
        </>
        );
      })()}

      {/* ── Dictionary view — one row per alias, sorted alphabetically ── */}
      {view === 'dict' && <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 140 }}>Dictionary</th>
            <th>Alias</th>
            <th style={{ width: 95 }}>Match</th>
          </tr>
        </thead>
        <tbody>
          {groups.size === 0 && !newDictRow && (
            <tr><td colSpan={3} style={{ color: 'var(--text-muted)', fontSize: 12 }}>No aliases.</td></tr>
          )}

          {[...groups.entries()].map(([dict, items], groupIdx) => {
            const matchVals = matchOptsLoaded[dict] || [];
            const sorted = [...items].sort((a, b) => (a.alias || '').localeCompare(b.alias || ''));
            const isSameRecordTarget = dragOverDict === dict && draggedI !== null &&
              record.aliases[draggedI]?.dict !== dict;
            const isCrossRecordTarget = crossDragOver === dict;
            const isDropTarget = isSameRecordTarget || isCrossRecordTarget;
            const GROUP_TINTS = [
              'rgba(80,120,200,0.07)',
              'rgba(80,180,120,0.07)',
              'rgba(200,140,60,0.07)',
              'rgba(180,80,180,0.07)',
              'rgba(60,180,200,0.07)',
              'rgba(200,80,80,0.07)',
            ];
            const groupBg = GROUP_TINTS[groupIdx % GROUP_TINTS.length];
            const isCollapsed = collapsedDicts.has(dict) && sorted.length > 1;
            const canCollapse = sorted.length > 1;
            const toggleCollapsed = () => setCollapsedDicts(prev => {
              const next = new Set(prev); next.has(dict) ? next.delete(dict) : next.add(dict); return next;
            });

            // Shared drop handlers for both collapsed header and expanded drop-zone row
            const sharedDropHandlers = {
              onDragOver: e => {
                e.preventDefault(); e.dataTransfer.dropEffect = 'move';
                if (_crossDragPayload && _crossDragPayload.recIdx !== recIdx) setCrossDragOver(dict);
                else if (draggedI !== null) setDragOverDict(dict);
              },
              onDragLeave: () => { setDragOverDict(null); setCrossDragOver(null); },
              onDrop: e => {
                e.preventDefault();
                if (_crossDragPayload && _crossDragPayload.recIdx !== recIdx) {
                  onCrossDrop?.(_crossDragPayload, recIdx, dict);
                  _crossDragPayload = null;
                } else if (draggedI !== null) {
                  const srcDict = record.aliases[draggedI]?.dict;
                  if (srcDict !== dict) updateAlias(draggedI, { dict, match: '' });
                  setDraggedI(null);
                }
                setDragOverDict(null); setCrossDragOver(null);
              },
            };

            // ── Collapsed header row ──
            if (isCollapsed) {
              return (
                <tr key={`collapsed-${dict}`}
                  style={{
                    background: isDropTarget ? 'rgba(124,106,247,0.12)' : groupBg,
                    ...(groupIdx > 0 ? { borderTop: '2px solid var(--border)' } : {}),
                    ...(isDropTarget ? { outline: '2px dashed var(--accent)' } : {}),
                    cursor: 'pointer',
                  }}
                  onClick={toggleCollapsed}
                  {...sharedDropHandlers}>
                  <td className="mono" style={{ fontSize: 12, padding: '5px 6px', verticalAlign: 'middle' }}>
                    <span style={{ marginRight: 5, color: 'var(--text-muted)', fontSize: 10 }}>▶</span>
                    {dict}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)', padding: '5px 6px', verticalAlign: 'middle' }}>
                    {sorted.length} alias{sorted.length !== 1 ? 'es' : ''}
                    {isDropTarget && <span style={{ marginLeft: 10, color: 'var(--accent)', fontSize: 11, fontStyle: 'italic' }}>drop here</span>}
                  </td>
                  <td />
                </tr>
              );
            }

            // ── Expanded: alias rows + drop-zone row ──
            const dropZoneRow = (
              <tr key={`dz-${dict}`}
                style={{ height: 6, padding: 0,
                  background: isCrossRecordTarget ? 'rgba(124,106,247,0.18)' : groupBg,
                  ...(isCrossRecordTarget ? { outline: '2px dashed var(--accent)' } : {}) }}
                {...sharedDropHandlers}>
                <td colSpan={3} style={{ padding: 0 }} />
              </tr>
            );

            // Limit rows for large groups to prevent UI freeze.
            const isLargeGroup = sorted.length > LARGE_DICT_THRESHOLD;
            const showAllLarge = largeDictExpanded.has(dict);
            const visibleSorted = isLargeGroup && !showAllLarge
              ? sorted.slice(0, LARGE_DICT_THRESHOLD)
              : sorted;

            return [
              ...visibleSorted.map((item, k) => (
              <tr key={item._i}
                draggable
                onDragStart={e => {
                  setDraggedI(item._i);
                  _crossDragPayload = { recIdx, aliasI: item._i, alias: item.alias,
                    _id: item._id ?? null, srcDict: item._origDict || item.dict,
                    match: item.match, dict: item.dict,
                    cartridges: item.cartridges, organisms: item.organisms };
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', item.alias);
                }}
                onDragOver={e => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (_crossDragPayload && _crossDragPayload.recIdx !== recIdx) {
                    setCrossDragOver(dict);
                  } else if (draggedI !== null && draggedI !== item._i) {
                    setDragOverDict(dict);
                  }
                }}
                onDragLeave={() => { setDragOverDict(null); setCrossDragOver(null); }}
                onDrop={e => {
                  e.preventDefault();
                  if (_crossDragPayload && _crossDragPayload.recIdx !== recIdx) {
                    onCrossDrop?.(_crossDragPayload, recIdx, dict);
                    _crossDragPayload = null;
                  } else if (draggedI !== null) {
                    const srcDict = record.aliases[draggedI]?.dict;
                    if (srcDict !== dict) updateAlias(draggedI, { dict, match: '' });
                    setDraggedI(null);
                  }
                  setDragOverDict(null);
                  setCrossDragOver(null);
                }}
                onDragEnd={() => {
                  setDraggedI(null); setDragOverDict(null); setCrossDragOver(null);
                  _crossDragPayload = null;
                }}
                style={{
                  background: isDropTarget ? 'rgba(124,106,247,0.12)' : (item._llmSource ? 'rgba(255,190,30,0.10)' : groupBg),
                  ...(k === 0 && groupIdx > 0 ? { borderTop: '2px solid var(--border)' } : {}),
                  ...(isDropTarget ? { outline: '2px dashed var(--accent)' } : {}),
                  ...(item._llmSource && !isDropTarget ? { outline: '1px solid rgba(255,190,30,0.45)' } : {}),
                  ...(item.bdeleted ? { textDecoration: 'line-through', color: 'var(--danger, #c44)', opacity: 0.7 } : {}),
                  ...(draggedI === item._i ? { opacity: 0.4 } : {}),
                  cursor: 'grab',
                }}
                title={item._llmSource ? '🤖 Suggested by LLM — review and save to keep' : undefined}>
                {/* Dict name on first row, with collapse toggle if group has >1 alias */}
                <td className="mono"
                  style={{ fontSize: 12, verticalAlign: 'middle',
                           color: k === 0 ? 'var(--text)' : 'var(--text-muted)',
                           opacity: k === 0 ? 1 : 0 }}>
                  {k === 0 && canCollapse && (
                    <span
                      title="Collapse this dictionary section"
                      onClick={e => { e.stopPropagation(); toggleCollapsed(); }}
                      style={{ marginRight: 4, color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer', userSelect: 'none' }}>▼</span>
                  )}
                  {dict}
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span title="Drag to move to another dictionary or another record"
                      style={{ color: 'var(--text-muted)', fontSize: 13, cursor: 'grab',
                               userSelect: 'none', padding: '0 3px', flexShrink: 0 }}>⠿</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {/* The box is as wide as its text (field-sizing: content measures the real font, unlike a "ch" estimate). Keywords and very long
                          aliases are wrapped onto further lines (a textarea that grows with its text) so that the whole text is always visible. */}
                      {(() => {
                        const tip = [
                          item.cartridges?.length ? `cartridges: ${item.cartridges.join(', ')}` : null,
                          item.organisms?.length  ? `organisms: ${item.organisms.join(', ')}`   : null,
                          item.date_created  ? `created: ${new Date(item.date_created).toLocaleString()}`  : null,
                          item.date_modified ? `modified: ${new Date(item.date_modified).toLocaleString()}` : null,
                        ].filter(Boolean).join('\n') || undefined;
                        return (item.dict === 'keywords' || (item.alias || '').length > 90)
                          ? <textarea
                              className="form-control"
                              rows={1}
                              value={item.alias}
                              title={tip}
                              style={{ padding: '1px 5px', fieldSizing: 'content', width: 'auto', minWidth: 60, maxWidth: '90ch', resize: 'none', overflow: 'hidden', lineHeight: 1.35, fontFamily: 'inherit' }}
                              onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                              onChange={e => updateAlias(item._i, { alias: e.target.value.replace(/[\r\n]+/g, ' ') })}
                            />
                          : <input
                              className="form-control"
                              value={item.alias}
                              title={tip}
                              style={{ padding: '1px 5px', fieldSizing: 'content', width: 'auto', minWidth: 60 }}
                              onChange={e => updateAlias(item._i, { alias: e.target.value })}
                            />;
                      })()}
                      {(item.normalized || item.tokenized) && item.dict !== 'exactliteral' && (
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
                          paddingLeft: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          maxWidth: `${Math.min(Math.max(((item.normalized||item.tokenized)||'').length + 4, 10), 80)}ch` }}
                          title={item.normalized
                            ? `normalized (medscan): ${item.normalized}${item.tokenized ? `\ntokenized: ${item.tokenized}` : ''}`
                            : `tokenized: ${item.tokenized}`}>
                          {item.normalized || item.tokenized}
                        </span>
                      )}
                    </div>
                    {item.bdeleted
                      ? <button title="Restore alias"
                          style={{ background: 'none', border: 'none', color: 'var(--accent, #7c6af7)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}
                          onClick={() => updateAlias(item._i, { bdeleted: false })}>↩</button>
                      : <button
                          title="Cut alias (move to another record or dictionary)"
                          style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}
                          onClick={() => handleCut(item)}>×</button>
                    }
                  </div>
                </td>
                <td style={{ verticalAlign: 'middle' }}>
                  <select style={sel} value={item.match || ''}
                    onChange={e => updateAlias(item._i, { match: e.target.value })}>
                    <option value="">—</option>
                    {matchVals.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </td>
              </tr>
            )),
            // "Show all" button row for large groups
            isLargeGroup && !showAllLarge && (
              <tr key={`show-all-${dict}`} style={{ background: groupBg }}>
                <td colSpan={3} style={{ padding: '4px 10px', textAlign: 'left' }}>
                  <button
                    className="btn btn-sm btn-secondary"
                    style={{ fontSize: 11, padding: '2px 10px' }}
                    onClick={() => setLargeDictExpanded(prev => { const n = new Set(prev); n.add(dict); return n; })}>
                    ▼ Show all {sorted.length} aliases ({sorted.length - LARGE_DICT_THRESHOLD} more)
                  </button>
                </td>
              </tr>
            ),
            dropZoneRow];
          })}

          {/* New dictionary row */}
          {ontologyRows}

          {newDictRow && (
            <tr style={{ background: 'rgba(124,106,247,0.06)' }}>
              <td style={{ verticalAlign: 'middle' }}>
                {clipboard
                  ? <span style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--text-muted)' }}>
                      {clipboard.alias} <em>(will be pasted)</em>
                    </span>
                  : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Cut an alias above to paste here</span>
                }
              </td>
              <td>
                <select style={sel} value={newDictRow.dict}
                  onChange={e => setNewDictRow(r => ({ ...r, dict: e.target.value, match: '' }))}>
                  {ALL_EDIT_TABLES.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select style={sel} value={newDictRow.match || ''}
                    onChange={e => setNewDictRow(r => ({ ...r, match: e.target.value }))}>
                    <option value="">—</option>
                    {(matchOptsLoaded[newDictRow.dict] || []).map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  {clipboard &&
                    <button className="btn btn-sm btn-primary" style={{ fontSize: 11, padding: '2px 10px' }}
                      onClick={handlePaste}>📋 Paste</button>
                  }
                  <button style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 15, padding: '0 2px' }}
                    onClick={() => setNewDictRow(null)}>×</button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>}

      {/* rsmap records link — shown below the dict table when there are rsmap rows */}
      {view === 'dict' && rsmapAliases.length > 0 && (
        <div style={{ padding: '4px 12px', borderTop: '1px solid var(--border)' }}>
          <button className="link-btn" style={{ fontSize: 12 }}
            onClick={() => setRsmapModalOpen(true)}>
            🧬 Edit {rsmapAliases.length} rsmap record{rsmapAliases.length !== 1 ? 's' : ''}
          </button>
        </div>
      )}

      {/* rsmap modal */}
      {rsmapModalOpen && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 820, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-title" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>rsmap — {rsmapAliases.length} record{rsmapAliases.length !== 1 ? 's' : ''} for NLP ID {Number(record.msId).toLocaleString()}</span>
              <button onClick={() => setRsmapModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'var(--text-muted)', padding: '0 2px' }}
                title="Close">×</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Protein name</th>
                    <th>HGVS code</th>
                    <th>URN</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {rsmapAliases.map(item => (
                    <tr key={item._i} style={item.bdeleted ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}>
                      <td>
                        <input className="form-control" style={{ padding: '1px 5px', width: '100%', minWidth: 120 }}
                          value={item.alias}
                          onChange={e => updateAlias(item._i, { alias: e.target.value })} />
                      </td>
                      <td>
                        <input className="form-control mono" style={{ padding: '1px 5px', width: '100%', minWidth: 100 }}
                          value={item.match || ''}
                          onChange={e => updateAlias(item._i, { match: e.target.value })} />
                      </td>
                      <td>
                        <input className="form-control mono" style={{ padding: '1px 5px', width: '100%', minWidth: 160 }}
                          value={item.urn || ''}
                          onChange={e => updateAlias(item._i, { urn: e.target.value })} />
                      </td>
                      <td>
                        {item.bdeleted
                          ? <button title="Restore" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14 }}
                              onClick={() => updateAlias(item._i, { bdeleted: false })}>↩</button>
                          : <button title="Delete" style={{ background: 'none', border: 'none', color: '#c33', cursor: 'pointer', fontSize: 15 }}
                              onClick={() => updateAlias(item._i, { bdeleted: true })}>×</button>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
                onClick={() => setRsmapModalOpen(false)}>Close</button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                Changes are saved with the main record Save button.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Add dictionary / Add alias / Remove record / Find literature — Dictionary view only */}
      {view === 'dict' && !newDictRow && (
        <div style={{ padding: '6px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
            onClick={() => setNewDictRow({ dict: ALL_EDIT_TABLES[0], match: '' })}>
            + Add dictionary
          </button>
          <button className="btn btn-sm btn-success" style={{ fontSize: 11 }}
            onClick={() => setAddAliasOpen(true)}>
            + Add alias
          </button>
          <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }} title="Add a row to the Ontology table for this NLP ID"
            onClick={addOntology}>
            + Add ontology
          </button>
          <datalist id="ontology-classes">{['Receptors', 'Ligands', 'Transcription factors', 'miRNAs'].map(c => <option key={c} value={c} />)}</datalist>
          {onFindLiterature && (
            <button className="btn btn-sm btn-secondary" style={{ fontSize: 11 }}
              title="Open Download Literature with all aliases as search query"
              onClick={() => {
                const aliases = record.aliases
                  .filter(a => !a._deleted && a.alias?.trim())
                  .map(a => `"${a.alias.trim()}"`);
                if (aliases.length === 0) return;
                onFindLiterature(aliases.join(' OR '));
              }}>
              🔍 Find literature
            </button>
          )}
          <button className="btn btn-sm btn-danger" style={{ fontSize: 11, marginLeft: 'auto' }}
            onClick={onRemove}>
            🗑 Remove record
          </button>
        </div>
      )}
    </div>
  );
}

// makeSearchTokenizer uses Phase-2 normalization so that e.g. searching "fascicle"
// finds aliases stored as "fasciculus" (both normalise to "fascicle").
// Queries the 'normalized' column.
const makeSearchTokenizer = makeXwordNormalizer;

// Returns true when a record has unsaved changes relative to its last-fetched/saved state.
function isRecordDirty(rec) {
  if (!rec) return false;
  if (rec.msId       !== rec._origMsId)       return true;
  if (rec.entityName !== rec._origEntityName) return true;
  if (rec.urn        !== rec._origUrn)        return true;
  const arrEq = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  for (const o of rec.ontology || []) {
    if (o._id == null ? !o._deleted : (o._deleted || o.class !== o._origClass || o.urn !== o._origUrn)) return true;
  }
  for (const a of rec.aliases) {
    if (a._deleted && a._orig != null)  return true; // cut alias: Save removes it from the record
    if (!a._deleted && a._orig == null) return true; // new alias not yet saved
    if (!a._deleted && a._orig != null) {
      if (a.alias !== a._orig || a.match !== a._origMatch || a.dict !== a._origDict) return true;
      if ((a.urn || null) !== (a._origUrn || null)) return true;
      if (!arrEq(a.cartridges, a._origCartridges) || !arrEq(a.organisms, a._origOrganisms)) return true;
    }
  }
  return false;
}

function RecordEditor({ initialMsId, initialAlias, cartridges = [], onFindLiterature }) {
  const [msIdInput,  setMsIdInput]  = useState('');
  const [aliasInput, setAliasInput] = useState('');
  const [records,    setRecords]    = useState([]);
  const [notFound,   setNotFound]   = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(null);
  const [error,      setError]      = useState(null);
  const [saveMsg,    setSaveMsg]    = useState(null);
  // Shared clipboard — persists across record navigations so cut→search→paste works
  const [clipboard,  setClipboard]  = useState(null);
  const [aliasSubstring, setAliasSubstring] = useState(false);
  // Re-entry guard — prevents concurrent handleSearch calls from racing on rapid Enter presses
  const searchingRef = React.useRef(false);
  // Unsaved-records warning modal
  const [unsavedWarn, setUnsavedWarn] = useState(null); // null | { names: string[], onSave: fn, onSkip: fn }
  // Discard (clipboard banner) — the ONLY place in the App that sets bdeleted = TRUE.
  // The cut alias's DB row is soft-deleted by primary key; other changes never touch bdeleted.
  const discardClipboard = async () => {
    const c = clipboard;
    setClipboard(null);
    if (!c || c._id == null || !c.srcDict) return;
    const res = await window.api.db.query(
      `UPDATE ${c.srcDict} SET bdeleted=TRUE, curated=TRUE, updated_at=NOW() WHERE id = $1`,
      [c._id]
    );
    if (!res.ok) { setError(`Discard failed: ${res.error}`); return; }
    // Reflect it in any loaded record (the cut alias was hidden as _deleted)
    setRecords(rs => rs.map(r => ({
      ...r,
      aliases: r.aliases.map(a =>
        (a._id === c._id && (a._origDict || a.dict) === c.srcDict)
          ? { ...a, _deleted: false, bdeleted: true, _origBdeleted: true }
          : a),
    })));
  };

  // "Edit by LLM" state
  const [llmEditing,  setLlmEditing]  = useState(false);
  const [llmProgress, setLlmProgress] = useState(null); // { done, total } | null
  const [llmMsg,      setLlmMsg]      = useState(null); // { text, ok } | null
  const [llmReplace,  setLlmReplace]  = useState(false); // "Replace existing values" checkbox

  // Shared lookup data — fetched once per RecordEditor mount, passed down to each RecordSection.
  // Only organisms are fetched at mount (queries organisms_lookup — tiny, instant).
  // Match options are fetched inside RecordSection (only when a record is loaded).
  const [sharedMatchOpts,   setSharedMatchOpts]   = useState({});
  const [sharedOrganisms,   setSharedOrganisms]   = useState([]);
  useEffect(() => {
    // Distinct organisms from the dedicated lookup table (populated at migrate/restore).
    window.api.db.query(`SELECT name FROM organisms_lookup ORDER BY name`)
      .then(r => { if (r.ok) setSharedOrganisms(r.rows.map(row => row.name)); });
  }, []);

  // Cross-record tokenized alias conflicts (computed from stored tokenized column)
  const [crossConflicts, setCrossConflicts] = useState([]);
  const [conflictSel,   setConflictSel]    = useState(new Set()); // Set of "msId::_id" keys
  // Guard: only re-query when the set of msIds actually changes, not on every records reference change.
  const lastConflictMsIds = React.useRef('');

  useEffect(() => {
    const msIds = records.map(r => r.msId);
    const msIdsKey = msIds.slice().sort().join(',');
    if (records.length < 2) {
      if (lastConflictMsIds.current !== '') { lastConflictMsIds.current = ''; setCrossConflicts([]); setConflictSel(new Set()); }
      return;
    }
    if (msIdsKey === lastConflictMsIds.current) return; // same set of records — skip re-query
    lastConflictMsIds.current = msIdsKey;
    // Use the same findTableConflicts function as Curate — no duplicated logic.
    // Filter to only the loaded msIds so we get conflicts between these records only.
    // 'keywords' intentionally excluded: Medscan uses keywords verbatim (no tokenized
    // column), so there are no tokenized-form conflicts to find for that table.
    const ALIAS_TABLES = ['curnames', 'exactliteral', 'celldictionary', 'casdictionary',
                          'chemnames', 'userdict', 'combnames'];
    let cancelled = false;
    console.log('[ConflictScan] Starting for msIds:', msIds);
    const t0 = Date.now();
    Promise.all(ALIAS_TABLES.map(tbl => {
      const ts = Date.now();
      return findTableConflicts(tbl, 1000, msIds).then(r => {
        console.log(`[ConflictScan] ${tbl}: ${r.length} conflicts in ${Date.now() - ts}ms`);
        return r;
      }).catch(err => {
        console.error(`[ConflictScan] ${tbl} ERROR after ${Date.now() - ts}ms:`, err.message);
        return [];
      });
    }))
      .then(results => {
        console.log(`[ConflictScan] All tables done in ${Date.now() - t0}ms`);
        if (cancelled) return;
        // Merge results from all tables into { tok (display), entries[] } groups.
        // Use lowercased tokenized as the map key so exactliteral case variants
        // ('mmrA?' and 'mmra?') are treated as one conflict — same as the SQL LOWER().
        const tokMap = new Map();
        results.forEach((conflicts, tblIdx) => {
          const dict = ALIAS_TABLES[tblIdx];
          for (const c of conflicts) {
            const key = c.tokenized.toLowerCase();
            if (!tokMap.has(key)) tokMap.set(key, { tok: c.tokenized, entries: [] });
            const group = tokMap.get(key);
            const addEntry = (msId, _id, alias) => {
              if (!group.entries.some(e => e._id === _id))
                group.entries.push({ msId, _id, alias, dict });
            };
            addEntry(c.newerMsId, c.rowIdNewer, c.newerAlias);
            addEntry(c.olderMsId, c.rowIdOlder, c.olderAlias);
          }
        });
        const conflicts = [...tokMap.values()].sort((a, b) => a.tok.localeCompare(b.tok));
        setCrossConflicts(conflicts);
        setConflictSel(new Set());
      })
      .catch(err => { console.error('[ConflictScan] Fatal error:', err.message); if (!cancelled) { lastConflictMsIds.current = ''; setCrossConflicts([]); setConflictSel(new Set()); } });
    return () => { cancelled = true; };
  }, [records]);

  const conflictSelKey = (msId, _id) => `${msId}::${_id}`;

  const toggleConflictSel = (_msId, _id) => {
    const k = conflictSelKey(_msId, _id);
    setConflictSel(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  };

  const handleConflictDeleteSelected = async () => {
    if (!conflictSel.size) return;
    const toDelete = [];
    for (const rec of records) {
      for (const a of rec.aliases) {
        if (conflictSel.has(conflictSelKey(rec.msId, a._id))) toDelete.push({ _id: a._id, dict: a.dict });
      }
    }
    await Promise.all(toDelete.map(({ _id, dict }) =>
      window.api.db.query(`DELETE FROM ${dict} WHERE id = $1`, [_id])
    ));
    const deletedIds = new Set(toDelete.map(d => d._id));
    lastConflictMsIds.current = ''; // force conflict re-scan after deletion
    setRecords(recs => recs.map(rec => ({
      ...rec,
      aliases: rec.aliases.filter(a => !deletedIds.has(a._id)),
    })));
    setConflictSel(new Set());
  };

  // Auto-fetch when navigated here from Browse / Batch Import via "Edit record".
  // initialMsId may be a single number or an array of numbers.
  useEffect(() => {
    if (!initialMsId) return;
    const ids = Array.isArray(initialMsId) ? initialMsId : [initialMsId];
    setMsIdInput(ids.map(String).join(', '));
    setAliasInput('');
    setError(null); setNotFound([]); setRecords([]);
    setLoading(true);
    Promise.all(ids.map(id => fetchRecord(Number(id)))).then(recs => {
      setLoading(false);
      const found = [], missing = [];
      for (const rec of recs) {
        if (rec.aliases.length === 0 && !rec.hasObjectNames) missing.push(String(rec.msId));
        else found.push(rec);
      }
      setRecords(found);
      if (missing.length) setNotFound(missing);
    }).catch(err => {
      setLoading(false);
      setError('Failed to load record: ' + err.message);
    });
  }, [initialMsId]);

  // initialAlias: array of name strings to search as semicolon-separated alias query
  useEffect(() => {
    if (!initialAlias?.length) return;
    const query = initialAlias.join(';');
    setMsIdInput('');
    setAliasInput(query);
    setError(null); setNotFound([]); setRecords([]);
    // Defer so aliasInput state is set before handleSearch reads it
    setTimeout(() => {
      setAliasInput(query); // ensure it's set before the search fires
    }, 0);
    // Trigger search imperatively using the query string directly
    (async () => {
      setLoading(true);
      try {
        const parts = initialAlias.map(s => s.trim()).filter(Boolean).slice(0, 10);
        const msIdSet = new Set();
        const notFoundTerms = [];
        for (const alias of parts) {
          const ids = await searchAlias(alias);
          if (ids.length === 0) notFoundTerms.push(alias);
          else ids.forEach(id => { if (msIdSet.size < 10) msIdSet.add(id); });
        }
        const fetched = [];
        for (const msId of msIdSet) {
          const rec = await fetchRecord(msId);
          if (rec.aliases.length === 0 && !rec.hasObjectNames) notFoundTerms.push(String(msId));
          else fetched.push(rec);
        }
        setNotFound(notFoundTerms);
        setRecords(fetched);
      } catch (err) {
        setError('Search failed: ' + (err?.message || String(err)));
      } finally {
        setLoading(false);
      }
    })();
  }, [initialAlias]);

  const fetchRecord = async (msId) => {
    const unionSql = ALL_EDIT_TABLES
      .map(t => t === 'keywords'
        ? `SELECT id, keywords AS alias, match, NULL AS urn, NULL AS tokenized, NULL AS normalized, '{}'::text[] AS cartridges, COALESCE(organisms, '{}') AS organisms, created_at, updated_at, COALESCE(bdeleted, FALSE) AS bdeleted, COALESCE(curated, FALSE) AS curated, 'keywords' AS dict FROM keywords WHERE medscan_id = $1`
        : t === 'rsmap'
        ? `SELECT id, protein_name AS alias, hgvs_code AS match, urn, NULL AS tokenized, normalized, '{}'::text[] AS cartridges, '{}'::text[] AS organisms, created_at, updated_at, COALESCE(bdeleted, FALSE) AS bdeleted, COALESCE(curated, FALSE) AS curated, 'rsmap' AS dict FROM rsmap WHERE medscan_id = $1`
        : `SELECT id, alias, match, NULL AS urn, tokenized, normalized, cartridges, organisms, created_at, updated_at, COALESCE(bdeleted, FALSE) AS bdeleted, COALESCE(curated, FALSE) AS curated, '${t}' AS dict FROM ${t} WHERE medscan_id = $1`)
      .join(' UNION ALL ');
    const [nameRes, aliasRes, ontRes] = await Promise.all([
      window.api.db.query(`SELECT id, name, urn FROM objectnames WHERE medscan_id = $1 ORDER BY id`, [msId]),
      window.api.db.query(`${unionSql} ORDER BY dict, alias`, [msId]),
      // only the rows whose URN is also the URN of this record (the same medscan_id with another URN is a different thing)
      window.api.db.query(`SELECT o.id, o.class, o.urn FROM ontology o WHERE o.medscan_id = $1 AND EXISTS (SELECT 1 FROM objectnames x WHERE x.medscan_id = o.medscan_id AND x.urn = o.urn) ORDER BY o.id`, [msId]),
    ]);
    // Ontology rows (table ontology: class, urn): edited in the record, saved with it
    const ontology = ontRes.ok ? ontRes.rows.map(r => ({ _id: r.id, class: r.class, urn: r.urn, _origClass: r.class, _origUrn: r.urn, _deleted: false })) : [];
    const entityName       = nameRes.ok && nameRes.rows[0] ? nameRes.rows[0].name        : '';
    const urn              = nameRes.ok && nameRes.rows[0] ? (nameRes.rows[0].urn || '')  : '';
    const objectNamesId    = nameRes.ok && nameRes.rows[0] ? Number(nameRes.rows[0].id)   : null;
    // Extra objectnames rows beyond the first (indicates a conflict that needs cleanup)
    const extraObjectNames = nameRes.ok && nameRes.rows.length > 1
      ? nameRes.rows.slice(1).map(r => ({ id: Number(r.id), name: r.name, urn: r.urn || '' }))
      : [];
    const aliases    = aliasRes.ok ? aliasRes.rows.map(r => ({
      _id: r.id,    // primary key — used for precise single-row soft-delete/restore
      alias: r.alias, match: r.match, urn: r.urn || null, tokenized: r.tokenized || '', normalized: r.normalized || '', dict: r.dict,
      cartridges: r.cartridges || [], organisms: r.organisms || [],
      // rsmap extra fields tracking
      _origUrn: r.urn || null,
      date_created:  r.created_at  || null,
      date_modified: r.updated_at  || null,
      curated: r.curated || false,
      bdeleted: r.bdeleted || false,
      _orig: r.alias, _origDict: r.dict, _origMatch: r.match,
      _origCartridges: r.cartridges || [], _origOrganisms: r.organisms || [],
      _origBdeleted: r.bdeleted || false,
      _deleted: false,
    })) : [];
    const activeAliases = aliases.filter(a => !a.bdeleted);
    const isCurated = aliases.some(a => a.curated);  // includes deleted aliases — deletion is also a curation action
    const latestUpdatedAt = activeAliases.reduce((best, a) => {
      if (!a.date_modified) return best;
      return best === null || new Date(a.date_modified) > new Date(best) ? a.date_modified : best;
    }, null);
    return {
      msId,
      _origMsId:       msId,
      entityName,
      urn,
      _origEntityName: entityName,
      _origUrn:        urn,
      aliases,
      ontology,
      isCurated,
      latestUpdatedAt,
      hasObjectNames: nameRes.ok && nameRes.rows.length > 0,
      objectNamesId,
      extraObjectNames,
    };
  };

  // Search for alias across all dictionary tables.
  // Uses normalizeForTable() from duplicateCheck.js so each table gets exactly the
  // same normalization rules as the DB used when storing the 'normalized' column.
  // All per-table normalization + DB queries run in parallel.
  // When substring=true, skip normalization and search alias columns with ILIKE '%q%'.
  // Returns array of distinct medscan_id numbers found (capped at 10).
  const searchAlias = async (alias, substring = false) => {
    let results;

    if (substring) {
      // Substring mode: search alias columns directly across all tables
      const pattern = `%${alias}%`;
      const substringTables = ['curnames', 'userdict', 'celldictionary', 'casdictionary', 'combnames', 'exactliteral'];
      results = await Promise.all([
        ...substringTables.map(tbl =>
          window.api.db.query(
            `SELECT DISTINCT medscan_id FROM ${tbl} WHERE alias ILIKE $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
            [pattern]
          )
        ),
        window.api.db.query(
          `SELECT DISTINCT medscan_id FROM rsmap WHERE (protein_name ILIKE $1 OR hgvs_code ILIKE $1) AND (bdeleted IS NULL OR bdeleted = FALSE)`,
          [pattern]
        ),
      ]);
    } else {
      // chemnames excluded: all rows share medscan_id=1000001.
      // keywords excluded from alias search (still shown in fetchRecord results).
      // exactliteral: normalizeForTable returns lower(alias), matched via LOWER(alias)=LOWER($1).
      const normalizedTables = ['curnames', 'userdict', 'celldictionary', 'casdictionary', 'combnames', 'exactliteral'];

      // Step 1: compute the correct normalized key for every table — in parallel
      const keys = await Promise.all(normalizedTables.map(tbl => normalizeForTable(alias, tbl)));

      // Step 2: query every table with its own normalized key — in parallel
      results = await Promise.all(
        normalizedTables.map((tbl, i) => {
          if (tbl === 'exactliteral') {
            // exactliteral stores normalized = lower(alias); use LOWER(alias) for safety
            return window.api.db.query(
              `SELECT DISTINCT medscan_id FROM exactliteral WHERE LOWER(alias) = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
              [keys[i]]
            );
          }
          // Also match on LOWER(alias) as a fallback: if xwords_cas loaded differently
          // between retokenize and this call (LIMIT 5000, no ORDER BY), the normalized
          // form may differ. An exact case-insensitive alias match is always reliable.
          return window.api.db.query(
            `SELECT DISTINCT medscan_id FROM ${tbl} WHERE (normalized = $1 OR LOWER(alias) = $2) AND (bdeleted IS NULL OR bdeleted = FALSE)`,
            [keys[i], alias.toLowerCase()]
          );
        })
      );
      // Also search rsmap by normalized (lower(protein_name || ' ' || hgvs_code))
      const rsmapNormRes = await window.api.db.query(
        `SELECT DISTINCT medscan_id FROM rsmap WHERE normalized = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
        [alias.toLowerCase()]
      );
      if (rsmapNormRes.ok) results = [...results, rsmapNormRes];
    }

    const ids = new Set();
    for (const res of results) {
      if (res.ok) {
        for (const row of res.rows) ids.add(Number(row.medscan_id));
      }
    }
    // Cap at 10 distinct IDs to avoid fetching too many records
    return [...ids].slice(0, 10);
  };

  const handleSearch = async (skipDirtyCheck = false) => {
    if (searchingRef.current) return; // hard guard against rapid re-entry
    const idRaw    = msIdInput.trim();
    const aliasRaw = aliasInput.trim();
    if (!idRaw && !aliasRaw) return;

    // Warn if any loaded records have unsaved changes
    if (!skipDirtyCheck && records.length > 0) {
      const dirtyRecs = records.filter(r => isRecordDirty(r));
      if (dirtyRecs.length > 0) {
        const names = dirtyRecs.map(r => r.entityName || `NLP ID ${Number(r.msId).toLocaleString()}`);
        setUnsavedWarn({
          names,
          onSave: async () => {
            setUnsavedWarn(null);
            // Save all dirty records sequentially, then search
            for (let i = 0; i < records.length; i++) {
              if (isRecordDirty(records[i])) {
                await handleSave(i);
              }
            }
            handleSearch(true);
          },
          onSkip: () => { setUnsavedWarn(null); handleSearch(true); },
          onCancel: () => setUnsavedWarn(null),
        });
        return;
      }
    }

    searchingRef.current = true;
    setLoading(true); setError(null); setNotFound([]); setRecords([]);

    try {
    const notFoundTerms = [];
    const msIdSet = new Set();

    // ── MedscanID lookup ──
    if (idRaw) {
      const parts = idRaw.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.some(p => !/^\d+$/.test(p))) {
        setError('Elsevier NLP ID must contain numbers only (comma-separated).');
        setLoading(false); return;
      }
      if (parts.length > 10) { setError('Maximum 10 Elsevier NLP IDs allowed.'); setLoading(false); return; }
      parts.forEach(p => msIdSet.add(Number(p)));
    }

    // ── Alias lookup ──
    if (aliasRaw && msIdSet.size < 10) {
      const parts = aliasRaw.split(';').map(s => s.trim()).filter(Boolean);
      if (parts.length > 10) { setError('Maximum 10 aliases allowed.'); setLoading(false); return; }

      for (const alias of parts) {
        if (msIdSet.size >= 10) break;
        const ids = await searchAlias(alias, aliasSubstring);
        if (ids.length === 0) {
          notFoundTerms.push(alias);
        } else {
          ids.forEach(id => { if (msIdSet.size < 10) msIdSet.add(id); });
        }
      }
    }

    // ── Fetch each record ──
    const fetched = [];
    for (const msId of msIdSet) {
      const rec = await fetchRecord(msId);
      if (rec.aliases.length === 0 && !rec.hasObjectNames) {
        notFoundTerms.push(String(msId));
      } else {
        fetched.push(rec);
      }
    }

    setNotFound(notFoundTerms);
    lastConflictMsIds.current = ''; // force conflict re-scan for newly loaded records
    setRecords(fetched);
    } catch (err) {
      console.error('[handleSearch] unexpected error:', err);
      setError('Search failed: ' + (err?.message || String(err)));
    } finally {
      setLoading(false);
      searchingRef.current = false;
    }
  };

  // ── Edit by LLM ─────────────────────────────────────────────────────────────
  // Name-selection helper (pure client-side, uses isAbbreviation from tokenizer.js).
  // Rules: prefer shortest alias > 4 chars that is NOT an abbreviation, OR a 4-char abbreviation.
  // Avoid 2-3 char abbreviations if any better candidate exists.
  const selectBestName = (aliases) => {
    if (!aliases || aliases.length === 0) return null;
    const texts = aliases.filter(a => a && a.length > 0);
    // Primary candidates: non-abbreviations longer than 4, OR abbreviations with exactly 4 chars
    const primary = texts.filter(a =>
      (!isAbbreviation(a) && a.length > 4) || (isAbbreviation(a) && a.length === 4)
    );
    if (primary.length > 0) return primary.sort((a, b) => a.length - b.length)[0];
    // Secondary: anything not a short (2-3 char) abbreviation
    const secondary = texts.filter(a => !(isAbbreviation(a) && a.length < 4));
    if (secondary.length > 0) return secondary.sort((a, b) => a.length - b.length)[0];
    // Fallback: pick longest short abbreviation (least bad)
    return texts.sort((a, b) => b.length - a.length)[0];
  };

  // Build entity-type-specific URN instruction for the LLM prompt.
  const urnInstructionFor = (msId, organisms) => {
    const id = Number(msId);
    const orgHint = (organisms && organisms.length > 0)
      ? `Organism context: ${organisms.join(', ')}. For "Mammal" use "Homo sapiens" when searching NCBI.`
      : '';
    if (id < 1000000) {
      return `Entity type: Protein/Gene (NLP ID < 1,000,000).
${orgHint}
Steps:
1. Try to obtain NCBI Entrez Gene ID for this gene/protein. Return "urn:agi-llid:<GENE_ID>" if found.
2. If Gene ID not available, try UniProt ID. Return "urn:agi-gbprot:<UNIPROT_ID>" if found.
3. Fallback: return "urn:agi-prot:<URN_ENCODED_NAME>" where URN_ENCODED_NAME is the name URL-encoded.`;
    } else if (id < 2000000) {
      return `Entity type: Small Molecule (1,000,000 ≤ NLP ID < 2,000,000).
Steps:
1. Try CAS registry number. Return "urn:agi-cas:<CAS_NUMBER>" if found.
2. If not available, try NCBI PubChem Compound ID (CID). Return "urn:agi-pccid:<CID>" if found.
3. If not available, try NCBI PubChem Substance ID (SID). Return "urn:agi-pcsid:<SID>" if found.
4. Fallback: return "urn:agi-smol:<URN_ENCODED_NAME>".`;
    } else if (id < 3000000) {
      return `Entity type: Cell component / Cell Object (2,000,000 ≤ NLP ID < 3,000,000).
Try to find the exact Gene Ontology (GO) cellular component term for this entity. Use the GO ID only if it matches EXACTLY — do not use parent or sibling GO terms.
Return "urn:agi-gocellobj:GO:<GO_ID>" (e.g. "urn:agi-gocellobj:GO:0005737") if found.
Fallback: return "urn:agi-cellobj:<URN_ENCODED_NAME>".`;
    } else if (id < 4000000) {
      return `Entity type: Protein Complex (3,000,000 ≤ NLP ID < 4,000,000).
Try to find the exact Gene Ontology (GO) cellular component term for this complex. Use the GO ID only if it matches EXACTLY.
Return "urn:agi-gocomplex:GO:<GO_ID>" if found. Fallback: return "urn:agi-complex:<URN_ENCODED_NAME>".`;
    } else if (id < 5000000) {
      return `Entity type: Cell Process (4,000,000 ≤ NLP ID < 5,000,000).
Try to find the exact Gene Ontology (GO) biological process term. Use the GO ID only if it matches EXACTLY.
Return "urn:agi-gocellproc:GO:<GO_ID>" if found. Fallback: return "urn:agi-cellproc:<URN_ENCODED_NAME>".`;
    } else if (id < 6000000) {
      return `Entity type: Virus (5,000,000 ≤ NLP ID < 6,000,000).
Try to find the NCBI Taxonomy ID (taxID) for this virus. Use taxID only if it is the EXACT species/strain.
Return "urn:agi-taxid:<TAX_ID>" if found. Fallback: return "urn:agi-virus:<URN_ENCODED_NAME>".`;
    } else if (id < 7000000) {
      return `Entity type: Tissue (6,000,000 ≤ NLP ID < 7,000,000).
Try to find the NCI Metathesaurus (NCIM) concept ID for this tissue. Use only the exact match.
Return "urn:agi-ncimorgan:<NCIM_ID>" (e.g. "urn:agi-ncimorgan:C0040300") if found.
Fallback: return "urn:agi-tissue:<URN_ENCODED_NAME>".`;
    } else if (id < 8000000) {
      return `Entity type: Organism (7,000,000 ≤ NLP ID < 8,000,000).
Try to find the NCBI Taxonomy ID (taxID) for this organism. Use taxID only if it is the EXACT species.
Return "urn:agi-taxid:<TAX_ID>" if found. Fallback: return "urn:agi-organism:<URN_ENCODED_NAME>".`;
    } else if (id < 9000000) {
      return `Entity type: Organ (8,000,000 ≤ NLP ID < 9,000,000).
Try to find the NCI Metathesaurus (NCIM) concept ID for this organ. Use only the exact match.
Return "urn:agi-ncimorgan:<NCIM_ID>" if found. Fallback: return "urn:agi-organ:<URN_ENCODED_NAME>".`;
    } else if (id < 10000000) {
      return `Entity type: Disease (9,000,000 ≤ NLP ID < 10,000,000).
Try to find the exact NCBI MeSH term name for this disease. Use only an EXACT MeSH match.
Return "urn:agi-disease:<URN_ENCODED_MESH_TERM>" if found.
Fallback: return "urn:agi-disease:<URN_ENCODED_NAME>".`;
    } else if (id < 11000000) {
      return `Entity type: Cell Type (10,000,000 ≤ NLP ID < 11,000,000).
Try to find the NCI Metathesaurus (NCIM) concept ID for this cell type. Use only the exact match.
Return "urn:agi-ncimorgan:<NCIM_ID>" if found. Fallback: return "urn:agi-celltype:<URN_ENCODED_NAME>".`;
    } else if (id < 12000000) {
      return `Entity type: Cell Line (11,000,000 ≤ NLP ID < 12,000,000).
Return "urn:agi-celllinename:<URN_ENCODED_NAME>".`;
    } else if (id < 13000000) {
      return `Entity type: Protein Functional Class (12,000,000 ≤ NLP ID < 13,000,000).
Try to find the exact Gene Ontology (GO) molecular function or biological process term. Use GO ID only if EXACT.
Return "urn:agi-go:GO:<GO_ID>" if found. Fallback: return "urn:agi-protfc:<URN_ENCODED_NAME>".`;
    } else if (id < 14000000) {
      return `Entity type: Treatment (13,000,000 ≤ NLP ID < 14,000,000).
Return "urn:agi-treatment:<URN_ENCODED_NAME>".`;
    } else if (id < 16000000) {
      return `Entity type: Clinical Parameter (15,000,000 ≤ NLP ID < 16,000,000).
Return "urn:agi-clnpar:<URN_ENCODED_NAME>".`;
    } else if (id < 17000000) {
      return `Entity type: Medical Procedure (16,000,000 ≤ NLP ID < 17,000,000).
Return "urn:agi-medproc:<URN_ENCODED_NAME>".`;
    } else if (id < 18000000) {
      return `Entity type: Genetic Variant (17,000,000 ≤ NLP ID < 18,000,000).
Return "urn:agi-gv:<URN_ENCODED_NAME>".`;
    } else if (id < 19000000) {
      return `Entity type: Pathogen (18,000,000 ≤ NLP ID < 19,000,000).
Try to find the NCBI Taxonomy ID (taxID) for this pathogen. Use taxID only if it is the EXACT species.
Return "urn:agi-taxid:<TAX_ID>" if found. Fallback: return "urn:agi-pathogen:<URN_ENCODED_NAME>".`;
    }
    return `Return a fallback URN using the pattern "urn:agi-entity:<URN_ENCODED_NAME>".`;
  };

  const handleEditByLlm = async () => {
    if (records.length === 0 || llmEditing) return;
    setLlmEditing(true);
    setLlmProgress({ done: 0, total: records.length });
    setLlmMsg(null);

    const results = await Promise.allSettled(records.map(async (rec) => {
      const activeAliases = rec.aliases.filter(a => !a.bdeleted && !a._deleted).map(a => a.alias);
      const organisms = [...new Set(rec.aliases.filter(a => !a._deleted).flatMap(a => a.organisms || []))];

      // Determine best name client-side (pure alias ranking, no LLM needed)
      const bestNameFromAliases = selectBestName(activeAliases);

      // Decide whether we need LLM for name/URN
      const needUrn  = llmReplace || !rec.urn || rec.urn.trim() === '';
      const needName = llmReplace || !rec.entityName || rec.entityName.trim() === '';

      const urnInstruction = urnInstructionFor(rec.msId, organisms);

      const prompt = `You are a biomedical curation expert. For the record below, complete the following tasks and return ONLY valid JSON.

RECORD:
- NLP ID: ${rec.msId}
- Current name: ${rec.entityName || '(empty)'}
- Current URN: ${rec.urn || '(empty)'}
- Known aliases (${activeAliases.length}): ${activeAliases.slice(0, 60).join('; ')}

TASKS:
${needUrn ? `1. URN: ${urnInstruction}
   URN_ENCODED_NAME means the name passed through encodeURIComponent() with spaces replaced by '+'.` : '1. URN: Keep existing — return current URN unchanged: "${rec.urn}"'}

2. SYNONYMS: Search your knowledge for additional synonyms/aliases for this entity that are NOT already in the alias list above. Include alternative names, abbreviations, trade names, IUPAC names, etc. Return up to 20 high-quality synonyms. If you find none, return an empty array.

IMPORTANT RULES:
- Do not hallucinate identifiers. If you are not confident about an external ID, use the fallback URN.
- For GO IDs, MeSH terms, TaxIDs — only use EXACT matches, never parent/sibling terms.
- Return ONLY a JSON object, no markdown, no explanation outside the JSON.

Return this exact JSON structure:
{
  "urn": "string — the determined URN",
  "new_synonyms": ["array", "of", "new", "synonym", "strings"],
  "reasoning": "one sentence explaining the URN choice"
}`;

      const messages = [{ role: 'user', content: prompt }];
      const rawReply = (await callLlm(messages, { fn: 'dict.editByLlm', temperature: 0 })).trim();

      // Parse JSON reply
      let parsed;
      try {
        const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawReply);
      } catch {
        throw new Error(`JSON parse failed for NLP ID ${rec.msId}: ${rawReply.slice(0, 200)}`);
      }

      const suggestedUrn  = (parsed.urn  || '').trim();
      const newSynonyms   = Array.isArray(parsed.new_synonyms) ? parsed.new_synonyms.filter(s => typeof s === 'string' && s.trim()) : [];

      // Deduplicate new synonyms against existing aliases (case-insensitive)
      const existingLower = new Set(activeAliases.map(a => a.toLowerCase()));
      const dedupedSynonyms = newSynonyms.filter(s => !existingLower.has(s.toLowerCase().trim()));

      return { msId: rec.msId, suggestedUrn, bestNameFromAliases, needName, needUrn, dedupedSynonyms };
    }));

    // Apply results to records state
    let done = 0;
    setRecords(prev => prev.map(rec => {
      const settled = results.find(r => r.status === 'fulfilled' && r.value.msId === rec.msId);
      if (!settled) { done++; setLlmProgress({ done, total: records.length }); return rec; }
      const { suggestedUrn, bestNameFromAliases, needName, needUrn, dedupedSynonyms } = settled.value;

      let updated = { ...rec };

      // Apply name
      if (needName && bestNameFromAliases) {
        updated = { ...updated, entityName: bestNameFromAliases, _llmName: true };
      }

      // Apply URN
      if (needUrn && suggestedUrn) {
        updated = { ...updated, urn: suggestedUrn, _llmUrn: true };
      }

      // Add new synonyms with entity-type-appropriate dict and _llmSource flag.
      // Rules (applied in order):
      //   1. < 6 letters/digits (isShortAlias)                → exactliteral (match='l')
      //   2. Looks like an identifier/abbreviation:
      //        • CAS registry number (digits-digits-digit)
      //        • All-uppercase string with at least one letter (no lowercase)
      //          e.g. "MRS 2365", "NF-KB", "RPMI 1640", "COVID-19"
      //        • Alphanumeric code: 1-8 letters immediately followed by digits
      //          e.g. "MRS2365", "SB203580", "U0126"               → exactliteral (match='l')
      //   3. Entity-type routing for true descriptive names:
      //        Protein (<1M), Complex (3M-4M),
      //          FunctionalClass (12M-13M),
      //          Treatment (13M-14M)                              → curnames
      //        Small Molecules (1M-2M)                            → casdictionary
      //        everything else                                    → celldictionary
      if (dedupedSynonyms.length > 0) {
        const defaultOrgs  = [...new Set(rec.aliases.filter(a => !a._deleted).flatMap(a => a.organisms  || []))];
        const defaultCarts = [...new Set(rec.aliases.filter(a => !a._deleted).flatMap(a => a.cartridges || []))];
        const msIdNum = Number(rec.msId);
        // Returns true for strings that look like codes/abbreviations, not descriptive names.
        const looksLikeIdentifier = (alias) => {
          const s = alias.trim();
          if (!s) return false;
          // CAS registry number (with or without "CAS " prefix)
          if (/^(?:CAS\s+)?\d{2,7}-\d{2}-\d$/.test(s)) return true;
          // All-uppercase: no lowercase letters anywhere, at least one capital letter
          // Catches: "MRS 2365", "NF-KB", "RPMI 1640", "COVID-19"
          if (!/[a-z]/.test(s) && /[A-Z]/.test(s)) return true;
          // Alphanumeric code: 1-8 letters then digits, no spaces, optional alphanumeric/hyphen suffix
          // Catches: "MRS2365", "SB203580", "U0126", "Cpd25b"
          if (/^[A-Za-z]{1,8}\d+[A-Za-z0-9\-]*$/.test(s)) return true;
          return false;
        };
        const dictForSynonym = (alias) => {
          if (isShortAlias(alias))       return 'exactliteral';
          if (looksLikeIdentifier(alias)) return 'exactliteral';
          if (msIdNum < 1000000)  return 'curnames';        // Protein
          if (msIdNum < 2000000)  return 'casdictionary';   // Small Molecules
          if (msIdNum >= 3000000  && msIdNum < 4000000)  return 'curnames'; // Complex
          if (msIdNum >= 12000000 && msIdNum < 13000000) return 'curnames'; // FunctionalClass
          if (msIdNum >= 13000000 && msIdNum < 14000000) return 'curnames'; // Treatment
          return 'celldictionary'; // all others
        };
        const newAliasObjs = dedupedSynonyms.map(s => {
          const dict  = dictForSynonym(s);
          const match = dict === 'exactliteral' ? 'l' : '';
          return {
            alias: s,
            match,
            dict,
            cartridges: defaultCarts,
            organisms: defaultOrgs,
            _orig: null, _origDict: null, _origMatch: null,
            _origCartridges: defaultCarts, _origOrganisms: defaultOrgs,
            _origBdeleted: false,
            _deleted: false,
            bdeleted: false,
            curated: false,
            _llmSource: true,
          };
        });
        updated = { ...updated, aliases: [...updated.aliases, ...newAliasObjs] };
      }

      done++;
      setLlmProgress({ done, total: records.length });
      return updated;
    }));

    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason?.message || String(r.reason));
    if (errors.length > 0) {
      setLlmMsg({ text: `LLM editing complete with ${errors.length} error(s): ${errors[0]}`, ok: false });
    } else {
      setLlmMsg({ text: `✓ LLM editing complete for ${records.length} record(s). Review highlighted fields, then save.`, ok: true });
    }
    setLlmEditing(false);
    setLlmProgress(null);
    // Force conflict re-scan: LLM may have added synonyms that conflict across records.
    lastConflictMsIds.current = '';
  };

  const handleRemove = async (idx) => {
    const rec = records[idx];
    const label = `Elsevier NLP ID ${Number(rec.msId).toLocaleString()}${rec.entityName ? ` (${rec.entityName})` : ''}`;

    // Count how many soft-deleted aliases would be preserved as tombstones
    const softDeletedCount = rec.aliases.filter(a => a.bdeleted).length;
    const tombstoneNote = softDeletedCount > 0
      ? `\n\nNote: ${softDeletedCount} soft-deleted alias(es) will be KEPT in the database as tombstones so future batch imports continue to skip them.`
      : '';
    if (!confirm(`Delete all active aliases and the entity name for ${label}?\n\nThis cannot be undone.${tombstoneNote}`)) return;

    setSaving(idx);
    await Promise.all([
      // Only hard-delete ACTIVE (non-deleted) rows — preserve bdeleted=TRUE tombstones
      ...ALL_EDIT_TABLES.map(t =>
        window.api.db.query(
          `DELETE FROM ${t} WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
          [rec.msId]
        )
      ),
      window.api.db.query(`DELETE FROM objectnames WHERE medscan_id = $1`, [rec.msId]),
    ]);
    setSaving(null);
    setRecords(r => r.filter((_, i) => i !== idx));
    const msg = softDeletedCount > 0
      ? `Elsevier NLP ID ${Number(rec.msId).toLocaleString()} removed. ${softDeletedCount} soft-deleted alias(es) kept as tombstones in the DB.`
      : `Elsevier NLP ID ${Number(rec.msId).toLocaleString()} removed.`;
    setSaveMsg({ text: msg, persistent: softDeletedCount > 0 });
  };

  const handleSave = async (idx, { reportSoftDeletes = false } = {}) => {
    const rec = records[idx];
    setSaving(idx);
    try {

    // ── CASdictionary: chemNames token check + approval (shared addToCasDictionary route) ──
    // Asked up-front, BEFORE anything is written, so declining cancels the whole save.
    {
      const casAliasesToWrite = rec.aliases.filter(a =>
        !a._deleted && a.dict === 'casdictionary' &&
        (a._orig === null || a._orig === undefined || a.dict !== (a._origDict || a.dict) || a.alias !== a._orig)
      ).map(a => a.alias);
      if (casAliasesToWrite.length > 0) {
        const pre = await ensureChemNamesTokens(casAliasesToWrite);
        if (!pre.ok) {
          setSaving(null);
          if (!pre.cancelled) setError(pre.error);
          return;
        }
      }
    }

    // tokenizeForTable / normalizeForTable are the single source of truth for all
    // tokenization — they use the same routing as the DB pipeline and cache xwords internally.
    const computeTok  = (alias, dictName, matchFlag) => tokenizeForTable(alias, dictName, matchFlag);
    const computeNorm = (alias, dictName, matchFlag) => normalizeForTable(alias, dictName, matchFlag);

    // If the entity type was changed, migrate all alias rows + objectnames to the new msId first.
    if (rec._origMsId && rec._origMsId !== rec.msId) {
      const oldId = rec._origMsId;
      const newId = rec.msId;
      // Migrate aliases in every dictionary table (use a single UPDATE per table); mark as curated
      for (const t of ALL_EDIT_TABLES) {
        await window.api.db.query(
          `UPDATE ${t} SET medscan_id = $1, curated = TRUE WHERE medscan_id = $2`,
          [newId, oldId]
        );
      }
      await window.api.db.query('UPDATE ontology SET medscan_id = $1 WHERE medscan_id = $2', [newId, oldId]);
      // Migrate or clear the objectnames row
      if (rec.hasObjectNames) {
        // Move the existing objectnames row to the new ID
        await window.api.db.query(
          `UPDATE objectnames SET medscan_id = $1, name = $2, urn = $3 WHERE medscan_id = $4`,
          [newId, rec.entityName, rec.urn || null, oldId]
        );
        // Normal objectnames save below will be a no-op since msId already matches
      }
    }

    if (rec.hasObjectNames) {
      await window.api.db.query(
        `UPDATE objectnames SET name = $1, urn = $2 WHERE medscan_id = $3`,
        [rec.entityName, rec.urn || null, rec.msId]
      );
    } else if (rec.entityName) {
      await window.api.db.query(
        `INSERT INTO objectnames (medscan_id, name, urn) VALUES ($1,$2,$3)`,
        [rec.msId, rec.entityName, rec.urn || null]
      );
    }

    // Ontology rows of the record (after a possible change of the ID above)
    for (const o of rec.ontology || []) {
      const cls = (o.class || '').trim(), urn = (o.urn || '').trim();
      if (o._id != null && o._deleted)       await window.api.db.query('DELETE FROM ontology WHERE id = $1', [o._id]);
      else if (o._id != null && !o._deleted) { if (cls !== o._origClass || urn !== o._origUrn) await window.api.db.query('UPDATE ontology SET class = $1, urn = $2 WHERE id = $3', [cls, urn, o._id]); }
      else if (!o._deleted && cls && urn)    await window.api.db.query('INSERT INTO ontology (class, urn, medscan_id) VALUES ($1, $2, $3)', [cls, urn, rec.msId]);
    }

    const arrEq = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

    // Derive organisms/cartridges for an alias: use the alias's own value if non-empty,
    // otherwise inherit from any sibling alias in this record that has the value set.
    const recordOrgs = [...new Set(
      rec.aliases
        .filter(x => !x._deleted && x.organisms?.length > 0)
        .flatMap(x => x.organisms)
    )];
    const recordCarts = [...new Set(
      rec.aliases
        .filter(x => !x._deleted && x.cartridges?.length > 0)
        .flatMap(x => x.cartridges)
    )];
    const resolveOrgs   = (a) => (a.organisms?.length  > 0 ? a.organisms  : recordOrgs);
    const resolveCarts  = (a) => (a.cartridges?.length > 0 ? a.cartridges : recordCarts);

    // Pre-save validation: block if any alias being written would still have empty organisms or cartridges.
    const aliasesNeedingWrite = rec.aliases.filter(a =>
      !a._deleted && (a._orig === null || a._orig === undefined || a.dict !== a._origDict ||
        a.alias !== a._orig || a.match !== a._origMatch ||
        !arrEq(a.cartridges, a._origCartridges) || !arrEq(a.organisms, a._origOrganisms))
    );
    const emptyOrgsAliases   = aliasesNeedingWrite.filter(a => a.dict !== 'rsmap' && resolveOrgs(a).length === 0);
    const emptyCartsAliases  = aliasesNeedingWrite.filter(a => a.dict !== 'rsmap' && resolveCarts(a).length === 0);
    if (emptyOrgsAliases.length > 0) {
      const names = emptyOrgsAliases.map(a => `"${a.alias}"`).join(', ');
      throw new Error(`Cannot save — organisms are empty for: ${names}. Please set organisms before saving.`);
    }
    if (emptyCartsAliases.length > 0) {
      const names = emptyCartsAliases.map(a => `"${a.alias}"`).join(', ');
      throw new Error(`Cannot save — cartridges are empty for: ${names}. Please assign at least one cartridge before saving.`);
    }

    for (const a of rec.aliases) {
      // The 'keywords' table stores the alias in a column named 'keywords', not 'alias'.
      const aliasCol    = (d) => d === 'keywords' ? 'keywords' : 'alias';
      const origAliasCol = aliasCol(a._origDict || a.dict);
      const curAliasCol  = aliasCol(a.dict);

      if (a._deleted) {
        // Cut alias: Save removes it from the record with a HARD delete (by primary key).
        // Save never touches bdeleted — a soft delete happens only through the Discard button
        // (discardClipboard), which runs before Save and leaves the row as bdeleted = TRUE.
        if (a._id != null) {
          const tbl = a._origDict || a.dict;
          await window.api.db.query(`DELETE FROM ${tbl} WHERE id = $1`, [a._id]);
        }
        // else: alias never saved — it just drops from memory
      } else if (a.bdeleted === false && a._origBdeleted === true) {
        // Restore this single alias row by primary key — also mark as curated
        await window.api.db.query(
          `UPDATE ${a._origDict || a.dict} SET bdeleted=FALSE, curated=TRUE, updated_at=NOW() WHERE id = $1`,
          [a._id]
        );
      } else if (a._orig === null || a._orig === undefined) {
        // New alias — INSERT (date_created = NOW, date_modified = NOW), mark curated
        const aliasVal  = a.dict === 'keywords' ? a.alias.toLowerCase() : a.alias;
        // rsmap uses protein_name/hgvs_code instead of alias/match
        if (a.dict === 'rsmap') {
          await window.api.db.query(
            `INSERT INTO rsmap (medscan_id, protein_name, hgvs_code, normalized, curated, created_at, updated_at)
             VALUES ($1, $2, $3, lower($2 || ' ' || $3), TRUE, NOW(), NOW())
             ON CONFLICT (medscan_id, protein_name, hgvs_code) DO NOTHING`,
            [rec.msId, aliasVal, a.match || '']
          );
          continue;
        }
        // keywords table has no tokenized/normalized columns — skip for that table
        if (a.dict === 'keywords') {
          await window.api.db.query(
            `INSERT INTO ${a.dict} (medscan_id, ${curAliasCol}, match, cartridges, organisms, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
            [rec.msId, aliasVal, a.match || null, resolveCarts(a), resolveOrgs(a)]
          );
        } else if (a.dict === 'casdictionary') {
          // CASDictionary: single route
          const cr = await addToCasDictionary([{ msId: rec.msId, alias: aliasVal, match: a.match, cartridges: resolveCarts(a), organisms: resolveOrgs(a), curated: true }]);
          if (!cr.ok) throw new Error(cr.cancelled ? 'Save cancelled — chemNames tokens were not approved.' : cr.error);
        } else {
          const [tokenized, normalized] = await Promise.all([
            computeTok(aliasVal, a.dict, a.match),
            computeNorm(aliasVal, a.dict, a.match),
          ]);
          await window.api.db.query(
            `INSERT INTO ${a.dict} (medscan_id, ${curAliasCol}, match, tokenized, normalized, cartridges, organisms, curated, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW())`,
            [rec.msId, aliasVal, a.match || null, tokenized || aliasVal, normalized || null, resolveCarts(a), resolveOrgs(a)]
          );
        }
      } else if (a.dict !== a._origDict) {
        // Moved to different dictionary — DELETE from old, INSERT into new (preserve date_created), mark curated
        // Use primary key (id) when available — more reliable than text-matching alias strings
        // which can silently fail on special characters or encoding differences.
        if (a._id != null) {
          await window.api.db.query(
            `DELETE FROM ${a._origDict} WHERE id = $1`,
            [a._id]
          );
        } else {
          await window.api.db.query(
            `DELETE FROM ${a._origDict} WHERE medscan_id = $1 AND ${origAliasCol} = $2 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
            [rec.msId, a._orig]
          );
        }
        const aliasVal    = a.dict === 'keywords' ? a.alias.toLowerCase() : a.alias;
        const origCreated = a.date_created ? `'${new Date(a.date_created).toISOString()}'` : 'NOW()';
        // rsmap uses protein_name/hgvs_code
        if (a.dict === 'rsmap') {
          await window.api.db.query(
            `INSERT INTO rsmap (medscan_id, protein_name, hgvs_code, normalized, curated, created_at, updated_at)
             VALUES ($1, $2, $3, lower($2 || ' ' || $3), TRUE, ${origCreated}, NOW())
             ON CONFLICT (medscan_id, protein_name, hgvs_code) DO NOTHING`,
            [rec.msId, aliasVal, a.match || '']
          );
          continue;
        }
        // keywords table has no tokenized/normalized columns — skip for that table
        if (a.dict === 'keywords') {
          await window.api.db.query(
            `INSERT INTO ${a.dict} (medscan_id, ${curAliasCol}, match, cartridges, organisms, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,${origCreated},NOW())`,
            [rec.msId, aliasVal, a.match || null, resolveCarts(a), resolveOrgs(a)]
          );
        } else if (a.dict === 'casdictionary') {
          // CASDictionary: single route (preserves original created_at)
          const cr = await addToCasDictionary([{ msId: rec.msId, alias: aliasVal, match: a.match, cartridges: resolveCarts(a), organisms: resolveOrgs(a), curated: true, createdAt: a.date_created || null }]);
          if (!cr.ok) throw new Error(cr.cancelled ? 'Save cancelled — chemNames tokens were not approved.' : cr.error);
        } else {
          const [tokenized, normalized] = await Promise.all([
            computeTok(aliasVal, a.dict, a.match),
            computeNorm(aliasVal, a.dict, a.match),
          ]);
          await window.api.db.query(
            `INSERT INTO ${a.dict} (medscan_id, ${curAliasCol}, match, tokenized, normalized, cartridges, organisms, curated, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,${origCreated},NOW())`,
            [rec.msId, aliasVal, a.match || null, tokenized || aliasVal, normalized || null, resolveCarts(a), resolveOrgs(a)]
          );
        }
      } else if (
        a.alias !== a._orig || a.match !== a._origMatch || (a.urn || null) !== (a._origUrn || null) ||
        !arrEq(a.cartridges, a._origCartridges) || !arrEq(a.organisms, a._origOrganisms)
      ) {
        // Same dictionary — UPDATE alias, match, tokenized, normalized, cartridges, organisms; bump updated_at; mark curated
        const aliasVal  = a.dict === 'keywords' ? a.alias.toLowerCase() : a.alias;
        // rsmap uses protein_name/hgvs_code — UPDATE with normalized recomputation
        if (a.dict === 'rsmap') {
          await window.api.db.query(
            `UPDATE rsmap SET protein_name=$1, hgvs_code=$2, urn=$3, normalized=lower($1 || ' ' || $2), curated=TRUE, updated_at=NOW()
             WHERE medscan_id=$4 AND protein_name=$5`,
            [aliasVal, a.match || '', a.urn || null, rec.msId, a._orig]
          );
          continue;
        }
        // keywords table has no tokenized/normalized columns
        if (a.dict === 'keywords') {
          await window.api.db.query(
            `UPDATE ${a.dict} SET ${curAliasCol}=$1, match=$2, cartridges=$3, organisms=$4, updated_at=NOW() WHERE medscan_id=$5 AND ${curAliasCol}=$6`,
            [aliasVal, a.match || null, resolveCarts(a), resolveOrgs(a), rec.msId, a._orig]
          );
        } else if (a.dict === 'casdictionary') {
          // CASDictionary: single route (update existing row)
          const cr = await addToCasDictionary([{ msId: rec.msId, alias: aliasVal, match: a.match, cartridges: resolveCarts(a), organisms: resolveOrgs(a), curated: true,
            replace: a._id != null ? { id: a._id } : { alias: a._orig } }]);
          if (!cr.ok) throw new Error(cr.cancelled ? 'Save cancelled — chemNames tokens were not approved.' : cr.error);
        } else {
          const [tokenized, normalized] = await Promise.all([
            computeTok(aliasVal, a.dict, a.match),
            computeNorm(aliasVal, a.dict, a.match),
          ]);
          await window.api.db.query(
            `UPDATE ${a.dict} SET ${curAliasCol}=$1, match=$2, tokenized=$3, normalized=$4, cartridges=$5, organisms=$6, curated=TRUE, updated_at=NOW() WHERE medscan_id=$7 AND ${curAliasCol}=$8`,
            [aliasVal, a.match || null, tokenized || aliasVal, normalized || null, resolveCarts(a), resolveOrgs(a), rec.msId, a._orig]
          );
        }
      } else if (a._id != null && a.dict !== 'keywords' && a.dict !== 'rsmap') {
        // No structural change — recompute tokenized/normalized to fix any stale values
        // (e.g. rows saved before normalized column was written, or match changed externally).
        // keywords and rsmap tables have no standard tokenized column — skip entirely.
        const aliasVal = a.alias;
        const [expectedTok, expectedNorm] = await Promise.all([
          computeTok(aliasVal, a.dict, a.match),
          computeNorm(aliasVal, a.dict, a.match),
        ]);
        const tokStale  = expectedTok  && expectedTok  !== a.tokenized;
        const normStale = expectedNorm && expectedNorm !== (a.normalized || '');
        if (tokStale || normStale) {
          await window.api.db.query(
            `UPDATE ${a.dict} SET tokenized=$1, normalized=$2, updated_at=NOW() WHERE id=$3`,
            [expectedTok || a.tokenized, expectedNorm || null, a._id]
          );
        }
      }
    }

    // ── Complete moves (cut → paste / drag): the source row is HARD-deleted now that the pasted copy
    // has been written. bdeleted is never involved (only Discard soft-deletes).
    const MOVE_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames','rsmap'];
    for (const a of rec.aliases) {
      if (a._deleted || !a._moveFrom || a._moveFrom.id == null) continue;
      if (!MOVE_TABLES.includes(a._moveFrom.dict)) continue;
      await window.api.db.query(`DELETE FROM ${a._moveFrom.dict} WHERE id = $1`, [a._moveFrom.id]);
    }

    // ── Sync objectnames.organisms + objectnames.cartridges ──────────────────
    // Recompute the union of organisms and cartridges from every active alias
    // row and write both back to objectnames in a single UPDATE.
    {
      // chemnames is NOT listed: it has no organisms/cartridges columns (the query failed with
      // 'column "organisms" does not exist').
      const ALIAS_TBLS = ['curnames','exactliteral','celldictionary','casdictionary',
                          'keywords','userdict','combnames'];
      const active = `(bdeleted IS NULL OR bdeleted = FALSE)`;
      const orgsUnion  = ALIAS_TBLS.map(t => `SELECT unnest(organisms)  AS v FROM ${t} WHERE medscan_id = $1 AND ${active}`).join(' UNION ALL ');
      const cartsUnion = ALIAS_TBLS.map(t => `SELECT unnest(cartridges) AS v FROM ${t} WHERE medscan_id = $1 AND ${active}`).join(' UNION ALL ');
      const syncRes = await window.api.db.query(
        `SELECT
           (SELECT array_agg(DISTINCT v ORDER BY v) FROM (${orgsUnion})  _o WHERE v IS NOT NULL AND v <> '') AS organisms,
           (SELECT array_agg(DISTINCT v ORDER BY v) FROM (${cartsUnion}) _c WHERE v IS NOT NULL AND v <> '') AS cartridges`,
        [rec.msId]
      );
      if (!syncRes.ok) throw new Error(`Could not sync organisms/cartridges to ObjectNames: ${syncRes.error}`);
      const mergedOrgs  = syncRes.rows[0]?.organisms  || [];
      const mergedCarts = syncRes.rows[0]?.cartridges || [];
      await window.api.db.query(
        `UPDATE objectnames SET organisms = $1, cartridges = $2 WHERE medscan_id = $3`,
        [mergedOrgs, mergedCarts, rec.msId]
      );
    }

    const fresh = await fetchRecord(rec.msId);
    fresh.hasObjectNames = true;
    lastConflictMsIds.current = ''; // force conflict re-scan after save (aliases may have changed)
    setRecords(r => r.map((x, i) => i === idx ? fresh : x));
    let msg = `Elsevier NLP ID ${Number(rec.msId).toLocaleString()} saved.`;
    setSaveMsg({ text: msg, persistent: false });
    } catch (err) {
      console.error('[handleSave] error:', err);
      setError(`Save failed: ${err?.message || String(err)}`);
    } finally {
      setSaving(null);
    }
  };

  // ── Merge Records ────────────────────────────────────────────────────────────
  const [mergeOpen,    setMergeOpen]    = useState(false);
  const [mergeKeeper,  setMergeKeeper]  = useState(null);
  const [merging,      setMerging]      = useState(false);
  const [mergeError,   setMergeError]   = useState(null);

  const handleMergeOpen = () => {
    setMergeKeeper(records[0]?.msId ?? null);
    setMergeError(null);
    setMergeOpen(true);
  };

  const handleMergeProceed = async () => {
    if (!mergeKeeper) return;
    setMerging(true); setMergeError(null);
    try {
      const keeperId   = mergeKeeper;
      const nonKeepers = records.filter(r => r.msId !== keeperId);

      // Every query must succeed: window.api.db.query returns {ok:false} instead of throwing, and the old
      // merge ignored those errors (a unique-key violation silently left the rows on the old ID).
      const q = async (sql, params) => {
        const r = await window.api.db.query(sql, params);
        if (!r.ok) throw new Error(r.error);
        return r;
      };

      // A row belongs to a record through medscan_id — that is the link (for rsmap too: its protein_name may
      // differ from the curnames record, only medscan_id ties it to the entity). So merging = give ALL rows of the
      // merged-away record the keeper's medscan_id. The comparison below is NOT a similarity test: it only finds
      // rows that would collide with a row the keeper already has under each table's unique index
      // (rsmap: medscan_id + protein_name + hgvs_code; other tables: medscan_id + alias + match); those exact
      // copies cannot be moved without a unique-key violation and are removed instead.
      const sameKey = (t) => t === 'rsmap'
        ? 'k.protein_name = s.protein_name AND k.hgvs_code = s.hgvs_code'
        : t === 'keywords'
        ? "k.keywords = s.keywords AND COALESCE(k.match, '') = COALESCE(s.match, '')"
        : "k.alias = s.alias AND COALESCE(k.match, '') = COALESCE(s.match, '')";
      const active = '(s.bdeleted IS NULL OR s.bdeleted = FALSE)';
      const kActive = '(k.bdeleted IS NULL OR k.bdeleted = FALSE)';

      let moved = 0, duplicates = 0, kept = 0;
      for (const src of nonKeepers) {
        let keptThis = 0;   // active rows of THIS source record that could not be merged
        for (const t of ALL_EDIT_TABLES) {
          const same = sameKey(t);
          // 1) Move every row the keeper does not already have (set-based: one UPDATE per table).
          const mv = await q(
            `UPDATE ${t} s SET medscan_id = $1, updated_at = NOW()
             WHERE s.medscan_id = $2
               AND NOT EXISTS (SELECT 1 FROM ${t} k WHERE k.medscan_id = $1 AND ${same})`,
            [keeperId, src.msId]);
          moved += mv.rowCount || 0;
          // 2) Rows still on the old ID are exact duplicates of keeper rows. Remove those whose keeper copy
          //    is active; a row whose keeper copy is a soft-deleted tombstone is left alone (not lost).
          const dp = await q(
            `DELETE FROM ${t} s
             WHERE s.medscan_id = $2 AND ${active}
               AND EXISTS (SELECT 1 FROM ${t} k WHERE k.medscan_id = $1 AND ${same} AND ${kActive})`,
            [keeperId, src.msId]);
          duplicates += dp.rowCount || 0;
          const left = await q(
            `SELECT COUNT(*)::int AS n FROM ${t} s WHERE s.medscan_id = $1 AND ${active}`, [src.msId]);
          keptThis += left.rows[0]?.n || 0;
        }
        // The merged-away record no longer exists: drop its ObjectNames row only when nothing active is left on it.
        kept += keptThis;
        if (keptThis === 0) await q('DELETE FROM objectnames WHERE medscan_id = $1', [src.msId]);
      }

      // Keeper's ObjectNames organisms/cartridges = union over all its (now merged) alias rows
      try {
        const T = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames'];
        const act = '(bdeleted IS NULL OR bdeleted = FALSE)';
        const orgsU  = T.map(t => `SELECT unnest(organisms)  AS v FROM ${t} WHERE medscan_id = $1 AND ${act}`).join(' UNION ALL ');
        const cartsU = T.map(t => `SELECT unnest(cartridges) AS v FROM ${t} WHERE medscan_id = $1 AND ${act}`).join(' UNION ALL ');
        const u = await q(
          `SELECT (SELECT array_agg(DISTINCT v ORDER BY v) FROM (${orgsU})  _o WHERE v IS NOT NULL AND v <> '') AS organisms,
                  (SELECT array_agg(DISTINCT v ORDER BY v) FROM (${cartsU}) _c WHERE v IS NOT NULL AND v <> '') AS cartridges`,
          [keeperId]);
        await q('UPDATE objectnames SET organisms = $1, cartridges = $2 WHERE medscan_id = $3',
          [u.rows[0]?.organisms || [], u.rows[0]?.cartridges || [], keeperId]);
      } catch (e) { console.warn('[merge] objectnames sync skipped:', e.message); }

      // Reload keeper and show only it
      const fresh = await fetchRecord(keeperId);
      fresh.hasObjectNames = true;
      setRecords([fresh]);
      setMsIdInput(String(keeperId));
      setMergeOpen(false);
      setSaveMsg({
        text: `Merged ${nonKeepers.length} record(s) into NLP ID ${Number(keeperId).toLocaleString()}: ` +
              `${moved.toLocaleString()} row(s) moved, ${duplicates.toLocaleString()} duplicate(s) removed` +
              (kept > 0 ? `, ${kept.toLocaleString()} row(s) NOT merged (keeper has a soft-deleted copy)` : '') + '.',
        persistent: kept > 0,
      });
    } catch (e) {
      setMergeError('Merge failed: ' + e.message);
    } finally {
      setMerging(false);
    }
  };

  const canSearch = !loading && (msIdInput.trim() || aliasInput.trim());
  const hasSearched = records.length > 0 || notFound.length > 0;

  return (
    <div>
      {/* Merge Records dialog */}
      {mergeOpen && (
        <div className="modal-backdrop" style={{ zIndex: 1200 }}>
          <div className="modal" style={{ maxWidth: 520, width: '96vw' }}>
            <div className="modal-title">Merge Records</div>
            <p style={{ fontSize: 13, margin: '0 0 12px' }}>
              Choose which record to keep. All aliases from the other records
              will be moved to the keeper. Duplicate aliases will be removed.
              The other records' names will be removed.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {records.map(r => (
                <label key={r.msId} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${mergeKeeper === r.msId ? 'var(--accent,#7c9ef8)' : 'var(--border)'}`,
                  background: mergeKeeper === r.msId ? 'var(--accent-subtle, rgba(124,158,248,.12))' : 'var(--surface)',
                }}>
                  <input type="radio" name="merge-keeper" value={r.msId}
                    checked={mergeKeeper === r.msId}
                    onChange={() => setMergeKeeper(r.msId)} />
                  <span style={{ fontSize: 13 }}>
                    <strong>{r.entityName || '(unnamed)'}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>
                      NLP ID {Number(r.msId).toLocaleString()} · {r.aliases.filter(a => !a.bdeleted).length} active alias(es)
                    </span>
                    {r.urn && (
                      <span style={{ display: 'block', fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        {r.urn}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            {mergeError && (
              <div className="alert alert-danger" style={{ fontSize: 12, marginBottom: 10 }}>{mergeError}</div>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setMergeOpen(false)} disabled={merging}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleMergeProceed}
                disabled={merging || !mergeKeeper}>
                {merging ? <><span className="spinner" /> Merging…</> : 'Proceed to merge'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', marginBottom: 0 }}>NLP IDs</label>
        <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 180px', minWidth: 140 }}>
          <input className="form-control" value={msIdInput}
            onChange={e => setMsIdInput(e.target.value)}
            onPaste={e => {
              e.preventDefault();
              const raw = e.clipboardData.getData('text');
              // Strip thousands-separator commas: digit,3-digits-not-followed-by-digit
              // e.g. "4,000,527" → "4000527", but "4000527, 4000528" → "4000527, 4000528"
              const stripped = raw.replace(/(\d{1,3}),(\d{3})(?!\d)/g, '$1$2')
                                  .replace(/(\d{1,3}),(\d{3})(?!\d)/g, '$1$2'); // second pass for 7-digit+ numbers
              const el = e.target;
              setMsIdInput(prev =>
                prev.slice(0, el.selectionStart) + stripped + prev.slice(el.selectionEnd)
              );
            }}
            onKeyDown={e => e.key === 'Enter' && canSearch && handleSearch()}
            placeholder="e.g. 5122800, 1263833" />
          <span className="text-xs text-muted" style={{ marginTop: 2 }}>comma-separated</span>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', marginBottom: 0 }}>Aliases</label>
        <div style={{ display: 'flex', flexDirection: 'column', flex: '2 1 220px', minWidth: 160 }}>
          <input className="form-control" value={aliasInput}
            onChange={e => setAliasInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && canSearch && handleSearch()}
            placeholder="e.g. Kepol; borna virus; SA11" />
          <span className="text-xs text-muted" style={{ marginTop: 2 }}>semicolon-separated</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
                        cursor: 'pointer', whiteSpace: 'nowrap', alignSelf: 'flex-start',
                        marginTop: 4 }}>
          <input type="checkbox" checked={aliasSubstring}
            onChange={e => setAliasSubstring(e.target.checked)} />
          Substring
        </label>
        <button className="btn btn-primary" onClick={handleSearch} disabled={!canSearch}
          style={{ whiteSpace: 'nowrap', alignSelf: 'flex-start' }}>
          {loading ? <><span className="spinner" /> Searching…</> : '🔍 Search'}
        </button>
        <button className="btn btn-secondary" onClick={handleMergeOpen}
          disabled={records.length <= 1}
          title={records.length <= 1 ? 'Load two or more records to enable merge' : `Merge ${records.length} records`}
          style={{ whiteSpace: 'nowrap', alignSelf: 'flex-start' }}>
          ⇒ Merge records
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleEditByLlm}
            disabled={records.length === 0 || llmEditing}
            title="Ask LLM to assign URN, select Name, and find additional synonyms for all displayed records"
            style={{ whiteSpace: 'nowrap' }}>
            {llmEditing
              ? <><span className="spinner" /> {llmProgress ? `${llmProgress.done}/${llmProgress.total}` : 'Editing…'}</>
              : '🤖 Edit by LLM'}
          </button>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
                          cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
            <input type="checkbox" checked={llmReplace}
              onChange={e => setLlmReplace(e.target.checked)} />
            Replace existing values
          </label>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {error   && <div className="alert alert-danger">{error}</div>}
        {llmMsg  && (
          <div className={`alert ${llmMsg.ok ? 'alert-success' : 'alert-warning'}`}
               style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{llmMsg.text}</span>
            <button onClick={() => setLlmMsg(null)} title="Dismiss"
              style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
                       fontSize: 18, lineHeight: 1, color: 'inherit', opacity: 0.55, padding: '0 2px' }}>×</button>
          </div>
        )}
        {saveMsg && (
          <div className="alert alert-info" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span style={{ flex: 1 }}>{saveMsg.text}</span>
            <button
              onClick={() => setSaveMsg(null)}
              title="Dismiss"
              style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
                       fontSize: 18, lineHeight: 1, color: 'inherit', opacity: 0.55, padding: '0 2px' }}>
              ×
            </button>
          </div>
        )}
        {notFound.length > 0 && (
          <div className="alert alert-warning" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>⚠ Not found:</span>
            {notFound.map(term => (
              <span key={term} style={{
                background: 'rgba(255,180,0,0.18)', border: '1px solid rgba(255,180,0,0.45)',
                borderRadius: 4, padding: '1px 8px', fontSize: 12, fontFamily: 'monospace',
              }}>
                "{term}"
              </span>
            ))}
            <span style={{ fontSize: 12, opacity: 0.75 }}>— no active alias matches this search term</span>
          </div>
        )}
      </div>

      {clipboard && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 6, marginBottom: 8, fontSize: 13 }}>
          <span>✂ Clipboard: <strong>{clipboard.alias}</strong>
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
              — search another record, then click Paste inside it
            </span>
          </span>
          <button className="btn btn-xs btn-secondary" style={{ marginLeft: 'auto' }}
            onClick={discardClipboard}>Discard</button>
        </div>
      )}

      {crossConflicts.length > 0 && (
        <div style={{ marginBottom: 12, border: '1px solid var(--danger, #c44)', borderRadius: 6, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ background: 'rgba(200,50,50,0.12)', padding: '6px 12px', fontSize: 12,
                        fontWeight: 600, color: 'var(--danger, #c44)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>⚠ Conflicts — {crossConflicts.length} token{crossConflicts.length !== 1 ? 's' : ''} shared between records</span>
            {conflictSel.size > 0 && (
              <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto', fontSize: 11 }}
                onClick={handleConflictDeleteSelected}>
                🗑 Delete {conflictSel.size} selected alias{conflictSel.size !== 1 ? 'es' : ''}
              </button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 12, margin: 0 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  <th style={{ width: '26%' }}>Tokenized form</th>
                  {records.map(r => (
                    <th key={r.msId} style={{ width: `${74 / records.length}%`, fontWeight: 600 }}>
                      <div>NLP {Number(r.msId).toLocaleString()}</div>
                      {r.entityName && <div style={{ fontWeight: 400, fontSize: 11 }}>{r.entityName}</div>}
                      {r.urn && <div style={{ fontWeight: 400, fontSize: 10, fontFamily: 'monospace',
                                             color: 'var(--text-muted)', wordBreak: 'break-all' }}>{r.urn}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {crossConflicts.map(({ tok, entries }) => {
                  const byId = {};
                  for (const e of entries) {
                    if (!byId[e.msId]) byId[e.msId] = [];
                    byId[e.msId].push(e);
                  }
                  return (
                    <tr key={tok}>
                      <td style={{ fontFamily: 'monospace', color: 'var(--warning,#c80)', whiteSpace: 'nowrap',
                                   verticalAlign: 'top', paddingTop: 6 }}>{tok}</td>
                      {records.map(r => (
                        <td key={r.msId} style={{ verticalAlign: 'top' }}>
                          {(byId[r.msId] || []).map((e) => {
                            const k = conflictSelKey(r.msId, e._id);
                            return (
                              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5,
                                                      cursor: 'pointer', marginBottom: 2 }}>
                                <input type="checkbox" checked={conflictSel.has(k)}
                                  onChange={() => toggleConflictSel(r.msId, e._id)} />
                                <span style={{ fontFamily: 'monospace', overflow: 'hidden',
                                               textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      title={e.alias}>{e.alias}</span>
                                <span style={{ color: 'var(--text-muted)', fontSize: 10,
                                               flexShrink: 0 }}>{e.dict}</span>
                              </label>
                            );
                          })}
                          {!byId[r.msId] && <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Unsaved-records warning modal ── */}
      {unsavedWarn && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.45)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-card, #fff)', border: '1px solid var(--border)',
                        borderRadius: 8, padding: '24px 28px', maxWidth: 480, width: '90%',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Unsaved records</div>
            <div style={{ fontSize: 13, marginBottom: 14, color: 'var(--text)' }}>
              You have <strong>{unsavedWarn.names.length}</strong> unsaved record{unsavedWarn.names.length > 1 ? 's' : ''}:{' '}
              {unsavedWarn.names.map((n, i) => (
                <span key={i}>{i > 0 && ', '}<em>{n}</em></span>
              ))}.
              {' '}Do you want to save them before searching?
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={unsavedWarn.onCancel}
                style={{ fontSize: 13 }}>Cancel</button>
              <button className="btn btn-secondary" onClick={unsavedWarn.onSkip}
                style={{ fontSize: 13 }}>Search without saving</button>
              <button className="btn btn-primary" onClick={unsavedWarn.onSave}
                style={{ fontSize: 13 }}>Save &amp; Search</button>
            </div>
          </div>
        </div>
      )}

      {records.map((rec, idx) => (
        <RecordSection key={rec.msId} record={rec}
          onChange={updated => setRecords(r => r.map((x, i) => i === idx ? updated : x))}
          onSave={(opts) => handleSave(idx, opts)}
          onRemove={() => handleRemove(idx)}
          saving={saving === idx}
          isDirty={isRecordDirty(rec)}
          cartridges={cartridges}
          onFindLiterature={onFindLiterature}
          recIdx={idx}
          clipboard={clipboard}
          setClipboard={setClipboard}
          onDiscardClipboard={discardClipboard}
          sharedMatchOpts={sharedMatchOpts}
          sharedOrganisms={sharedOrganisms}
          onCrossDrop={(payload, toRecIdx, toDict) => {
            setRecords(recs => recs.map((r, i) => {
              if (i === payload.recIdx) {
                // Mark alias as deleted in source record
                return { ...r, aliases: r.aliases.map((a, ai) =>
                  ai === payload.aliasI ? { ...a, _deleted: true } : a
                )};
              }
              if (i === toRecIdx) {
                // Add alias to target record with target dict
                const newAlias = {
                  alias: payload.alias,
                  match: payload.match || '',
                  dict: toDict,
                  tokenized: '',
                  cartridges: payload.cartridges || [],
                  organisms: payload.organisms || [],
                  date_created: null,
                  date_modified: null,
                  _orig: null,        // null = new (unsaved)
                  _origDict: toDict,
                  _origMatch: payload.match || '',
                  _origCartridges: payload.cartridges || [],
                  _origOrganisms: payload.organisms || [],
                  _deleted: false,
                  // completing the move: source DB row is hard-deleted when this record is saved
                  _moveFrom: payload._id != null ? { id: payload._id, dict: payload.srcDict } : null,
                };
                return { ...r, aliases: [...r.aliases, newAlias] };
              }
              return r;
            }));
          }}
        />
      ))}

      {!loading && hasSearched && records.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No records found.</div>
      )}
    </div>
  );
}

// Per-row "Actions" menu for Browse. A custom popup instead of a native <select>: the native
// popup got stuck in Electron (other rows' Actions became unclickable), especially after confirm().
function RowActionsMenu({ items, label = 'Actions ▾', small = false }) {
  const [pos, setPos] = useState(null); // { top, left } while open
  const btnRef = React.useRef(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = e => { if (e.key === 'Escape') close(); };
    // mousedown outside the menu closes it (menu items stop propagation themselves)
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const rc = btnRef.current.getBoundingClientRect();
    const menuH = items.length * 36 + 12;
    const top = rc.bottom + menuH > window.innerHeight ? Math.max(4, rc.top - menuH) : rc.bottom + 2;
    setPos({ top, left: Math.max(4, Math.min(rc.left, window.innerWidth - 230)) });
  };

  const run = async (it) => {
    setPos(null);
    await it.onClick();
    // Electron can leave the window without keyboard/pointer focus after confirm(); restore it.
    window.focus();
  };

  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle} onMouseDown={e => e.stopPropagation()}
        style={{ fontSize: small ? 11 : 12, padding: small ? '1px 8px' : '2px 8px', borderRadius: 4, border: '1px solid var(--border)',
                 background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' }}>
        {label}
      </button>
      {pos && ReactDOM.createPortal(
        // Portal to <body>: inside the table the menu sat in the sticky Actions column's stacking
        // context, under the following rows' buttons, and could not be clicked.
        <div onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 100000, minWidth: 200,
                   background: '#252535', border: '1px solid var(--border)', borderRadius: 6,
                   boxShadow: '0 8px 28px rgba(0,0,0,0.55)', padding: 6, fontSize: 14, color: 'var(--text)' }}>
          {items.length === 0 && <div style={{ padding: '7px 14px', opacity: 0.6 }}>nothing to add</div>}
          {items.map((it, i) => (
            <div key={i} onClick={() => run(it)}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,106,247,0.22)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}
              style={{ padding: '7px 14px', cursor: 'pointer', borderRadius: 4, whiteSpace: 'nowrap' }}>
              {it.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

function DictBrowser({ onEditRecord }) {
  const [activeTable, setActiveTable] = useState(DICT_TABLES[0].table);
  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [tableStats, setTableStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // Sort state stored per table so it survives table switches
  const [sortByTable, setSortByTable] = useState({});  // { [table]: { col, dir } }
  const setSortForTable = (table, col, dir) =>
    setSortByTable(prev => ({ ...prev, [table]: { col, dir } }));
  const [showDeletedBrowse, setShowDeletedBrowse] = useState(false);
  const [showCuratedBrowse, setShowCuratedBrowse] = useState(false);
  const [filterOrganism, setFilterOrganism] = useState('');
  const [availableOrganisms, setAvailableOrganisms] = useState([]);
  const PAGE_SIZE = 100;

  // Tables that have an `xword` column
  const XWORD_TABLES = ['xwords', 'xwords_cells', 'xwords_cas', 'xwords_comb'];
  // All service/xword-like tables (no bdeleted/curated/organisms columns)
  const SERVICE_TABLES = new Set([
    ...XWORD_TABLES, 'spelling', 'bracketstop', 'ontology',
    'organisms_lookup', 'cartridges_lookup', 'match_opts_lookup',
  ]);
  // Pure lookup tables: no id/bdeleted/curated — suppress action column
  const PURE_LOOKUP_TABLES = new Set(['organisms_lookup', 'cartridges_lookup', 'match_opts_lookup']);
  const isXword      = SERVICE_TABLES.has(activeTable);
  const isPureLookup = PURE_LOOKUP_TABLES.has(activeTable);

  // Primary search/sort column per service table
  const serviceSearchCol = (tbl) => {
    if (tbl === 'bracketstop')    return 'word';
    if (tbl === 'spelling')       return 'canonical';
    if (tbl === 'ontology')       return 'class';
    if (tbl === 'organisms_lookup')   return 'name';
    if (tbl === 'cartridges_lookup')  return 'name';
    if (tbl === 'match_opts_lookup')  return 'table_name';
    return 'xword';
  };

  // Default sort: updated_at DESC for entity/objectnames tables so the most recently
  // changed records appear first.  xword tables have no updated_at → keep medscan_id ASC.
  const DEFAULT_SORT_COL = (isXword || !activeTable) ? null : 'updated_at';
  const DEFAULT_SORT_DIR = 'desc';
  const sortCol = sortByTable[activeTable]?.col ?? DEFAULT_SORT_COL;
  const sortDir = sortByTable[activeTable]?.dir ?? DEFAULT_SORT_DIR;

  // Columns excluded from sorting
  const NON_SORTABLE = new Set(['cartridges', 'organisms']);
  const isSortable = c => !NON_SORTABLE.has(c);

  const orderClause = (col) => {
    if (col) return `"${col}" ${sortDir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    if (activeTable === 'bracketstop')    return '"comment" ASC, "word" ASC';
    if (activeTable === 'spelling')       return '"canonical" ASC';
    if (activeTable === 'ontology')       return '"class" ASC, "urn" ASC';
    if (activeTable === 'organisms_lookup')   return '"name" ASC';
    if (activeTable === 'cartridges_lookup')  return '"name" ASC';
    if (activeTable === 'match_opts_lookup')  return '"table_name" ASC, "match_value" ASC';
    return isXword ? '"xword" ASC' : '"medscan_id" ASC';
  };

  // Date columns default to descending (newest first) when first clicked.
  const DATE_COLS = new Set(['created_at', 'updated_at']);
  const handleSortClick = (col) => {
    if (col === sortCol) {
      setSortForTable(activeTable, col, sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortForTable(activeTable, col, DATE_COLS.has(col) ? 'desc' : 'asc');
    }
    setPage(0);
  };

  useEffect(() => { fetchRows(); }, [activeTable, page, sortCol, sortDir, showDeletedBrowse, showCuratedBrowse, filterOrganism]);
  useEffect(() => { setTableStats(null); setShowStats(false); }, [activeTable]);
  // Re-fetch stats whenever any filter changes and the stats panel is open
  useEffect(() => { if (showStats) fetchStats(); }, [showStats, filterOrganism, showDeletedBrowse, showCuratedBrowse]);

  // Load distinct organisms for the current table (entity tables only)
  // rsmap and keywords have no organisms column — skip them.
  const TABLES_WITHOUT_ORGANISMS = new Set(['rsmap', 'keywords', 'objectnames']);
  useEffect(() => {
    setFilterOrganism('');
    setAvailableOrganisms([]);
    if (SERVICE_TABLES.has(activeTable) || TABLES_WITHOUT_ORGANISMS.has(activeTable)) return;
    (async () => {
      const res = await window.api.db.query(
        `SELECT DISTINCT unnest(organisms) AS org FROM "${activeTable}" WHERE organisms IS NOT NULL AND array_length(organisms,1) > 0 ORDER BY org`
      );
      if (res.ok) setAvailableOrganisms(res.rows.map(r => r.org).filter(Boolean));
    })();
  }, [activeTable]);

  const fetchRows = async () => {
    setLoading(true);
    const offset = page * PAGE_SIZE;
    const conditions = [];
    const params = [];
    if (!SERVICE_TABLES.has(activeTable) && activeTable !== 'objectnames' && !showDeletedBrowse)
      conditions.push('(bdeleted IS NULL OR bdeleted = FALSE)');
    if (!SERVICE_TABLES.has(activeTable) && activeTable !== 'objectnames' && showCuratedBrowse)
      conditions.push('curated = TRUE');
    if (!SERVICE_TABLES.has(activeTable) && filterOrganism) {
      params.push(filterOrganism);
      conditions.push(`$${params.length} = ANY(organisms)`);
    }
    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const [res, cntRes] = await Promise.all([
      window.api.db.query(
        `SELECT * FROM "${activeTable}"${whereClause} ORDER BY ${orderClause(sortCol)} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        params.length > 0 ? params : undefined
      ),
      window.api.db.query(
        `SELECT COUNT(*) AS n FROM "${activeTable}"${whereClause}`,
        params.length > 0 ? params : undefined
      ),
    ]);
    setLoading(false);
    if (res.ok) setRows(res.rows);
    else { setRows([]); console.error('Browse query failed:', res.error); }
    setTotalCount(cntRes.ok ? parseInt(cntRes.rows[0].n, 10) : null);
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      // Query all entity-bearing tables in parallel, respecting active filters
      const results = await Promise.all(
        STATS_TABLES.map(({ table }) => {
          const isObjNames = table === 'objectnames';
          const conditions = [];
          const params = [];
          if (!isObjNames && !showDeletedBrowse)
            conditions.push('(bdeleted IS NULL OR bdeleted = FALSE)');
          if (!isObjNames && showCuratedBrowse)
            conditions.push('curated = TRUE');
          if (filterOrganism) {
            params.push(filterOrganism);
            conditions.push(`$${params.length} = ANY(organisms)`);
          }
          const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
          return window.api.db.query(
            `SELECT FLOOR(medscan_id::bigint / 1000000)::bigint AS m, COUNT(*) AS cnt
             FROM "${table}"${where} GROUP BY m`,
            params.length > 0 ? params : undefined
          ).then(res => ({ table, res }));
        })
      );

      // Build per-table maps: table → Map<m, count>
      const tableData = {};
      const allMs = new Set();
      for (const { table, res } of results) {
        tableData[table] = new Map();
        if (res.ok) {
          for (const row of res.rows) {
            const m = parseInt(row.m, 10);
            const cnt = parseInt(row.cnt, 10);
            allMs.add(m);
            tableData[table].set(m, cnt);
          }
        }
      }

      // every entity type is listed (also those without aliases yet), so the table doubles as an ID range lookup
      for (const e of ENTITY_TYPES) allMs.add(Math.floor(e.min / 1000000));
      // Sort m values and map to entity type display names (+ the type's ID range)
      const entityRows = [...allMs].sort((a, b) => a - b).map(m => {
        const et = ENTITY_TYPES.find(e => Math.floor(e.min / 1000000) === m);
        return { m, display: et ? et.display : `Range ${m}M`, range: et ? `${et.min.toLocaleString('en-US')}–${et.max.toLocaleString('en-US')}` : `${(m * 1000000).toLocaleString('en-US')}–${(m * 1000000 + 999999).toLocaleString('en-US')}` };
      });

      setTableStats({ entityRows, tableData, tables: STATS_TABLES });
    } catch (e) {
      console.error('fetchStats error:', e);
      setTableStats(null);
    }
    setStatsLoading(false);
  };

  const handleSearch = async () => {
    if (!search.trim()) { fetchRows(); return; }
    setLoading(true);
    let res;
    if (activeTable === 'ontology') {
      res = await window.api.db.query(
        `SELECT * FROM "ontology" WHERE (class ILIKE $1 OR urn ILIKE $1 OR CAST(medscan_id AS text) ILIKE $1) ORDER BY ${orderClause(sortCol)} LIMIT 200`,
        [`%${search}%`]
      );
    } else if (isXword) {
      const xwCol = serviceSearchCol(activeTable);
      res = await window.api.db.query(
        `SELECT * FROM "${activeTable}" WHERE "${xwCol}" ILIKE $1 ORDER BY ${orderClause(sortCol)} LIMIT 200`,
        [`%${search}%`]
      );
    } else if (activeTable === 'rsmap') {
      const bdel = showDeletedBrowse ? '' : ' AND (bdeleted IS NULL OR bdeleted = FALSE)';
      res = await window.api.db.query(
        `SELECT * FROM "rsmap" WHERE (protein_name ILIKE $1 OR hgvs_code ILIKE $1 OR CAST(medscan_id AS text) ILIKE $1)${bdel} ORDER BY ${orderClause(sortCol)} LIMIT 200`,
        [`%${search}%`]
      );
    } else if (activeTable === 'objectnames') {
      const searchParams = [`%${search}%`];
      let orgClause = '';
      if (filterOrganism) {
        searchParams.push(filterOrganism);
        orgClause = ` AND $${searchParams.length} = ANY(organisms)`;
      }
      res = await window.api.db.query(
        `SELECT * FROM "objectnames" WHERE (name ILIKE $1 OR urn ILIKE $1 OR CAST(medscan_id AS text) ILIKE $1)${orgClause} ORDER BY ${orderClause(sortCol)} LIMIT 200`,
        searchParams
      );
    } else {
      const aliasCol = activeTable === 'keywords' ? 'keywords' : 'alias';
      const bdel = showDeletedBrowse ? '' : ' AND (bdeleted IS NULL OR bdeleted = FALSE)';
      const cur  = showCuratedBrowse ? ' AND curated = TRUE' : '';
      const searchParams = [`%${search}%`];
      let orgClause = '';
      if (filterOrganism) {
        searchParams.push(filterOrganism);
        orgClause = ` AND $${searchParams.length} = ANY(organisms)`;
      }
      // chemnames has no normalized column (single tokens: alias = normalized)
      const normClause = activeTable === 'chemnames' ? '' : ` OR normalized ILIKE $1`;
      res = await window.api.db.query(
        `SELECT * FROM "${activeTable}" WHERE (${aliasCol} ILIKE $1${normClause})${bdel}${cur}${orgClause} ORDER BY ${orderClause(sortCol)} LIMIT 200`,
        searchParams
      );
    }
    setLoading(false);
    if (res.ok) setRows(res.rows);
    else console.error('Browse search failed:', res.error);
  };

  const handleSoftDelete = async (row) => {
    const aliasLabel = row.alias || row.keywords || row.xword || (row.protein_name ? `${row.protein_name} ${row.hgvs_code || ''}`.trim() : null) || `row id ${row.id}`;
    if (isXword) {
      if (!confirm(`Delete "${aliasLabel}"?`)) return;
      await window.api.db.query(`DELETE FROM "${activeTable}" WHERE id = $1`, [row.id]);
    } else if (row.bdeleted) {
      if (!confirm(`Restore alias "${aliasLabel}"?`)) return;
      await window.api.db.query(
        `UPDATE "${activeTable}" SET bdeleted=FALSE, updated_at=NOW() WHERE id = $1`,
        [row.id]
      );
    }
    // (Browse never soft-deletes: bdeleted = TRUE is set only by the Discard button in Edit Record.)
    fetchRows();
  };

  const handleHardDelete = async (row) => {
    const aliasLabel = row.alias || row.keywords || row.xword || `row id ${row.id}`;
    if (!confirm(`Permanently delete "${aliasLabel}" from the database? This cannot be undone.`)) return;
    await window.api.db.query(`DELETE FROM "${activeTable}" WHERE id = $1`, [row.id]);
    fetchRows();
  };

  const handleToggleNlpId = async (row) => {
    const current = Number(row.medscan_id);
    const next    = current === 1000001 ? 1000000 : 1000001;
    await window.api.db.query(
      `UPDATE chemnames SET medscan_id = $1, updated_at = NOW() WHERE id = $2`,
      [next, row.id]
    );
    // Patch the row in-place so the table doesn't scroll back to the top
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, medscan_id: next } : r));
  };

  const cols = rows.length > 0 ? Object.keys(rows[0]).filter(c => c !== 'id') : [];
  const formatCell = (col, val) => {
    if ((col === 'created_at' || col === 'updated_at') && val && val !== '—')
      return new Date(val).toLocaleString();
    return val;
  };

  const termControlActive  = TERM_CONTROL_TABLES.some(t => t.table === activeTable);
  const serviceLookupActive = SERVICE_LOOKUP_TABLES.some(t => t.table === activeTable);

  return (
    <div>
      <div className="flex gap-8 mb-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {DICT_TABLES.map(t => (
          <button key={t.table} className={`btn btn-sm ${activeTable === t.table ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setActiveTable(t.table); setPage(0); setSearch(''); }}>
            {t.label}
          </button>
        ))}
        <span className="text-sm text-muted" style={{ whiteSpace: 'nowrap', marginLeft: 4 }}>Term Control:</span>
        <select
          className="form-control"
          style={{ width: 150, fontSize: 13, height: 28, padding: '0 6px' }}
          value={termControlActive ? activeTable : ''}
          onChange={e => { if (e.target.value) { setActiveTable(e.target.value); setPage(0); setSearch(''); } }}
        >
          <option value="">— select —</option>
          {TERM_CONTROL_TABLES.map(t => (
            <option key={t.table} value={t.table}>{t.label}</option>
          ))}
        </select>
        <span className="text-sm text-muted" style={{ whiteSpace: 'nowrap', marginLeft: 4 }}>Service:</span>
        <select
          className="form-control"
          style={{ width: 160, fontSize: 13, height: 28, padding: '0 6px' }}
          value={serviceLookupActive ? activeTable : ''}
          onChange={e => { if (e.target.value) { setActiveTable(e.target.value); setPage(0); setSearch(''); } }}
        >
          <option value="">— select —</option>
          {SERVICE_LOOKUP_TABLES.map(t => (
            <option key={t.table} value={t.table}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-8 mb-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-control" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Search alias / tokenized…" style={{ flex: '1 1 180px', minWidth: 120 }} />
        <button className="btn btn-secondary" onClick={handleSearch}>Search</button>
        <button className="btn btn-secondary" onClick={() => { setSearch(''); fetchRows(); }}>Clear</button>
        {!isXword && availableOrganisms.length > 0 && (
          <>
            <span className="text-sm text-muted" style={{ whiteSpace: 'nowrap' }}>Organism:</span>
            <select
              className="form-control"
              style={{ width: 160, fontSize: 13, height: 28, padding: '0 6px' }}
              value={filterOrganism}
              onChange={e => { setFilterOrganism(e.target.value); setPage(0); }}
            >
              <option value="">All</option>
              {availableOrganisms.map(org => (
                <option key={org} value={org}>{org}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {loading && <div className="flex items-center gap-8"><span className="spinner" /><span className="text-muted text-sm">Loading…</span></div>}

      {!loading && rows.length === 0 && <div className="alert alert-info">No records found in <strong>{activeTable}</strong>.</div>}

      {!loading && rows.length > 0 && (
        <>
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 240px)' }}>
            <table className="data-table compact">
              <colgroup>
                {cols.map(c => {
                  let w;
                  if (c === 'medscan_id')  w = 90;
                  else if (c === 'match')  w = 60;
                  else if (c === 'cartridges') w = 110;
                  else if (c === 'organisms') w = 130;
                  else if (c === 'alias' || c === 'keywords' || c === 'tokenized') w = 200;
                  else if (c === 'created_at' || c === 'updated_at') w = 145;
                  return <col key={c} style={w ? { width: w } : {}} />;
                })}
                {!isPureLookup && <col style={{ width: 80 }} />}
              </colgroup>
              <thead>
                <tr>
                  {cols.map(c => (
                    <th key={c}
                      onClick={isSortable(c) ? () => handleSortClick(c) : undefined}
                      style={isSortable(c) ? { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' } : {}}>
                      {c}
                      {isSortable(c) && (
                        <span style={{ marginLeft: 4, fontSize: 10, opacity: sortCol === c ? 1 : 0.35 }}>
                          {sortCol === c ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      )}
                    </th>
                  ))}
                  {!isPureLookup && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={r.bdeleted ? { textDecoration: 'line-through', color: 'var(--danger, #c44)', opacity: 0.75 } : {}}>
                    {cols.map(c => {
                      const isCartridges = c === 'cartridges';
                      const isOrganisms  = c === 'organisms';
                      const isAbbrevArr  = isCartridges || isOrganisms;
                      const rawArr = Array.isArray(r[c]) ? r[c] : [];
                      const raw = isAbbrevArr
                        ? (rawArr[0] || '—')                          // first value only
                        : (Array.isArray(r[c]) ? r[c].join(', ') || '—' : (r[c] ?? '—'));
                      const tooltip = isAbbrevArr
                        ? (rawArr.length > 0 ? rawArr.join(', ') : '—') // all values in tooltip
                        : String(formatCell(c, raw));
                      const val = formatCell(c, raw);
                      const isLong = c === 'alias' || c === 'keywords' || c === 'tokenized';
                      return (
                        <td key={c} className={c === 'medscan_id' ? 'mono' : ''}
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: isLong ? 200 : isCartridges ? 110 : isOrganisms ? 130 : undefined,
                          }}
                          title={tooltip}
                        >
                          {val}{isAbbrevArr && rawArr.length > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 3 }}>+{rawArr.length - 1}</span>}
                        </td>
                      );
                    })}
                    {!isPureLookup && <td>
                      <RowActionsMenu items={[
                        { label: 'Edit record', onClick: () => onEditRecord?.(r.medscan_id) },
                        ...((r.bdeleted || isXword) ? [{ label: r.bdeleted ? 'Restore' : 'Delete', onClick: () => handleSoftDelete(r) }] : []),
                        ...(!isXword ? [{ label: 'Delete', onClick: () => handleHardDelete(r) }] : []),
                        ...(activeTable === 'chemnames'
                          ? [{ label: `Toggle NLP ID → ${Number(r.medscan_id) === 1000001 ? '1,000,000' : '1,000,001'}`, onClick: () => handleToggleNlpId(r) }]
                          : []),
                      ]} />
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-8 items-center mt-8 text-sm text-muted">
            <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span>Page {page + 1}</span>
            <button className="btn btn-secondary btn-sm" disabled={rows.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>Next →</button>
            <span>{rows.length}{totalCount != null ? ` of ${totalCount.toLocaleString()}` : ''} records shown</span>
            {!isXword && (
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', marginLeft: 8 }}>
                <input type="checkbox" checked={showDeletedBrowse} onChange={e => { setShowDeletedBrowse(e.target.checked); }} />
                Show deleted
              </label>
            )}
            {!isXword && (
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                              color: showCuratedBrowse ? '#a6e3a1' : undefined }}>
                <input type="checkbox" checked={showCuratedBrowse} onChange={e => { setShowCuratedBrowse(e.target.checked); setPage(0); }} />
                Show curated only
              </label>
            )}
            <button
              className="btn btn-secondary btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                if (!showStats) {
                  if (!tableStats) fetchStats();
                  setShowStats(true);
                } else {
                  setShowStats(false);
                }
              }}
            >
              {showStats ? 'Hide Statistics' : 'Statistics'}
            </button>
          </div>
          {activeTable === 'xwords_cells' && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <strong>Flags:</strong> <code>'o'</code>/<code>'O'</code> — cell object recognition &nbsp;·&nbsp;
              <code>'p'</code>/<code>'P'</code> — cell process recognition &nbsp;·&nbsp;
              <code>'l'</code>/<code>'L'</code> — cell line recognition
            </div>
          )}
        </>
      )}

      {/* ── Table Statistics ── */}
      {showStats && statsLoading && !tableStats && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}>Loading statistics…</div>
      )}
      {showStats && tableStats && tableStats.entityRows && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflowX: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 8 }}>
            Statistics — alias counts by entity type (with its ID range) and dictionary table
          </div>
          {tableStats.entityRows.length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>No data</span>
          ) : (() => {
            const { entityRows, tableData, tables } = tableStats;
            const thStyle = { padding: '3px 10px', color: 'var(--text-dim)', fontWeight: 600, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 11 };
            const tdStyle = { padding: '2px 10px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11 };
            const totals  = tables.map(({ table }) =>
              [...(tableData[table]?.values() ?? [])].reduce((s, v) => s + v, 0)
            );
            return (
              <table style={{ borderCollapse: 'collapse', width: 'max-content' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, textAlign: 'left', padding: '3px 20px 3px 0' }}>Entity Type</th>
                    {tables.map(({ label, table }) => (
                      <th key={table} style={{ ...thStyle, color: table === activeTable ? 'var(--accent, #7ec8f0)' : 'var(--text-dim)' }}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entityRows.map(({ m, display, range }) => (
                    <tr key={m}>
                      <td style={{ ...tdStyle, textAlign: 'left', padding: '2px 20px 2px 0', color: 'var(--text)', whiteSpace: 'nowrap' }}>{display} <span style={{ color: 'var(--text-muted, #888)', fontSize: 10, marginLeft: 6 }}>{range}</span></td>
                      {tables.map(({ table }) => {
                        const cnt = tableData[table]?.get(m) ?? 0;
                        return (
                          <td key={table} style={{ ...tdStyle, color: cnt ? 'var(--text)' : 'var(--text-muted, #555)' }}>
                            {cnt ? cnt.toLocaleString() : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...tdStyle, textAlign: 'left', padding: '3px 20px 3px 0', fontWeight: 600, color: 'var(--text)' }}>Total</td>
                    {totals.map((total, ti) => (
                      <td key={tables[ti].table} style={{ ...tdStyle, fontWeight: 600, color: 'var(--text)' }}>
                        {total ? total.toLocaleString() : '—'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── DB Export ─────────────────────────────────────────────────────────────────
const DEPLOY_STEPS = [
  { n: 1, label: 'Backup'  },
  { n: 2, label: 'Export'  },
  { n: 3, label: 'Compile' },
];

export function DbExport() {
  const [cartridges, setCartridges] = useState([]);
  const [selectedCartridges, setSelectedCartridges] = useState([]);
  const [running,   setRunning]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [curStep,   setCurStep]   = useState(0);
  const [log,       setLog]       = useState([]);
  const [warnings,  setWarnings]  = useState([]);
  const [backupPath,setBackupPath]= useState(null);
  const [error,     setError]     = useState(null);
  const logRef = React.useRef(null);

  const settings_ref = React.useRef(null);
  const [medscanDir, setMedscanDir] = useState('');
  useEffect(() => { window.api.settings.get().then(s => { settings_ref.current = s; setMedscanDir(s?.medscanDir || ''); }); }, []);
  useEffect(() => { window.api.medscan.listCartridges().then(setCartridges); }, []);

  // Auto-scroll log
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const addLog = (msg) => setLog(l => [...l, msg]);

  const handleDeploy = async () => {
    setRunning(true);
    setDone(false);
    setLog([]);
    setWarnings([]);
    setBackupPath(null);
    setError(null);
    setCurStep(0);

    const s = settings_ref.current;
    if (!s?.medscanDir) {
      setError('MedScan directory not configured in Settings.');
      setRunning(false);
      return;
    }

    const off = window.api.medscan.onDeployEvent(ev => {
      if (ev.type === 'step')        setCurStep(ev.data.n);
      if (ev.type === 'log')         addLog(ev.data);
      if (ev.type === 'backup_done') setBackupPath(ev.data.zipPath);
      if (ev.type === 'done') {
        setWarnings(ev.data.warnings || []);
        setDone(true);
        setRunning(false);
        off();
      }
      if (ev.type === 'error') {
        setError(ev.data);
        setRunning(false);
        off();
      }
    });

    await window.api.medscan.deployDicts({
      cartridges: selectedCartridges,
      medscanDir: s.medscanDir,
    });
  };

  const allSelected = cartridges.length > 0 && selectedCartridges.length === cartridges.length;
  const toggleAll = () => setSelectedCartridges(allSelected ? [] : [...cartridges]);

  return (
    <div>
      <div className="alert alert-info mb-12">
        Deploy selected cartridges: backs up existing files → exports from DB → compiles dictionaries.
      </div>

      {/* Export destination path */}
      <div style={{ marginBottom: 12, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-muted)' }}>Export path:</span>
        {medscanDir
          ? <code style={{ background: 'var(--surface-3,#2a2d3e)', padding: '2px 8px', borderRadius: 4, wordBreak: 'break-all' }}>{medscanDir}</code>
          : <span style={{ color: 'var(--danger,#e05c5c)' }}>⚠ Elsevier NLP Installation Directory not configured in Settings</span>}
      </div>

      {/* Cartridge selector */}
      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong>Select Cartridges</strong>
          <button className="btn btn-xs btn-secondary" onClick={toggleAll} style={{ fontSize: 11, padding: '1px 8px' }}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </label>
        <div className="checkbox-list">
          {cartridges.map(c => (
            <label key={c.name} className="checkbox-item">
              <input type="checkbox"
                checked={selectedCartridges.some(s => s.name === c.name)}
                onChange={ev => setSelectedCartridges(ev.target.checked
                  ? [...selectedCartridges, c]
                  : selectedCartridges.filter(s => s.name !== c.name))}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>

      {/* Step progress */}
      {(running || done) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {DEPLOY_STEPS.map(st => {
            const state = (done || curStep > st.n) ? 'done' : curStep === st.n ? 'active' : 'pending';
            return (
              <div key={st.n} style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                color: state === 'pending' ? 'var(--text-muted)' : state === 'active' ? 'var(--accent)' : 'var(--success, #2a9)' ,
                fontWeight: state !== 'pending' ? 600 : 400,
              }}>
                <span style={{ fontSize: 14 }}>
                  {state === 'done' ? '✓' : state === 'active' ? <span className="spinner" style={{ display: 'inline-block' }} /> : '○'}
                </span>
                {st.label}
                {st.n < DEPLOY_STEPS.length && <span style={{ color: 'var(--border)', marginLeft: 5 }}>→</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Backup confirmation banner */}
      {backupPath && (
        <div className="alert alert-success mb-8" style={{ fontSize: 12 }}>
          ✓ Backup saved: <span className="mono" style={{ wordBreak: 'break-all' }}>{backupPath}</span>
        </div>
      )}

      {/* Deploy button */}
      <button className="btn btn-primary" onClick={handleDeploy}
        disabled={running || selectedCartridges.length === 0}>
        {running ? <><span className="spinner" /> Deploying…</> : '🚀 Deploy Dictionaries'}
      </button>

      {/* Log output */}
      {log.length > 0 && (
        <div ref={logRef} className="log-output mt-12"
          style={{ maxHeight: 240, overflowY: 'auto', fontSize: 11 }}>
          {log.map((l, i) => (
            <div key={i} style={{ color: l.startsWith('✗') ? 'var(--danger, #c33)' : 'inherit' }}>{l}</div>
          ))}
        </div>
      )}

      {/* Success banner */}
      {done && !error && (
        <div className="alert alert-success mt-12" style={{ fontWeight: 600 }}>
          ✓ Dictionary deployment was successfully finished.
        </div>
      )}

      {/* Warnings (*** lines) */}
      {warnings.length > 0 && (() => {
        const countConflicts = (lines) => lines.filter(l => l.includes('CC:***') || l.includes('LL:***')).length;
        const totalConflicts = warnings.reduce((n, w) => n + countConflicts(w.lines), 0);
        const totalLines     = warnings.reduce((n, w) => n + w.lines.length, 0);
        return (
          <div className="mt-12">
            <div style={{ fontWeight: 600, color: 'var(--warning, #c80)', marginBottom: 4 }}>
              ⚠ Compiler warnings ({totalLines} line(s)
              {totalConflicts > 0 && <>, <span style={{ color: 'var(--danger, #f44)' }}>{totalConflicts} conflict{totalConflicts !== 1 ? 's' : ''}</span></>}):
            </div>
            {warnings.map((w, wi) => {
              const conflicts = countConflicts(w.lines);
              return (
                <div key={wi} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{w.cart} / {w.org}:</span>
                    {conflicts > 0 && (
                      <span style={{
                        background: 'var(--danger, #f44)', color: '#fff',
                        borderRadius: 3, padding: '0 5px', fontSize: 10, fontWeight: 700,
                      }}>
                        {conflicts} conflict{conflicts !== 1 ? 's' : ''}
                      </span>
                    )}
                    <button
                      className="btn btn-xs btn-secondary"
                      style={{ fontSize: 10, padding: '1px 7px' }}
                      onClick={() => navigator.clipboard.writeText(w.lines.join('\n'))}
                    >Copy</button>
                  </div>
                  <div className="log-output" style={{ fontSize: 11 }}>
                    {w.lines.map((ln, li) => (
                      <div key={li} style={{
                        color: (ln.includes('CC:***') || ln.includes('LL:***'))
                          ? 'var(--danger, #f44)'
                          : 'var(--warning, #c80)',
                      }}>{ln}</div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Error */}
      {error && (
        <div className="alert alert-danger mt-12" style={{ fontSize: 12 }}>✗ {error}</div>
      )}

    </div>
  );
}

function RestoreBackup() {
  const [backups,        setBackups]        = useState(null);   // null = not loaded yet
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [selected,       setSelected]       = useState(null);
  const [restoring,      setRestoring]      = useState(false);
  const [restoreDone,    setRestoreDone]    = useState(false);
  const [restoreLog,     setRestoreLog]     = useState([]);
  const [restoreError,   setRestoreError]   = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const settings_ref = React.useRef(null);
  useEffect(() => { window.api.settings.get().then(s => { settings_ref.current = s; }); }, []);

  const loadBackups = async () => {
    setLoadingBackups(true);
    setBackups(null);
    setSelected(null);
    setRestoreDone(false);
    setRestoreLog([]);
    setRestoreError(null);
    const s = settings_ref.current;
    if (!s?.medscanDir) { setBackups([]); setLoadingBackups(false); return; }
    const r = await window.api.medscan.listBackups({ medscanDir: s.medscanDir });
    setBackups(r.ok ? r.backups : []);
    if (r.ok && r.backups.length > 0) setSelected(r.backups[0].path);
    setLoadingBackups(false);
  };

  const handleRestore = async () => {
    if (!selected) return;
    setRestoring(true);
    setRestoreDone(false);
    setRestoreLog([]);
    setRestoreError(null);
    const s = settings_ref.current;

    // Step 1: extract the zip back to disk
    await new Promise((resolve) => {
      const off = window.api.medscan.onDeployEvent(ev => {
        if (ev.type === 'log')          setRestoreLog(l => [...l, ev.data]);
        if (ev.type === 'restore_done') { off(); resolve(); }
        if (ev.type === 'error')        { setRestoreError(ev.data); setRestoring(false); off(); resolve(); }
      });
      window.api.medscan.restoreBackup({ zipPath: selected, medscanDir: s.medscanDir });
    });

    // Step 2: re-import all .tab.e files from disk into the database
    setRestoreLog(l => [...l, '— Importing restored files into database…']);
    const progressHandler = (msg) => setRestoreLog(l => [...l, msg]);
    window.api.dict.onProgress(progressHandler);
    try {
      const result = await window.api.dict.refresh();
      if (!result.ok) {
        setRestoreError(`DB import failed: ${result.error}`);
      } else {
        setRestoreLog(l => [...l, '✓ Database updated from restored files.']);
        setRestoreDone(true);
      }
    } finally {
      window.api.dict.offProgress();
      setRestoring(false);
    }
  };

  const fmtSize = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
  const fmtDate = (ms) => new Date(ms).toLocaleString();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <strong>Restore Dictionary from Backup</strong>
        <button className="btn btn-secondary btn-sm" onClick={loadBackups} disabled={loadingBackups} style={{ fontSize: 12 }}>
          {loadingBackups ? <><span className="spinner" /> Loading…</> : '📂 Show backups'}
        </button>
      </div>

      {backups !== null && backups.length === 0 && (
        <div className="alert alert-info" style={{ fontSize: 12 }}>No backups found in DictionaryBackup folder.</div>
      )}

      {backups !== null && backups.length > 0 && (
        <>
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
            <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>File</th>
                  <th style={{ width: 140 }}>Created</th>
                  <th style={{ width: 72, textAlign: 'right' }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {backups.map(b => (
                  <tr key={b.path} style={{ cursor: 'pointer', background: selected === b.path ? 'var(--accent-light, rgba(var(--accent-rgb,0,120,212),0.12))' : '' }}
                    onClick={() => setSelected(b.path)}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="radio" readOnly checked={selected === b.path} style={{ cursor: 'pointer' }} />
                    </td>
                    <td className="mono">{b.name}</td>
                    <td>{fmtDate(b.mtimeMs)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtSize(b.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn btn-warning" onClick={() => setConfirmRestore(true)}
            disabled={restoring || !selected}
            style={{ background: 'var(--warning, #d18000)', color: '#fff', border: 'none' }}>
            {restoring ? <><span className="spinner" /> Restoring…</> : '⏪ Restore selected backup'}
          </button>
        </>
      )}

      {confirmRestore && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg, #1e1e2e)', border: '1px solid var(--border, #444)',
                        borderRadius: 10, padding: '28px 32px', maxWidth: 500, width: '90%',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: 'var(--warning, #d18000)' }}>
              ⚠ Restore selected backup?
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
              This will <strong>override all deployed dictionary files</strong> in{' '}
              <code style={{ fontSize: 12 }}>{settings_ref.current?.medscanDir ?? 'the NLP installation directory'}</code>{' '}
              and <strong>reload the database</strong> from the restored files.
              <br /><br />
              Any changes made after the selected backup was created will be <strong style={{ color: 'var(--danger, #e44)' }}>permanently lost</strong>.
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setConfirmRestore(false)}>Cancel</button>
              <button className="btn btn-warning"
                style={{ background: 'var(--warning, #d18000)', color: '#fff', border: 'none' }}
                onClick={() => { setConfirmRestore(false); handleRestore(); }}>
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreLog.length > 0 && (
        <div className="log-output mt-10" style={{ fontSize: 11 }}>
          {restoreLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {restoreDone && (
        <div className="alert alert-success mt-10" style={{ fontWeight: 600 }}>✓ Dictionary files restored successfully.</div>
      )}
      {restoreError && (
        <div className="alert alert-danger mt-10" style={{ fontSize: 12 }}>✗ {restoreError}</div>
      )}
    </div>
  );
}

// ── Refresh from Elsevier NLP Files ────────────────────────────────────────────────
// ── Curate tab — find and remove tokenized-form conflicts ────────────────────
const CURATE_TABLES = [
  { value: 'curnames',       label: 'curNames' },
  { value: 'exactliteral',   label: 'ExactLiteral' },
  { value: 'celldictionary', label: 'cellDictionary' },
  { value: 'chemnames',      label: 'chemNames' },
  { value: 'casdictionary',  label: 'CASDictionary' },
  { value: 'combnames',      label: 'combNames' },
  { value: 'rsmap',          label: 'rsmap' },
];
// Sentinel value used in Find Alias to search across all tables at once
const ALL_TABLES_VALUE = '__all__';
// Sentinel for "find NLP IDs missing from ObjectNames" mode
const MISSING_OBJECTNAMES_VALUE = '__missing_objectnames__';

// Entity type shown in Curate: ONE source of truth — the ranges in shared/entityTypes.js (ENTITY_TYPES).
// (Curate used to keep its own, outdated range list: 7,000,000 Organism, 16,000,000 Medical Procedure,
// 31,000,000 Masking terms, 45,000,000 Protein domain, … all fell into "Other".)
function getEntityType(msId) {
  return resolveEntityTypeFromId(msId)?.display ?? 'Other';
}
const ENTITY_TYPE_OPTIONS = ['All types', ...ENTITY_TYPES.map(e => e.display), 'Other'];

function Curate({ onEditRecord }) {
  const [table,      setTable]      = useState(ALL_TABLES_VALUE);
  const [searching,       setSearching]       = useState(false);
  const [conflicts,       setConflicts]       = useState(null);
  const [rsmapObjNames,   setRsmapObjNames]   = useState({}); // medscan_id → { name, urn }
  const [rsmapUpdating,   setRsmapUpdating]   = useState(false);
  const [rsmapUpdateMsg,  setRsmapUpdateMsg]  = useState(null);
  const [rsmapDupModal,   setRsmapDupModal]   = useState(null); // { rowIds, newerIds, conflictRowIds }
  const [skipPrefix,      setSkipPrefix]      = useState('');
  const [error,           setError]           = useState(null);
  const [sel,             setSel]             = useState(new Map());
  const [deleting,        setDeleting]        = useState(false);
  const [deleteMsg,       setDeleteMsg]       = useState(null);
  const [resolveMsg,      setResolveMsg]      = useState(null);
  const [resolvedBy,      setResolvedBy]      = useState(null); // null | 'name' | 'llm'
  const [llmResolving,    setLlmResolving]    = useState(false);
  const [llmProgress,     setLlmProgress]     = useState(null); // { done, total } while running
  const [ctxMenu,         setCtxMenu]         = useState(null); // { x, y, conflict, origIdx } | null
  const [singleLlmRow,    setSingleLlmRow]    = useState(null); // origIdx of row being single-resolved

  // ── Find Alias state ──────────────────────────────────────────────────────
  const [aliasQuery,     setAliasQuery]     = useState('');
  const [aliasSubstring, setAliasSubstring] = useState(false);
  const [aliasSearching, setAliasSearching] = useState(false);
  const [aliasResults,   setAliasResults]   = useState(null); // [{rowId, msId, name, alias, updatedAt}]
  const [aliasError,     setAliasError]     = useState(null);
  const [aliasSelIds,    setAliasSelIds]    = useState(new Set()); // selected row ids
  const [aliasDeleMsg,   setAliasDeleMsg]   = useState(null);
  const [aliasDeleting,  setAliasDeleting]  = useState(false);

  // ── Conflicts pivot view ──────────────────────────────────────────────────
  const [showPairsView,   setShowPairsView]   = useState(false);
  const [conflictPairs,   setConflictPairs]   = useState(null);
  const [pairSel,         setPairSel]         = useState(new Map());
  const [pairRowSel,      setPairRowSel]      = useState(new Set());
  const [pairSort,        setPairSort]        = useState({ col: null, dir: 1 });
  const [merging,         setMerging]         = useState(false);
  const [mergeMsg,        setMergeMsg]        = useState(null);
  // Entity type filters
  const [newerTypeFilter, setNewerTypeFilter] = useState('All types');
  const [olderTypeFilter, setOlderTypeFilter] = useState('All types');
  const [aliasTypeFilter, setAliasTypeFilter] = useState('All types');

  // ── Violations state ──────────────────────────────────────────────────────
  const [violations,        setViolations]        = useState(null); // [{msId, alias, tokenized, match, violType}] | null
  const [violSearching,     setViolSearching]     = useState(false);
  const [violError,         setViolError]         = useState(null);
  const [showViolations,    setShowViolations]    = useState(false);
  const [updatingChemNames, setUpdatingChemNames] = useState(false);
  const [chemUpdateMsg,     setChemUpdateMsg]     = useState(null);

  // ── Missing-in-ObjectNames state ──────────────────────────────────────────
  const [missingObjNames,        setMissingObjNames]        = useState(null);  // [{msId, entityType, dicts:[]}] | null
  const [missingObjNamesSearching, setMissingObjNamesSearching] = useState(false);
  const [missingObjNamesError,   setMissingObjNamesError]   = useState(null);
  const [creatingObjNames,        setCreatingObjNames]        = useState(false);
  const [createObjNamesMsg,       setCreateObjNamesMsg]       = useState(null);  // { ok, text } | null

  // Monotonically-increasing counter: each new conflict search increments this.
  // After the async query resolves we compare against the current value; if it
  // has changed the user has already switched tables and we discard the result.
  const searchGenRef = React.useRef(0);

  // runAliasSearch can be called directly with a query string (e.g. from conflict alias click)
  // or with no argument to use the current aliasQuery state value.
  const runAliasSearch = async (queryOverride) => {
    const q = (queryOverride !== undefined ? queryOverride : aliasQuery).trim();
    if (!q) return;
    if (queryOverride !== undefined) {
      setAliasQuery(queryOverride);
      setAliasSubstring(false);
    }
    setAliasSearching(true); setAliasResults(null); setAliasError(null);
    setAliasSelIds(new Set()); setAliasDeleMsg(null);
    try {
      const useSubstring = queryOverride !== undefined ? false : aliasSubstring;
      const pattern = useSubstring ? `%${q}%` : q;

      // Helper: query one table and return mapped rows
      const queryOneTable = async (tbl) => {
        const aliasCol = tbl === 'keywords' ? 'keywords' : tbl === 'rsmap' ? `protein_name || ' ' || hgvs_code` : 'alias';
        const res = await window.api.db.query(`
          SELECT
            t.id,
            t.medscan_id,
            (SELECT name FROM objectnames WHERE medscan_id = t.medscan_id LIMIT 1) AS record_name,
            t.${aliasCol} AS alias,
            t.updated_at,
            '${tbl}' AS dict
          FROM ${tbl} t
          WHERE t.${aliasCol} ILIKE $1
            AND (t.bdeleted IS NULL OR t.bdeleted = FALSE)
          ORDER BY t.medscan_id, t.updated_at DESC
          LIMIT 500
        `, [pattern]);
        if (!res.ok) throw new Error(`${tbl}: ${res.error}`);
        return res.rows.map(r => ({
          rowId:     Number(r.id),
          msId:      Number(r.medscan_id),
          name:      r.record_name || `#${r.medscan_id}`,
          alias:     r.alias,
          updatedAt: r.updated_at,
          dict:      r.dict,
        }));
      };

      let allRows;
      if (table === ALL_TABLES_VALUE) {
        // Search every table and merge, dedup by (msId, dict) pair
        const allTableRows = await Promise.all(CURATE_TABLES.map(t => queryOneTable(t.value)));
        const seenKey = new Set();
        allRows = allTableRows.flat().filter(r => {
          const k = `${r.msId}|${r.dict}`;
          if (seenKey.has(k)) return false;
          seenKey.add(k); return true;
        });
        allRows.sort((a, b) => a.msId - b.msId);
      } else {
        // Single table — deduplicate by msId only
        const seenMs = new Set();
        allRows = (await queryOneTable(table)).filter(r => {
          if (seenMs.has(r.msId)) return false; seenMs.add(r.msId); return true;
        });
      }
      setAliasResults(allRows);
    } catch (e) {
      setAliasError(e.message);
    } finally {
      setAliasSearching(false);
    }
  };
  const handleFindAlias = () => runAliasSearch();

  // Group selected rows by their source table (needed when "All tables" is active)
  const groupSelectedByDict = () => {
    const byDict = new Map();
    for (const r of (aliasResults || [])) {
      if (!aliasSelIds.has(r.rowId)) continue;
      const tbl = r.dict ?? table;
      if (!byDict.has(tbl)) byDict.set(tbl, []);
      byDict.get(tbl).push(r.rowId);
    }
    return byDict;
  };

  const handleDeleteAliases = async () => {
    if (aliasSelIds.size === 0) return;
    setAliasDeleting(true); setAliasDeleMsg(null); setAliasError(null);
    try {
      let total = 0;
      for (const [tbl, ids] of groupSelectedByDict()) {
        const res = await window.api.db.query(`DELETE FROM ${tbl} WHERE id = ANY($1)`, [ids]);
        if (!res.ok) { setAliasError(res.error || `Delete failed (${tbl}).`); return; }
        total += ids.length;
      }
      setAliasDeleMsg(`Deleted ${total} alias row${total !== 1 ? 's' : ''}.`);
      setAliasResults(prev => prev.filter(r => !aliasSelIds.has(r.rowId)));
      setAliasSelIds(new Set());
    } catch (e) {
      setAliasError(e.message);
    } finally {
      setAliasDeleting(false);
    }
  };

  // ── Compute conflict pairs (unique NLP ID pairs, aggregated) ──────────────
  const computePairs = React.useCallback(async (rawConflicts) => {
    if (!rawConflicts || rawConflicts.length === 0) { setConflictPairs([]); return; }
    const pairMap = new Map();
    for (const c of rawConflicts) {
      const key = `${c.newerMsId}|${c.olderMsId}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, { newerMsId: c.newerMsId, olderMsId: c.olderMsId,
          newerName: c.newerName, olderName: c.olderName,
          newerUrn: '', olderUrn: '', sharedAliases: [] });
      }
      pairMap.get(key).sharedAliases.push({ newerAlias: c.newerAlias, olderAlias: c.olderAlias, tokenized: c.tokenized });
    }
    const allIds = [...new Set([...pairMap.values()].flatMap(p => [p.newerMsId, p.olderMsId]))];
    let urnMap = {};
    if (allIds.length > 0) {
      try {
        const res = await window.api.db.query(
          `SELECT medscan_id, urn FROM objectnames WHERE medscan_id = ANY($1) LIMIT 2000`, [allIds]);
        if (res.ok) res.rows.forEach(r => { urnMap[Number(r.medscan_id)] = r.urn || ''; });
      } catch {}
    }
    setConflictPairs([...pairMap.values()].map(p => ({
      ...p, newerUrn: urnMap[p.newerMsId] || '', olderUrn: urnMap[p.olderMsId] || '',
      count: p.sharedAliases.length,
    })));
  }, []);

  // ── Merge to checked — conflicts raw view ─────────────────────────────────
  const handleMergeConflictsRaw = async () => {
    if (sel.size === 0) return;
    setMerging(true); setMergeMsg(null); setError(null);
    try {
      let count = 0;
      for (const [i, side] of sel.entries()) {
        const c = conflicts[i];
        const destId = side === 'newer' ? c.newerMsId : c.olderMsId;
        const srcId  = side === 'newer' ? c.olderMsId : c.newerMsId;
        // Drop src rows whose tokenized form already exists in dest (the conflict itself)
        // to avoid unique-constraint violations on the subsequent UPDATE.
        const del = await window.api.db.query(
          `DELETE FROM ${table} WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)
             AND tokenized IN (
               SELECT tokenized FROM ${table} WHERE medscan_id = $2
                 AND (bdeleted IS NULL OR bdeleted = FALSE)
             )`,
          [srcId, destId]);
        if (!del.ok) throw new Error(del.error || 'Pre-merge dedup failed');
        const res = await window.api.db.query(
          `UPDATE ${table} SET medscan_id = $1 WHERE medscan_id = $2 AND (bdeleted IS NULL OR bdeleted = FALSE)`, [destId, srcId]);
        if (!res.ok) throw new Error(res.error || 'Merge failed');
        count++;
      }
      setMergeMsg(`Merged ${count} pair(s). Re-running search…`);
      setSel(new Map()); setRowSel(new Set());
      await handleFindConfirmed();
    } catch (e) { setError(e.message); } finally { setMerging(false); }
  };

  // ── Merge to checked — conflicts pairs view ───────────────────────────────
  const handleMergeConflictsPairs = async () => {
    if (pairSel.size === 0 || !sortedPairs) return;
    setMerging(true); setMergeMsg(null); setError(null);
    try {
      let count = 0;
      for (const [i, side] of pairSel.entries()) {
        const pair = sortedPairs[i];
        if (!pair) continue;
        const destId = side === 'newer' ? pair.newerMsId : pair.olderMsId;
        const srcId  = side === 'newer' ? pair.olderMsId : pair.newerMsId;
        // Drop src rows whose tokenized form already exists in dest before moving the rest.
        const del = await window.api.db.query(
          `DELETE FROM ${table} WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)
             AND tokenized IN (
               SELECT tokenized FROM ${table} WHERE medscan_id = $2
                 AND (bdeleted IS NULL OR bdeleted = FALSE)
             )`,
          [srcId, destId]);
        if (!del.ok) throw new Error(del.error || 'Pre-merge dedup failed');
        const res = await window.api.db.query(
          `UPDATE ${table} SET medscan_id = $1 WHERE medscan_id = $2 AND (bdeleted IS NULL OR bdeleted = FALSE)`, [destId, srcId]);
        if (!res.ok) throw new Error(res.error || 'Merge failed');
        count++;
      }
      setMergeMsg(`Merged ${count} record(s). Re-running search…`);
      setPairSel(new Map()); setPairRowSel(new Set());
      await handleFindConfirmed();
    } catch (e) { setError(e.message); } finally { setMerging(false); }
  };

  // ── Merge to checked — alias view ─────────────────────────────────────────
  const handleMergeAliases = async () => {
    if (!aliasResults || aliasSelIds.size === 0) return;
    const checked   = aliasResults.filter(r => aliasSelIds.has(r.rowId));
    const unchecked = aliasResults.filter(r => !aliasSelIds.has(r.rowId));
    if (checked.length !== 1) { setAliasError('Select exactly one record as the merge destination (check exactly one row).'); return; }
    const destId = checked[0].msId;
    const srcIds = [...new Set(unchecked.map(r => r.msId).filter(id => id !== destId))];
    if (srcIds.length === 0) { setAliasError('No unchecked records to merge.'); return; }
    setAliasDeleting(true); setAliasDeleMsg(null); setAliasError(null);
    try {
      for (const srcId of srcIds) {
        for (const t of CURATE_TABLES) {
          await window.api.db.query(
            `UPDATE ${t.value} SET medscan_id = $1 WHERE medscan_id = $2`, [destId, srcId]);
        }
      }
      setAliasDeleMsg(`Merged ${srcIds.length} record(s) into NLP ID ${destId}.`);
      await runAliasSearch();
    } catch (e) { setAliasError(e.message); } finally { setAliasDeleting(false); }
  };

  // ── Pairs view derived data ───────────────────────────────────────────────
  const filteredPairs = React.useMemo(() => {
    if (!conflictPairs) return null;
    return conflictPairs.filter(p => {
      if (newerTypeFilter !== 'All types' && getEntityType(p.newerMsId) !== newerTypeFilter) return false;
      if (olderTypeFilter !== 'All types' && getEntityType(p.olderMsId) !== olderTypeFilter) return false;
      return true;
    });
  }, [conflictPairs, newerTypeFilter, olderTypeFilter]);

  const sortedPairs = React.useMemo(() => {
    if (!filteredPairs || !pairSort.col) return filteredPairs;
    const { col, dir } = pairSort;
    return [...filteredPairs].sort((a, b) => {
      const getVal = (o) => ({ count: o.count, newerName: o.newerName, newerUrn: o.newerUrn,
        olderName: o.olderName, olderUrn: o.olderUrn, newerMsId: o.newerMsId, olderMsId: o.olderMsId })[col] ?? '';
      const av = getVal(a), bv = getVal(b);
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
    });
  }, [filteredPairs, pairSort]);

  const togglePairSort = (col) => setPairSort(prev => prev.col === col ? { col, dir: prev.dir * -1 } : { col, dir: 1 });
  const pairSortIcon  = (col) => pairSort.col !== col ? ' ↕' : pairSort.dir === 1 ? ' ↑' : ' ↓';

  const togglePair = (i, side) => setPairSel(prev => {
    const next = new Map(prev); if (next.get(i) === side) next.delete(i); else next.set(i, side); return next;
  });
  const allPairNewerChecked = sortedPairs?.length > 0 && sortedPairs.every((_, i) => pairSel.get(i) === 'newer');
  const allPairOlderChecked = sortedPairs?.length > 0 && sortedPairs.every((_, i) => pairSel.get(i) === 'older');
  const selectAllPairSide   = (side) => setPairSel(prev => {
    const next = new Map(prev);
    const allThis = (sortedPairs || []).every((_, i) => prev.get(i) === side);
    (sortedPairs || []).forEach((_, i) => { if (allThis) next.delete(i); else next.set(i, side); });
    return next;
  });
  const lastPairRowClick = React.useRef(null);
  const handlePairRowClick = (i, e) => {
    if (e.shiftKey && lastPairRowClick.current !== null) {
      const [lo, hi] = [Math.min(lastPairRowClick.current, i), Math.max(lastPairRowClick.current, i)];
      setPairRowSel(prev => { const next = new Set(prev); for (let p = lo; p <= hi; p++) next.add(p); return next; });
    } else if (e.ctrlKey || e.metaKey) {
      setPairRowSel(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; });
      lastPairRowClick.current = i;
    } else {
      setPairRowSel(new Set([i])); lastPairRowClick.current = i;
    }
  };
  const checkPairSelected = (side) => {
    if (pairRowSel.size === 0) return;
    setPairSel(prev => { const next = new Map(prev); pairRowSel.forEach(i => next.set(i, side)); return next; });
  };

  // ── Alias view entity type filter ─────────────────────────────────────────
  const filteredAliasResults = React.useMemo(() => {
    if (!aliasResults) return null;
    if (aliasTypeFilter === 'All types') return aliasResults;
    return aliasResults.filter(r => getEntityType(r.msId) === aliasTypeFilter);
  }, [aliasResults, aliasTypeFilter]);

  // Build (oldMsId, proteinName) → newMsId group mappings from current conflicts.
  // Operates on groups so that ALL rsmap rows sharing the same protein_name + old medscan_id
  // are updated in a single SQL statement (fixes the "multiple passes needed" problem).
  // Circular pairs — (A, P)→B and (B, P)→A for the same protein — are detected and excluded
  // because updating them just swaps the medscan_ids, resolving nothing.
  const buildRsmapUpdatePlan = () => {
    const plan = new Map(); // key: `${olderMsId}\t${olderAlias}` → newerMsId
    for (const c of conflicts || []) {
      const key = `${c.olderMsId}\t${c.olderAlias}`;
      if (!plan.has(key)) plan.set(key, c.newerMsId);
    }

    // Detect circular conflicts: (A, P) → B and (B, P) → A
    const circular = new Set();
    for (const [key, newId] of plan) {
      const tab = key.indexOf('\t');
      const oldId = Number(key.slice(0, tab));
      const pname = key.slice(tab + 1);
      const reverseKey = `${newId}\t${pname}`;
      if (plan.has(reverseKey) && plan.get(reverseKey) === oldId) {
        circular.add(key);
        circular.add(reverseKey);
      }
    }

    const oldMsIds = [], proteinNames = [], newMsIds = [];
    const circularProteins = new Set();
    for (const [key, newId] of plan) {
      if (circular.has(key)) {
        const tab = key.indexOf('\t');
        circularProteins.add(key.slice(tab + 1));
        continue;
      }
      const tab = key.indexOf('\t');
      oldMsIds.push(Number(key.slice(0, tab)));
      proteinNames.push(key.slice(tab + 1));
      newMsIds.push(newId);
    }
    return { oldMsIds, proteinNames, newMsIds, circularProteins };
  };

  // "Resolve to Name": for circular conflicts, pick the NLP ID whose entity name == protein_name.
  // E.g. GAPDH conflict: entity 2597 has name "GAPDH" → rsmap rows with (GAPDH, old_id=12812112) → 2597.
  const handleResolveRsmapToName = async () => {
    if (!conflicts || conflicts.length === 0) return;

    // Filter conflicts where the objectnames entity name matches the rsmap protein_name
    const nameMatches = conflicts.filter(c => {
      const obj = rsmapObjNames[c.newerMsId];
      return obj?.name && obj.name.toLowerCase() === (c.olderAlias || '').toLowerCase();
    });

    if (nameMatches.length === 0) {
      setRsmapUpdateMsg('No conflicts resolved: no rows where the entity Name matches the Protein Name.');
      return;
    }

    // Build group update plan from name-matched conflicts only
    const plan = new Map();
    for (const c of nameMatches) {
      const key = `${c.olderMsId}\t${c.olderAlias}`;
      if (!plan.has(key)) plan.set(key, c.newerMsId);
    }
    const oldMsIds = [], proteinNames = [], newMsIds = [];
    for (const [key, newId] of plan) {
      const tab = key.indexOf('\t');
      oldMsIds.push(Number(key.slice(0, tab)));
      proteinNames.push(key.slice(tab + 1));
      newMsIds.push(newId);
    }

    setRsmapUpdating(true); setRsmapUpdateMsg(null); setRsmapDupModal(null);
    try {
      // Pre-check for duplicates (same logic as handleUpdateRsmap)
      const checkRes = await window.api.db.query(
        `WITH upd AS (
           SELECT unnest($1::int[]) AS old_ms_id,
                  unnest($2::text[]) AS protein_name,
                  unnest($3::int[]) AS new_ms_id
         ),
         ranked AS (
           SELECT r.id, upd.new_ms_id, r.protein_name, r.hgvs_code,
                  ROW_NUMBER() OVER (
                    PARTITION BY upd.new_ms_id, r.protein_name, r.hgvs_code
                    ORDER BY r.id
                  ) AS rn
           FROM upd
           JOIN rsmap r ON r.medscan_id = upd.old_ms_id AND r.protein_name = upd.protein_name
         )
         SELECT COUNT(*)::int AS cnt
         FROM ranked a
         WHERE a.rn > 1
            OR EXISTS (
                 SELECT 1 FROM rsmap ex
                 WHERE ex.medscan_id = a.new_ms_id
                   AND ex.protein_name = a.protein_name
                   AND ex.hgvs_code    = a.hgvs_code
               )`,
        [oldMsIds, proteinNames, newMsIds]
      );
      if (!checkRes.ok) throw new Error(checkRes.error || 'Pre-check failed');

      const conflictCount = Number(checkRes.rows[0]?.cnt ?? 0);
      if (conflictCount > 0) {
        setRsmapDupModal({ oldMsIds, proteinNames, newMsIds, conflictCount, circularProteins: new Set() });
        setRsmapUpdating(false);
        return;
      }

      await executeRsmapUpdate(oldMsIds, proteinNames, newMsIds, 0, false, new Set());
    } catch (e) {
      setRsmapUpdateMsg(`Error: ${e.message}`);
      setRsmapUpdating(false);
    }
  };

  const handleUpdateRsmap = async () => {
    if (!conflicts || conflicts.length === 0) return;
    setRsmapUpdating(true); setRsmapUpdateMsg(null); setRsmapDupModal(null);
    try {
      const { oldMsIds, proteinNames, newMsIds, circularProteins } = buildRsmapUpdatePlan();

      // If ALL entries are circular (nothing to update), report and stop
      if (oldMsIds.length === 0) {
        const names = [...circularProteins].join(', ');
        setRsmapUpdateMsg(
          `No rows updated. All ${circularProteins.size} conflicting protein name${circularProteins.size !== 1 ? 's' : ''} ` +
          `have circular conflicts (${names}) and require manual resolution.`
        );
        setRsmapUpdating(false);
        return;
      }

      // Pre-check: count rows that would violate uniqueness after remapping.
      // Two conflict sources are detected:
      //   1. Existing rsmap row already occupies the target (new_ms_id, protein_name, hgvs_code).
      //   2. Two rows in this batch both land on the same target key (inter-batch conflict);
      //      ROW_NUMBER() partitioned by target key catches these — only rn=1 can win.
      const checkRes = await window.api.db.query(
        `WITH upd AS (
           SELECT unnest($1::int[]) AS old_ms_id,
                  unnest($2::text[]) AS protein_name,
                  unnest($3::int[]) AS new_ms_id
         ),
         ranked AS (
           SELECT r.id, upd.new_ms_id, r.protein_name, r.hgvs_code,
                  ROW_NUMBER() OVER (
                    PARTITION BY upd.new_ms_id, r.protein_name, r.hgvs_code
                    ORDER BY r.id
                  ) AS rn
           FROM upd
           JOIN rsmap r ON r.medscan_id = upd.old_ms_id AND r.protein_name = upd.protein_name
         )
         SELECT COUNT(*)::int AS cnt
         FROM ranked a
         WHERE a.rn > 1
            OR EXISTS (
                 SELECT 1 FROM rsmap ex
                 WHERE ex.medscan_id = a.new_ms_id
                   AND ex.protein_name = a.protein_name
                   AND ex.hgvs_code    = a.hgvs_code
               )`,
        [oldMsIds, proteinNames, newMsIds]
      );
      if (!checkRes.ok) throw new Error(checkRes.error || 'Pre-check failed');

      const conflictCount = Number(checkRes.rows[0]?.cnt ?? 0);
      if (conflictCount > 0) {
        setRsmapDupModal({ oldMsIds, proteinNames, newMsIds, conflictCount, circularProteins });
        setRsmapUpdating(false);
        return;
      }

      await executeRsmapUpdate(oldMsIds, proteinNames, newMsIds, 0, false, circularProteins);
    } catch (e) {
      setRsmapUpdateMsg(`Error: ${e.message}`);
      setRsmapUpdating(false);
    }
  };

  // deleteConflicting: true → delete ALL conflicting rows (both types), then update the rest
  //                   false → skip conflicting rows, update only the safe ones
  const executeRsmapUpdate = async (oldMsIds, proteinNames, newMsIds, conflictCount, deleteConflicting, circularProteins = new Set()) => {
    setRsmapDupModal(null);
    try {
      let deleted = 0;
      let updated = 0;

      if (deleteConflicting) {
        // Delete both types of conflicts:
        //   - rn > 1 : inter-batch duplicates (second+ row targeting the same key)
        //   - rn = 1 but target key already exists in rsmap
        const delRes = await window.api.db.query(
          `WITH upd AS (
             SELECT unnest($1::int[]) AS old_ms_id,
                    unnest($2::text[]) AS protein_name,
                    unnest($3::int[]) AS new_ms_id
           ),
           ranked AS (
             SELECT r.id, upd.new_ms_id, r.protein_name, r.hgvs_code,
                    ROW_NUMBER() OVER (
                      PARTITION BY upd.new_ms_id, r.protein_name, r.hgvs_code
                      ORDER BY r.id
                    ) AS rn
             FROM upd
             JOIN rsmap r ON r.medscan_id = upd.old_ms_id AND r.protein_name = upd.protein_name
           ),
           to_del AS (
             SELECT id FROM ranked WHERE rn > 1
             UNION
             SELECT a.id FROM ranked a WHERE a.rn = 1
               AND EXISTS (
                 SELECT 1 FROM rsmap ex
                 WHERE ex.medscan_id = a.new_ms_id
                   AND ex.protein_name = a.protein_name
                   AND ex.hgvs_code    = a.hgvs_code
               )
           )
           DELETE FROM rsmap WHERE id IN (SELECT id FROM to_del)`,
          [oldMsIds, proteinNames, newMsIds]
        );
        if (!delRes.ok) throw new Error(delRes.error || 'Delete failed');
        deleted = delRes.rowCount ?? 0;

        // Plain update — all conflicts were just removed so no guard needed
        const updRes = await window.api.db.query(
          `UPDATE rsmap r SET medscan_id = upd.new_ms_id
           FROM (SELECT unnest($1::int[]) AS old_ms_id,
                        unnest($2::text[]) AS protein_name,
                        unnest($3::int[]) AS new_ms_id) AS upd
           WHERE r.medscan_id = upd.old_ms_id
             AND r.protein_name = upd.protein_name`,
          [oldMsIds, proteinNames, newMsIds]
        );
        if (!updRes.ok) throw new Error(updRes.error || 'Update failed');
        updated = updRes.rowCount ?? 0;

      } else {
        // Skip mode: use DISTINCT ON to pick one winner per target key, then NOT EXISTS
        // to skip any that still collide with existing rows.
        const updRes = await window.api.db.query(
          `WITH upd AS (
             SELECT unnest($1::int[]) AS old_ms_id,
                    unnest($2::text[]) AS protein_name,
                    unnest($3::int[]) AS new_ms_id
           ),
           safe AS (
             SELECT DISTINCT ON (upd.new_ms_id, r.protein_name, r.hgvs_code)
                    r.id, upd.new_ms_id
             FROM upd
             JOIN rsmap r ON r.medscan_id = upd.old_ms_id AND r.protein_name = upd.protein_name
             WHERE NOT EXISTS (
               SELECT 1 FROM rsmap ex
               WHERE ex.medscan_id = upd.new_ms_id
                 AND ex.protein_name = r.protein_name
                 AND ex.hgvs_code    = r.hgvs_code
             )
             ORDER BY upd.new_ms_id, r.protein_name, r.hgvs_code, r.id
           )
           UPDATE rsmap SET medscan_id = safe.new_ms_id
           FROM safe WHERE rsmap.id = safe.id`,
          [oldMsIds, proteinNames, newMsIds]
        );
        if (!updRes.ok) throw new Error(updRes.error || 'Update failed');
        updated = updRes.rowCount ?? 0;
      }

      const circularSuffix = circularProteins.size > 0
        ? ` ${circularProteins.size} protein name${circularProteins.size !== 1 ? 's' : ''} ` +
          `(${[...circularProteins].join(', ')}) skipped — circular conflicts require manual resolution.`
        : '';
      const resultMsg = deleteConflicting
        ? `${updated.toLocaleString()} row${updated !== 1 ? 's' : ''} updated, ` +
          `${deleted.toLocaleString()} row${deleted !== 1 ? 's' : ''} deleted due to duplication constraint.` +
          circularSuffix
        : `${updated.toLocaleString()} row${updated !== 1 ? 's' : ''} updated` +
          (conflictCount > 0
            ? `, ${conflictCount.toLocaleString()} row${conflictCount !== 1 ? 's' : ''} could not be remapped due to duplication constraint.`
            : '.') +
          circularSuffix;

      await handleFindConfirmed();
      setRsmapUpdateMsg(resultMsg);
    } catch (e) {
      setRsmapUpdateMsg(`Error: ${e.message}`);
    } finally {
      setRsmapUpdating(false);
    }
  };

  const handleFindConfirmed = async () => {
    const gen = ++searchGenRef.current;
    setSearching(true); setConflicts(null); setRsmapObjNames({}); setError(null); setSel(new Map()); setRowSel(new Set()); setDeleteMsg(null);
    try {
      const rows = await findTableConflicts(table);
      if (gen !== searchGenRef.current) return;
      setConflicts(rows);
      // For rsmap: fetch Name + URN from objectnames for all newerMsId values in a
      // separate query (avoiding a triple join in the conflict query itself).
      if (table === 'rsmap' && rows.length > 0) {
        const msIds = [...new Set(rows.map(r => r.newerMsId))];
        const objRes = await window.api.db.query(
          `SELECT DISTINCT ON (medscan_id) medscan_id, name, urn FROM objectnames WHERE medscan_id = ANY($1) ORDER BY medscan_id, id`,
          [msIds]
        );
        if (gen !== searchGenRef.current) return;
        if (objRes.ok) {
          const map = {};
          for (const r of objRes.rows) map[r.medscan_id] = { name: r.name, urn: r.urn };
          setRsmapObjNames(map);
        }
      }
    } catch (e) {
      if (gen !== searchGenRef.current) return;
      setError(e.message);
    } finally {
      if (gen === searchGenRef.current) setSearching(false);
    }
  };

  // Auto-trigger conflict search when the table dropdown changes (and on Curate mount)
  React.useEffect(() => {
    // Always clear violations + missing-objectnames results when table changes
    setViolations(null); setViolError(null); setShowViolations(false);
    setChemUpdateMsg(null);
    setMissingObjNames(null); setMissingObjNamesError(null);
    if (table === ALL_TABLES_VALUE || table === 'chemnames') {
      // "No table selected" or chemnames (no normalized column) — clear any previous results
      setConflicts(null); setSel(new Map()); setRowSel(new Set()); setDeleteMsg(null); setError(null);
      return;
    }
    if (table === MISSING_OBJECTNAMES_VALUE) {
      // ObjectNames mode — run the missing-IDs query, don't run conflict search
      setConflicts(null); setSel(new Map()); setRowSel(new Set()); setDeleteMsg(null); setError(null);
      handleFindMissingInObjectNames();
      return;
    }
    handleFindConfirmed();
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-compute pairs whenever conflicts result changes
  React.useEffect(() => {
    if (conflicts !== null) {
      setShowPairsView(false);
      setPairSel(new Map()); setPairRowSel(new Set()); setMergeMsg(null);
      computePairs(conflicts);
    }
  }, [conflicts]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (i, side) => setSel(prev => {
    const next = new Map(prev);
    if (next.get(i) === side) next.delete(i); else next.set(i, side);
    return next;
  });

  const selectAllSide = (side) => setSel(prev => {
    const next = new Map(prev);
    const allThisSide = conflicts.every((_, i) => prev.get(i) === side);
    conflicts.forEach((_, i) => { if (allThisSide) next.delete(i); else next.set(i, side); });
    return next;
  });

  // ── Violations helpers ────────────────────────────────────────────────────
  const GREEK_TOKENS = new Set(['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa','lambda','mu','nu','xi','omicron','pi','rho','sigma','tau','upsilon','phi','chi','psi','omega']);

  const violationType = (tokenized) => {
    const tokens = tokenized.split(' ').filter(Boolean);
    // C:greek — every token is a Greek letter name (1 or more)
    if (tokens.length >= 1 && tokens.every(t => GREEK_TOKENS.has(t))) return 'C:greek';
    // C:number — exactly one token that is a pure number
    if (tokens.length === 1 && /^\d+$/.test(tokens[0])) return 'C:number';
    // C:latin — exactly one token that is a single letter
    if (tokens.length === 1 && /^[a-z]$/.test(tokens[0])) return 'C:latin';
    return 'C:other';
  };

  // ── Find NLP IDs missing from ObjectNames ────────────────────────────────
  // Queries every alias table for medscan_ids that have no entry in objectnames,
  // then aggregates results by NLP ID showing which dictionaries they appear in.
  const handleFindMissingInObjectNames = async () => {
    setMissingObjNamesSearching(true);
    setMissingObjNames(null);
    setMissingObjNamesError(null);
    try {
      // Tables that have a medscan_id column (all CURATE_TABLES)
      const dictTables = [
        { tbl: 'curnames',       aliasCol: 'alias',       label: 'curNames' },
        { tbl: 'exactliteral',   aliasCol: 'alias',       label: 'ExactLiteral' },
        { tbl: 'celldictionary', aliasCol: 'alias',       label: 'cellDictionary' },
        { tbl: 'casdictionary',  aliasCol: 'alias',       label: 'CASDictionary' },
        { tbl: 'rsmap',          aliasCol: 'protein_name', label: 'rsmap' },
        { tbl: 'keywords',       aliasCol: 'keywords',    label: 'keywords' },
        { tbl: 'userdict',       aliasCol: 'alias',       label: 'userDict' },
      ];

      // Query each table in parallel for IDs not in objectnames
      const results = await Promise.all(dictTables.map(async ({ tbl, aliasCol, label }) => {
        const res = await window.api.db.query(`
          SELECT DISTINCT t.medscan_id
          FROM ${tbl} t
          WHERE (t.bdeleted IS NULL OR t.bdeleted = FALSE)
            AND NOT EXISTS (
              SELECT 1 FROM objectnames o WHERE o.medscan_id = t.medscan_id
            )
          ORDER BY t.medscan_id
          LIMIT 10000
        `);
        if (!res.ok) throw new Error(`${tbl}: ${res.error}`);
        return { label, ids: res.rows.map(r => Number(r.medscan_id)) };
      }));

      // Aggregate: msId → { entityType, dicts: [label, …], aliasCount }
      const byId = new Map();
      for (const { label, ids } of results) {
        for (const msId of ids) {
          if (!byId.has(msId)) byId.set(msId, { msId, entityType: getEntityType(msId), dicts: [] });
          byId.get(msId).dicts.push(label);
        }
      }

      // Sort by msId
      const rows = [...byId.values()].sort((a, b) => a.msId - b.msId);
      setMissingObjNames(rows);
    } catch (e) {
      setMissingObjNamesError(e.message);
    } finally {
      setMissingObjNamesSearching(false);
    }
  };

  // ── Create ObjectNames rows for the listed NLP IDs ───────────────────────────
  // For every NLP ID missing from ObjectNames:
  //   1) take the SHORTEST alias in the dictionaries, but with at least 4 letters/digits (separators don't count)
  //   2) use it as the Name
  //   3) URN = same rule as "Generate URN" in Edit Record: buildEntityUrn(name, entity type of the ID range)
  // IDs without a qualifying alias, outside every entity-type range, or whose generated URN is already used by
  // another record are skipped and reported (nothing is guessed).
  const handleCreateMissingObjectNames = async () => {
    const list = missingObjNames || [];
    if (!list.length || creatingObjNames) return;
    if (!window.confirm(`Create ObjectNames records for ${list.length.toLocaleString()} NLP ID(s)?\n\n` +
      'Name = the shortest alias with at least 4 letters/digits; URN = the default URN for the entity type + encoded name.')) return;
    setCreatingObjNames(true); setCreateObjNamesMsg(null);
    try {
      const q = async (sql, params) => {
        const r = await window.api.db.query(sql, params);
        if (!r.ok) throw new Error(r.error);
        return r;
      };
      const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
      const ids = list.map(r => r.msId);
      const active = '(bdeleted IS NULL OR bdeleted = FALSE)';
      const alnum = (a) => (a.match(/[\p{L}\p{N}]/gu) || []).length;

      // candidate aliases + organisms/cartridges per ID
      const best = new Map();   // msId → alias
      const orgs = new Map(), carts = new Map();
      const addAll = (m, id, arr) => { if (!arr) return; if (!m.has(id)) m.set(id, new Set()); arr.forEach(x => x && m.get(id).add(x)); };
      const SOURCES = [
        { t: 'curnames',       sql: 'alias',        oc: true  },
        { t: 'exactliteral',   sql: 'alias',        oc: true  },
        { t: 'celldictionary', sql: 'alias',        oc: true  },
        { t: 'casdictionary',  sql: 'alias',        oc: true  },
        { t: 'userdict',       sql: 'alias',        oc: true  },
        { t: 'combnames',      sql: 'alias',        oc: true  },
        { t: 'keywords',       sql: 'keywords',     oc: false },
        { t: 'rsmap',          sql: 'protein_name', oc: false },
      ];
      for (const { t, sql, oc } of SOURCES) {
        for (const part of chunk(ids, 3000)) {
          const r = await q(
            `SELECT medscan_id, ${sql} AS alias${oc ? ', organisms, cartridges' : ''} FROM ${t} WHERE medscan_id = ANY($1) AND ${active}`,
            [part]);
          for (const row of r.rows) {
            const id = Number(row.medscan_id);
            const al = (row.alias || '').trim();
            if (oc) { addAll(orgs, id, row.organisms); addAll(carts, id, row.cartridges); }
            if (!al || alnum(al) < 4) continue;
            const cur = best.get(id);
            if (!cur || al.length < cur.length || (al.length === cur.length && al.localeCompare(cur) < 0)) best.set(id, al);
          }
        }
      }

      // build rows
      const rows = [], skipNoAlias = [], skipNoType = [];
      for (const id of ids) {
        const et = resolveEntityTypeFromId(id);
        if (!et) { skipNoType.push(id); continue; }
        const name = best.get(id);
        if (!name) { skipNoAlias.push(id); continue; }
        rows.push({ id, name, urn: buildEntityUrn(name, et) });
      }

      // URNs already used by another record are not reused
      const usedUrns = new Map();   // urn → NLP ID that already owns it
      for (const part of chunk(rows.map(r => r.urn), 3000)) {
        const r = await q('SELECT urn, medscan_id FROM objectnames WHERE urn = ANY($1)', [part]);
        r.rows.forEach(x => usedUrns.set(x.urn, Number(x.medscan_id)));
      }
      // ...and neither twice within this batch (two IDs whose shortest alias is the same text)
      const seenInBatch = new Map(); // urn → first NLP ID in this batch
      const toInsert = [], skipUrn = [];
      const skippedDetails = [];     // every skipped ID with the reason — shown under the result message
      for (const r of rows) {
        if (usedUrns.has(r.urn)) {
          skipUrn.push(r.id);
          skippedDetails.push({ msId: r.id, name: r.name, urn: r.urn, reason: 'URN already used by NLP ID', otherId: usedUrns.get(r.urn) });
          continue;
        }
        if (seenInBatch.has(r.urn)) {
          skipUrn.push(r.id);
          skippedDetails.push({ msId: r.id, name: r.name, urn: r.urn, reason: 'same name/URN as NLP ID (also missing, created in this batch)', otherId: seenInBatch.get(r.urn) });
          continue;
        }
        seenInBatch.set(r.urn, r.id);
        toInsert.push(r);
      }
      skipNoAlias.forEach(id => skippedDetails.push({ msId: id, name: '', urn: '', reason: 'no alias with at least 4 letters/digits' }));
      skipNoType.forEach(id => skippedDetails.push({ msId: id, name: '', urn: '', reason: 'NLP ID is outside every entity-type range' }));

      if (toInsert.length > 0) {
        const now = new Date().toISOString();
        const res = await window.api.db.bulkInsert({
          table: 'objectnames',
          columns: ['medscan_id', 'name', 'urn', 'cartridges', 'organisms', 'created_at', 'updated_at'],
          rows: toInsert.map(r => [r.id, r.name, r.urn,
            [...(carts.get(r.id) || [])].sort(), [...(orgs.get(r.id) || [])].sort(), now, now]),
        });
        if (!res.ok) throw new Error(res.error);
      }

      const skipped = skipNoAlias.length + skipNoType.length + skipUrn.length;
      setCreateObjNamesMsg({
        ok: skipped === 0,
        skipped: skippedDetails.sort((a, b) => a.msId - b.msId),
        text: `Created ${toInsert.length.toLocaleString()} ObjectNames record(s).` +
          (skipNoAlias.length ? ` ${skipNoAlias.length.toLocaleString()} skipped: no alias with at least 4 letters/digits.` : '') +
          (skipUrn.length ? ` ${skipUrn.length.toLocaleString()} skipped: the generated URN is already used by another record.` : '') +
          (skipNoType.length ? ` ${skipNoType.length.toLocaleString()} skipped: NLP ID is outside every entity-type range.` : ''),
      });
      await handleFindMissingInObjectNames();   // refresh: the created IDs disappear from the list
    } catch (e) {
      setCreateObjNamesMsg({ ok: false, text: 'Create failed: ' + e.message });
    } finally {
      setCreatingObjNames(false);
    }
  };

  const handleFindViolations = async () => {
    if (table === ALL_TABLES_VALUE || table === MISSING_OBJECTNAMES_VALUE || table === 'combnames' || table === 'chemnames') return;
    setViolSearching(true); setViolError(null); setViolations(null);
    setShowViolations(true);
    // Clear conflicts view when switching to violations
    try {
      const aliasCol = table === 'keywords' ? 'keywords' : 'alias';
      const res = await window.api.db.query(`
        SELECT t.medscan_id, t.${aliasCol} AS alias, t.tokenized, t.match
        FROM ${table} t
        WHERE t.tokenized IS NOT NULL AND t.tokenized != ''
          AND (t.bdeleted IS NULL OR t.bdeleted = FALSE)
          AND t.tokenized ~ $1
        ORDER BY t.medscan_id
        LIMIT 5000
      `, ['(^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)( (alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega))*$)|(^\\d+$)|(^[a-z]$)']);
      if (!res.ok) throw new Error(res.error);
      const viols = res.rows.map(r => ({
        msId:          Number(r.medscan_id),
        alias:         r.alias,
        tokenized:     r.tokenized,
        match:         r.match,
        violType:      violationType(r.tokenized),
        missingTokens: [],
      }));

      // ── CASdictionary extra: aliases whose tokens are missing from chemNames ──
      if (table === 'casdictionary') {
        // Fetch all active casdictionary aliases with their stored tokenized forms.
        // Use the stored tokenized column (same rules as the DB uses) for accuracy.
        const casRes = await window.api.db.query(`
          SELECT medscan_id, alias, tokenized
          FROM casdictionary
          WHERE tokenized IS NOT NULL AND tokenized != ''
            AND (bdeleted IS NULL OR bdeleted = FALSE)
          ORDER BY medscan_id
        `);
        if (casRes.ok && casRes.rows.length > 0) {
          // Collect all distinct tokens across all aliases
          const allTokens = [...new Set(
            casRes.rows.flatMap(r => r.tokenized.split(/\s+/).filter(Boolean).map(t => t.toLowerCase()).filter(t => /[a-z]/.test(t)))
          )];
          // Batch-check which tokens exist in chemnames (chunks of 500 to avoid IPC/query size limits)
          const existingTokens = new Set();
          const CHEM_CHUNK = 500;
          for (let ci = 0; ci < allTokens.length; ci += CHEM_CHUNK) {
            const batch = allTokens.slice(ci, ci + CHEM_CHUNK);
            const chemRes = await window.api.db.query(
              `SELECT lower(alias) AS alias FROM chemnames WHERE lower(alias) = ANY($1) AND (bdeleted IS NULL OR bdeleted = FALSE)`,
              [batch]
            );
            if (chemRes.ok) chemRes.rows.forEach(r => existingTokens.add(r.alias));
            // If chemRes.ok is false, that batch's tokens stay "missing" (conservative)
          }

          // Build a lookup of existing violations by (msId, alias) to enrich them
          const violKey = (msId, alias) => `${msId}\x00${alias}`;
          const violMap = new Map(viols.map(v => [violKey(v.msId, v.alias), v]));

          for (const r of casRes.rows) {
            const tokens  = r.tokenized.split(/\s+/).filter(Boolean).map(t => t.toLowerCase()).filter(t => /[a-z]/.test(t));
            const missing = tokens.filter(t => !existingTokens.has(t));
            if (!missing.length) continue;

            const key = violKey(Number(r.medscan_id), r.alias);
            if (violMap.has(key)) {
              // Alias already flagged for another reason — just attach missing tokens
              violMap.get(key).missingTokens = missing;
            } else {
              // New violation: only the chemNames issue
              const entry = {
                msId:          Number(r.medscan_id),
                alias:         r.alias,
                tokenized:     r.tokenized,
                match:         null,
                violType:      'C:no-chem-token',
                missingTokens: missing,
              };
              viols.push(entry);
              violMap.set(key, entry);
            }
          }
        }
      }
      // ── End CASdictionary chemNames check ─────────────────────────────────────

      setViolations(viols);
    } catch (e) {
      setViolError(e.message);
    } finally {
      setViolSearching(false);
    }
  };

  // ── Update chemNames from violations "Missing tokens" ─────────────────────
  const handleUpdateChemNames = async () => {
    if (!violations) return;
    const allMissing = [...new Set(
      violations.flatMap(v => v.missingTokens || []).filter(Boolean)
    )];
    if (allMissing.length === 0) {
      setChemUpdateMsg('No missing tokens to add.');
      return;
    }
    setUpdatingChemNames(true);
    setChemUpdateMsg(null);
    try {
      let added = 0;
      for (const token of allMissing) {
        const msId = token.length < 6 ? 1000000 : 1000001;
        const res = await window.api.db.query(
          `INSERT INTO chemnames (medscan_id, alias, created_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (medscan_id, alias) DO NOTHING`,
          [msId, token]
        );
        if (res.ok && res.rowCount !== 0) added++;
      }
      setChemUpdateMsg(`✓ Added/restored ${added} token${added !== 1 ? 's' : ''} in chemNames.`);
      // Re-run violations so the Missing tokens column clears for fixed entries
      handleFindViolations();
    } catch (e) {
      setChemUpdateMsg(`✗ ${e.message}`);
    } finally {
      setUpdatingChemNames(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true); setDeleteMsg(null); setError(null);
    try {
      let ids;
      if (showPairsView) {
        if (pairSel.size === 0) return;
        ids = [];
        for (const [i, side] of pairSel.entries()) {
          const pair = sortedPairs?.[i];
          if (!pair) continue;
          // Collect raw row IDs for all conflicts belonging to this pair
          const pairConflicts = (conflicts || []).filter(c =>
            c.newerMsId === pair.newerMsId && c.olderMsId === pair.olderMsId
          );
          for (const c of pairConflicts) {
            ids.push(side === 'newer' ? c.rowIdNewer : c.rowIdOlder);
          }
        }
      } else {
        if (sel.size === 0) return;
        ids = [...sel.entries()].map(([i, side]) =>
          side === 'newer' ? conflicts[i].rowIdNewer : conflicts[i].rowIdOlder
        );
      }
      if (!ids.length) { setError('No rows to delete.'); return; }
      const res = await window.api.db.query(
        `DELETE FROM ${table} WHERE id = ANY($1)`, [ids]
      );
      if (!res.ok) { setError(res.error || 'Delete failed.'); return; }
      setDeleteMsg(`Deleted ${ids.length} row(s).`);
      showPairsView ? setPairSel(new Map()) : setSel(new Map());
      await handleFindConfirmed();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleResolveToName = async () => {
    if (!conflicts || conflicts.length === 0) return;
    // Load xwords once for the current table, then tokenize all names locally
    const xwordsTableMap = {
      curnames:       'xwords',
      keywords:       'xwords',
      userdict:       'xwords',
      celldictionary: 'xwords_cells',
      casdictionary:  'xwords_cas',
      combnames:      'xwords_comb',
      // exactliteral and chemnames: no xwords
    };
    const svcTable = xwordsTableMap[table];
    let xwordSet = new Set();
    if (svcTable) {
      const res = await window.api.db.query(`SELECT xword FROM ${svcTable} LIMIT 5000`);
      if (res.ok) xwordSet = new Set(res.rows.map(r => r.xword.toLowerCase()));
    }
    const tokenize = makeXwordTokenizer(xwordSet, { stemming: !NO_STEM_TABLES.has(table) });

    // Build name→token cache for every distinct name
    const nameSet = new Set();
    conflicts.forEach(c => {
      if (c.newerName) nameSet.add(c.newerName);
      if (c.olderName) nameSet.add(c.olderName);
    });
    const tokCache = {};
    nameSet.forEach(name => { tokCache[name] = tokenize(name); });

    // Strip skip prefix (case-sensitive) from alias before matching against entity name.
    // e.g. prefix "At", alias "AtFLP1" → stripped "FLP1"; then tokenize and compare to name token.
    const stripPrefix = (alias) => {
      if (skipPrefix && alias.startsWith(skipPrefix)) return alias.slice(skipPrefix.length);
      return alias;
    };

    // Compute updates synchronously BEFORE calling setSel so the resolved
    // count is available immediately (setSel callbacks run asynchronously).
    const updates = new Map(); // i → 'newer' | 'older'
    conflicts.forEach((c, i) => {
      const strippedAlias = stripPrefix(c.newerAlias || '');
      // Normalize for exact comparison: lowercase, hyphens → spaces, collapse runs
      const norm     = s => s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      const aliasLow = norm(strippedAlias);
      const nLow     = norm(c.newerName || '');
      const oLow     = norm(c.olderName || '');

      // ── Step 1: exact case-insensitive match ──────────────────────────────
      // Preferred over tokenized because stemPlural can collapse distinct names
      // (e.g. "acetals" and "acetal" both stem to "acetal") making the tokenized
      // comparison ambiguous.  An exact alias↔name match is unambiguous.
      const newerExact = aliasLow === nLow;
      const olderExact = aliasLow === oLow;
      if (newerExact !== olderExact) {
        // Exactly one side is a verbatim match — resolve to it
        if (newerExact) updates.set(i, 'older'); // keep newer, mark older for deletion
        else            updates.set(i, 'newer'); // keep older, mark newer for deletion
        return;
      }

      // ── Step 2: tokenized match (fallback when neither/both are exact) ────
      const tok = tokenize(strippedAlias).toLowerCase();
      const newerIsName = !!(c.newerName && (tokCache[c.newerName] || '').toLowerCase() === tok);
      const olderIsName = !!(c.olderName && (tokCache[c.olderName] || '').toLowerCase() === tok);
      // Only resolve when exactly one side matches to avoid ambiguity
      if (newerIsName && !olderIsName) { updates.set(i, 'older'); return; }
      if (olderIsName && !newerIsName) { updates.set(i, 'newer'); return; }

      // ── Step 3: sorted-token match (catches word-order variants) ─────────
      // e.g. alias "monocytic chronic leukemia" ↔ name "chronic monocytic leukemia"
      const sortTok = s => s.split(/\s+/).filter(Boolean).sort().join(' ');
      const aliasSorted  = sortTok(tok);
      const newerSorted  = sortTok((tokCache[c.newerName] || '').toLowerCase());
      const olderSorted  = sortTok((tokCache[c.olderName] || '').toLowerCase());
      // Require at least 2 tokens to avoid spurious single-token matches
      const enoughTokens = aliasSorted.includes(' ');
      if (enoughTokens) {
        const newerSortMatch = aliasSorted === newerSorted;
        const olderSortMatch = aliasSorted === olderSorted;
        if (newerSortMatch && !olderSortMatch) updates.set(i, 'older');
        if (olderSortMatch && !newerSortMatch) updates.set(i, 'newer');
      }
    });
    if (updates.size > 0) {
      setSel(prev => { const next = new Map(prev); updates.forEach((side, i) => next.set(i, side)); return next; });
      setResolvedBy('name');
    } else {
      setResolveMsg('Nothing to resolve to name.');
    }
  };

  const handleResolveLlm = async () => {
    if (!conflicts || conflicts.length === 0) return;
    setLlmResolving(true);
    setLlmProgress(null);
    setResolveMsg(null);

    try {
      const aliasCol = table === 'keywords' ? 'keywords' : 'alias';

      // ALL alias tables and their alias column name.
      // A medscan_id can have aliases in any of these; we query all of them
      // so the LLM receives the full alias set for each record.
      // 'keywords' excluded: term control table, not an alias table.
      const ALL_ALIAS_TABLES = [
        { t: 'curnames',       col: 'alias'    },
        { t: 'exactliteral',   col: 'alias'    },
        { t: 'celldictionary', col: 'alias'    },
        { t: 'userdict',       col: 'alias'    },
        { t: 'casdictionary',  col: 'alias'    },
        { t: 'chemnames',      col: 'alias'    },
        { t: 'combnames',      col: 'alias'    },
      ];

      // Fetch aliases for a given medscan_id from every alias table in parallel,
      // combine and deduplicate.
      const fetchAllAliases = async (msId) => {
        const results = await Promise.all(
          ALL_ALIAS_TABLES.map(({ t, col }) =>
            window.api.db.query(`SELECT ${col} AS alias FROM ${t} WHERE medscan_id = $1`, [msId])
          )
        );
        return [...new Set(results.flatMap(r => r.ok ? r.rows.map(row => row.alias) : []))];
      };

      // Strip leading punctuation/namespace prefixes (e.g. ".cap" → "cap") for LLM display
      const stripAliasPfx = s => s.replace(/^[.\-_]+/, '').trim();

      // ── Group conflicts by tokenized alias ──────────────────────────────────
      // Each unique alias → ONE LLM call presenting ALL records that share it.
      // Better than pairwise: for a 3-way conflict (A, B, C sharing alias X),
      // "X → A, B, or C?" is asked once instead of three harder pairwise calls.
      const aliasGroupMap = new Map(); // tokenized → group
      conflicts.forEach((c, i) => {
        const key = c.tokenized;
        if (!aliasGroupMap.has(key)) {
          aliasGroupMap.set(key, {
            displayAlias: stripAliasPfx(c.newerAlias || c.tokenized),
            msIds: new Set(),
            names: new Map(),  // msId → display name
            items: [],         // { i, newerMsId, olderMsId }
          });
        }
        const g = aliasGroupMap.get(key);
        g.msIds.add(c.newerMsId); g.names.set(c.newerMsId, c.newerName);
        g.msIds.add(c.olderMsId); g.names.set(c.olderMsId, c.olderName);
        g.items.push({ i, newerMsId: c.newerMsId, olderMsId: c.olderMsId });
      });

      const groups   = [...aliasGroupMap.values()];
      const total    = groups.length;
      const s2 = await window.api.settings.get();
      const dailyLimit2  = Math.max(1, s2?.llmMaxRequestsPerDay ?? 1000);
      const cappedTotal  = Math.min(total, dailyLimit2);
      if (cappedTotal < total)
        setResolveMsg(`🤖 LLM: processing first ${cappedTotal} of ${total} (daily limit ${dailyLimit2}). Increase in Settings → LLM Connector.`);
      const CONC     = Math.min(25, cappedTotal);
      setLlmProgress({ done: 0, total: cappedTotal });

      // Shared mutable state — safe because JS is single-threaded; awaits interleave
      // but no two workers can mutate these simultaneously.
      let queueIdx = 0;
      let resolved = 0, unresolved = 0, errCount = 0;
      let firstError = null;
      let aborted = false;
      let anyResolved = false;
      // Apply sel updates immediately so the table shows results as they arrive.
      const applySelUpdates = (updates) => {
        if (updates.length === 0) return;
        setSel(prev => {
          const next = new Map(prev);
          updates.forEach(({ i, side }) => next.set(i, side));
          return next;
        });
        if (!anyResolved) { anyResolved = true; setResolvedBy('llm'); }
      };
      // Track which msIds have already been marked for deletion by a prior group.
      // Workers skip groups where ALL records are already decided, avoiding
      // contradictory decisions from parallel workers processing chained conflicts.
      const pendingDelete = new Set(); // msIds the LLM has decided to delete

      // Normalise an LLM reply: strip surrounding quotes/backticks, trailing punctuation,
      // collapse internal whitespace.
      const normalise = s =>
        s.replace(/^[`"']+|[`"']+$/g, '')   // surrounding quotes / backticks
         .replace(/[.,;:!?]+$/, '')           // trailing punctuation ("dicA." → "dicA")
         .replace(/\s+/g, ' ')
         .trim();

      // Errors where retrying more groups won't help — abort the whole run.
      const isRateLimit  = (msg) => {
        const m = (msg || '').toLowerCase();
        return m.includes('429') || m.includes('rate limit') || m.includes('rate_limit') ||
               m.includes('ratelimit') || m.includes('too many requests') ||
               m.includes('request rate') || m.includes('request speed') ||
               m.includes('hit rate') || m.includes('quota exceeded') ||
               m.includes('quota limit') || m.includes('throttl');
      };
      const isFatalError = (msg) => {
        const m = (msg || '').toLowerCase();
        return (
          m.includes('not configured') || m.includes('401') || m.includes('403') ||
          // 429 / rate-limit handled separately via sequential retry
          m.includes('model not found') || m.includes('model_not_found') ||
          m.includes('no such model') || m.includes('does not exist') ||
          m.includes('not active') || m.includes('decommissioned') || m.includes('deprecated')
        );
      };

      // Match LLM reply against a candidate record name (both already lowercased).
      // Exact match is preferred.  Substring match is used when the reply is longer
      // (LLM added "Record N –" prefix or explanation), but rejected when the reply
      // is only slightly longer than the name — that threshold prevents near-identical
      // names like "glycol" (6) matching reply "glycols" (7).
      // The ambiguity guard in the winner-finding loop catches any cross-name false positives,
      // so the threshold only needs to exceed the typical noise length (~2–3 chars).
      const looseMatch = (replyLow, nameLow) =>
        replyLow === nameLow ||
        (replyLow.length >= nameLow.length + 4 && replyLow.includes(nameLow));

      const fetchOrganisms = async (msId) => {
        const r = await window.api.db.query(
          'SELECT organisms FROM objectnames WHERE medscan_id = $1 LIMIT 1', [msId]
        );
        const orgs = r.ok && r.rows.length > 0 ? r.rows[0].organisms : null;
        return Array.isArray(orgs) && orgs.length > 0 ? orgs.join(', ') : 'global (all organisms)';
      };

      // ── Worker: keeps consuming alias groups from the queue until empty ───────
      let retryQueue = []; // group indices that hit rate limit — retried sequentially

      const processOne = async (groupIdx, addDelay = false, inRetry = false) => {
        if (addDelay) await new Promise(r => setTimeout(r, 1000));
        const { displayAlias, msIds, names, items } = groups[groupIdx];

        // Filter out records already marked for deletion by prior groups.
        // This collapses 3+-way conflicts into simpler 2-way conflicts mid-run,
        // matching what a second run would see after deletions are applied.
        const allMsIds = [...msIds].filter(id => !pendingDelete.has(id));
        if (allMsIds.length <= 1) {
          // Conflict already fully resolved by prior decisions — skip LLM call.
          resolved += items.length;
          setLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
          return;
        }

          // Fetch aliases and organisms for ALL records in this group in parallel
          const [aliasResults, orgResults] = await Promise.all([
            Promise.all(allMsIds.map(id => fetchAllAliases(id))),
            Promise.all(allMsIds.map(id => fetchOrganisms(id))),
          ]);

          // Remove the conflict alias itself from each record's alias list so the LLM
          // can use the remaining aliases as genuine evidence without being confused
          // by seeing the disputed alias in every record.
          const conflictNorm = displayAlias.toLowerCase().replace(/\s+/g, '');
          const filterConflict = (aliases) =>
            aliases.filter(a => {
              const aNorm = normalise(a).toLowerCase().replace(/\s+/g, '');
              return aNorm !== conflictNorm;
            });
          const filteredAliasResults = aliasResults.map(filterConflict);

          const recordCount = allMsIds.length;
          const namesList   = allMsIds.map(id => `"${names.get(id)}"`).join(', ');

          // ── Branch: 2-record vs 3+-record prompt ─────────────────────────────
          let winnerMsId = null;           // set for 2-record path
          let shouldDelete = null;         // Map<msId, bool> set for 3+-record path

          if (recordCount === 2) {
            // ── 2-record prompt: pick the canonical owner ───────────────────────
            const recordBlocks = allMsIds.map((msId, idx) =>
              `Record ${idx + 1} (ID ${msId}):\n` +
              `  Name: ${names.get(msId)}\n` +
              `  Entity type: ${resolveEntityTypeFromId(msId)?.display ?? 'Unknown'}\n` +
              `  Organisms: ${orgResults[idx]}\n` +
              `  Aliases: ${filteredAliasResults[idx].slice(0, 40).join('; ')}`
            ).join('\n\n');

            const messages = [
              {
                role: 'system',
                content:
                  'You are a biomedical nomenclature expert with deep knowledge of gene/protein databases ' +
                  '(UniProt, NCBI Gene, EcoCyc, RegulonDB, HGNC, MGI, etc.).\n' +
                  'Your task: identify which biological entity a given alias canonically refers to.\n\n' +
                  'Think through the problem and search for information as needed.\n' +
                  'Your LAST LINE must be a tab-separated answer in exactly this format:\n' +
                  '  <answer><TAB><confidence>\n\n' +
                  `<answer>     = one of: ${namesList}  — or exactly: Cannot resolve\n` +
                  '<confidence> = HIGH | MEDIUM | LOW\n\n' +
                  'Confidence guide:\n' +
                  '  HIGH   = current authoritative databases (EcoliWiki, EcoCyc, UniProt, NCBI Gene)\n' +
                  '           attribute the alias to exactly one of the listed entities — even if older\n' +
                  '           literature was ambiguous, what CURRENT databases say is what matters\n' +
                  '  MEDIUM = likely one entity but no authoritative database entry found\n' +
                  '  LOW    = current databases attribute the alias to BOTH entities simultaneously\n\n' +
                  'CRITICAL RULE: Use "Cannot resolve<TAB>LOW" ONLY when the alias is simultaneously\n' +
                  'canonical for BOTH entities in current databases — NOT simply because older papers\n' +
                  'were ambiguous. If EcoliWiki/EcoCyc/UniProt lists the alias under one entity,\n' +
                  'output that entity name with HIGH confidence.\n\n' +
                  'Example final line:  rbsA\tHIGH',
              },
              {
                role: 'user',
                content:
                  `The alias "${displayAlias}" is duplicated across 2 records.\n` +
                  `Organisms: ${[...new Set(orgResults)].join(', ')}\n\n` +
                  `What entity is "${displayAlias}" a canonical name or historical synonym for?\n` +
                  'Which record below matches that entity?\n\n' +
                  recordBlocks + '\n\n' +
                  '(The disputed alias has been removed from each alias list above; remaining aliases are legitimate.)\n\n' +
                  `End your response with one tab-separated line: <answer><TAB><confidence>\n` +
                  `Valid answers: ${namesList}  or  Cannot resolve`,
              },
            ];

            try {
              const rawReply = (await callLlm(messages, { fn: 'dict.resolveConflicts', temperature: 0 })).trim();
              // Expected: "rbsA\tHIGH"  (single tab-separated line)
              // Parse: scan lines in reverse for a line ending with HIGH/MEDIUM/LOW,
              // separated from the answer by a tab OR any whitespace.
              // Log the raw reply so we can see what the model actually returned.
              console.log(`[LLM] alias="${displayAlias}" raw reply:`, JSON.stringify(rawReply));
              const lines = rawReply.split(/\n/).map(l => l.trim()).filter(Boolean);
              let parsedAnswer = null, confidence = null;
              for (const line of [...lines].reverse()) {
                // Tab-separated: "rbsA\tHIGH"
                const tab = line.indexOf('\t');
                if (tab > 0) {
                  const maybeConf = line.slice(tab + 1).trim().toUpperCase();
                  if (['HIGH', 'MEDIUM', 'LOW'].includes(maybeConf)) {
                    parsedAnswer = normalise(line.slice(0, tab).trim());
                    confidence   = maybeConf;
                    break;
                  }
                }
                // Space-separated: "rbsA HIGH" or "rbsA  HIGH"
                const spaceM = line.match(/^(.+?)\s+(HIGH|MEDIUM|LOW)$/i);
                if (spaceM) {
                  parsedAnswer = normalise(spaceM[1].trim());
                  confidence   = spaceM[2].toUpperCase();
                  break;
                }
              }
              // Fallback: model returned unparseable text → leave unresolved
              if (!parsedAnswer) {
                console.warn(`[LLM] alias="${displayAlias}" — no parseable answer in reply`);
                parsedAnswer = '';
                confidence   = 'LOW';
              }
              console.log(`[LLM] alias="${displayAlias}" → answer="${parsedAnswer}" confidence=${confidence}`);

              if (confidence !== 'HIGH') {
                // leave winnerMsId null → unresolved
              } else {
                const rLow   = parsedAnswer.toLowerCase();
                let ambiguous = false;
                for (const msId of allMsIds) {
                  if (looseMatch(rLow, names.get(msId).toLowerCase())) {
                    if (winnerMsId !== null) { ambiguous = true; winnerMsId = null; break; }
                    winnerMsId = msId;
                  }
                }
                if (ambiguous) winnerMsId = null;
                }
            } catch (e) {
              if (isRateLimit(e.message) && !inRetry) {
                retryQueue.push(groupIdx);
                aborted = true;
              } else {
                errCount++;
                if (!firstError) firstError = e.message;
                unresolved += items.length;
                if (!isRateLimit(e.message) && isFatalError(e.message)) { aborted = true; }
              }
              setLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
              return;
            }

          } else {
            // ── 3+-record prompt: pre-filled table, LLM fills Canonical? column ─
            // Build the table rows (alias column already excluded above)
            const tableRows = allMsIds.map((msId, idx) => {
              const otherAliases = filteredAliasResults[idx].slice(0, 20).join('; ') || '(none)';
              return `| ${names.get(msId).padEnd(35)} | ${otherAliases.slice(0, 60).padEnd(60)} | ???        |`;
            }).join('\n');

            const tableHeader =
              '| Record Name                        | Other aliases (legitimate)                                   | Canonical? |\n' +
              '|------------------------------------|--------------------------------------------------------------|------------|';

            const recordContext = allMsIds.map((msId, idx) =>
              `• ${names.get(msId)} — Type: ${resolveEntityTypeFromId(msId)?.display ?? 'Unknown'}, ` +
              `Organisms: ${orgResults[idx]}`
            ).join('\n');

            const messages = [
              {
                role: 'system',
                content:
                  'You are a biomedical nomenclature expert (UniProt, NCBI Gene, EcoCyc, RegulonDB, HGNC, MGI, etc.).\n' +
                  'A single alias is erroneously stored in multiple database records.\n' +
                  'For each record, determine whether the alias CANONICALLY belongs to it.\n\n' +
                  'Rules:\n' +
                  '  • Yes = this entity genuinely uses this alias in authoritative databases\n' +
                  '  • No  = this entity does NOT canonically use this alias; it was erroneously added\n' +
                  '  • Multiple "Yes" values are valid if the alias genuinely applies to several entities\n' +
                  '  • The disputed alias has been removed from the "Other aliases" column;\n' +
                  '    remaining aliases there are legitimate evidence\n\n' +
                  'Return the completed table ONLY — no extra text. Replace every ??? with Yes or No.',
              },
              {
                role: 'user',
                content:
                  `Alias under review: "${displayAlias}"\n\n` +
                  `Records:\n${recordContext}\n\n` +
                  'Complete the table by replacing ??? with Yes or No:\n\n' +
                  tableHeader + '\n' + tableRows,
              },
            ];

            try {
              const rawReply = (await callLlm(messages, { fn: 'dict.resolveConflicts', temperature: 0 })).trim();

              // Parse each row: find the record name in the line, then look for Yes/No
              shouldDelete = new Map();
              for (const msId of allMsIds) {
                const nameLow = names.get(msId).toLowerCase();
                let found = false;
                for (const line of rawReply.split('\n')) {
                  if (line.toLowerCase().includes(nameLow)) {
                    if (/\byes\b/i.test(line))      { shouldDelete.set(msId, false); found = true; break; }
                    else if (/\bno\b/i.test(line))  { shouldDelete.set(msId, true);  found = true; break; }
                  }
                }
                if (!found) shouldDelete.set(msId, false); // default: keep if unparseable
              }
            } catch (e) {
              if (isRateLimit(e.message) && !inRetry) {
                retryQueue.push(groupIdx);
                aborted = true;
              } else {
                errCount++;
                if (!firstError) firstError = e.message;
                unresolved += items.length;
                if (!isRateLimit(e.message) && isFatalError(e.message)) { aborted = true; }
              }
              setLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
              return;
            }
          }

          // ── Apply decisions ───────────────────────────────────────────────────
          if (winnerMsId !== null) {
            // 2-record path: one clear winner
            const batchUpdates = [];
            items.forEach(({ i, newerMsId, olderMsId }) => {
              const newerWins = newerMsId === winnerMsId;
              const olderWins = olderMsId === winnerMsId;
              const loserMsId = newerWins ? olderMsId : newerMsId;
              if (newerWins)      batchUpdates.push({ i, side: 'older' });
              else if (olderWins) batchUpdates.push({ i, side: 'newer' });
              else                batchUpdates.push({ i, side: 'newer' }); // both losers
              pendingDelete.add(loserMsId); // inform other parallel workers
              resolved++;
            });
            applySelUpdates(batchUpdates);

          } else if (shouldDelete !== null) {
            // 3+-record path: per-record Yes/No table
            const anyDeleted = [...shouldDelete.values()].some(Boolean);
            if (!anyDeleted) {
              // LLM said Yes to all (or couldn't parse) → unresolved
              unresolved += items.length;
            } else {
              const batchUpdates = [];
              items.forEach(({ i, newerMsId, olderMsId }) => {
                const delNewer = shouldDelete.get(newerMsId) ?? false;
                const delOlder = shouldDelete.get(olderMsId) ?? false;
                if (delNewer && !delOlder)       { batchUpdates.push({ i, side: 'newer' }); pendingDelete.add(newerMsId); }
                else if (!delNewer && delOlder)  { batchUpdates.push({ i, side: 'older' }); pendingDelete.add(olderMsId); }
                else if (delNewer && delOlder)   { batchUpdates.push({ i, side: 'newer' }); pendingDelete.add(newerMsId); }
                // both Yes → leave this specific row unresolved (no push)
                resolved++;
              });
              applySelUpdates(batchUpdates);
            }

          } else {
            // 2-record path, no winner (Cannot resolve / low confidence)
            unresolved += items.length;
          }

          setLlmProgress(p => ({ ...p, done: (p?.done ?? 0) + 1 }));
      };

      const worker = async () => {
        while (!aborted && queueIdx < cappedTotal) { await processOne(queueIdx++); }
      };

      // ── Launch CONC workers and wait for all to finish ──────────────────────
      await Promise.all(Array.from({ length: CONC }, worker));

      // ── Sequential retry after rate limit ─────────────────────────────────
      if (retryQueue.length > 0) {
        const skipped = Array.from({ length: Math.max(0, cappedTotal - queueIdx) }, (_, i) => queueIdx + i);
        const toRetry = [...new Set([...retryQueue, ...skipped])].sort((a, b) => a - b);
        aborted = false; firstError = null;
        setLlmProgress({ done: 0, total: toRetry.length });
        // Wait 1 s before the first retry so the LLM's rate-limit window can reset.
        await new Promise(r => setTimeout(r, 1000));
        for (const idx of toRetry) {
          if (aborted) break;
          await processOne(idx, /* addDelay */ true, /* inRetry */ true);
        }
      }

      const parts = [];
      if (resolved > 0)                    parts.push(`${resolved} resolved`);
      if (unresolved - errCount > 0)       parts.push(`${unresolved - errCount} unresolved`);
      if (errCount > 0)                    parts.push(`${errCount} API error${errCount !== 1 ? 's' : ''}`);
      if (retryQueue.length > 0)           parts.push('retried sequentially after rate limit');
      if (aborted)                         parts.push('aborted early');
      let msg = `🤖 LLM: ${parts.join(', ') || 'Nothing resolved'}.`;
      if (firstError) msg += `  Error: ${firstError}`;
      setResolveMsg(msg);
    } catch (e) {
      setResolveMsg(`🤖 LLM error: ${e.message}`);
    } finally {
      setLlmResolving(false);
      setLlmProgress(null);
    }
  };

  // Close context menu when clicking anywhere outside it
  React.useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  // Resolve a single conflict row via LLM (called from context menu)
  const handleResolveSingleByLlm = async (conflict, origIdx) => {
    setCtxMenu(null);
    setSingleLlmRow(origIdx);
    setResolveMsg(null);

    // 'keywords' excluded: term control table, not an alias table.
    const ALL_ALIAS_TABLES = [
      { t: 'curnames',       col: 'alias'    },
      { t: 'exactliteral',   col: 'alias'    },
      { t: 'celldictionary', col: 'alias'    },
      { t: 'userdict',       col: 'alias'    },
      { t: 'casdictionary',  col: 'alias'    },
      { t: 'chemnames',      col: 'alias'    },
      { t: 'combnames',      col: 'alias'    },
    ];

    try {
      const { newerMsId, olderMsId, newerName, olderName, newerAlias } = conflict;
      const displayAlias = newerAlias.replace(/^[.\-_]+/, '').trim();
      const conflictNorm = displayAlias.toLowerCase().replace(/\s+/g, '');

      const fetchAliases = async (msId) => {
        const results = await Promise.all(
          ALL_ALIAS_TABLES.map(({ t, col }) =>
            window.api.db.query(`SELECT ${col} AS alias FROM ${t} WHERE medscan_id = $1`, [msId])
          )
        );
        return [...new Set(results.flatMap(r => r.ok ? r.rows.map(row => row.alias) : []))];
      };

      const fetchOrgs = async (msId) => {
        const r = await window.api.db.query(
          'SELECT organisms FROM objectnames WHERE medscan_id = $1 LIMIT 1', [msId]
        );
        const orgs = r.ok && r.rows.length > 0 ? r.rows[0].organisms : null;
        return Array.isArray(orgs) && orgs.length > 0 ? orgs.join(', ') : 'global (all organisms)';
      };

      const normalise = s =>
        s.replace(/^[`"']+|[`"']+$/g, '').replace(/[.,;:!?]+$/, '').replace(/\s+/g, ' ').trim();

      const looseMatch = (replyLow, nameLow) =>
        replyLow === nameLow || (replyLow.length >= nameLow.length + 4 && replyLow.includes(nameLow));

      const [[aliases1, aliases2], [org1, org2]] = await Promise.all([
        Promise.all([fetchAliases(newerMsId), fetchAliases(olderMsId)]),
        Promise.all([fetchOrgs(newerMsId),    fetchOrgs(olderMsId)]),
      ]);

      const filterConflict = (aliases) =>
        aliases.filter(a => normalise(a).toLowerCase().replace(/\s+/g, '') !== conflictNorm);

      const allMsIds  = [newerMsId, olderMsId];
      const names     = new Map([[newerMsId, newerName], [olderMsId, olderName]]);
      const orgs      = [org1, org2];
      const filtered  = [filterConflict(aliases1), filterConflict(aliases2)];
      const namesList = `"${newerName}", "${olderName}"`;

      const recordBlocks = allMsIds.map((msId, idx) =>
        `Record ${idx + 1} (ID ${msId}):\n` +
        `  Name: ${names.get(msId)}\n` +
        `  Entity type: ${resolveEntityTypeFromId(msId)?.display ?? 'Unknown'}\n` +
        `  Organisms: ${orgs[idx]}\n` +
        `  Aliases: ${filtered[idx].slice(0, 40).join('; ')}`
      ).join('\n\n');

      const messages = [
        {
          role: 'system',
          content:
            'You are a biomedical nomenclature expert with deep knowledge of gene/protein databases ' +
            '(UniProt, NCBI Gene, EcoCyc, RegulonDB, HGNC, MGI, etc.).\n' +
            'Your task: identify which biological entity a given alias canonically refers to.\n\n' +
            'Think through the problem and search for information as needed.\n' +
            'Your LAST LINE must be a tab-separated answer in exactly this format:\n' +
            '  <answer><TAB><confidence>\n\n' +
            `<answer>     = one of: ${namesList}  — or exactly: Cannot resolve\n` +
            '<confidence> = HIGH | MEDIUM | LOW\n\n' +
            'Confidence guide:\n' +
            '  HIGH   = current authoritative databases (EcoliWiki, EcoCyc, UniProt, NCBI Gene)\n' +
            '           attribute the alias to exactly one of the listed entities — even if older\n' +
            '           literature was ambiguous, what CURRENT databases say is what matters\n' +
            '  MEDIUM = likely one entity but no authoritative database entry found\n' +
            '  LOW    = current databases attribute the alias to BOTH entities simultaneously\n\n' +
            'CRITICAL RULE: Use "Cannot resolve<TAB>LOW" ONLY when the alias is simultaneously\n' +
            'canonical for BOTH entities in current databases — NOT simply because older papers\n' +
            'were ambiguous. If EcoliWiki/EcoCyc/UniProt lists the alias under one entity,\n' +
            'output that entity name with HIGH confidence.\n\n' +
            'Example final line:  rbsA\tHIGH',
        },
        {
          role: 'user',
          content:
            `The alias "${displayAlias}" is duplicated across 2 records.\n` +
            `Organisms: ${[...new Set([org1, org2])].join(', ')}\n\n` +
            `What entity is "${displayAlias}" a canonical name or historical synonym for?\n` +
            'Which record below matches that entity?\n\n' +
            recordBlocks + '\n\n' +
            '(The disputed alias has been removed from each alias list above; remaining aliases are legitimate.)\n\n' +
            `End your response with one tab-separated line: <answer><TAB><confidence>\n` +
            `Valid answers: ${namesList}  or  Cannot resolve`,
        },
      ];

      const rawReply = (await callLlm(messages, { fn: 'dict.resolveSingle', temperature: 0 })).trim();
      console.log(`[LLM single] alias="${displayAlias}" raw reply:`, JSON.stringify(rawReply));

      const lines = rawReply.split(/\n/).map(l => l.trim()).filter(Boolean);
      let parsedAnswer = null, confidence = null;
      for (const line of [...lines].reverse()) {
        const tab = line.indexOf('\t');
        if (tab > 0) {
          const maybeConf = line.slice(tab + 1).trim().toUpperCase();
          if (['HIGH', 'MEDIUM', 'LOW'].includes(maybeConf)) {
            parsedAnswer = normalise(line.slice(0, tab).trim());
            confidence   = maybeConf;
            break;
          }
        }
        const spaceM = line.match(/^(.+?)\s+(HIGH|MEDIUM|LOW)$/i);
        if (spaceM) {
          parsedAnswer = normalise(spaceM[1].trim());
          confidence   = spaceM[2].toUpperCase();
          break;
        }
      }
      if (!parsedAnswer) { parsedAnswer = ''; confidence = 'LOW'; }

      if (confidence === 'HIGH') {
        const rLow = parsedAnswer.toLowerCase();
        let winnerMsId = null;
        let ambiguous  = false;
        for (const msId of allMsIds) {
          if (looseMatch(rLow, names.get(msId).toLowerCase())) {
            if (winnerMsId !== null) { ambiguous = true; winnerMsId = null; break; }
            winnerMsId = msId;
          }
        }
        if (!ambiguous && winnerMsId !== null) {
          const newerWins = newerMsId === winnerMsId;
          setSel(prev => { const n = new Map(prev); n.set(origIdx, newerWins ? 'older' : 'newer'); return n; });
          setResolvedBy('llm');
          setResolveMsg(`🤖 LLM resolved "${displayAlias}" → keep ${names.get(winnerMsId)} (${confidence} confidence)`);
          return;
        }
      }

      // Could not resolve — tell the user why, no checkbox changes
      const reason = parsedAnswer.toLowerCase().startsWith('cannot')
        ? 'alias is canonical for both entities in current databases'
        : `answer was "${parsedAnswer || '(empty)'}" with ${confidence || '?'} confidence`;
      setResolveMsg(`🤖 LLM could not resolve "${displayAlias}": ${reason}. No changes made.`);

    } catch (e) {
      setResolveMsg(`🤖 LLM error: ${e.message}`);
    } finally {
      setSingleLlmRow(null);
    }
  };

  const [conflictSort, setConflictSort] = useState({ col: null, dir: 1 });

  const sortedConflicts = React.useMemo(() => {
    if (!conflicts) return conflicts;
    // When a resolve button was used, show only rows that got checked; hide both-unchecked rows
    const base = resolvedBy
      ? conflicts.filter((_, i) => sel.has(i))
      : conflicts;
    if (!conflictSort.col) return base;
    const { col, dir } = conflictSort;
    const key = { newerMsId: 'newerMsId', newerName: 'newerName', newerUpdated: 'newerUpdated',
                  olderMsId: 'olderMsId', olderName: 'olderName', olderUpdated: 'olderUpdated',
                  alias: 'newerAlias' }[col];
    return [...base].sort((a, b) => {
      const av = a[key] ?? '', bv = b[key] ?? '';
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
    });
  }, [conflicts, conflictSort, resolvedBy, sel]);

  const toggleConflictSort = (col) => setConflictSort(prev =>
    prev.col === col ? { col, dir: prev.dir * -1 } : { col, dir: 1 }
  );
  const sortIcon = (col) => conflictSort.col !== col ? ' ↕' : conflictSort.dir === 1 ? ' ↑' : ' ↓';

  const allNewerChecked = conflicts?.length > 0 && conflicts.every((_, i) => sel.get(i) === 'newer');
  const allOlderChecked = conflicts?.length > 0 && conflicts.every((_, i) => sel.get(i) === 'older');

  // Row selection (Ctrl/Shift click) — separate from checkbox state
  const [rowSel,      setRowSel]      = useState(new Set()); // Set of origIdx
  const lastRowClick  = React.useRef(null);

  const handleRowClick = (origIdx, e) => {
    if (e.shiftKey && lastRowClick.current !== null) {
      // Shift: select range between last click and current (by position in sortedConflicts)
      const posLast = sortedConflicts.findIndex(c => conflicts.indexOf(c) === lastRowClick.current);
      const posCur  = sortedConflicts.findIndex(c => conflicts.indexOf(c) === origIdx);
      const [lo, hi] = [Math.min(posLast, posCur), Math.max(posLast, posCur)];
      setRowSel(prev => {
        const next = new Set(prev);
        for (let p = lo; p <= hi; p++) next.add(conflicts.indexOf(sortedConflicts[p]));
        return next;
      });
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl: toggle individual row
      setRowSel(prev => { const next = new Set(prev); next.has(origIdx) ? next.delete(origIdx) : next.add(origIdx); return next; });
      lastRowClick.current = origIdx;
    } else {
      // Plain click: select only this row
      setRowSel(new Set([origIdx]));
      lastRowClick.current = origIdx;
    }
  };

  const checkSelected = (side) => {
    if (rowSel.size === 0) return;
    setSel(prev => { const next = new Map(prev); rowSel.forEach(i => next.set(i, side)); return next; });
    // Keep row selection so the buttons stay visible and the user can immediately
    // apply the opposite check or clear manually.
  };

  return (
    <div style={{ padding: '12px 0' }}>
      {/* ── Find Conflicts ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          className="form-control"
          style={{ width: 160 }}
          value={table}
          onChange={e => {
            setTable(e.target.value);
            setAliasResults(null); setAliasError(null);
            setResolvedBy(null);
          }}
        >
          <option value={ALL_TABLES_VALUE}>— No table selected —</option>
          {CURATE_TABLES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          <option disabled>──────────────</option>
          <option value={MISSING_OBJECTNAMES_VALUE}>⚠ Missing in ObjectNames</option>
        </select>
        {table !== 'rsmap' && (
          <button
            className={`btn ${showViolations ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (!showViolations) {
                handleFindViolations();
              } else {
                setShowViolations(false); setViolations(null); setViolError(null);
              }
            }}
            disabled={table === ALL_TABLES_VALUE || table === MISSING_OBJECTNAMES_VALUE || table === 'combnames' || table === 'chemnames' || violSearching}
            title="Find aliases whose tokenized form consists only of Greek letter names, single letters, or numbers"
          >
            {violSearching
              ? <><span className="spinner" /> Violations…</>
              : showViolations ? '⚠ Hide Violations' : '⚠ Violations'}
          </button>
        )}
        {searching && <><span className="spinner" style={{ marginRight: 4 }} /> Searching…</>}
        {missingObjNamesSearching && <><span className="spinner" style={{ marginRight: 4 }} /> Checking ObjectNames…</>}
        {table !== 'rsmap' && conflicts !== null && conflicts.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="text"
              value={skipPrefix}
              onChange={e => setSkipPrefix(e.target.value)}
              placeholder="Skip prefix…"
              title="Case-sensitive prefix to strip from aliases before matching to entity name (e.g. 'At' turns 'AtFLP1' → 'FLP1')"
              style={{ fontSize: 12, padding: '3px 6px', width: 100, borderRadius: 4,
                       border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
            />
            <button className="btn btn-secondary" onClick={handleResolveToName}
              title="For each conflict where one record has the alias as its entity name (after stripping any skip prefix), check the other record for deletion">
              ✅ Resolve to Name
            </button>
            <button className="btn btn-secondary" onClick={handleResolveLlm}
              disabled={llmResolving}
              title="Ask the configured LLM to decide which record to keep for each conflict. Runs up to 25 requests in parallel. The LLM receives both records' names and alias lists. Conflicts resolved by LLM will have the losing record's checkbox pre-checked for deletion — you can review and adjust before deleting.">
              {llmResolving
                ? <><span className="spinner" />{llmProgress ? ` ${llmProgress.done}/${llmProgress.total}` : ' Resolving…'}</>
                : '🤖 Resolve by LLM'}
            </button>
          </span>
        )}
        {table !== 'rsmap' && conflicts !== null && conflicts.length > 0 && (
          <button
            className={`btn ${showPairsView ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setShowPairsView(v => !v); setPairSel(new Map()); setPairRowSel(new Set()); }}
          >
            {showPairsView ? '📋 Alias View' : '🔀 Conflicts'}
          </button>
        )}
        {table === 'rsmap' && conflicts !== null && conflicts.length > 0 && (
          <button
            className="btn btn-primary"
            onClick={handleUpdateRsmap}
            disabled={rsmapUpdating}
            title="Replace rsmap medscan_id with the NLP ID of the matching alias from curnames / exactliteral"
          >
            {rsmapUpdating ? <><span className="spinner" /> Updating…</> : '✏ Update rsmap'}
          </button>
        )}
        {table === 'rsmap' && conflicts !== null && conflicts.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={handleResolveRsmapToName}
            disabled={rsmapUpdating}
            title="For circular conflicts: assign the NLP ID whose entity Name matches the rsmap Protein Name"
          >
            {rsmapUpdating ? <><span className="spinner" /> Updating…</> : '✅ Resolve to Name'}
          </button>
        )}
        {showPairsView && conflicts !== null && conflicts.length > 0 && (
          <button
            className="btn"
            style={{ background: '#40a02b', color: '#fff', border: '1px solid #40a02b' }}
            onClick={handleMergeConflictsPairs}
            disabled={merging || pairSel.size === 0}
            title="Merge unchecked records' aliases into the checked record"
          >
            {merging ? <><span className="spinner" /> Merging…</> : '🔀 Merge to checked'}
          </button>
        )}
        <button
          className="btn btn-danger"
          style={{ marginLeft: 'auto' }}
          onClick={handleDelete}
          disabled={deleting || (showPairsView ? pairSel.size === 0 : sel.size === 0)}
        >
          {deleting
            ? <><span className="spinner" /> Deleting…</>
            : (() => {
                const n = showPairsView ? pairSel.size : sel.size;
                return `🗑 Delete ${n > 0 ? n : ''} checked duplicate${n !== 1 ? 's' : ''} from database`;
              })()}
        </button>
      </div>

      {error          && <div className="alert alert-danger"  style={{ marginBottom: 12 }}>{error}</div>}
      {deleteMsg      && <div className="alert alert-success" style={{ marginBottom: 12 }}>{deleteMsg}</div>}
      {rsmapUpdateMsg && <div className={`alert ${rsmapUpdateMsg.startsWith('Error') ? 'alert-danger' : 'alert-success'}`} style={{ marginBottom: 12 }}>{rsmapUpdateMsg}</div>}
      {rsmapDupModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg-card, #1e1e2e)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '24px 28px',
            maxWidth: 460,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>⚠ Duplicate Constraint</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong>{rsmapDupModal.conflictCount}</strong> rsmap row{rsmapDupModal.conflictCount !== 1 ? 's' : ''} would
              create duplicates after remapping. What would you like to do?
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" style={{ fontSize: 12 }}
                onClick={() => { setRsmapDupModal(null); setRsmapUpdating(false); }}>
                Cancel
              </button>
              <button className="btn btn-secondary" style={{ fontSize: 12 }}
                disabled={rsmapUpdating}
                onClick={() => {
                  setRsmapUpdating(true);
                  executeRsmapUpdate(rsmapDupModal.oldMsIds, rsmapDupModal.proteinNames, rsmapDupModal.newMsIds, rsmapDupModal.conflictCount, false, rsmapDupModal.circularProteins);
                }}>
                Skip duplicates &amp; Update
              </button>
              <button className="btn btn-primary" style={{ fontSize: 12, background: '#e05252', borderColor: '#e05252' }}
                disabled={rsmapUpdating}
                onClick={() => {
                  setRsmapUpdating(true);
                  executeRsmapUpdate(rsmapDupModal.oldMsIds, rsmapDupModal.proteinNames, rsmapDupModal.newMsIds, rsmapDupModal.conflictCount, true, rsmapDupModal.circularProteins);
                }}>
                Delete duplicates &amp; Update
              </button>
            </div>
          </div>
        </div>
      )}
      {mergeMsg    && <div className="alert alert-success" style={{ marginBottom: 12 }}>{mergeMsg}</div>}
      {resolveMsg  && (
        <div className="alert alert-info" style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resolveMsg}</span>
          <button onClick={() => setResolveMsg(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1,
                     color: 'inherit', opacity: 0.6, padding: '0 2px', flexShrink: 0 }}
            title="Dismiss">×</button>
        </div>
      )}

      {/* ── Violations results ───────────────────────────────────────────────── */}
      {showViolations && (
        <>
          {violError && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{violError}</div>}
          {violations !== null && violations.length === 0 && (
            <div className="alert alert-success" style={{ marginBottom: 12 }}>
              No violations found in <strong>{CURATE_TABLES.find(t => t.value === table)?.label ?? table}</strong>.
            </div>
          )}
          {violations !== null && violations.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <h4 style={{ margin: 0, fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                  Violations in "{CURATE_TABLES.find(t => t.value === table)?.label ?? table}"
                  <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>
                    — {violations.length} alias{violations.length !== 1 ? 'es' : ''}{violations.length === 5000 ? ' (limit 5000)' : ''}
                  </span>
                </h4>
                {table === 'casdictionary' && violations.some(v => v.missingTokens?.length > 0) && (
                  <button
                    className="btn btn-warning btn-sm"
                    style={{ fontSize: 12, padding: '2px 10px', whiteSpace: 'nowrap' }}
                    disabled={updatingChemNames}
                    onClick={handleUpdateChemNames}
                    title="Insert all missing tokens from the 'Missing tokens' column into chemNames"
                  >
                    {updatingChemNames ? '⏳ Updating…' : '⚗ Update chemNames'}
                  </button>
                )}
                {chemUpdateMsg && (
                  <span style={{ fontSize: 12, color: chemUpdateMsg.startsWith('✓') ? 'var(--success, #40a02b)' : 'var(--danger, #e06070)' }}>
                    {chemUpdateMsg}
                  </span>
                )}
              </div>
              <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420, marginBottom: 16 }}>
                <table className="data-table" style={{ width: '100%', fontSize: 12, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 90 }} />
                    <col style={{ width: table === 'casdictionary' ? '25%' : '35%' }} />
                    <col style={{ width: table === 'casdictionary' ? '25%' : '35%' }} />
                    <col style={{ width: 110 }} />
                    {table === 'casdictionary' && <col style={{ width: '25%' }} />}
                  </colgroup>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface-2, #1e2030)' }}>
                    <tr>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>NLP ID</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>Alias</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>Tokenized</th>
                      <th style={{ padding: '4px 6px', textAlign: 'left' }}>Type</th>
                      {table === 'casdictionary' && (
                        <th style={{ padding: '4px 6px', textAlign: 'left' }}>Missing tokens</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {violations.map((v, i) => {
                      const isChemTok = v.violType === 'C:no-chem-token';
                      const badgeBg    = v.violType.includes('greek')   ? '#f0a30a22'
                                       : v.violType.includes('number')  ? '#e0607022'
                                       : isChemTok                      ? '#e8650022'
                                       :                                   '#8839ef22';
                      const badgeColor = v.violType.includes('greek')   ? '#f0a30a'
                                       : v.violType.includes('number')  ? '#e06070'
                                       : isChemTok                      ? '#e86500'
                                       :                                   '#8839ef';
                      const badgeBorder= v.violType.includes('greek')   ? '#f0a30a44'
                                       : v.violType.includes('number')  ? '#e0607044'
                                       : isChemTok                      ? '#e8650044'
                                       :                                   '#8839ef44';
                      return (
                        <tr key={i}>
                          <td style={{ padding: '3px 6px' }}>
                            <button
                              className="btn-link"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, fontSize: 12 }}
                              onClick={() => onEditRecord?.(v.msId)}
                              title={`Open NLP ID ${v.msId} in Edit Records`}
                            >
                              {v.msId}
                            </button>
                          </td>
                          <td style={{ padding: '3px 6px', wordBreak: 'break-all' }}>{v.alias}</td>
                          <td style={{ padding: '3px 6px', wordBreak: 'break-all', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{v.tokenized}</td>
                          <td style={{ padding: '3px 6px' }}>
                            <span style={{
                              fontSize: 11, padding: '1px 5px', borderRadius: 3,
                              background: badgeBg, color: badgeColor,
                              border: `1px solid ${badgeBorder}`,
                            }}>
                              {v.violType}
                            </span>
                          </td>
                          {table === 'casdictionary' && (
                            <td style={{ padding: '3px 6px', wordBreak: 'break-all', fontFamily: 'monospace', color: '#e86500', fontSize: 11 }}>
                              {v.missingTokens?.length > 0
                                ? v.missingTokens.join(', ')
                                : <span style={{ color: 'var(--text-muted)' }}>—</span>
                              }
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Missing in ObjectNames results ── */}
      {table === MISSING_OBJECTNAMES_VALUE && (
        <>
          {missingObjNamesSearching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', color: 'var(--text-muted)' }}>
              <span className="spinner" /> Searching all dictionary tables for NLP IDs missing from ObjectNames…
            </div>
          )}
          {missingObjNamesError && (
            <div className="alert alert-danger">{missingObjNamesError}</div>
          )}
          {missingObjNames !== null && !missingObjNamesSearching && (
            <>
              {missingObjNames.length === 0 ? (
                <div className="alert alert-success">✓ All NLP IDs in every dictionary table have a matching record in ObjectNames.</div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <h4 style={{ margin: 0, fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                      NLP IDs missing from ObjectNames ({missingObjNames.length.toLocaleString()})
                    </h4>
                    <button className="btn btn-secondary btn-sm" onClick={handleFindMissingInObjectNames}
                      title="Re-run the search">↺ Refresh</button>
                    <button className="btn btn-primary btn-sm" onClick={handleCreateMissingObjectNames}
                      disabled={creatingObjNames}
                      title="Create ObjectNames records: Name = shortest alias with at least 4 letters/digits, URN = default URN for the entity type">
                      {creatingObjNames ? <><span className="spinner" /> Creating…</> : '＋ Create'}
                    </button>
                  </div>
                  {createObjNamesMsg && (
                    <div style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
                                  color: createObjNamesMsg.ok ? 'var(--success, #2a9)' : 'var(--warning, #e8a000)' }}>
                      {createObjNamesMsg.text}
                      <button onClick={() => setCreateObjNamesMsg(null)} title="Dismiss"
                        style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                                 color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
                    </div>
                  )}
                  {createObjNamesMsg?.skipped?.length > 0 && (
                    <details style={{ marginBottom: 8 }}>
                      <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>
                        Skipped NLP IDs ({createObjNamesMsg.skipped.length.toLocaleString()}) — and why
                      </summary>
                      <div className="table-wrap" style={{ maxHeight: 260, marginTop: 4 }}>
                        <table className="data-table" style={{ fontSize: 11 }}>
                          <thead><tr><th style={{ width: 100 }}>NLP ID</th><th>Name</th><th>Reason</th></tr></thead>
                          <tbody>
                            {createObjNamesMsg.skipped.map(sk => (
                              <tr key={sk.msId}>
                                <td className="mono">
                                  <button className="link-btn mono" onClick={() => onEditRecord?.(sk.msId)}>{sk.msId.toLocaleString()}</button>
                                </td>
                                <td>{sk.name}</td>
                                <td>
                                  {sk.reason}
                                  {sk.otherId != null && <> <button className="link-btn mono" onClick={() => onEditRecord?.(sk.otherId)}>{sk.otherId.toLocaleString()}</button></>}
                                  {sk.urn && <div className="mono" style={{ color: 'var(--text-muted)' }}>{sk.urn}</div>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                  <div className="table-wrap" style={{ maxHeight: 600 }}>
                    <table className="data-table" style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 110 }}>NLP ID</th>
                          <th style={{ width: 160 }}>Entity Type</th>
                          <th>Found in Dictionaries</th>
                        </tr>
                      </thead>
                      <tbody>
                        {missingObjNames.map(row => (
                          <tr key={row.msId}>
                            <td className="mono">
                              <button className="link-btn mono"
                                onClick={() => onEditRecord?.(row.msId)}
                                title="Open in Edit Record">
                                {row.msId.toLocaleString()}
                              </button>
                            </td>
                            <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{row.entityType}</td>
                            <td style={{ fontSize: 11 }}>
                              {row.dicts.map(d => (
                                <span key={d} style={{
                                  display: 'inline-block', margin: '1px 3px 1px 0',
                                  padding: '1px 6px', borderRadius: 10,
                                  background: 'var(--surface-2, rgba(127,127,127,0.15))',
                                  border: '1px solid var(--border)',
                                }}>{d}</span>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {conflicts !== null && conflicts.length === 0 && (
        <div className="alert alert-success">No tokenized conflicts found in <strong>{CURATE_TABLES.find(t => t.value === table)?.label ?? table}</strong>.</div>
      )}

      {conflicts !== null && conflicts.length > 0 && (
        <>
          <h4 style={{ margin: '0 0 8px 0', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
            {resolvedBy
              ? `Conflicts in "${CURATE_TABLES.find(t => t.value === table)?.label ?? table}" resolved by ${resolvedBy === 'llm' ? 'LLM' : 'Name'}`
              : `Conflicts in "${CURATE_TABLES.find(t => t.value === table)?.label ?? table}"`}
          </h4>
          {/* Toolbar: selection hint on left, status message on right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            {rowSel.size > 0 && (
              <button className="btn btn-xs btn-secondary" onClick={() => setRowSel(new Set())}
                style={{ fontSize: 11 }}>Clear selection</button>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {rowSel.size === 0 && table !== 'rsmap' && 'Click rows to select (Ctrl/Shift for multi-select).'}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {showPairsView
                ? <>Found <strong>{filteredPairs?.length ?? 0}</strong> unique pair{(filteredPairs?.length ?? 0) !== 1 ? 's' : ''}{filteredPairs?.length !== conflictPairs?.length ? ` (${conflictPairs?.length} total)` : ''}.
                    {pairSel.size > 0 && <> <strong>{pairSel.size}</strong> pair{pairSel.size !== 1 ? 's' : ''} checked.</>}
                    {pairRowSel.size > 0 && <> <strong>{pairRowSel.size}</strong> selected.</>}
                  </>
                : <>Found <strong>{conflicts.length}</strong> conflict{conflicts.length !== 1 ? 's' : ''}{conflicts.length === 5000 ? ' (limit 5000)' : ''}.
                    {sel.size > 0 && <> <strong>{sel.size}</strong> row{sel.size !== 1 ? 's' : ''} checked.</>}
                    {rowSel.size > 0 && <> <strong>{rowSel.size}</strong> row{rowSel.size !== 1 ? 's' : ''} selected.</>}
                  </>
              }
            </span>
          </div>

          {showPairsView ? (
            /* ── Pairs view ─────────────────────────────────────────── */
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420, marginBottom: 12 }}>
              <table className="data-table" style={{ width: '100%', fontSize: 12, tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 70 }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: 30 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 30 }} />
                  <col style={{ width: 110 }} />
                </colgroup>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface-2, #1e2030)' }}>
                  {pairRowSel.size > 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '3px 4px', borderBottom: 'none' }}>
                        <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }}
                          onClick={() => checkPairSelected('newer')}>✓ Check selected as Newer</button>
                      </td>
                      <td colSpan={3} style={{ padding: '3px 4px', borderBottom: 'none' }}>
                        <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }}
                          onClick={() => checkPairSelected('older')}>✓ Check selected as Older</button>
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={4} style={{ padding: '2px 4px', borderBottom: 'none', background: 'var(--surface-2, #1e2030)' }} />
                    <td style={{ padding: '2px 4px', borderBottom: 'none', background: 'var(--surface-2, #1e2030)' }} />
                    <td colSpan={2} style={{ padding: '2px 4px', borderBottom: 'none', background: 'var(--surface-2, #1e2030)' }}>
                      <select className="form-control" style={{ fontSize: 11, padding: '1px 4px', height: 22, width: '100%' }}
                        value={newerTypeFilter} onChange={e => setNewerTypeFilter(e.target.value)}>
                        {ENTITY_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                    <td colSpan={2} style={{ padding: '2px 4px', borderBottom: 'none', background: 'var(--surface-2, #1e2030)' }}>
                      <select className="form-control" style={{ fontSize: 11, padding: '1px 4px', height: 22, width: '100%' }}
                        value={olderTypeFilter} onChange={e => setOlderTypeFilter(e.target.value)}>
                        {ENTITY_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('newerName')}>Newer name{pairSortIcon('newerName')}</th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('newerUrn')}>Newer URN{pairSortIcon('newerUrn')}</th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('olderName')}>Older name{pairSortIcon('olderName')}</th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('olderUrn')}>Older URN{pairSortIcon('olderUrn')}</th>
                    <th style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'center' }} onClick={() => togglePairSort('count')}>Shared aliases{pairSortIcon('count')}</th>
                    <th style={{ textAlign: 'center' }} title="Select all newer">
                      <input type="checkbox" checked={allPairNewerChecked} onChange={() => selectAllPairSide('newer')} />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('newerMsId')}>Newer ID{pairSortIcon('newerMsId')}</th>
                    <th style={{ textAlign: 'center' }} title="Select all older">
                      <input type="checkbox" checked={allPairOlderChecked} onChange={() => selectAllPairSide('older')} />
                    </th>
                    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePairSort('olderMsId')}>Older ID{pairSortIcon('olderMsId')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(sortedPairs || []).map((pair, i) => {
                    const aliasTooltip = pair.sharedAliases.map(a => a.newerAlias).join('\n');
                    return (
                      <tr key={i}
                        onClick={e => handlePairRowClick(i, e)}
                        style={{
                          cursor: 'pointer',
                          background: pairRowSel.has(i)
                            ? 'rgba(var(--accent-rgb,0,120,212),0.15)'
                            : pairSel.has(i) ? 'rgba(var(--danger-rgb,200,50,50),0.08)' : '',
                        }}>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pair.newerName}>{pair.newerName}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-muted)' }} title={pair.newerUrn}>{pair.newerUrn}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pair.olderName}>{pair.olderName}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-muted)' }} title={pair.olderUrn}>{pair.olderUrn}</td>
                        <td style={{ textAlign: 'center' }}>
                          <button className="link-btn" title={aliasTooltip}
                            style={{ color: 'var(--accent, #7c9ef8)', fontWeight: 600 }}
                            onClick={e => { e.stopPropagation(); onEditRecord?.([pair.newerMsId, pair.olderMsId]); }}>
                            {pair.count}
                          </button>
                        </td>
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={pairSel.get(i) === 'newer'} onChange={() => togglePair(i, 'newer')} />
                        </td>
                        <td>
                          <button className="link-btn mono" onClick={e => { e.stopPropagation(); onEditRecord?.(pair.newerMsId); }}>{pair.newerMsId}</button>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>{getEntityType(pair.newerMsId)}</span>
                        </td>
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={pairSel.get(i) === 'older'} onChange={() => togglePair(i, 'older')} />
                        </td>
                        <td>
                          <button className="link-btn mono" onClick={e => { e.stopPropagation(); onEditRecord?.(pair.olderMsId); }}>{pair.olderMsId}</button>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>{getEntityType(pair.olderMsId)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* ── Conflict table (rsmap and generic) ──────────────────── */
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420, marginBottom: 12 }}>
              <table className="data-table" style={{ width: '100%', fontSize: 12, tableLayout: 'fixed' }}>
                {table === 'rsmap' ? (
                  <colgroup>
                    <col style={{ width: '8%' }} />
                    <col style={{ width: '6%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '16%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '29%' }} />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col style={{ width: 36 }} />
                    <col style={{ width: 75 }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 36 }} />
                    <col style={{ width: 75 }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: 110 }} />
                    <col />
                  </colgroup>
                )}
                <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface-2, #1e2030)' }}>
                  {/* Action row — buttons sit directly above their column groups (not used for rsmap) */}
                  {table !== 'rsmap' && rowSel.size > 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: '3px 24px 3px 4px', borderBottom: 'none' }}>
                        <button className="btn btn-secondary btn-sm" style={{ width: '70%', fontSize: 11 }}
                          onClick={() => checkSelected('newer')}>
                          ✓ Check selected as Newer
                        </button>
                      </td>
                      <td colSpan={4} style={{ padding: '3px 4px 3px 24px', borderBottom: 'none' }}>
                        <button className="btn btn-secondary btn-sm" style={{ width: '70%', fontSize: 11 }}
                          onClick={() => checkSelected('older')}>
                          ✓ Check selected as Older
                        </button>
                      </td>
                      <td colSpan={1} style={{ padding: '3px 4px', borderBottom: 'none' }}>
                        <button className="btn btn-secondary btn-sm" style={{ width: '100%', fontSize: 11 }}
                          onClick={() => setSel(prev => {
                            const next = new Map(prev);
                            rowSel.forEach(i => next.delete(i));
                            return next;
                          })}>
                          ✕ Uncheck selected
                        </button>
                      </td>
                    </tr>
                  )}
                  {table === 'rsmap' ? (
                    <tr>
                      <th style={{ whiteSpace:'nowrap', minWidth:90 }}>Source</th>
                      <th style={{ cursor:'pointer', userSelect:'none', minWidth:60 }} onClick={() => toggleConflictSort('newerMsId')}>NLP ID{sortIcon('newerMsId')}</th>
                      <th style={{ cursor:'pointer', userSelect:'none', minWidth:100 }} onClick={() => toggleConflictSort('newerName')}>Name{sortIcon('newerName')}</th>
                      <th style={{ minWidth:130 }}>URN</th>
                      <th style={{ cursor:'pointer', userSelect:'none', minWidth:80, background:'rgba(200,160,0,0.12)' }} onClick={() => toggleConflictSort('olderMsId')}>rsmap ID{sortIcon('olderMsId')}</th>
                      <th style={{ cursor:'pointer', userSelect:'none', minWidth:110, background:'rgba(200,160,0,0.12)' }} onClick={() => toggleConflictSort('alias')}>Protein Name{sortIcon('alias')}</th>
                      <th style={{ minWidth:120, background:'rgba(200,160,0,0.12)' }}>HGVS Code</th>
                      <th style={{ minWidth:130, background:'rgba(200,160,0,0.12)' }}>rsmap URN</th>
                    </tr>
                  ) : (
                  <tr>
                    <th style={{ textAlign: 'center' }} title="Select all newer">
                      <input type="checkbox" checked={allNewerChecked}
                        onChange={() => selectAllSide('newer')} />
                    </th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('newerMsId')}>Newer ID{sortIcon('newerMsId')}</th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('newerName')}>Newer Name{sortIcon('newerName')}</th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('newerUpdated')}>Newer Modified{sortIcon('newerUpdated')}</th>
                    <th style={{ textAlign: 'center' }} title="Select all older">
                      <input type="checkbox" checked={allOlderChecked}
                        onChange={() => selectAllSide('older')} />
                    </th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('olderMsId')}>Older ID{sortIcon('olderMsId')}</th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('olderName')}>Older Name{sortIcon('olderName')}</th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('olderUpdated')}>Older Modified{sortIcon('olderUpdated')}</th>
                    <th style={{ cursor:'pointer', userSelect:'none' }} onClick={() => toggleConflictSort('alias')}>Conflict Alias{sortIcon('alias')}</th>
                  </tr>
                  )}
                </thead>
                <tbody>
                  {sortedConflicts.map((c, i) => {
                    const origIdx = conflicts.indexOf(c);
                    const fmtDate = v => v ? new Date(v).toLocaleDateString() : '—';
                    // ── rsmap-specific row layout ──────────────────────────────
                    if (table === 'rsmap') {
                      const obj = rsmapObjNames[c.newerMsId] || {};
                      const rsCell = { background: 'rgba(200,160,0,0.08)' };
                      const rsText = { ...rsCell, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#c8a000', fontSize:11 };
                      return (
                        <tr key={i} onClick={e => handleRowClick(origIdx, e)}
                          style={{ cursor: 'pointer', background: rowSel.has(origIdx) ? 'rgba(var(--accent-rgb,0,120,212),0.15)' : '' }}>
                          <td style={{ whiteSpace:'nowrap', color:'var(--text-muted)', fontSize:11 }}>{c.srcTable || '—'}</td>
                          <td>
                            <button className="link-btn mono" onClick={e => { e.stopPropagation(); onEditRecord?.(c.newerMsId); }}>
                              {c.newerMsId}
                            </button>
                          </td>
                          <td style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={obj.name}>{obj.name || '—'}</td>
                          <td style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text-muted)', fontSize:11 }} title={obj.urn}>{obj.urn || '—'}</td>
                          <td style={rsCell}>
                            <button className="link-btn mono" onClick={e => { e.stopPropagation(); onEditRecord?.(c.olderMsId); }}>
                              {c.olderMsId}
                            </button>
                          </td>
                          <td style={{ ...rsCell, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#c8a000' }}>{c.olderAlias}</td>
                          <td style={rsText} title={c.hgvsCode}>{c.hgvsCode || '—'}</td>
                          <td style={rsText} title={c.rsmapUrn}>{c.rsmapUrn || '—'}</td>
                        </tr>
                      );
                    }
                    // ── generic row layout ─────────────────────────────────────
                    return (
                    <tr key={i}
                      onClick={e => handleRowClick(origIdx, e)}
                      onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, conflict: c, origIdx }); }}
                      style={{
                        cursor: 'pointer',
                        opacity: singleLlmRow !== null && singleLlmRow !== origIdx ? 0.45 : 1,
                        background: singleLlmRow === origIdx
                          ? 'rgba(var(--accent-rgb,0,120,212),0.25)'
                          : rowSel.has(origIdx)
                            ? 'rgba(var(--accent-rgb,0,120,212),0.15)'
                            : sel.has(origIdx) ? 'rgba(var(--danger-rgb,200,50,50),0.08)' : '',
                      }}>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={sel.get(origIdx) === 'newer'}
                          onChange={() => toggle(origIdx, 'newer')} />
                      </td>
                      <td>
                        <button className="link-btn mono" onClick={() => onEditRecord?.(c.newerMsId)}>
                          {c.newerMsId}
                        </button>
                      </td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={c.newerName}>{c.newerName}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDate(c.newerUpdated)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={sel.get(origIdx) === 'older'}
                          onChange={() => toggle(origIdx, 'older')} />
                      </td>
                      <td>
                        <button className="link-btn mono" onClick={() => onEditRecord?.(c.olderMsId)}>
                          {c.olderMsId}
                        </button>
                      </td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={c.olderName}>{c.olderName}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDate(c.olderUpdated)}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          cursor: 'pointer', color: 'var(--accent, #7c9ef8)', textDecoration: 'underline dotted' }}
                          title={`${c.newerAlias}\n\nOpen all conflicting records in Edit Record`}
                          onClick={e => {
                            e.stopPropagation();
                            const alias = c.newerAlias;
                            const allMsIds = [...new Set(
                              (conflicts || [])
                                .filter(row => row.newerAlias === alias)
                                .flatMap(row => [row.newerMsId, row.olderMsId])
                            )];
                            onEditRecord?.(allMsIds.length > 0 ? allMsIds : [c.newerMsId, c.olderMsId]);
                          }}>{c.newerAlias}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Single-row LLM context menu (position: fixed, renders over everything) ── */}
          {ctxMenu && (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: ctxMenu.x,
                top: ctxMenu.y,
                zIndex: 9999,
                background: 'var(--bg-card, #1e1e2e)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                padding: '4px 0',
                minWidth: 190,
              }}
            >
              <button
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '7px 14px', background: 'none', border: 'none',
                  cursor: singleLlmRow !== null ? 'not-allowed' : 'pointer',
                  color: 'inherit', fontSize: 13, opacity: singleLlmRow !== null ? 0.5 : 1,
                }}
                onMouseEnter={e => { if (singleLlmRow === null) e.currentTarget.style.background = 'rgba(var(--accent-rgb,0,120,212),0.15)'; }}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                disabled={singleLlmRow !== null}
                onClick={() => handleResolveSingleByLlm(ctxMenu.conflict, ctxMenu.origIdx)}
              >
                {singleLlmRow !== null ? '⏳ Resolving…' : '🤖 Resolve by LLM'}
              </button>
            </div>
          )}

          {sel.size === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              Check a box in the Newer or Older column to select which alias row to delete.
            </div>
          )}
        </>
      )}

      {/* ── Diagnose Conflict ──────────────────────────────────────────────── */}
      <DiagnoseConflict onEditRecord={onEditRecord} />

      {/* ── Find Alias ─────────────────────────────────────────────────────── */}
      <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <input
            className="form-control"
            style={{ minWidth: 220, maxWidth: 340 }}
            placeholder="Find alias…"
            value={aliasQuery}
            onChange={e => setAliasQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFindAlias()}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={aliasSubstring}
              onChange={e => setAliasSubstring(e.target.checked)} />
            Substring
          </label>
          <button className="btn btn-secondary" onClick={handleFindAlias}
            disabled={aliasSearching || !aliasQuery.trim()}>
            {aliasSearching ? <><span className="spinner" /> Searching…</> : '🔍 Find Alias'}
          </button>
        </div>
        {aliasError && <div className="alert alert-danger" style={{ marginBottom: 8 }}>{aliasError}</div>}
        {aliasResults !== null && aliasResults.length === 0 && (
          <div className="alert alert-info" style={{ fontSize: 12 }}>No matching aliases found.</div>
        )}
        {aliasDeleMsg && <div className="alert alert-success" style={{ marginBottom: 8 }}>{aliasDeleMsg}</div>}
        {aliasResults !== null && aliasResults.length > 0 && (() => {
          const fmtDate = v => v ? new Date(v).toLocaleDateString() : '—';
          const allChecked = (filteredAliasResults?.length ?? 0) > 0 && (filteredAliasResults || []).every(r => aliasSelIds.has(r.rowId));
          const toggleAll  = () => setAliasSelIds((filteredAliasResults?.length ?? 0) > 0 && allChecked
            ? new Set()
            : new Set((filteredAliasResults || []).map(r => r.rowId)));
          const toggleOne  = (rowId) => setAliasSelIds(prev => {
            const next = new Set(prev);
            next.has(rowId) ? next.delete(rowId) : next.add(rowId);
            return next;
          });
          return (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                {aliasResults.length} row{aliasResults.length !== 1 ? 's' : ''} found
                {aliasResults.length === 500 ? ' (limit 500)' : ''}.
                Click an NLP ID to open in Edit Record.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Filter by entity type:</span>
                <select className="form-control" style={{ width: 180, fontSize: 12 }}
                  value={aliasTypeFilter} onChange={e => setAliasTypeFilter(e.target.value)}>
                  {ENTITY_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  {(filteredAliasResults?.length ?? 0)} shown
                  {aliasResults.length !== (filteredAliasResults?.length ?? 0) ? ` of ${aliasResults.length}` : ''}
                </span>
              </div>
              <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ width: 32, textAlign: 'center' }}>
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                    </th>
                    <th style={{ width: 90 }}>NLP ID</th>
                    <th>Record Name</th>
                    {table === ALL_TABLES_VALUE && <th style={{ width: 110 }}>Dictionary</th>}
                    <th>Matched Alias</th>
                    <th style={{ width: 110 }}>Last Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {(filteredAliasResults || []).map((r, i) => (
                    <tr key={i} style={{ background: aliasSelIds.has(r.rowId) ? 'rgba(var(--danger-rgb,200,50,50),0.08)' : '' }}>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={aliasSelIds.has(r.rowId)}
                          onChange={() => toggleOne(r.rowId)} />
                      </td>
                      <td>
                        <button className="link-btn mono" onClick={() => onEditRecord?.(r.msId)}>
                          {r.msId}
                        </button>
                      </td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={r.name}>{r.name}</td>
                      {table === ALL_TABLES_VALUE && (
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11 }}>
                          {CURATE_TABLES.find(t => t.value === r.dict)?.label ?? r.dict}
                        </td>
                      )}
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={r.alias}>{r.alias}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDate(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-danger" onClick={handleDeleteAliases}
                  disabled={aliasDeleting || aliasSelIds.size === 0}>
                  {aliasDeleting
                    ? <><span className="spinner" /> Deleting…</>
                    : `🗑 Delete ${aliasSelIds.size > 0 ? aliasSelIds.size : ''} selected alias${aliasSelIds.size !== 1 ? 'es' : ''} from database`}
                </button>
                <button
                  className="btn"
                  style={{ background: '#40a02b', color: '#fff', border: '1px solid #40a02b' }}
                  onClick={handleMergeAliases}
                  disabled={aliasDeleting || aliasSelIds.size === 0}
                  title="Merge all unchecked records' aliases into the single checked record (check exactly one to keep)"
                >
                  {aliasDeleting ? '…' : '🔀 Merge to checked'}
                </button>
              </div>
            </div>
          );
        })()}
      </div>

    </div>
  );
}

// ── DiagnoseConflict ──────────────────────────────────────────────────────────
// Given two NLP IDs (from a MedScan CC:*** warning), fetches all their aliases
// from all dictionary tables, tokenizes each, and shows which alias pairs
// produce the same tokenized form — explaining WHY MedScan reports a conflict.
function DiagnoseConflict({ onEditRecord }) {
  const [idA,      setIdA]      = useState('');
  const [idB,      setIdB]      = useState('');
  const [running,  setRunning]  = useState(false);
  const [matches,  setMatches]  = useState(null); // [{tok, aAlias, aDict, bAlias, bDict}]
  const [error,    setError]    = useState(null);

  // 'keywords' excluded: term control table, not an alias table.
  const ALIAS_TABLES = [
    { tbl: 'curnames',       aliasCol: 'alias',    xwSvc: 'xwords' },
    { tbl: 'exactliteral',   aliasCol: 'alias',    xwSvc: null },
    { tbl: 'celldictionary', aliasCol: 'alias',    xwSvc: 'xwords_cells' },
    { tbl: 'chemnames',      aliasCol: 'alias',    xwSvc: null },
    { tbl: 'casdictionary',  aliasCol: 'alias',    xwSvc: 'xwords_cas' },
    { tbl: 'combnames',      aliasCol: 'alias',    xwSvc: 'xwords_comb' },
  ];

  const handleDiagnose = async () => {
    const msA = Number(idA), msB = Number(idB);
    if (!msA || !msB) return;
    setRunning(true); setMatches(null); setError(null);
    try {
      // Load all xwords sets once
      const xwCache = {};
      for (const { xwSvc } of ALIAS_TABLES) {
        if (xwSvc && !xwCache[xwSvc]) {
          const r = await window.api.db.query(`SELECT xword FROM ${xwSvc} LIMIT 5000`);
          xwCache[xwSvc] = r.ok ? new Set(r.rows.map(x => x.xword.toLowerCase())) : new Set();
        }
      }
      const tokFnFor = (tbl, xwSvc) => {
        if (tbl === 'exactliteral' || tbl === 'chemnames') {
          // Verbatim/lowercase exact match — no xword stripping, no stemming
          return s => s.toLowerCase();
        }
        return makeXwordTokenizer(xwCache[xwSvc] || new Set());
      };

      // Fetch aliases for both records from all tables
      const fetchAliases = async (msId) => {
        const rows = [];
        for (const { tbl, aliasCol, xwSvc } of ALIAS_TABLES) {
          const res = await window.api.db.query(
            `SELECT ${aliasCol} AS alias, '${tbl}' AS dict
             FROM ${tbl}
             WHERE medscan_id = $1 AND (bdeleted IS NULL OR bdeleted = FALSE)`,
            [msId]
          );
          if (res.ok) {
            const tokFn = tokFnFor(tbl, xwSvc);
            for (const row of res.rows) {
              rows.push({ alias: row.alias, dict: tbl, tok: tokFn(row.alias) });
            }
          }
        }
        return rows;
      };

      const [aliasesA, aliasesB] = await Promise.all([fetchAliases(msA), fetchAliases(msB)]);

      // Find pairs that tokenize identically
      const tokMapB = new Map(); // tok → [{alias, dict}]
      for (const b of aliasesB) {
        if (!tokMapB.has(b.tok)) tokMapB.set(b.tok, []);
        tokMapB.get(b.tok).push(b);
      }
      const found = [];
      for (const a of aliasesA) {
        for (const b of tokMapB.get(a.tok) || []) {
          found.push({ tok: a.tok, aAlias: a.alias, aDict: a.dict, bAlias: b.alias, bDict: b.dict });
        }
      }
      setMatches(found);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const dictLabel = tbl => CURATE_TABLES.find(t => t.value === tbl)?.label ?? tbl;

  return null;
}

export function DictRefresh() {
  const [latestDate, setLatestDate]   = useState(null);
  const [dateError, setDateError]     = useState(null);
  const [confirming, setConfirming]   = useState(false);
  const [running, setRunning]         = useState(false);
  const [log, setLog]                 = useState([]);
  const [done, setDone]               = useState(false);

  useEffect(() => {
    window.api.dict.getLatestDate().then(r => {
      if (r.ok) setLatestDate(r.date);
      else setDateError(r.error);
    });
    window.api.dict.onProgress(msg => setLog(l => [...l, msg]));
    return () => window.api.dict.offProgress();
  }, []);

  const handleRefresh = async () => {
    setConfirming(false);
    setRunning(true);
    setLog([]);
    setDone(false);
    const result = await window.api.dict.refresh();
    setRunning(false);
    setDone(true);
    if (!result.ok) setLog(l => [...l, `ERROR: ${result.error}`]);
  };

  const formattedDate = latestDate
    ? new Date(latestDate).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '(unknown)';

  return (
    <div>
      {/* Confirmation modal */}
      {confirming && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">⚠ Restore deployed dictionaries</div>
            <p className="text-sm" style={{ marginBottom: 16 }}>
              This will <strong>erase all dictionary modifications</strong> made after{' '}
              <strong>{formattedDate}</strong> and re-import everything from the Elsevier NLP
              installation files.
            </p>
            <p className="text-sm" style={{ marginBottom: 16, color: 'var(--danger)' }}>
              Any aliases added or edited in the app that have not been exported to files will be lost.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleRefresh}>Yes, Restore</button>
            </div>
          </div>
        </div>
      )}

      {dateError && <div className="alert alert-danger">{dateError}</div>}

      <div className="alert alert-warning" style={{ marginBottom: 16 }}>
        <strong>Warning:</strong> Refreshing will erase all dictionary modifications done after{' '}
        <strong>{formattedDate}</strong> (latest modification date of Elsevier NLP dictionary files).
        Export your changes first if you want to keep them.
      </div>

      <button
        className="btn btn-danger"
        onClick={() => setConfirming(true)}
        disabled={running || !!dateError}
        style={{ marginBottom: 16 }}
      >
        {running ? <><span className="spinner" /> Restoring…</> : '🔄 Restore deployed dictionaries'}
      </button>

      {done && !running && (
        <div className="alert alert-success">Refresh complete.</div>
      )}

      {log.length > 0 && (
        <div className="log-output" style={{ maxHeight: 'calc(100vh - 420px)' }}>
          {log.map((l, i) => (
            <div key={i} className={l.startsWith('ERROR') ? 'log-err' : ''}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SQL Console ───────────────────────────────────────────────────────────────
const SQL_HISTORY_KEY = 'nlpm_sql_history';
const SQL_HISTORY_MAX = 200;
const SQL_HINTS_KEY   = 'nlpm_sql_hints';

const SQL_HINTS_SEED = [
  { id: 's1', comment: 'Array columns (organisms, cartridges) use = ANY()',
    code: "SELECT * FROM curnames WHERE 'Ecoli' = ANY(organisms) LIMIT 100;" },
  { id: 's2', comment: 'To set an array use ARRAY[] — not []',
    code: "SET organisms = ARRAY['Ecoli']" },
  { id: 's3', comment: 'To select empty array values',
    code: "SELECT * FROM objectnames WHERE organisms IS NULL OR organisms = '{}'" },
  { id: 's4', comment: 'To select from multiple organisms (array overlap)',
    code: "SELECT * FROM objectnames WHERE organisms && ARRAY['Arabidopsis','Mammal','Rice']" },
];

function loadSqlHistory() {
  try {
    const raw = localStorage.getItem(SQL_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveSqlHistory(history) {
  try { localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(history)); } catch {}
}
function loadSqlHints() {
  try {
    const raw = localStorage.getItem(SQL_HINTS_KEY);
    return raw ? JSON.parse(raw) : SQL_HINTS_SEED;
  } catch { return SQL_HINTS_SEED; }
}
function saveSqlHints(hints) {
  try { localStorage.setItem(SQL_HINTS_KEY, JSON.stringify(hints)); } catch {}
}

function SqlConsole({ onEditRecord }) {
  const [sql,         setSql]         = useState('');
  const [running,     setRunning]     = useState(false);
  const [result,      setResult]      = useState(null);   // { cols, rows } | null
  const [error,       setError]       = useState(null);
  const [rowCount,    setRowCount]    = useState(null);   // for non-SELECT
  const [queryVerb,   setQueryVerb]   = useState(null);   // 'deleted' | 'updated' | 'inserted' | null
  const [sqlPage,     setSqlPage]     = useState(0);      // current page index (0-based)
  const SQL_PAGE_SIZE = 200;
  const [history,     setHistory]     = useState(() => loadSqlHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [histPos,     setHistPos]     = useState({ x: null, y: 120 }); // null x = right-anchored default
  const [hints,       setHints]       = useState(() => loadSqlHints());
  const [showHints,   setShowHints]   = useState(false);
  const [hintsSearch, setHintsSearch] = useState('');
  const [hintCtxMenu, setHintCtxMenu] = useState(null); // { id, x, y }
  const [hintEdit,    setHintEdit]    = useState(null);  // { id:'new'|id, comment, code }
  const textareaRef = React.useRef(null);

  const startHistDrag = (e) => {
    if (e.button !== 0) return;
    const el = e.currentTarget.closest('[data-hist-dialog]');
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev) => setHistPos({ x: ev.clientX - offX, y: ev.clientY - offY });
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  // Upsert a query into history (dedup by exact text, update timestamp)
  const recordHistory = (query) => {
    setHistory(prev => {
      const now = new Date().toISOString();
      const filtered = prev.filter(h => h.sql !== query);
      const next = [{ sql: query, lastRun: now }, ...filtered].slice(0, SQL_HISTORY_MAX);
      saveSqlHistory(next);
      return next;
    });
  };

  const handleRun = async () => {
    const query = sql.trim();
    if (!query || running) return;
    setRunning(true); setError(null); setResult(null); setRowCount(null); setQueryVerb(null); setSqlPage(0);
    try {
      // Use queryArray so duplicate column names (e.g. two JOINed tables with same col)
      // are preserved — pg returns rows as arrays with positional values.
      const res = await window.api.db.queryArray(query);
      if (!res.ok) { setError(res.error || 'Query failed'); return; }
      recordHistory(query);
      const isModifying = /^\s*(delete|update|insert)\b/i.test(query);
      if (isModifying) {
        // DELETE/UPDATE/INSERT: rows is always [] from pg; use rowCount for affected count
        setResult(null);
        setRowCount(res.rowCount ?? 0);
        const verb = /^\s*delete\b/i.test(query) ? 'deleted'
                   : /^\s*update\b/i.test(query) ? 'updated'
                   : 'inserted';
        setQueryVerb(verb);
      } else if (res.rows && res.rows.length > 0) {
        // res.rows are already arrays (rowMode: 'array'); res.fields are column names
        const cols = res.fields || res.rows[0].map((_, i) => `col${i + 1}`);
        setResult({ cols, rows: res.rows });
        setRowCount(res.rows.length);
      } else {
        setResult({ cols: [], rows: [] });
        setRowCount(0);
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleRun(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const start = el.selectionStart, end = el.selectionEnd;
      const next = sql.slice(0, start) + '  ' + sql.slice(end);
      setSql(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    }
  };

  const clearHistory = () => {
    if (!confirm('Clear all SQL history?')) return;
    setHistory([]); saveSqlHistory([]);
  };

  return (
    <div style={{ padding: '12px 16px', display: 'flex', gap: 12, height: 'calc(100vh - 160px)' }}>

      {/* ── Left: editor + results ────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
            SQL — runs directly on the dictionary database
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.7 }}>Ctrl+Enter to run</span>
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
            onClick={() => { setShowHints(true); setShowHistory(false); }}>
            Hints
          </button>
          <button className="btn btn-secondary btn-sm"
            onClick={() => setShowHistory(v => !v)}>
            {showHistory ? 'Hide history' : `History${history.length ? ` (${history.length})` : ''}`}
          </button>
          <button className="btn btn-primary btn-sm" style={{ minWidth: 80 }}
            disabled={!sql.trim() || running} onClick={handleRun}>
            {running ? <><span className="spinner" /> Running…</> : '▶ Run'}
          </button>
        </div>

        {/* Editor */}
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder="SELECT * FROM curnames WHERE medscan_id = 1234567 LIMIT 20;"
          style={{
            fontFamily: 'monospace', fontSize: 13, resize: 'vertical',
            minHeight: 120, maxHeight: 300,
            padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', outline: 'none', lineHeight: 1.5,
          }}
        />

        {/* ── Hints dialog ─────────────────────────────────────────────────── */}
        {showHints && (() => {
          const q = hintsSearch.toLowerCase();
          const filtered = hints.filter(h =>
            !q || h.comment.toLowerCase().includes(q) || h.code.toLowerCase().includes(q)
          );
          const saveHints = (next) => { setHints(next); saveSqlHints(next); };
          const deleteHint = (id) => saveHints(hints.filter(h => h.id !== id));
          const commitEdit = () => {
            if (!hintEdit) return;
            if (hintEdit.id === 'new') {
              const newH = { id: Date.now().toString(), comment: hintEdit.comment, code: hintEdit.code };
              saveHints([...hints, newH]);
            } else {
              saveHints(hints.map(h => h.id === hintEdit.id ? { ...h, comment: hintEdit.comment, code: hintEdit.code } : h));
            }
            setHintEdit(null);
          };
          return (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={e => { if (e.target === e.currentTarget) { setShowHints(false); setHintEdit(null); setHintCtxMenu(null); } }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                width: 820, maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
                onClick={() => setHintCtxMenu(null)}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                  borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>SQL Hints</span>
                  <input value={hintsSearch} onChange={e => setHintsSearch(e.target.value)}
                    placeholder="Search comments and snippets…"
                    style={{ flex: 1, fontSize: 12, padding: '3px 8px', borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--input-bg, var(--surface))',
                      color: 'var(--text)', outline: 'none' }} />
                  <button className="btn btn-xs btn-secondary" style={{ marginLeft: 'auto' }}
                    onClick={() => { setShowHints(false); setHintEdit(null); setHintCtxMenu(null); }}>
                    ✕ Close
                  </button>
                </div>

                {/* Table */}
                <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'var(--surface-raised, rgba(255,255,255,0.04))',
                        borderBottom: '1px solid var(--border)', position: 'sticky', top: 0 }}>
                        <th style={{ padding: '6px 10px', textAlign: 'left', width: '38%', fontWeight: 600 }}>Comment</th>
                        <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>Code snippet</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.length === 0 && (
                        <tr><td colSpan={2} style={{ padding: '16px 10px', color: 'var(--text-muted)', textAlign: 'center' }}>
                          {hintsSearch ? 'No hints match your search.' : 'No hints yet. Add one below.'}
                        </td></tr>
                      )}
                      {filtered.map(h => {
                        const isEditing = hintEdit?.id === h.id;
                        return (
                          <tr key={h.id}
                            style={{ borderBottom: '1px solid var(--border)',
                              background: isEditing ? 'var(--selection, rgba(100,150,255,0.12))' : undefined }}
                            onContextMenu={e => { e.preventDefault(); setHintCtxMenu({ id: h.id, x: e.clientX, y: e.clientY }); }}>
                            <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
                              {isEditing
                                ? <input value={hintEdit.comment}
                                    onChange={e => setHintEdit(v => ({ ...v, comment: e.target.value }))}
                                    style={{ width: '100%', fontSize: 12, padding: '2px 4px',
                                      border: '1px solid var(--accent)', borderRadius: 3,
                                      background: 'var(--input-bg, var(--surface))', color: 'var(--text)' }} />
                                : <span style={{ userSelect: 'text' }}>{h.comment}</span>
                              }
                            </td>
                            <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
                              {isEditing
                                ? <textarea value={hintEdit.code}
                                    onChange={e => setHintEdit(v => ({ ...v, code: e.target.value }))}
                                    rows={3}
                                    style={{ width: '100%', fontSize: 11, fontFamily: 'monospace', padding: '2px 4px',
                                      border: '1px solid var(--accent)', borderRadius: 3, resize: 'vertical',
                                      background: 'var(--input-bg, var(--surface))', color: 'var(--text)' }} />
                                : <code style={{ fontFamily: 'monospace', fontSize: 11,
                                    color: 'var(--accent, #7aa2f7)', cursor: 'pointer', whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all' }}
                                    title="Click to insert into SQL editor"
                                    onClick={() => { setSql(s => (s ? s + '\n' : '') + h.code); setShowHints(false); }}>
                                    {h.code}
                                  </code>
                              }
                              {isEditing && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                  <button className="btn btn-xs btn-primary" onClick={commitEdit}>Save</button>
                                  <button className="btn btn-xs btn-secondary" onClick={() => setHintEdit(null)}>Cancel</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {/* Add new hint row */}
                      {hintEdit?.id === 'new' && (
                        <tr style={{ borderBottom: '1px solid var(--border)',
                          background: 'var(--selection, rgba(100,150,255,0.12))' }}>
                          <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
                            <input value={hintEdit.comment}
                              onChange={e => setHintEdit(v => ({ ...v, comment: e.target.value }))}
                              placeholder="Comment…"
                              style={{ width: '100%', fontSize: 12, padding: '2px 4px',
                                border: '1px solid var(--accent)', borderRadius: 3,
                                background: 'var(--input-bg, var(--surface))', color: 'var(--text)' }} />
                          </td>
                          <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
                            <textarea value={hintEdit.code}
                              onChange={e => setHintEdit(v => ({ ...v, code: e.target.value }))}
                              placeholder="SQL snippet…"
                              rows={3}
                              style={{ width: '100%', fontSize: 11, fontFamily: 'monospace', padding: '2px 4px',
                                border: '1px solid var(--accent)', borderRadius: 3, resize: 'vertical',
                                background: 'var(--input-bg, var(--surface))', color: 'var(--text)' }} />
                            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                              <button className="btn btn-xs btn-primary" onClick={commitEdit}>Save</button>
                              <button className="btn btn-xs btn-secondary" onClick={() => setHintEdit(null)}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Footer */}
                <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
                  <button className="btn btn-xs btn-secondary"
                    onClick={() => setHintEdit({ id: 'new', comment: '', code: '' })}>
                    + Add hint
                  </button>
                </div>
              </div>

              {/* Right-click context menu */}
              {hintCtxMenu && (
                <div style={{ position: 'fixed', top: hintCtxMenu.y, left: hintCtxMenu.x,
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.35)', zIndex: 9999, minWidth: 140 }}>
                  <div style={{ padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--hover, rgba(255,255,255,0.08))'}
                    onMouseLeave={e => e.currentTarget.style.background=''}
                    onClick={() => {
                      const h = hints.find(x => x.id === hintCtxMenu.id);
                      if (h) setHintEdit({ id: h.id, comment: h.comment, code: h.code });
                      setHintCtxMenu(null);
                    }}>Edit hint</div>
                  <div style={{ padding: '6px 14px', cursor: 'pointer', fontSize: 12, color: 'var(--danger, #e06c75)' }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--hover, rgba(255,255,255,0.08))'}
                    onMouseLeave={e => e.currentTarget.style.background=''}
                    onClick={() => { deleteHint(hintCtxMenu.id); setHintCtxMenu(null); }}>
                    Delete hint
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Results */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {error && (
            <div className="alert alert-danger" style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', flexShrink: 0 }}>
              {error}
            </div>
          )}
          {!error && rowCount != null && !result && (
            <div className="alert alert-success" style={{ fontSize: 13, flexShrink: 0 }}>
              ✓ {rowCount.toLocaleString()} row{rowCount !== 1 ? 's' : ''} {queryVerb ?? 'affected'}.
            </div>
          )}
          {result && (() => {
            const totalRows  = result.rows.length;
            const totalPages = Math.max(1, Math.ceil(totalRows / SQL_PAGE_SIZE));
            const page       = Math.min(sqlPage, totalPages - 1);
            const pageRows   = result.rows.slice(page * SQL_PAGE_SIZE, (page + 1) * SQL_PAGE_SIZE);
            const from       = totalRows === 0 ? 0 : page * SQL_PAGE_SIZE + 1;
            const to         = Math.min((page + 1) * SQL_PAGE_SIZE, totalRows);
            return (
              <>
                {/* Stats + pagination — fixed, never scrolls */}
                <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span>
                    <strong style={{ color: 'var(--text)' }}>{totalRows.toLocaleString()} row{totalRows !== 1 ? 's' : ''}</strong> returned
                    {result.cols.length > 0 && ` · ${result.cols.length} column${result.cols.length !== 1 ? 's' : ''}`}
                  </span>
                  {totalPages > 1 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button className="btn btn-xs btn-secondary" disabled={page === 0} onClick={() => setSqlPage(0)}>«</button>
                      <button className="btn btn-xs btn-secondary" disabled={page === 0} onClick={() => setSqlPage(p => Math.max(0, p - 1))}>‹</button>
                      <span style={{ fontSize: 12 }}>{from.toLocaleString()}–{to.toLocaleString()}</span>
                      <button className="btn btn-xs btn-secondary" disabled={page >= totalPages - 1} onClick={() => setSqlPage(p => Math.min(totalPages - 1, p + 1))}>›</button>
                      <button className="btn btn-xs btn-secondary" disabled={page >= totalPages - 1} onClick={() => setSqlPage(totalPages - 1)}>»</button>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>page {page + 1} / {totalPages}</span>
                    </span>
                  )}
                </div>
                {result.cols.length === 0
                  ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Query returned no rows.</div>
                  : (
                    /* Only the table body scrolls; thead stays sticky at the top */
                    <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                      <table className="data-table" style={{ fontSize: 12, minWidth: '100%' }}>
                        <thead>
                          <tr style={{ position: 'sticky', top: 0, zIndex: 2,
                            background: 'var(--surface-raised, var(--surface))',
                            boxShadow: '0 1px 0 var(--border)' }}>
                            {result.cols.map((c, ci) => (
                              <th key={ci} style={{ whiteSpace: 'nowrap', userSelect: 'none' }}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((row, ri) => (
                            <tr key={page * SQL_PAGE_SIZE + ri}>
                              {result.cols.map((c, ci) => {
                                const rawVal = row[ci]; // rows are arrays — use positional index
                                const isMsId = c === 'medscan_id';
                                const isCartridges = c === 'cartridges';
                                const isDate = c === 'created_at' || c === 'updated_at';
                                const rawArr = Array.isArray(rawVal) ? rawVal : [];

                                let display, tooltip;
                                if (isCartridges) {
                                  display = rawArr.length > 0 ? rawArr[0] : (rawVal ?? '—');
                                  tooltip = rawArr.length > 0 ? rawArr.join(', ') : undefined;
                                } else if (isDate) {
                                  display = rawVal ? new Date(rawVal).toLocaleString() : (rawVal ?? '—');
                                  tooltip = rawVal ? String(rawVal) : undefined;
                                } else if (Array.isArray(rawVal)) {
                                  display = rawVal.join(', ') || '—';
                                  tooltip = display;
                                } else {
                                  display = rawVal === null || rawVal === undefined ? '—' : String(rawVal);
                                  tooltip = rawVal !== null && rawVal !== undefined ? String(rawVal) : undefined;
                                }

                                return (
                                  <td key={ci}
                                    className={typeof rawVal === 'number' ? 'mono' : undefined}
                                    style={{ maxWidth: isDate ? 140 : isCartridges ? 120 : 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    title={tooltip}>
                                    {rawVal === null || rawVal === undefined
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : isMsId && onEditRecord
                                        ? <span style={{ color: 'var(--link, #7eb8f7)', cursor: 'pointer', textDecoration: 'underline' }}
                                            onClick={() => onEditRecord(Number(rawVal))}>{display}</span>
                                        : display}
                                    {isCartridges && rawArr.length > 1 && (
                                      <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 3 }}>+{rawArr.length - 1}</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </>
            );
          })()}
        </div>
      </div>

      {/* ── History floating dialog (draggable + resizable) ──────────── */}
      {showHistory && (
        <div data-hist-dialog style={{
          position: 'fixed',
          top:   histPos.y,
          left:  histPos.x !== null ? histPos.x : undefined,
          right: histPos.x !== null ? undefined  : 32,
          width: 360, height: 480,
          minWidth: 260, minHeight: 200,
          resize: 'both', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          zIndex: 9000,
        }}>
          {/* Title bar — drag handle */}
          <div onMouseDown={startHistDrag}
            style={{ display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
              cursor: 'move', userSelect: 'none',
              background: 'var(--surface-raised, rgba(255,255,255,0.04))' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>⠿ SQL History</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
              {history.length} {history.length === 1 ? 'query' : 'queries'}
            </span>
            {history.length > 0 && (
              <button className="btn btn-xs btn-secondary" style={{ fontSize: 10, cursor: 'default' }}
                onMouseDown={e => e.stopPropagation()}
                onClick={clearHistory}>Clear</button>
            )}
            <button className="btn btn-xs btn-secondary" style={{ fontSize: 10, cursor: 'default' }}
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setShowHistory(false)}>✕</button>
          </div>
          {/* Scrollable list */}
          <div style={{ flex: 1, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px' }}>
            {history.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
                No history yet.
              </div>
            )}
            {history.map((h, i) => {
              const date = new Date(h.lastRun);
              const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
              const preview = h.sql.replace(/\s+/g, ' ');
              return (
                <div key={i}
                  onClick={() => { setSql(h.sql); setShowHistory(false); }}
                  title={h.sql}
                  style={{ padding: '5px 8px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid var(--border)', background: 'var(--surface)',
                    transition: 'background 0.1s', flexShrink: 0 }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2, #2a2d3e)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}
                >
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                    {preview}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {dateStr} {timeStr}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Dictionary Screen ────────────────────────────────────────────────────
export default function DictionaryScreen({ onFindLiterature, dictPush }) {
  const [tab, setTab] = useState('single');
  // Track which tabs have ever been visited so we can lazy-mount them.
  // 'single' starts visited; heavy tabs (browse, batch, export) only mount on first visit.
  // This prevents DictBrowser's GROUP BY fetchStats query from racing with form inputs on load.
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(['single']));
  const [cartridges, setCartridges] = useState([]);
  const [successMsg, setSuccessMsg] = useState(null);
  // editTarget: msId to pre-load in RecordEditor when navigating from Browse or Results
  const [editTarget, setEditTarget] = useState(null);

  const goToTab = React.useCallback((newTab) => {
    setVisitedTabs(prev => { const s = new Set(prev); s.add(newTab); return s; });
    setTab(newTab);
  }, []);

  const handleEditFromBrowse = React.useCallback((msIdOrAlias) => {
    // Callers pass either:
    //   • a numeric NLP ID (number or Postgres string-integer like "1924244")
    //   • an array of such IDs
    //   • an alias string (non-numeric) — e.g. from Curate alias click
    const isNumericId = v => typeof v === 'number'
      || (typeof v === 'string' && /^\d+$/.test(v.trim()));
    const isId = Array.isArray(msIdOrAlias)
      ? msIdOrAlias.every(isNumericId)
      : isNumericId(msIdOrAlias);
    const toNum = v => Array.isArray(v) ? v.map(Number) : Number(v);
    const target = isId
      ? { msId: toNum(msIdOrAlias), ts: Date.now() }
      : { aliasSearch: [msIdOrAlias], ts: Date.now() };
    setEditTarget(target);
    setVisitedTabs(prev => { const s = new Set(prev); s.add('edit'); return s; });
    setTab('edit');
  }, []);

  // Navigate to Edit Record tab when triggered from Results Viewer or Settings
  useEffect(() => {
    if (!dictPush?.msId && !dictPush?.aliases) return;
    const target = dictPush.aliases
      ? { aliasSearch: dictPush.aliases, ts: dictPush.seq }
      : { msId: dictPush.msId, ts: dictPush.seq };
    setEditTarget(target);
    setVisitedTabs(prev => { const s = new Set(prev); s.add('edit'); return s; });
    setTab('edit');
  }, [dictPush?.seq]);

  useEffect(() => {
    window.api.medscan.listCartridges().then(setCartridges);
  }, []);

  const onSuccess = React.useCallback((msg) => {
    setSuccessMsg(msg);
  }, []);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Dictionary Manager</h1>
      </div>

      {successMsg && (
        <div className="alert alert-success" style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
          <span style={{ flex:1 }}>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} title="Dismiss"
            style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, lineHeight:1,
                     color:'inherit', opacity:0.55, padding:'0 2px', flexShrink:0 }}>×</button>
        </div>
      )}

      <div className="tabs">
        <div className={`tab ${tab === 'single' ? 'active' : ''}`} onClick={() => goToTab('single')}>Add Record</div>
        <div className={`tab ${tab === 'edit'   ? 'active' : ''}`} onClick={() => goToTab('edit')}>Edit Record</div>
        <div className={`tab ${tab === 'batch'  ? 'active' : ''}`} onClick={() => goToTab('batch')}>Batch Import</div>
        <div className={`tab ${tab === 'browse' ? 'active' : ''}`} onClick={() => goToTab('browse')}>Browse</div>
        <div className={`tab ${tab === 'curate' ? 'active' : ''}`} onClick={() => goToTab('curate')}>Curate</div>
        <div className={`tab ${tab === 'sql'    ? 'active' : ''}`} onClick={() => goToTab('sql')}>SQL</div>
      </div>

      {/* Lazy-mount: panels only mount when first visited, then stay mounted to preserve state */}
      {visitedTabs.has('single') && <div style={{ display: tab === 'single'  ? 'block' : 'none' }}><SingleEntryForm cartridges={cartridges} onSuccess={onSuccess} /></div>}
      {visitedTabs.has('batch')  && <div style={{ display: tab === 'batch'   ? 'block' : 'none' }}><BatchImport cartridges={cartridges} onSuccess={onSuccess} onEditRecord={handleEditFromBrowse} /></div>}
      {visitedTabs.has('browse') && <div style={{ display: tab === 'browse'  ? 'block' : 'none' }}><DictBrowser onEditRecord={handleEditFromBrowse} /></div>}
      {visitedTabs.has('edit')   && <div style={{ display: tab === 'edit'    ? 'block' : 'none' }}><RecordEditor initialMsId={editTarget?.msId} initialAlias={editTarget?.aliasSearch} key={editTarget?.ts} cartridges={cartridges} onFindLiterature={onFindLiterature} /></div>}
      {visitedTabs.has('curate') && <div style={{ display: tab === 'curate'  ? 'block' : 'none' }}><Curate onEditRecord={handleEditFromBrowse} /></div>}
      {visitedTabs.has('sql')    && <div style={{ display: tab === 'sql'     ? 'block' : 'none' }}><SqlConsole onEditRecord={handleEditFromBrowse} /></div>}
    </div>
  );
}