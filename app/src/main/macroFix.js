'use strict';
// Corrections of a designed pattern's word sets:
//   1. a bare word with a hyphen is a syntax error ("illegal wordset element: -") → it is quoted as it is:  anti-  →  "anti-"
//   2. macro substitution — literal words that a small macro of the cartridge covers become the macro:  [$TREAT anti]  →  [$TREAT $ANTI]
//        tier 1 (applied):   the macro is a flat word list; the pattern spells out at least one of its words and the macro has at most MAX_EXTRA words more
//        tier 2 (suggested): the macro contains the literal word but has more extra words — only reported, the pattern is not changed
//   3. glued prefixes — a prefix stuck to an entity in the tagged sentence (anti-ID{relapse}) is the text "anti-"; a macro with the word anti
//        and the literal "anti -" ($ANTI = [anti "anti -"]) does not contain it, so "anti-" is added next to that macro:  $ANTI  →  [$ANTI "anti-"]
//   2b. redundant words — a literal word that a macro in the same word set already contains (also through nested macros) is removed
// Text in double quotes is matched as is, character for character (no tokenization), so "anti-" and "anti -" are different strings.
// Words match as written in the msgrep file: case-insensitive, quotes ignored, "anti-" and "anti -" and "anti" are three different words,
// a trailing "~" (stem match) must be on both sides.

const MAX_EXTRA = 2;
const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'to', 'by', 'with', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'as', 'from', 'that', 'this', 'it', 'its', 'not', 'no']);

