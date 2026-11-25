// "Consolidate patterns": patterns of one set that do not contradict each other are merged into one more relaxed pattern.
// A pattern is a sequence of elements:  @regulator @target (entities) · $ACT · @.{0,N} (gap) · [a b c] (word set) · $MACRO · [^$NOT]{0,20} (negation guard) · a word · "a phrase" · ( … ) (a group)
// Two patterns merge when
//   1. their anchors (entities and $ACT) are the same, in the same order — the stretches between the anchors are merged one by one;
//   2. in a stretch, elements of the same kind are paired (in order) and combined: gaps take the widest bounds, word sets are united (x and x~ → x~),
//      a negation guard must be the same set on both sides (it is only ever merged with itself, never with a plain gap);
//   3. an element that only one of the patterns has is inserted as optional (a gap by min 0, a word set / macro / word by "?") — but the merged stretch must keep a required
//      word / word set / macro whenever one of the originals had one, so a merged pattern never loses its verb.
// The only changes are therefore a longer combined pattern and optional elements — nothing that one of the originals would have refused is made impossible, and nothing is renamed.
// Anything the parser does not understand (a group, a wildcard like @$ or @.*, a comment) is never changed: such patterns stay as they are.

const QUANT = '(?:[?*+]|\\{\\d+(?:,\\d*)?\\})\\??';
const RE_QUANT_AT = new RegExp('^' + QUANT);
const RE_ENTITY = /^(?:@(?:regulator|target|in|out)|%[A-Za-z]\w*)$/;       // @regulator / @target of a pattern set, or a variable (%a %c %t) of a rule written in the rule file
const RE_GAP = /^@\.\{(\d+),(\d+)\}(\??)$/;
const RE_GUARD = new RegExp('^\\[\\^([\\s\\S]*)\\](\\{\\d+(?:,\\d+)?\\})$');
const RE_WORDSET = new RegExp('^\\[([\\s\\S]*)\\](' + QUANT + ')?$');
const RE_MACRO = new RegExp('^(\\$[A-Za-z_]\\w*)(' + QUANT + ')?$');
const RE_ITEMS = /"[^"]*"~?|\S+/g;

/** index of the bracket closing the one at `open` (quotes skipped); -1 if none */
function closeOf(s, open) {
  const o = s[open], c = { '(': ')', '[': ']', '{': '}' }[o];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '"') { const e = s.indexOf('"', i + 1); if (e < 0) return -1; i = e; continue; }
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** Splits a pattern body at the | outside brackets and quotes → trimmed alternatives; null when the body has comments (those are not touched) */
export function splitAlternatives(body) {
  if (/\/\/|\/\*/.test(body.replace(/"[^"]*"/g, '""'))) return null;
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') { const e = body.indexOf('"', i + 1); if (e < 0) return null; i = e; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '|' && depth === 0) { out.push(body.slice(from, i).trim()); from = i + 1; }
  }
  out.push(body.slice(from).trim());
  return out.filter(Boolean);
}

/** the elements of one pattern: [{ kind, text, … }] or null when something cannot be read */
export function readElements(src) {
  const els = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (/\s/.test(src[i])) { i++; continue; }
    const c = src[i];
    let j = i;
    if (c === '[' || c === '(') { j = closeOf(src, i); if (j < 0) return null; j++; const q = RE_QUANT_AT.exec(src.slice(j)); if (q) j += q[0].length; }
    else if (c === '"') { j = src.indexOf('"', i + 1); if (j < 0) return null; j++; const q = /^~?/.exec(src.slice(j)); j += q[0].length; const q2 = RE_QUANT_AT.exec(src.slice(j)); if (q2) j += q2[0].length; }
    else { while (j < n && !/\s/.test(src[j]) && src[j] !== '[' && src[j] !== '(') j++; if (j === i) return null; }
    els.push(classify(src.slice(i, j)));
    i = j;
  }
  return els;
}

