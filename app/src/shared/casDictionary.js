/**
 * AddToCasDictionary — the ONLY route for writing aliases into CASDictionary.
 *
 * Every screen (Add Record, Edit Record, Batch Import — all formats, Mixed list …)
 * must call addToCasDictionary() instead of issuing its own INSERT/UPDATE on
 * `casdictionary`.
 *
 * For every alias the function:
 *   1. tokenizes + normalizes it with the CASDictionary rules and the xwords_cas table
 *      (tokenizeForTable / normalizeForTable — single source of truth);
 *   2. checks that every token (must contain a letter) exists in chemNames;
 *   3. if tokens are missing, fires ONE approval dialog listing all missing tokens
 *      (grouped by alias). If the user declines nothing is written;
 *   4. adds the approved tokens to chemNames, then writes the aliases to casdictionary.
 *
 * The approval dialog is rendered by <ChemNamesApprovalHost/> (mounted once in App.jsx),
 * which registers itself through setChemNamesApprovalHandler().
 *
 * Renderer-only (uses window.api.db.query).
 */
import { tokenizeForTable, normalizeForTable } from './duplicateCheck.js';

let _approvalHandler = null;

/** Called by <ChemNamesApprovalHost/>. handler(missingByAlias) → Promise<boolean> */
export function setChemNamesApprovalHandler(handler) {
  _approvalHandler = handler;
}

const _q = (sql, params) => window.api.db.query(sql, params);

/** Tokens of an already tokenized CAS alias that must exist in chemNames. */
function chemTokensOf(tokenized) {
  return [...new Set(
    String(tokenized || '').split(/\s+/).filter(Boolean)
      .map(t => t.toLowerCase())
      .filter(t => /[a-z]/.test(t))
  )];
}

/**
 * Check aliases against chemNames; ask the user to approve adding missing tokens.
 * Does not write any alias.
 *
 * @param {string[]} aliases
 * @returns {Promise<{ok:boolean, cancelled?:boolean, error?:string, tokensAdded:number, tokenized:Map<string,string>}>}
 */
export async function ensureChemNamesTokens(aliases) {
  const uniq = [...new Set(aliases.filter(a => a != null && String(a).trim() !== ''))];
  const tokenized = new Map();
  await Promise.all(uniq.map(async a => tokenized.set(a, await tokenizeForTable(a, 'casdictionary'))));

  const perAlias = uniq.map(a => ({ alias: a, tokens: chemTokensOf(tokenized.get(a)) }));
  const allTokens = [...new Set(perAlias.flatMap(x => x.tokens))];
  if (!allTokens.length) return { ok: true, tokensAdded: 0, tokenized };

  // Look up existing tokens in chunks (keeps the IPC payload small)
  const existing = new Set();
  for (let i = 0; i < allTokens.length; i += 500) {
    const chunk = allTokens.slice(i, i + 500);
    const res = await _q(
      `SELECT lower(alias) AS alias FROM chemnames WHERE lower(alias) = ANY($1)`,   // deleted rows count as present: only a user may undelete
      [chunk]
    );
    if (!res.ok) return { ok: false, error: `chemNames check failed: ${res.error}`, tokensAdded: 0, tokenized };
    res.rows.forEach(r => existing.add(r.alias));
  }

  const missingByAlias = perAlias
    .map(x => ({ alias: x.alias, tokens: x.tokens.filter(t => !existing.has(t)) }))
    .filter(x => x.tokens.length > 0);
  if (!missingByAlias.length) return { ok: true, tokensAdded: 0, tokenized };

  if (!_approvalHandler) {
    return { ok: false, error: 'chemNames approval dialog is not available.', tokensAdded: 0, tokenized };
  }
  const approved = await _approvalHandler(missingByAlias);
  if (!approved) return { ok: false, cancelled: true, tokensAdded: 0, tokenized };

  const missingTokens = [...new Set(missingByAlias.flatMap(x => x.tokens))];
  for (const token of missingTokens) {
    const res = await _q(
      `INSERT INTO chemnames (medscan_id, alias, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (medscan_id, alias) DO NOTHING`,
      [token.length <= 3 ? 1000000 : 1000001, token]
    );
    if (!res.ok) return { ok: false, error: `chemNames insert failed for "${token}": ${res.error}`, tokensAdded: 0, tokenized };
  }
  return { ok: true, tokensAdded: missingTokens.length, tokenized };
}

/**
 * Add (or update) aliases in CASDictionary.
 *
 * @param {Array<{
 *   msId: number, alias: string, match?: string|null,
 *   cartridges?: string[], organisms?: string[],
 *   curated?: boolean,                       // sets curated=TRUE
 *   createdAt?: string|Date|null,            // preserve created_at (moves); default NOW()
 *   replace?: { id?: number, alias?: string } // UPDATE this existing row instead of INSERT
 * }>} entries
 * @returns {Promise<{ok:boolean, cancelled?:boolean, error?:string, written:number, tokensAdded:number}>}
 */
