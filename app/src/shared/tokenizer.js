// ── Shared MedScan tokenizer ──────────────────────────────────────────────────
// Single source of truth for alias tokenization.  Used by:
//   • Renderer (DictionaryScreen): Edit Record, Add Record, Curate, search
//   • Main process: dict refresh (batch import), Retokenize Aliases
//
// Two-phase pipeline:
//   makeTokenizer   (Phase-1): charRx split → applyTokenRules → lowercase → xwords filter
//                   Produces the value stored in the 'tokenized' DB column.
//   makeNormalizer  (Phase-2): same as Phase-1 PLUS preNormToken → stemPlural → normalizeToken
//                   Produces the value stored in the 'normalized' DB column.
//
// NOTE: Greek → Latin conversion is NOT applied here; it is a UI/search concern
// and is handled by the renderer wrapper (makeXwordTokenizer in DictionaryScreen).
//
// src/shared/package.json sets "type":"module" so Node.js also loads this as ESM.
// Main process uses: await import(pathToFileURL(path.join(__dirname,'../shared/tokenizer.js')))
// Renderer uses:     import { makeTokenizer, makeNormalizer, TABLE_XWORDS } from '../../shared/tokenizer'

import pluralize from 'pluralize';

// Words that exist only in plural form (pluralia tantum) and have no singular.
// The pluralize package doesn't know these and would incorrectly strip their
// endings (e.g. "feces" → "fece").  Register them as uncountable so the
// library returns them unchanged.
pluralize.addUncountableRule('feces');
pluralize.addUncountableRule('faeces');
// "varices" is the canonical medical plural of "varix" (esophageal varices, etc.).
// Medscan keeps "varices" as-is and normalises "varix" → "varices".
pluralize.addUncountableRule('varices');

// ── Greek symbol → ASCII name map ────────────────────────────────────────────
// Maps every Unicode Greek letter (lower + upper) to its ASCII name.
// Used by applyTokenRules to convert e.g. "Fc γR3" → "Fc gammaR3".
// A single .replace() with the combined character-class regex is equivalent to
// the previous 20 individual .replace() calls but compiles the regex only once.
const _GREEK_SYMS = new Map([
  ['α', 'alpha'],  ['Α', 'alpha'],
  ['β', 'beta'],   ['Β', 'beta'],
  ['γ', 'gamma'],  ['Γ', 'gamma'],
  ['δ', 'delta'],  ['Δ', 'delta'],
  ['ε', 'epsilon'],['Ε', 'epsilon'],
  ['ζ', 'zeta'],   ['Ζ', 'zeta'],
  ['η', 'eta'],    ['Η', 'eta'],
  ['θ', 'theta'],  ['Θ', 'theta'],
  ['ι', 'iota'],   ['Ι', 'iota'],
  ['κ', 'kappa'],  ['Κ', 'kappa'],
  ['λ', 'lambda'], ['Λ', 'lambda'],
  ['μ', 'mu'],     ['Μ', 'mu'],
  ['ν', 'nu'],     ['Ν', 'nu'],
  ['ξ', 'xi'],     ['Ξ', 'xi'],
  ['σ', 'sigma'],  ['Σ', 'sigma'],
  ['τ', 'tau'],    ['Τ', 'tau'],
  ['υ', 'upsilon'],['Υ', 'upsilon'],
  ['φ', 'phi'],    ['Φ', 'phi'],
  ['χ', 'chi'],    ['Χ', 'chi'],
  ['ψ', 'psi'],    ['Ψ', 'psi'],
  ['ω', 'omega'],  ['Ω', 'omega'],
]);
const _greekSymRx = new RegExp(`[${[..._GREEK_SYMS.keys()].join('')}]`, 'g');

// ── Prefix-merging regex ──────────────────────────────────────────────────────
// Prefixes that should be glued back onto the following word when separated by
// a space or a charRx-expanded hyphen (" - ").
// e.g. "non-structural" / "non structural" / "non - structural" → "nonstructural"
//      "haemo-ptysis"   / "haemo ptysis"                        → "haemoptysis"
const _MERGE_PREFIXES = [
  'non', 'neuro',
];
const _mergePrefixRx = new RegExp(
  `\\b(${_MERGE_PREFIXES.join('|')})(?:\\s+-\\s+|\\s+)([a-zA-Z])`,
  'gi',
);