function classify(t) {
  let m;
  if (RE_ENTITY.test(t)) return { kind: 'anchor', text: t };
  if (t === '$ACT') return { kind: 'anchor', text: t };
  if ((m = RE_GAP.exec(t))) return { kind: 'gap', min: +m[1], max: +m[2], opt: m[3] === '?', text: t };
  if ((m = RE_GUARD.exec(t))) return { kind: 'guard', items: m[1].match(RE_ITEMS) || [], range: m[2], text: t };
  if (t[0] === '[' && t[1] !== '^' && (m = RE_WORDSET.exec(t))) return { kind: 'wordset', items: m[1].match(RE_ITEMS) || [], q: m[2] || '', text: t };
  if ((m = RE_MACRO.exec(t))) return { kind: 'macro', name: m[1], q: m[2] || '', text: t };
  if (/^@(?:\$|\^|\.)/.test(t) || t[0] === '(' || t[0] === '[') return { kind: 'opaque', text: t, unsafe: true };       // a wildcard, a group, a set we cannot read: never changed
  return { kind: 'word', text: t };                                                                                         // a word / a quoted phrase
}

const stemmed = (it) => it.replace(/"/g, '');
const covers = (a, b) => a === b || (a.endsWith('~') && !b.endsWith('~') && stemmed(a).slice(0, -1) === stemmed(b));     // release~ covers release
const overlap = (A, B) => A.some(a => B.some(b => covers(a, b) || covers(b, a)));
const unite = (A, B) => {
  const all = [...A];
  for (const b of B) if (!all.some(a => covers(a, b))) { const k = all.findIndex(a => covers(b, a)); if (k >= 0) all[k] = b; else all.push(b); }
  return all.filter((a, k) => !all.some((x, kk) => kk !== k && x !== a && covers(x, a)));
};
const sameSet = (A, B) => A.length === B.length && A.every(a => B.includes(a));
const isOptional = (q) => /^[?*]/.test(q) || /^\{0/.test(q);

// can a (from the first pattern) and b (from the second) be one element? → score (0 = no)
function pairScore(a, b, sole) {
  if (a.kind !== b.kind) return 0;
  switch (a.kind) {
    case 'gap': return 2;
    case 'wordset': return a.q !== b.q ? 0 : overlap(a.items, b.items) ? 4 : sole ? 3 : 0;
    case 'macro': return a.name === b.name && a.q === b.q ? 4 : 0;
    case 'guard': return sameSet(a.items, b.items) ? 4 : 0;
    case 'word': return a.text === b.text ? 4 : 0;
    default: return 0;
  }
}
const joinPair = (a, b) => {
  switch (a.kind) {
    case 'gap': return { ...classify(`@.{${Math.min(a.min, b.min)},${Math.max(a.max, b.max)}}${a.opt && b.opt ? '?' : ''}`) };
    case 'wordset': return classify('[' + unite(a.items, b.items).join(' ') + ']' + a.q);
    case 'guard': { const r = (x) => (x.range.match(/\d+/g) || []).map(Number); const [a1, a2 = a1] = r(a), [b1, b2 = b1] = r(b); return classify('[^' + a.items.join(' ') + ']{' + Math.min(a1, b1) + ',' + Math.max(a2, b2) + '}'); }
    default: return a;
  }
};
// an element only one pattern has: made optional; null when that cannot be done safely
function optional(e) {
  switch (e.kind) {
    case 'gap': return classify(`@.{0,${e.max}}${e.opt ? '?' : ''}`);
    case 'wordset': return e.q === '' ? classify(e.text + '?') : isOptional(e.q) ? e : null;
    case 'macro': return e.q === '' ? classify(e.text + '?') : isOptional(e.q) ? e : null;
    case 'word': return classify(e.text + '?');
    default: return null;                                                    // a guard (protection against negation) or something unknown is never made optional
  }
}

// two stretches between the same anchors → one, or null
function mergeStretch(A, B) {
  if (A.some(e => e.kind === 'opaque') || B.some(e => e.kind === 'opaque')) return null;
  const nonGap = (S) => S.filter(e => e.kind !== 'gap');
  const sole = nonGap(A).length === 1 && nonGap(B).length === 1;
  const n = A.length, m = B.length;
  const sc = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const pair = (i, j) => pairScore(A[i], B[j], sole);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const p = pair(i, j);
    sc[i][j] = Math.max(sc[i + 1][j], sc[i][j + 1], p ? p + sc[i + 1][j + 1] : 0);
  }
  const out = [];
  let i = 0, j = 0;
  const only = (e) => { const o = optional(e); if (!o) return false; out.push(o); return true; };
  while (i < n || j < m) {
    const p = i < n && j < m ? pair(i, j) : 0;
    if (p && sc[i][j] === p + sc[i + 1][j + 1]) { out.push(joinPair(A[i], B[j])); i++; j++; }
    else if (i < n && (j >= m || sc[i][j] === sc[i + 1][j])) { if (!only(A[i++])) return null; }
    else { if (!only(B[j++])) return null; }
  }
  // the relation words must survive: when either pattern has a required word / word set / macro between the anchors, the merged stretch must still have one
  // (else the merged pattern would match with no verb at all)
  const required = (S) => S.some(e => (e.kind === 'wordset' || e.kind === 'macro' || e.kind === 'word') && !/\?$/.test(e.text) && !(e.q && isOptional(e.q)));
  if ((required(A) || required(B)) && !required(out)) return null;
  // two gaps next to each other are one gap
  const res = [];
  for (const e of out) {
    const l = res[res.length - 1];
    if (l && l.kind === 'gap' && e.kind === 'gap') res[res.length - 1] = classify(`@.{${l.min + e.min},${l.max + e.max}}${l.opt && e.opt ? '?' : ''}`);
    else res.push(e);
  }
  return res;
}

const stretches = (els) => { const anchors = [], parts = [[]]; for (const e of els) { if (e.kind === 'anchor') { anchors.push(e.text); parts.push([]); } else parts[parts.length - 1].push(e); } return { anchors, parts }; };
const textOf = (els) => els.map(e => e.text).join(' ');

/** two patterns (element lists) → the merged element list, or null when they contradict */
export function mergeElements(A, B) {
  const a = stretches(A), b = stretches(B);
  if (a.anchors.join('|') !== b.anchors.join('|') || a.anchors.length < 2) return null;     // different (or too few) anchors: not the same kind of pattern
  const out = [];
  for (let k = 0; k <= a.anchors.length; k++) {
    const m = mergeStretch(a.parts[k], b.parts[k]);
    if (!m) return null;
    out.push(...m);
    if (k < a.anchors.length) out.push({ kind: 'anchor', text: a.anchors[k] });
  }
  return out;
}

/**
 * The alternatives of one pattern set → { out: [text], groups: [{ members: [index…], text, merged }] }.
 * Greedy: each pattern joins the first group it does not contradict. A pattern that cannot be read stays alone and unchanged.
 */
export function consolidateAlternatives(alts) {
  const groups = [];
  alts.forEach((src, idx) => {
    const els = readElements(src);
    const safe = els && els.length && !els.some(e => e.kind === 'opaque');
    if (safe) for (const g of groups) {
      if (!g.els) continue;
      const m = mergeElements(g.els, els);
      if (m) { g.els = m; g.members.push(idx); g.merged = true; return; }
    }
    groups.push({ members: [idx], els: safe ? els : null, src, merged: false });
  });
  for (const g of groups) g.text = g.els && g.members.length > 1 ? textOf(g.els) : g.src;
  // a group of identical patterns only is not a merge
  for (const g of groups) if (g.members.length > 1 && g.members.every(i => alts[i].replace(/\s+/g, ' ') === alts[g.members[0]].replace(/\s+/g, ' '))) g.merged = false;
  return { out: groups.map(g => g.text), groups: groups.map(({ members, text, merged }) => ({ members, text, merged })) };
}