export async function addToCasDictionary(entries) {
  const list = (entries || []).filter(e => e && e.alias != null && String(e.alias).trim() !== '');
  if (!list.length) return { ok: true, written: 0, tokensAdded: 0 };

  const chk = await ensureChemNamesTokens(list.map(e => e.alias));
  if (!chk.ok) return { ok: false, cancelled: chk.cancelled, error: chk.error, written: 0, tokensAdded: 0 };

  let written = 0;
  const nowIso = new Date().toISOString();
  const insertRows = [];          // bulk path: plain INSERTs (the common, high-volume case)
  const normCache = new Map();    // alias+match → normalized
  const normOf = async (alias, match) => {
    const k = `${alias}\0${match || ''}`;
    if (!normCache.has(k)) normCache.set(k, (await normalizeForTable(alias, 'casdictionary', match || '')) || null);
    return normCache.get(k);
  };

  for (const e of list) {
    const match = e.match || null;
    const tokenized  = chk.tokenized.get(e.alias) || e.alias;
    const normalized = await normOf(e.alias, match);
    const carts = e.cartridges || [];
    const orgs  = e.organisms  || [];
    let res;
    if (e.onlyIfAbsent && !e.replace) {
      // Restore-style insert (Database → Import): keeps bdeleted / updated_at, skips an existing active row.
      res = await _q(
        `INSERT INTO casdictionary (medscan_id, alias, match, tokenized, normalized, cartridges, organisms, curated, bdeleted, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW())
         WHERE NOT EXISTS (SELECT 1 FROM casdictionary WHERE medscan_id=$1 AND LOWER(alias)=LOWER($2) AND (bdeleted IS NULL OR bdeleted = FALSE))`,
        [e.msId, e.alias, match, tokenized, normalized, carts, orgs, !!e.curated, !!e.bdeleted, e.createdAt || null, e.updatedAt || null]);
      if (!res.ok) return { ok: false, error: `casdictionary write failed for "${e.alias}": ${res.error}`, written, tokensAdded: chk.tokensAdded };
      written += res.rowCount || 0;
      continue;
    }
    if (!e.replace) {
      insertRows.push([e.msId, e.alias, match, tokenized, normalized, carts, orgs, !!e.curated,
        e.createdAt ? new Date(e.createdAt).toISOString() : nowIso, nowIso]);
      continue;
    }
    {
      res = e.replace.id != null
        ? await _q(
            `UPDATE casdictionary SET alias=$1, match=$2, tokenized=$3, normalized=$4, cartridges=$5, organisms=$6,
                    curated=${e.curated ? 'TRUE' : 'curated'}, updated_at=NOW() WHERE id=$7`,
            [e.alias, match, tokenized, normalized, carts, orgs, e.replace.id])
        : await _q(
            `UPDATE casdictionary SET alias=$1, match=$2, tokenized=$3, normalized=$4, cartridges=$5, organisms=$6,
                    curated=${e.curated ? 'TRUE' : 'curated'}, updated_at=NOW() WHERE medscan_id=$7 AND alias=$8`,
            [e.alias, match, tokenized, normalized, carts, orgs, e.msId, e.replace.alias ?? e.alias]);
    }
    if (!res.ok) return { ok: false, error: `casdictionary write failed for "${e.alias}": ${res.error}`, written, tokensAdded: chk.tokensAdded };
    written++;
  }

  if (insertRows.length) {
    // _viaCasRoute: main-process db:bulkInsert refuses casdictionary without this flag
    const res = await window.api.db.bulkInsert({
      table: 'casdictionary',
      columns: ['medscan_id', 'alias', 'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'curated', 'created_at', 'updated_at'],
      rows: insertRows,
      _viaCasRoute: true,
    });
    if (!res.ok) return { ok: false, error: `casdictionary insert failed: ${res.error}`, written, tokensAdded: chk.tokensAdded };
    written += insertRows.length;
  }
  return { ok: true, written, tokensAdded: chk.tokensAdded };
}

/**
 * Drop-in replacement for window.api.db.bulkInsert for alias tables: rows destined for
 * casdictionary are routed through addToCasDictionary (approval dialog etc.), all other
 * tables go straight to bulkInsert. `rows` use the 9-column alias layout given in `columns`.
 * Returns { ok, error?, cancelled? } like bulkInsert.
 */
export async function bulkInsertAliasTable({ table, columns, rows }) {
  if (table !== 'casdictionary') return window.api.db.bulkInsert({ table, columns, rows });
  const ix = n => columns.indexOf(n);
  const r = await addToCasDictionary(rows.map(row => ({
    msId: row[ix('medscan_id')], alias: row[ix('alias')], match: row[ix('match')],
    cartridges: row[ix('cartridges')], organisms: row[ix('organisms')],
  })));
  if (r.ok) return { ok: true, rowCount: r.written };
  return { ok: false, cancelled: r.cancelled,
    error: r.cancelled ? 'Adding to CASdictionary was cancelled — chemNames tokens were not approved. Nothing was imported.' : r.error };
}

// Name requested by the spec
export const AddToCasDictionary = addToCasDictionary;