const norm = (tok) => String(tok).replace(/"/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const tokensOf = (s) => String(s).match(/"[^"]*"|\S+/g) || [];
const isLiteral = (tok) => /^"?[A-Za-z0-9][\w -]*"?~?$/.test(tok);

/** flat word list of a macro body "[a b "c d"~ ]" → { words: Set(normalised), raw: [tokens] }, or null when the body uses other macros / is not a plain list */
function flatWords(body) {
  const m = String(body).trim().match(/^\[([^\[\]]*)\]$/);
  if (!m) return null;
  const toks = tokensOf(m[1]);
  if (!toks.length || toks.some(t => /^[$@&^]/.test(t) || !isLiteral(t))) return null;
  return { words: new Set(toks.map(norm)), raw: toks };
}

/** prefixes stuck to an entity in a tagged sentence: "…the only anti-ID{…relapse}…" → ['anti-'] */
function gluedPrefixes(text) {
  return [...new Set([...String(text).matchAll(/([A-Za-z]{2,}-)(?=ID\{)/g)].map(m => m[1].toLowerCase()))];
}

/**
 * macros: [{ name, body }]; patterns: [text]; glued: ['anti-', …] (see gluedPrefixes)
 * → [{ pattern, applied: [{ kind: 'quote' | 'macro' | 'glue', macro, replaced: [tokens], to, extra: [words] }], suggested: [{ macro, words: [tokens], extra: n }] }]
 */
function fixMacros(macros, patterns, glued = []) {
  const flat = [];
  for (const m of macros) {
    if (!m.name.startsWith('$') || m.name === '$ACT') continue;
    const f = flatWords(m.body);
    if (f) flat.push({ name: m.name, ...f });
  }
  // every word a macro accepts, with the words of the macros it includes (any depth)
  const bodies = new Map(macros.map(m => [m.name, m.body]));
  const closure = new Map();
  const wordsOfMacro = (name, seen = new Set()) => {
    if (closure.has(name)) return closure.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const out = new Set();
    for (const t of tokensOf(String(bodies.get(name) || '').replace(/[\[\]]/g, ' '))) {
      if (/^\$/.test(t)) { if (bodies.has(t) && t !== '$ACT') wordsOfMacro(t, seen).forEach(w => out.add(w)); }
      else if (isLiteral(t)) out.add(norm(t));
    }
    return out;
  };
  for (const [name] of bodies) if (name.startsWith('$') && name !== '$ACT') closure.set(name, wordsOfMacro(name));
  return patterns.map(pattern => {
    const applied = [], suggested = [];
    let out = String(pattern).replace(/\[([^\[\]]*)\]/g, (whole, inner) => {
      if (inner.trim().startsWith('^')) return whole;                              // a guard, not a word set
      let toks = tokensOf(inner);
      // 1. a bare word with a hyphen: quote it as it is
      toks = toks.map(t => {
        const m = t.match(/^([A-Za-z0-9-]*-[A-Za-z0-9-]*)(~?)$/);
        if (!m || m[1] === '-') return t;
        const to = '"' + m[1] + '"' + m[2];
        applied.push({ kind: 'quote', macro: null, replaced: [t], to, extra: [] });
        return to;
      });
      // 2. macros for literal words
      for (let round = 0; round < 6; round++) {
        const lit = toks.filter(t => isLiteral(t));
        if (!lit.length) break;
        const litNorm = new Set(lit.map(norm));
        let best = null;
        for (const m of flat) {
          if (toks.includes(m.name)) continue;
          const covered = lit.filter(t => m.words.has(norm(t)));
          if (!covered.length) continue;
          const extra = [...m.words].filter(w => !litNorm.has(w));
          if (extra.length > MAX_EXTRA) continue;
          if (!best || covered.length > best.covered.length || (covered.length === best.covered.length && extra.length < best.extra.length)) best = { m, covered, extra };
        }
        if (!best) break;
        const at = toks.findIndex(t => best.covered.includes(t));
        toks = toks.filter(t => !best.covered.includes(t));
        toks.splice(Math.min(at, toks.length), 0, best.m.name);
        applied.push({ kind: 'macro', macro: best.m.name, replaced: best.covered, extra: best.extra });
      }
      // 2b. a word that a macro of the same word set already contains (directly or through the macros it includes) is redundant: [$ASSOCIATE_BM relate~] → [$ASSOCIATE_BM]
      const refs = toks.filter(t => closure.has(t));
      if (refs.length) {
        toks = toks.filter(t => {
          if (!isLiteral(t)) return true;
          const by = refs.find(r => closure.get(r).has(norm(t)));
          if (!by) return true;
          applied.push({ kind: 'drop', macro: by, replaced: [t], to: '', extra: [] });
          return false;
        });
      }
      // tier 2: what is left — a macro that holds the word but brings many more
      for (const t of toks.filter(isLiteral)) {
        const n = norm(t);
        if (n.length < 3 || STOP.has(n.replace('~', ''))) continue;
        let small = null;
        for (const m of flat) if (m.words.has(n) && (!small || m.words.size < small.words.size)) small = m;
        if (small && !suggested.some(s => s.macro === small.name)) suggested.push({ macro: small.name, words: [t], extra: small.words.size - 1 });
      }
      return '[' + toks.join(' ') + ']';
    });
    // 3. glued prefixes (tagged-sentence patterns only: ConceptScan pseudo-sentences are normalised)
    if (glued.length && !/\$ACT\b/.test(out)) {
      for (const g of glued) {
        const stem = g.slice(0, -1), gq = '"' + g + '"';
        const withStem = new Set(flat.filter(m => m.words.has(stem)).map(m => m.name));
        out = out.replace(/\[[^\[\]]*\]|\$[A-Za-z_]\w*/g, (tok) => {
          if (tok[0] === '[') {
            if (tok.slice(1).trim().startsWith('^')) return tok;
            const toks = tokensOf(tok.slice(1, -1));
            const uses = toks.find(t => withStem.has(t) || norm(t) === stem);
            if (!uses || toks.some(t => norm(t) === g)) return tok;
            applied.push({ kind: 'glue', macro: withStem.has(uses) ? uses : null, replaced: [], to: gq, extra: [] });
            return '[' + toks.join(' ') + ' ' + gq + ']';
          }
          if (!withStem.has(tok)) return tok;
          applied.push({ kind: 'glue', macro: tok, replaced: [], to: gq, extra: [] });
          return '[' + tok + ' ' + gq + ']';
        });
      }
    }
    return { pattern: applied.length ? out : String(pattern), applied, suggested: suggested.slice(0, 5) };
  });
}

module.exports = { fixMacros, flatWords, gluedPrefixes };