// ── Core string rules ─────────────────────────────────────────────────────────
// Applied on the original-case string before splitting into tokens.
export function applyTokenRules(s) {
  return s
    .replace(/\+/g, ' + ')                        // H+ → H +  NAD+ → NAD +
    .replace(/(\d)([^\d\s])/g, '$1 $2')           // digit → non-digit
    .replace(/([^\d\s])(\d)/g, '$1 $2')           // non-digit → digit
    // Prefix merging: glue each listed prefix back onto the following word even when
    // separated by a space or a charRx-expanded hyphen (" - ").
    // charRx runs before applyTokenRules and expands "non-word" → "non - word",
    // so both the hyphenated and space-separated forms arrive here as "non - word"
    // or "non word" and are both caught by the same pattern.
    .replace(_mergePrefixRx, '$1$2')
    // Unicode Greek letter symbols → ASCII names (e.g. "Fc γR3" → "Fc gammaR3").
    // Must run before the ASCII Greek injection below so the names get spaced correctly.
    // Single pass over all 20 pairs via the pre-built _greekSymRx + _GREEK_SYMS map.
    .replace(_greekSymRx, ch => _GREEK_SYMS.get(ch))
    // Greek-letter name injection: ensure Greek names are always separate tokens even
    // when written without spaces, e.g. "17betaHSD5" → "17 beta HSD 5",
    // "TNFalpha" → "TNF alpha", "FcgammaRIII" → "Fc gamma RIII".
    // Applied before the lowercase step.
    // Only longer/unambiguous names are listed; short ones (mu, nu, pi…) risk
    // false-splitting common words (murine, nucleotide, picomolar…).
    //
    // IMPORTANT: the `i` flag is intentionally ABSENT here.  With `i`, the `[a-z]`
    // inside the lookahead becomes [a-zA-Z], which would prevent splitting "TNFalpha".
    // Without `i` we handle both lowercase and Title-case names via `[Xx]xxx` classes.
    //
    // Single-pass injection: inject unless BOTH neighbours are lowercase
    // (which means the Greek name is embedded in a word, e.g. "synthetase" → "theta"
    // has 'n' before and 's' after → no injection).
    // Examples that DO inject: "deltacoronavirus" ('nothing' before, 'c' after → inject),
    // "Fcgamma" ('c' before, 'nothing' after → inject), "TNFalpha" ('F' before → inject).
    .replace(/(?:[Aa]lpha|[Bb]eta|[Gg]amma|[Dd]elta|[Ee]psilon|[Zz]eta|[Tt]heta|[Kk]appa|[Ll]ambda|[Ss]igma|[Uu]psilon|[Oo]mega)/g,
      (name, offset, str) => {
        const before = offset > 0 ? str[offset - 1] : '';
        const after  = str[offset + name.length] || '';
        const loBefore = before >= 'a' && before <= 'z';
        const loAfter  = after  >= 'a' && after  <= 'z';
        return (loBefore && loAfter) ? name : ` ${name} `;
      })
    // "anti" prefix splitting: "antiprotease" → "anti protease", "antitrypsin" → "anti trypsin".
    // \b ensures we only split at a word boundary — "romantic", "pedantic", "Atlantic" are
    // unaffected because the 'a' in their embedded "anti" is not at a word boundary.
    // The lookahead (?=[a-zA-Z]) prevents splitting "anti." or "anti-" (hyphens are handled
    // by the separator charRx step before applyTokenRules is called).
    // Must run before normalization so "antiproteinase" → "anti proteinase" → "anti protease".
    .replace(/\banti(?=[a-zA-Z])/gi, 'anti ')
    // Roman numeral splitting (≥ 2 consecutive Roman chars adjacent to lowercase).
    // {2,} prevents false-splitting single uppercase letters like "I" in "Inhibitor"
    // or "V" in "Victoria".  Covers e.g. "IIalpha" → "II alpha",
    // "CaMKIIalpha" → "CaMK II alpha", "alphaIV" → "alpha IV".
    .replace(/([IVXLCDM]{2,})([a-z])/g, '$1 $2')
    .replace(/([a-z])([IVXLCDM]{2,})/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── combnames-specific string rules ──────────────────────────────────────────
// combnames stores multi-marker expressions such as Tim-3+PD-1+KLRG1+.
// Standard applyTokenRules would wrongly explode the + signs and split digits
// from letters inside marker names.  These rules instead:
//   1. Replace "/" with space  (Tim-3+/PD-1+ → Tim-3+ PD-1+)
//   2. Insert space after "+" when immediately followed by an uppercase letter
//      (new marker starts)  Tim-3+PD-1+ → Tim-3+ PD-1+
//   3. Insert space after "-" when immediately followed by a lowercase letter
//      (English compound word)  T-cells → T- cells
// Digit-nondigit splitting and the generic + expansion are intentionally omitted
// so marker identifiers like Tim-3, PD-1, KLRG1 remain intact.
export function applyTokenRulesComb(s) {
  return s
    .replace(/\//g, ' ')               // forward slash → space
    .replace(/\+(?=[A-Z])/g, '+ ')    // Tim-3+PD-1+ → Tim-3+ PD-1+
    .replace(/-(?=[a-z])/g, '- ')     // T-cells → T- cells
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Abbreviation detector ─────────────────────────────────────────────────────
// Returns true when a token (in ORIGINAL CASE) is an ALL-CAPS abbreviation.
// Such tokens must never be de-pluralised: "CARS2" is not the plural of "CAR2".
// Called before stemPlural so it can be skipped entirely for abbreviations.
//
// Algorithm:
//   1. If token length is 7 or more → cannot be an abbreviation (too long).
//   2. Extract only the letter characters (ignore digits and punctuation).
//   3. If all extracted letters are uppercase → it is an abbreviation.
//
// Must be called on ORIGINAL-CASE tokens (before Phase-1 lowercasing).
//
// Examples that return true:  ACRPS, ANKS, CARS2, ACS, IL6, BCAS
// Examples that return false: kinases (length ≥ 7), Louckes (mixed case), il6 (lowercase)
export function isAbbreviation(token) {
  if (token.length >= 7) return false;
  const letters = token.replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}

// ── Plural normalisation ──────────────────────────────────────────────────────
// Uses the `pluralize` package for accurate English singularisation.
// Called on ORIGINAL-CASE tokens so abbreviations ending in uppercase 'S' are
// never touched (only a lowercase 's' suffix is considered plural).
export function stemPlural(token) {
  if (!token.endsWith('s')) return token;  // uppercase 'S' never matches
  // Short tokens (≤ 3 chars) are abbreviations or initials ("ps", "gs", "ms", "acs"),
  // never genuine English plurals — minimum length for de-pluralisation is 4 chars.
  if (token.length <= 3) return token;
  // Tokens starting with an uppercase letter are proper nouns, surnames, or
  // abbreviations (e.g. "Louckes", "HeLa", "BCells") — MedScan skips de-pluralisation
  // for these so they remain intact before lowercasing.
  if (token[0] >= 'A' && token[0] <= 'Z') return token;
  // Guard against the English `pluralize` library incorrectly stripping suffixes from
  // Latin 3rd-declension words that are common in anatomical nomenclature:
  //   -alis  (singular): hypophysialis, portalis, lateralis …
  //   -ales  (plural):   portales, laterales, ventrales …
  // pluralize() would produce "hypophysiali", "portale" etc. — all wrong.
  // Use length > 6 / > 7 to avoid blocking short English words that happen to share
  // the same ending (e.g. "gales" → "gale", "locales" → "locale" should still work).
  if (token.endsWith('alis') && token.length > 6) return token;
  // Latin 2nd-declension adjectives in -uus (e.g. ambiguus, conspicuus) must not be
  // de-pluralized — pluralize() would produce "ambiguu" etc.
  if (token.endsWith('uus') && token.length > 5) return token;
  // Greek/Latin -sis words (amebiasis, diagnosis, analysis, metastasis…) are never
  // English plurals — protect them so the spelling map can normalize them intact.
  if (token.endsWith('sis') && token.length > 5) return token;
  // Greek -itis words (tendonitis, arthritis, appendicitis…) are never English plurals.
  if (token.endsWith('itis') && token.length > 6) return token;
  // Greek/Latin -oses plurals (lipidoses, neuroses, diagnoses…): pluralize knows the
  // common ones (neuroses→neurosis) but may give a wrong "-ose" form for rare terms.
  // Correct silently: if pluralize gives back "-ose", force the "-osis" singular instead.
  if (token.endsWith('oses') && token.length > 6) {
    const s = pluralize.singular(token);
    return s.endsWith('osis') ? s : token.slice(0, -4) + 'osis';
  }
  // Greek -iasis words (amebiasis, leishmaniasis, giardiasis, candidiasis…) pluralise
  // to -iases.  pluralize() incorrectly strips only 's' → '-iase' (not a real word).
  // The '-iases' ending is specific enough to medical terms that a forced correction
  // is safe — common English words ending in '-iases' don't exist.
  if (token.endsWith('iases') && token.length > 7) {
    const s = pluralize.singular(token);
    // slice(0,-2) replaces trailing 'es' with 'is': "amebiases" → "amebias" + "is" = "amebiasis"
    return s.endsWith('iasis') ? s : token.slice(0, -2) + 'is';
  }
  // Greek -ysis words (hemoptysis, electrolysis, dialysis, analysis…) pluralise
  // to -yses.  pluralize() may strip only 'es' → '-ys' (not a real word) for rare terms.
  // slice(0,-4) + 'ysis': "haemoptyses" → "haemopt" + "ysis" = "haemoptysis"
  if (token.endsWith('yses') && token.length > 6) {
    const s = pluralize.singular(token);
    return s.endsWith('ysis') ? s : token.slice(0, -4) + 'ysis';
  }
  const singular = pluralize.singular(token);
  if (token.endsWith('ales') && singular.endsWith('ale') && token.length > 7) return token;
  // Let pluralize decide: it returns the token unchanged when it isn't a plural
  // (e.g. "virus", "process", "mass", "basis" all survive intact).
  return singular;
}

// ── Term normalizations ───────────────────────────────────────────────────────
const WORD_NORMS = new Map([
  ['synthetase',        'synthase'],
  ['proteinase',        'protease'],
  ['metalloproteinase', 'metalloprotease'],
  ['eyes',              'eye'],
  // Latin irregular plurals
  ['nuclei',            'nucleus'],
  // British → American spelling (double-l → single-l before suffix)
  ['signalling',        'signaling'],
  ['remodelling',       'remodeling'],
  // British → American: -our → -or
  ['tumour',            'tumor'],
  ['colour',            'color'],
  ['behaviour',         'behavior'],
  ['neighbour',         'neighbor'],
  ['flavour',           'flavor'],
  ['honour',            'honor'],
  ['labour',            'labor'],
  ['humour',            'humor'],
  // British → American: faeces/faecal → feces/fecal
  ['faeces',            'feces'],
  ['faecal',            'fecal'],
  // Latin singular "varix" → canonical plural "varices" (matches Medscan tokenization)
  ['varix',             'varices'],
]);

// ── Runtime spelling normalization ───────────────────────────────────────────
// Loaded from the DB 'spelling' table at app startup.
// Maps each spelling variant (lowercased) → canonical normalized form.
// e.g. 'thiamin' → 'thiamine', 'tiamin' → 'thiamine'
// The table schema: col1 = canonical form, col2 = space-separated variants.
let _spellingMap = new Map();

export function setSpellingMap(variantToNormalized) {
  _spellingMap = variantToNormalized instanceof Map
    ? variantToNormalized
    : new Map(variantToNormalized);
}

// ── Static suffix / word-norm rules (applied before spelling lookup) ──────────
function _staticNorm(tok) {
  // 1. Exact-match corrections.
  if (tok === 'azygous') return 'azygos';
  if (tok === 'fibre')  return 'fiber';

  // 2. Substring replacements — fall-through so multiple may apply in one token.
  if (tok.includes('coel'))                    tok = tok.replace(/coel/g,  'cel');  // coeliac→celiac, noncoeliac→nonceliac
  if (tok.includes('haem') && tok.length > 4)  tok = tok.replace(/haem/g,  'hem');

  // 3. Prefix rules — first match wins.
  const prefixRules = [
    // Latin biological: silvestris→sylvestris.
    { prefix: 'silv',     minLen: 0, replace: t => 'sylv' + t.slice(4) },
    // Anatomical: piriformis→pyriformis.
    { prefix: 'piri',     minLen: 0, replace: t => 'pyri' + t.slice(4) },
    // Anatomical 'ae' ligature: parataenia→paratenia, parataenialis→paratenialis.
    { prefix: 'parataen', minLen: 0, replace: t => 'paraten' + t.slice(8) },
  ];
  for (const { prefix, minLen, replace } of prefixRules) {
    if (tok.startsWith(prefix) && tok.length > minLen) return replace(tok);
  }

  // 4. Suffix rules: [suffix, minLen, replacement]
  //    Replacement uses slice(0, -suffix.length) + replacement, so the leading
  //    vowel of 'ysing'/'ising' is kept in the replacement string.
  const suffixRules = [
    // Must precede 'ial': epiphysial→epiphyseal, zygapophysial→zygapophyseal.
    ['physial',  0,  'physeal' ],
    // mitochondrial→mitochondria. Length > 8 keeps short -ial words intact.
    ['ial',      8,  'ia'      ],
    // myocardiac→myocardia. Length > 7 keeps "cardiac" (7) and "celiac" (6).
    ['iac',      7,  'ia'      ],
    // hydrolysing→hydrolyzing ('y' is kept in replacement).
    ['ysing',    0,  'yzing'   ],
    // oxidising→oxidizing ('i' is kept in replacement). Length > 8.
    ['ising',    8,  'izing'   ],
    // localisation→localization.
    ['isation',  8,  'ization' ],
    // corticotrophin→corticotropin. Length > 10.
    ['phin',     10, 'pin'     ],
    // hypogammaglobulinaemia→hypogammaglobulinemia.
    ['aemia',    7,  'emia'    ],
    // cryoglobulinaemic→cryoglobulinemic.
    ['aemic',    7,  'emic'    ],
    // arteriales→arterialis, hypophysiales→hypophysialis.
    ['iales',    7,  'ialis'   ],
  ];
  for (const [suffix, minLen, replacement] of suffixRules) {
    if (tok.endsWith(suffix) && tok.length > minLen) {
      return tok.slice(0, -suffix.length) + replacement;
    }
  }

  // Fallback: WORD_NORMS lookup (used by the normalizeToken path which calls
  // _staticNorm directly without going through preNormToken).
  return WORD_NORMS.get(tok) ?? tok;
}

// Apply WORD_NORMS and _spellingMap before stemming so variant spellings are
// converted to their canonical form before stemPlural runs.  Without this,
// "lipoides" would be stemmed to "lipoide" before the spelling map can match it.
// The key is lowercased for lookup; result comes from the map (always lowercase)
// or the original token is kept if not found in either map.
function preNormToken(tok) {
  const lower = tok.toLowerCase();
  if (WORD_NORMS.has(lower)) return WORD_NORMS.get(lower);
  if (_spellingMap.size > 0 && _spellingMap.has(lower)) return _spellingMap.get(lower);
  return tok;
}

export function normalizeToken(tok) {
  // _spellingMap is applied in preNormToken (before stemPlural), not here,
  // to match Medscan's tokenization order: spelling normalisation fires before stemming.
  return _staticNorm(tok);
}

// ── Tables that must NOT have plural stemming ─────────────────────────────────
// CAS dictionary and chemnames use precise chemical nomenclature where
// singular and plural are distinct compounds (e.g. "polyethylene glycol" ≠
// "polyethylene glycols").  MedScan NLP does not apply stemPlural to these
// tables, so we must not either.
export const NO_STEM_TABLES = new Set(['casdictionary', 'chemnames']);

// ── Normalizer factory (Phase-2) ──────────────────────────────────────────────
/**
 * Build a Phase-2 normalizer function for a given xword set.
 * Full pipeline: charRx split → applyTokenRules → preNormToken → stemPlural →
 *   lowercase → xwords filter → normalizeToken/_staticNorm/WORD_NORMS.
 * Output is stored in the 'normalized' DB column.
 *
 * @param {Set<string>|null} xwordSet        Current table's xwords — used for filtering tokens.
 * @param {object}           [opts]
 * @param {boolean}          [opts.stemming=true]  Apply stemPlural.
 *   Pass false for casdictionary / chemnames (use NO_STEM_TABLES to check).
 * @param {Set<string>|null} [opts.separatorSet]  Union of single-char xwords from ALL tables —
 *   used for splitting.  A char in separatorSet but not in xwordSet becomes its own token and
 *   is KEPT (e.g. '.' in celldictionary).  A char in both is split AND then filtered away.
 *   Defaults to xwordSet when omitted (backwards-compatible).
 * @returns {(alias: string) => string}
 */
export function makeNormalizer(xwordSet, { stemming = true, separatorSet = null } = {}) {
  // wordSet: table-specific xwords — controls which tokens are removed.
  const wordSet = (xwordSet && xwordSet.size > 0)
    ? new Set([...xwordSet])
    : new Set();
  // charRx: built from the union separator set so that punctuation chars that live in
  // ANY xwords table are always split into their own tokens, regardless of current table.
  const sepSource = separatorSet ?? xwordSet;
  const singleChars = (sepSource && sepSource.size > 0)
    ? [...sepSource].filter(w => w.length === 1).join('')
    : '';
  let charRx = null;
  if (singleChars.length > 0) {
    const esc = singleChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    charRx = new RegExp(`([${esc}])`, 'g');  // capture group keeps the char as its own token
  }
  // Returns a normalizer function.
  // @param {string} s             Phase-1 tokenized form (or original alias when originalAlias omitted).
  // @param {string} [originalAlias]  Original alias string BEFORE Phase-1 lowercasing.
  //   When provided, original-case tokens are extracted from it for the stemPlural /
  //   isAbbreviation step, so ALL-CAPS abbreviations (e.g. "ACRPS", "ANKS") are
  //   correctly protected from de-pluralisation even though `s` is already lowercase.
  return (s, originalAlias = null) => {
    // Normalize curly/smart apostrophes → straight so xword splitting is consistent
    // regardless of whether the input came from a file (often curly) or was typed (straight).
    const s2 = s.replace(/['']/g, "'");
    let result = charRx ? s2.replace(charRx, ' $1 ') : s2;  // e.g. "P.falciparum" → "P . falciparum"
    result = applyTokenRules(result);

    // For the stemPlural step we need original-case tokens.
    // When `originalAlias` is supplied (i.e. Phase-2 is being applied to Phase-1 output
    // which is already lowercase), re-extract tokens from the original alias so that
    // isAbbreviation() can detect ALL-CAPS tokens and stemPlural's own guards can fire.
    let stemSource;
    if (originalAlias != null) {
      const orig2 = originalAlias.replace(/['']/g, "'");
      let origResult = charRx ? orig2.replace(charRx, ' $1 ') : orig2;
      origResult = applyTokenRules(origResult);
      stemSource = origResult;
    } else {
      stemSource = result;  // no original alias → use `s` as-is (original case preserved)
    }
    result = stemSource.split(' ').filter(Boolean).map(t => {
      if (!stemming) return t;  // skip preNormToken + stemPlural for precise tables (e.g. casdictionary)
      t = preNormToken(t);
      if (isAbbreviation(t)) return t;  // ALL-CAPS token → skip de-pluralisation
      return stemPlural(t);
    }).join(' ');
    result = result.toLowerCase();
    const tokens = result.split(' ').filter(Boolean);
    const stripped = wordSet.size > 0 ? tokens.filter(t => !wordSet.has(t)) : tokens;
    // normalizeToken applies WORD_NORMS; skip for precise tables to preserve exact chemical names.
    const finalToks = stemming ? (stripped.length > 0 ? stripped : tokens).map(normalizeToken)
                               : (stripped.length > 0 ? stripped : tokens);
    return finalToks.join(' ');
  };
}

// ── combnames normalizer factory ─────────────────────────────────────────────
// Like makeNormalizer but uses applyTokenRulesComb instead of applyTokenRules.
//
// Options:
//   preserveSigns {boolean} — when true, "-" and "+" are never stripped by the
//     single-char xwords charRx step even if they appear in xwordSet.
//     Use this for match type "c" (compound marker) rows in combnames, where
//     the signs are part of the canonical token form (e.g. "tim-3+ pd-1+").
export function makeCombTokenizer(xwordSet, { preserveSigns = false } = {}) {
  const wordSet = (xwordSet && xwordSet.size > 0)
    ? new Set([...xwordSet])
    : new Set();
  let singleChars = (xwordSet && xwordSet.size > 0)
    ? [...xwordSet].filter(w => w.length === 1).join('')
    : '';
  if (preserveSigns) {
    // Remove - and + from the chars-to-split set so they survive into applyTokenRulesComb
    singleChars = singleChars.replace(/[-+]/g, '');
  }
  let charRx = null;
  if (singleChars.length > 0) {
    const esc = singleChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    charRx = new RegExp(`([${esc}])`, 'g');
  }
  return (s) => {
    const s2 = s.replace(/['']/g, "'");
    let result = charRx ? s2.replace(charRx, ' $1 ') : s2;
    result = applyTokenRulesComb(result);
    result = result.split(' ').filter(Boolean).map(preNormToken).map(stemPlural).join(' ');
    result = result.toLowerCase();
    const tokens = result.split(' ').filter(Boolean);
    const stripped = wordSet.size > 0 ? tokens.filter(t => !wordSet.has(t)) : tokens;
    return (stripped.length > 0 ? stripped : tokens).map(normalizeToken).join(' ');
  };
}

// ── Conflict comparison key ───────────────────────────────────────────────────
// Returns the canonical key to use when comparing a stored normalized value for
// conflict detection.  makeNormalizer always lowercases, so for every table except
// exactliteral the stored normalized is already lowercase — use it verbatim.
// For exactliteral with a literal match ('l', 'lf', 'il', …) the normalized is
// stored verbatim (original case) and comparison must be case-sensitive, so again
// return it verbatim.  In both cases the answer is the same: just return normalized
// as-is — never apply an extra toLowerCase().
export function conflictKey(tokenized) {
  return tokenized;
}

// ── ExactLiteral Phase-2 normalization ────────────────────────────────────────
// Match semantics (mirrors MedScan runtime):
//   match includes 'l' (e.g. 'l', 'lf', 'il') → verbatim original case (case-sensitive)
//   all other match values, or no match        → full normalizer pipeline, no xwords filtering
//
// MedScan DOES normalise non-literal exactliteral aliases (split, apply rules, stem,
// normalise) but skips xword stop-word removal.  So "fish tape worms" normalises to
// "fish tape worm" and conflicts with "fish tape worm".
//
// Implementation: reuse makeNormalizer with an empty xword set so all pipeline steps
// run (applyTokenRules, stemPlural, normalizeToken) but nothing is filtered.
// The normalizer is created lazily and cached.
let _exactLitNonLiteralNormalizer = null;

export function exactLiteralTokenized(alias, matchFlag) {
  if ((matchFlag || '').includes('l')) return alias;   // literal: verbatim
  if (!_exactLitNonLiteralNormalizer) {
    _exactLitNonLiteralNormalizer = makeNormalizer(new Set(), { stemming: true });
  }
  return _exactLitNonLiteralNormalizer(alias);
}

// ── Tokenizer factory (Phase-1) ───────────────────────────────────────────────
// Produces a Phase-1 tokenizer that applies the same split steps as makeNormalizer
// (charRx punctuation expansion → applyTokenRules → lowercase → xwords filter)
// but STOPS before Phase-2 normalization (preNormToken, stemPlural,
// normalizeToken / _staticNorm / WORD_NORMS).
//
// Output is stored in the 'tokenized' DB column.
// This is the "direct string comparison" form: tokens are split and xwords-filtered
// but not yet stemmed or spelling-normalised.
//
// Greek → Latin conversion is a renderer/duplicateCheck concern; callers that need
// it should apply convertGreekToLatin() first.
//
// @param {Set<string>|null} xwordSet        Table xwords — controls token filtering.
// @param {object}           [opts]
// @param {Set<string>|null} [opts.separatorSet]  Union single-char xwords across all
//   tables (same semantics as in makeNormalizer).  Defaults to xwordSet.
// @returns {(alias: string) => string}
export function makeTokenizer(xwordSet, { separatorSet = null } = {}) {
  const wordSet   = xwordSet && xwordSet.size > 0 ? new Set([...xwordSet]) : new Set();
  const sepSource = separatorSet ?? xwordSet;
  const singleChars = sepSource && sepSource.size > 0
    ? [...sepSource].filter(w => w.length === 1).join('')
    : '';
  let charRx = null;
  if (singleChars.length > 0) {
    const esc = singleChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    charRx = new RegExp(`([${esc}])`, 'g');
  }
  return (s) => {
    const s2 = s.replace(/['']/g, "'");
    let result = charRx ? s2.replace(charRx, ' $1 ') : s2;  // same punctuation split as makeNormalizer
    result = applyTokenRules(result);                         // same prefix-merge rules
    result = result.toLowerCase();
    const tokens = result.split(/\s+/).filter(Boolean);
    const stripped = wordSet.size > 0 ? tokens.filter(t => !wordSet.has(t)) : tokens;
    return (stripped.length > 0 ? stripped : tokens).join(' ');
  };
}

// ── Phase-2 normalizer alias ──────────────────────────────────────────────────
// makePhase2Tokenizer = makeNormalizer (full pipeline: Phase-1 split/filter steps
// PLUS preNormToken → stemPlural → normalizeToken/_staticNorm/WORD_NORMS).
// Exported for call-sites that want to be explicit about the phase.
export const makePhase2Tokenizer = makeNormalizer;

// ── xwords table per dictionary table ────────────────────────────────────────
// Maps each dict table to the xwords table used to build its tokenizer.
// Tables absent from this map use no xwords (plain tokenization).
export const TABLE_XWORDS = {
  curnames:       'xwords',
  // keywords is intentionally absent — Medscan uses keywords as-is, no tokenization
  userdict:       'xwords',
  celldictionary: 'xwords_cells',
  casdictionary:  'xwords_cas',
  chemnames:      'xwords_cas',
  combnames:      'xwords_comb',
  // exactliteral: verbatim — bypasses makeNormalizer/makeTokenizer (handled inline)
};

// ── All xwords service tables (for loading the separator union) ───────────────
export const ALL_XWORDS_TABLES = ['xwords', 'xwords_cells', 'xwords_cas', 'xwords_comb'];

// ── Compute the global separator set ─────────────────────────────────────────
// Call with a Map/object of { tableName → Set<string> } covering all xwords tables.
// Returns a Set of every single-char entry across all of them.
// This is the charRx source for makeTokenizer: a char in the union is always split
// into its own token; whether it stays or is filtered depends on the per-table xwordSet.
export function buildSeparatorSet(xwordsByTable) {
  const result = new Set();
  for (const xwSet of Object.values(xwordsByTable)) {
    for (const w of xwSet) {
      if (w.length === 1) result.add(w);
    }
  }
  return result;
}

// ── Greek → Latin conversion ──────────────────────────────────────────────────
// Exported here so both the renderer and main process use the identical mapping,
// ensuring tokenization is consistent regardless of which side is normalizing.
const GREEK_TO_LATIN = {
  'α':'alpha','β':'beta','γ':'gamma','δ':'delta','ε':'epsilon',
  'ζ':'zeta','η':'eta','θ':'theta','ι':'iota','κ':'kappa',
  'λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','ο':'omicron',
  'π':'pi','ρ':'rho','σ':'sigma','ς':'sigma','τ':'tau',
  'υ':'upsilon','φ':'phi','χ':'chi','ψ':'psi','ω':'omega',
  'Α':'alpha','Β':'beta','Γ':'gamma','Δ':'delta','Ε':'epsilon',
  'Ζ':'zeta','Η':'eta','Θ':'theta','Ι':'iota','Κ':'kappa',
  'Λ':'lambda','Μ':'mu','Ν':'nu','Ξ':'xi','Ο':'omicron',
  'Π':'pi','Ρ':'rho','Σ':'sigma','Τ':'tau','Υ':'upsilon',
  'Φ':'phi','Χ':'chi','Ψ':'psi','Ω':'omega',
};
const GREEK_RX = new RegExp(
  Object.keys(GREEK_TO_LATIN).map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g'
);
export function convertGreekToLatin(s) {
  return typeof s === 'string' ? s.replace(GREEK_RX, c => GREEK_TO_LATIN[c] ?? c) : s;
}

// ── Canonical per-table normalization (synchronous, xwords pre-loaded) ────────
// This is the single source of truth for Phase-2 normalization.
// Both the renderer (normalizeForTable in duplicateCheck.js) and the main process
// (db:retokenize) must call this function so the stored `normalized` column always
// matches what the search computes.
//
// @param {string}  alias       Original alias string (pre-normalization).
// @param {string}  tableName   Target dictionary table.
// @param {object}  xwMap       { xwords, xwords_cells, xwords_cas, xwords_comb } — each a Set<string>.
// @param {Set}     sepSet      Global separator set (union of all single-char xwords).
// @param {string}  [matchFlag] Match flag (used by combnames to preserve +/- signs).
// @returns {string}  The normalized form to store in the `normalized` column.
export function normalizeForTableSync(alias, tableName, xwMap, sepSet, matchFlag = '') {
  // Greek → Latin pre-step applied everywhere so "α4" and "alpha4" normalise identically.
  const gl = convertGreekToLatin(alias);

  switch (tableName) {
    case 'exactliteral':
    case 'rsmap':
    case 'chemnames':
      return gl.toLowerCase();

    case 'celldictionary': {
      const xwSet = xwMap['xwords_cells'] || new Set();
      const tok = makeTokenizer(xwSet, { separatorSet: sepSet });
      const tokenized = tok(gl);
      return makeNormalizer(xwSet, { stemming: true, separatorSet: sepSet })(tokenized, gl);
    }

    case 'casdictionary': {
      // Chemical spelling normalisations before tokenization (casdictionary only).
      // Matches MedScan's own normalisation rules:
      //   sulph→sulf  : sulphate→sulfate, disulphide→disulfide, etc.
      //   stearyl→stearoyl : fatty-acid acyl-group normalisation (MedScan SS warnings)
      const glCas = gl.replace(/sulph/gi, 'sulf').replace(/stearyl/gi, 'stearoyl');
      const xwSet = xwMap['xwords_cas'] || new Set();
      const tok = makeTokenizer(xwSet, { separatorSet: sepSet });
      const tokenized = tok(glCas);
      return makeNormalizer(xwSet, { stemming: false, separatorSet: sepSet })(tokenized, glCas);
    }

    case 'combnames': {
      const xwSet = xwMap['xwords_comb'] || new Set();
      const preserveSigns = (matchFlag || '') === 'c';
      const tok = makeCombTokenizer(xwSet, { preserveSigns, separatorSet: sepSet });
      const tokenized = tok(gl);
      return tok(tokenized);
    }

    default: { // curnames, userdict, keywords
      const xwSet = xwMap['xwords'] || new Set();
      const tok = makeTokenizer(xwSet, { separatorSet: sepSet });
      const tokenized = tok(gl);
      return makeNormalizer(xwSet, { stemming: true, separatorSet: sepSet })(tokenized, gl);
    }
  }
}

// ── Canonical Phase-1 tokenization (synchronous, xwords pre-loaded) ───────────
// Mirrors normalizeForTableSync but returns the Phase-1 (tokenized column) form.
export function tokenizeForTableSync(alias, tableName, xwMap, sepSet, matchFlag = '') {
  const gl = convertGreekToLatin(alias);
  switch (tableName) {
    case 'exactliteral':
    case 'rsmap':
    case 'chemnames':
      return gl.toLowerCase();
    case 'celldictionary': {
      const xwSet = xwMap['xwords_cells'] || new Set();
      return makeTokenizer(xwSet, { separatorSet: sepSet })(gl);
    }
    case 'casdictionary': {
      const glCas = gl.replace(/sulph/gi, 'sulf').replace(/stearyl/gi, 'stearoyl');
      const xwSet = xwMap['xwords_cas'] || new Set();
      return makeTokenizer(xwSet, { separatorSet: sepSet })(glCas);
    }
    case 'combnames': {
      const xwSet = xwMap['xwords_comb'] || new Set();
      const preserveSigns = (matchFlag || '') === 'c';
      return makeCombTokenizer(xwSet, { preserveSigns, separatorSet: sepSet })(gl);
    }
    default: {
      const xwSet = xwMap['xwords'] || new Set();
      return makeTokenizer(xwSet, { separatorSet: sepSet })(gl);
    }
  }
}

// ── Alias length rule (single source of truth) ───────────────────────────────
// An alias is SHORT when it has fewer than 6 letters/digits — separators (hyphen, space, punctuation)
// do not count, e.g. "ML-297" = 5 → short. Short aliases go to ExactLiteral (match 'l') and are never
// checked against chemNames; longer aliases go to the entity's dictionary (curnames / casdictionary / …).
export function isShortAlias(alias) {
  return ((String(alias ?? '').match(/[\p{L}\p{N}]/gu)) || []).length < 6;
}

// ── One entry point: tokenize / normalize an alias for a dictionary table ───────
// tokenizeAlias(alias, table) / normalizeAlias(alias, table) pick the right xwords table for the
// dictionary (curnames/userdict → xwords, celldictionary → xwords_cells, casdictionary → xwords_cas,
// combnames → xwords_comb; exactliteral is verbatim/lower-case) and the global separator set, and they
// LOAD those xwords themselves the first time (and only cache a successful, non-empty load).
// Callers never have to pass or pre-load xwords, so no screen can silently tokenize without them.
//
// The environment registers ONE loader (the renderer does it in shared/duplicateCheck.js):
//   setXwordsLoader(async () => ({ sets: { xwords: Set, xwords_cells: Set, xwords_cas: Set, xwords_comb: Set },
//                                  spelling: Map<variant, canonical> | null }))
let _xwordsLoader = null;
let _xwordsState  = null;   // { xwMap, sepSet } once loaded
let _xwordsLoading = null;

export function setXwordsLoader(fn) { _xwordsLoader = fn; }

export async function ensureXwordsLoaded(force = false) {
  if (_xwordsState && !force) return _xwordsState;
  if (_xwordsLoading && !force) return _xwordsLoading;
  if (!_xwordsLoader) throw new Error('tokenizer: no xwords loader registered');
  _xwordsLoading = (async () => {
    const { sets, spelling } = await _xwordsLoader();
    const xwMap = {
      xwords:       sets.xwords       || new Set(),
      xwords_cells: sets.xwords_cells || new Set(),
      xwords_cas:   sets.xwords_cas   || new Set(),
      xwords_comb:  sets.xwords_comb  || new Set(),
    };
    if (spelling && spelling.size > 0) setSpellingMap(spelling);
    const state = { xwMap, sepSet: buildSeparatorSet(xwMap) };
    const total = Object.values(xwMap).reduce((n, s) => n + s.size, 0);
    if (total > 0) _xwordsState = state;           // never cache an empty / failed load
    return state;
  })().finally(() => { _xwordsLoading = null; });
  return _xwordsLoading;
}

/** Already-loaded xwords (sync), or null. */
export function getLoadedXwords() { return _xwordsState; }

export async function tokenizeAlias(alias, table, matchFlag = '') {
  const { xwMap, sepSet } = await ensureXwordsLoaded();
  return tokenizeForTableSync(alias, table, xwMap, sepSet, matchFlag);
}
export async function normalizeAlias(alias, table, matchFlag = '') {
  const { xwMap, sepSet } = await ensureXwordsLoaded();
  return normalizeForTableSync(alias, table, xwMap, sepSet, matchFlag);
}

/** Sync variants — only valid after ensureXwordsLoaded(); they THROW instead of tokenizing without xwords. */
export function tokenizeAliasSync(alias, table, matchFlag = '') {
  if (!_xwordsState) throw new Error('xwords are not loaded — call await ensureXwordsLoaded() first');
  return tokenizeForTableSync(alias, table, _xwordsState.xwMap, _xwordsState.sepSet, matchFlag);
}
export function normalizeAliasSync(alias, table, matchFlag = '') {
  if (!_xwordsState) throw new Error('xwords are not loaded — call await ensureXwordsLoaded() first');
  return normalizeForTableSync(alias, table, _xwordsState.xwMap, _xwordsState.sepSet, matchFlag);
}
