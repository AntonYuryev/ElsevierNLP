// Reader screen: everything between "a document in the DOM" and "the NLP markup of its text shown as highlights".
//
//   collectBlocks / collectPdfBlocks   the text of the document as blocks (a paragraph, a list item, a heading …) with the way back to the DOM text nodes
//   makeChunks                         the blocks cut into pieces of text for the pipelines
//   parseCsSentences / parseRelations  the pipeline outputs: the marked-up sentences (ID{ids=text}) and the extracted relations
//   alignChunk                         where every entity / relation sentence of a chunk is in the blocks
//   applyAnnotations                   the highlights and underlines put into the DOM (undo() takes them out again)
import { NODE_TYPE_RANGES } from '../../shared/entityTypes';
import { effectArrow, effectColor } from './effectArrow';

// ── entity types and their highlight colours (RGB) ─────────────────────────────────────────────────────────────
export const ENTITY_RGB = {
  Protein: [211, 47, 47], SmallMol: [0, 200, 83], Treatment: [21, 101, 192], Disease: [204, 85, 0], CellProcess: [249, 168, 37],
  FunctionalClass: [230, 81, 0], Complex: [127, 0, 0], CellObject: [117, 117, 117], Tissue: [109, 76, 65], Organ: [74, 20, 140],
  CellType: [129, 212, 250], Cell: [129, 212, 250], GeneticVariant: [255, 109, 0], ClinicalParameter: [92, 107, 192],
  MedicalProcedure: [93, 214, 197], Pathogen: [97, 222, 42], Virus: [181, 191, 80], ChemicalReaction: [33, 33, 33],
};
export const DEFAULT_RGB = [158, 158, 158];                     // a type that is not in the table (Organism, CellLine …)
export const rgbOf = (type) => ENTITY_RGB[type] || DEFAULT_RGB;
export const TYPE_ORDER = ['Protein', 'SmallMol', 'Treatment', 'Disease', 'CellProcess', 'FunctionalClass', 'Complex', 'CellObject', 'Tissue', 'Organ', 'CellType', 'GeneticVariant', 'ClinicalParameter', 'MedicalProcedure', 'Pathogen', 'Virus', 'ChemicalReaction'];

const NAME_OF_MILLION = Object.fromEntries(NODE_TYPE_RANGES.map(([n, m]) => [m, n]));

/** { type, key } of the ids of an ID{…} markup: the node type comes from the ID range of the first real id (0 and the range starts 9000000 … are not entities) */
export function entityOfIds(ids) {
  const nums = ids.map(s => Number(String(s).trim())).filter(n => Number.isFinite(n));
  const real = nums.filter(n => n !== 0 && n % 1e6 !== 0);
  const pick = real.length ? real[0] : (nums.find(n => n > 0) ?? 0);
  return { type: NAME_OF_MILLION[Math.floor(pick / 1e6)] || 'Entity', key: [...new Set(real.length ? real : [pick])].sort((a, b) => a - b).join(',') };
}

// ── the pipeline outputs ───────────────────────────────────────────────────────────────────────────────────────
/** "In ID{9000000,9012750=lung cancer}, the …" → { plain: "In lung cancer, the …", ents: [{ start, end, surface, markup, ids, type, key }] } (offsets in plain) */
export function parseMsrc(msrc0) {
  // the markers at the end of a sentence (CONTEXT{tissue ids}, GLOSSARY{variant names}) are not words of it: with them the sentence is not found on the page (its end is searched for)
  // and the ranges of the sentences overlap
  const msrc = String(msrc0 || '').replace(/\s*(?:GLOSSARY|CONTEXT)\{[^}]*\}/g, '');
  const re = /ID\{([^=}]*)=([^}]*)\}/g;
  let plain = '', last = 0, m;
  const ents = [];
  while ((m = re.exec(msrc)) !== null) {
    plain += msrc.slice(last, m.index);
    const surface = m[2];
    const ids = m[1].split(',').map(s => s.trim());
    ents.push({ start: plain.length, end: plain.length + surface.length, surface, markup: m[0], ids, ...entityOfIds(ids) });
    plain += surface;
    last = m.index + m[0].length;
  }
  plain += msrc.slice(last);
  return { plain, ents };
}
/** the marked-up sentences (msrc lines) of a ConceptScan / MedScan output */
export function parseCsSentences(out) {
  const res = [];
  for (const line of String(out || '').split(/\r?\n/)) if (line.startsWith('msrc\t')) res.push(parseMsrc(line.slice(5)));
  return res;
}

// ── the semantic triples (the lines "<\t#Main  NP1 & verb  NP2" of a ConceptScan output) ──────────────────────────
/** "ID{1=IRF3} agonist" → "IRF3 agonist" */
export const stripIds = (s) => String(s || '').replace(/ID\{[^=}]*=([^}]*)\}/g, '$1').replace(/\s+/g, ' ').trim();
/** one triple line (without the "<\t"): "#Main  NP1 & verb  NP2" → { tag, np1, pred, np2 } (np1 / np2 keep their ID{ids=text} markup) */
function parseTriple(s) {
  let depth = 0, at = -1;
  for (let i = 0; i < s.length; i++) {                       // the first "&" outside an ID{…}
    const c = s[i];
    if (c === '{') depth++; else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '&' && !depth) { at = i; break; }
  }
  if (at < 0) return null;
  let left = s.slice(0, at).trim();
  const right = /^(\S+)\s*([\s\S]*)$/.exec(s.slice(at + 1).trim());
  if (!right) return null;
  const tag = (/^(#\w+)\s*/.exec(left) || [, ''])[1];
  if (tag) left = left.slice(tag.length).trim();
  const t = { tag: tag.replace(/^#/, ''), np1: left, pred: right[1], np2: right[2].trim() };
  // the same triple from two cartridges differs in spacing ("(SREBP-1c)" / "( SREBP-1c )"): the key has letters and digits only
  const flat = (x) => stripIds(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  t.key = [flat(t.np1), flat(t.pred), flat(t.np2)].join('|');
  return t;
}
/** the records of the triples of a ConceptScan output (see readerTriples in main.js) → [{ bi (block), plain (the sentence), mods, triples: [{ tag, np1, pred, np2, key }] }] */
export function parseTriples(cs) {
  const out = [];
  let cur = null;
  for (const line of String(cs || '').split(/\r?\n/)) {
    if (line.startsWith('mref\t')) { cur = { bi: -1, mods: [], plain: '', triples: [] }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('TextRef\t')) cur.bi = blockOfTextRef(line.slice(8));
    else if (line.startsWith('TextMods\t')) cur.mods.push(...parseTextMods(line.slice(9)));
    else if (line.startsWith('msrc\t')) cur.plain = parseMsrc(line.slice(5)).plain;
    else if (line.startsWith('<\t')) { const t = parseTriple(line.slice(2)); if (t) cur.triples.push(t); }
  }
  return out.filter(r => r.plain && r.triples.length);
}

// properties of a relation that are not shown in its symbolic form
const NOISE = new Set(['controltype', 'effect', 'msrc', 'mref', 'textmods', 'textref', 'source', 'sentence', 'medline', 'pubmed', 'doi', 'title', 'journal', 'url', 'sentencetext']);
/** the relations of an RNEF output → [{ type, effect, props: [[name, value]], regs, tgts, both, msrc (marked sentence) }] (one entry per sentence the relation was found in) */
export function parseRelations(xml) {
  const out = [];
  if (!xml || !xml.includes('<')) return out;
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (_) { return out; }
  if (doc.getElementsByTagName('parsererror').length) return out;
  for (const resnet of Array.from(doc.getElementsByTagName('resnet'))) {
    const nodes = new Map();
    for (const n of Array.from(resnet.getElementsByTagName('node'))) {
      const id = n.getAttribute('local_id') || n.getAttribute('id') || '';
      let type = '', name = '';
      for (const a of Array.from(n.getElementsByTagName('attr'))) { const an = a.getAttribute('name'); if (an === 'NodeType') type = a.getAttribute('value') || ''; else if (an === 'Name') name = a.getAttribute('value') || ''; }
      nodes.set(id, { label: `${type || '?'}:(${name})`, urn: n.getAttribute('urn') || '' });
    }
    const resMsrc = resnet.getAttribute('msrc') || '';
    for (const ctrl of [...Array.from(resnet.getElementsByTagName('control')), ...Array.from(resnet.getElementsByTagName('relation'))]) {
      const attrs = Array.from(ctrl.getElementsByTagName('attr'));
      let type = '', effect = '';
      const props = [], msrcs = [], refs = {};                      // refs: TextRef by the index of its msrc
      const modsText = [];
      for (const a of attrs) {
        const an = a.getAttribute('name') || '', val = a.getAttribute('value') || '';
        if (an === 'msrc') { msrcs.push({ idx: a.getAttribute('index') || '1', val }); continue; }
        if (an === 'TextRef') { refs[a.getAttribute('index') || '1'] = val; continue; }
        if (an === 'TextMods') { modsText.push(val); continue; }
        if (a.getAttribute('index')) continue;
        if (an === 'ControlType') type = val; else if (an === 'Effect') effect = val;
        else if (!NOISE.has(an.toLowerCase()) && val && val.length <= 80) props.push([an, val]);
      }
      const links = Array.from(ctrl.getElementsByTagName('link'));
      // the participants: one per node (two nodes of one relation can have the same name — an entity associated with itself, FCR … FCR — both are shown)
      const linkedNodes = (t) => [...new Set(links.filter(l => l.getAttribute('type') === t).map(l => l.getAttribute('ref') || ''))].map(ref => nodes.get(ref)).filter(Boolean);
      const regN = linkedNodes('in'), tgtN = linkedNodes('out'), bothN = linkedNodes('in-out');
      const regs = regN.map(n => n.label), tgts = tgtN.map(n => n.label), both = bothN.map(n => n.label);
      const regUrns = regN.map(n => n.urn), tgtUrns = tgtN.map(n => n.urn), bothUrns = bothN.map(n => n.urn);
      if (!regs.length && !tgts.length && !both.length) continue;
      for (const m of (msrcs.length ? msrcs : [{ idx: '1', val: resMsrc }]).filter(x => x.val)) out.push({ type: type || 'relation', effect, props, regs, tgts, both, regUrns, tgtUrns, bothUrns, msrc: m.val, textRef: refs[m.idx] || refs['1'] || '', mods: parseTextMods(modsText.join(' ')) });
    }
  }
  return out;
}
/** Regulator -[RelationType]-+> Target (Mechanism: …; ChangeType: …)  as text parts: [{ t, color? }] (--| red for a negative Effect, -+> green for a positive one, → for an unknown Effect) */
export function relationParts(r) {
  const arrow = effectArrow(r.effect), color = effectColor(r.effect);
  const parts = [];
  if (r.regs.length || r.tgts.length) {
    parts.push({ t: r.regs.join(' + ') + ' ' });
    parts.push({ t: '-[' + r.type + ']' });
    parts.push({ t: arrow === '→' ? '→' : arrow, color, bold: true });
    parts.push({ t: ' ' + r.tgts.join(' + ') });
  } else if (r.both.length > 1) parts.push({ t: r.both.join(' -[' + r.type + ']- ') });                   // non-directional: A -[Type]- B
  else parts.push({ t: (r.both[0] || '?') + ' -[' + r.type + ']' });                                      // a relation with one participant: A -[Type]
  if (r.props.length) parts.push({ t: '  (' + r.props.map(([k, v]) => k + ': ' + v).join('; ') + ')' });
  return parts;
}
export const relationText = (r) => relationParts(r).map(p => p.t).join('');
/** a key that is the same for the same relation found by several cartridges / pattern folders */
export const relationKey = (r, plain) => [r.type, r.effect, r.regs.join('+'), r.tgts.join('+'), r.both.join('+'), r.props.map(p => p.join('=')).join(';'), plain.replace(/\W+/g, '').toLowerCase().slice(0, 80)].join('|');

// ── the text of the document as blocks ─────────────────────────────────────────────────────────────────────────
const INVISIBLE_RE = /[\u00ad\u200b-\u200d\u2060\ufeff]/;
// Typographic characters of publishers' pages written the plain way, for medscan and the LLM (code points, so that no invisible character stands in the source):
// hyphen / non-breaking hyphen / figure dash / en dash / minus → "-";  em dash / horizontal bar → " - ";  single quotes and primes → ';  double quotes and double primes → ";  ligatures → their letters
const FOLD = new Map();
const fold = (codes, to) => codes.forEach(c => FOLD.set(String.fromCharCode(c), to));
fold([0x2010, 0x2011, 0x2012, 0x2013, 0x2212, 0xfe63, 0xff0d], '-');
fold([0x2014, 0x2015], ' - ');
fold([0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x02bc, 0x2035, 0x00b4, 0x0060, 0x02b9, 0x02c8, 0xff07], "'");
fold([0x201c, 0x201d, 0x201e, 0x201f, 0x2033], '"');
fold([0xfb00], 'ff'); fold([0xfb01], 'fi'); fold([0xfb02], 'fl'); fold([0xfb03], 'ffi'); fold([0xfb04], 'ffl'); fold([0xfb05, 0xfb06], 'st');
/** soft hyphens / zero-width characters dropped, dashes / quotes / ligatures written plain, whitespace runs → one space, the ends trimmed; map[i] = index in raw of norm[i] */
export function normalize(raw) {
  let norm = '';
  const map = [];
  let prevSpace = true;
  for (let i = 0; i < raw.length; i++) {
    if (INVISIBLE_RE.test(raw[i])) continue;                                      // soft hyphens and zero-width characters are dropped ("PPAR\u00ADgamma" is the word PPARgamma); the positions still map back to raw
    for (const ch of (FOLD.get(raw[i]) || raw[i])) {                              // dashes, quotes and ligatures \u2192 plain ASCII (a ligature gives several characters: all of them map to its place in raw)
      if (/[\s\u00a0]/.test(ch)) { if (!prevSpace) { norm += ' '; map.push(i); prevSpace = true; } }
      else { norm += ch; map.push(i); prevSpace = false; }
    }
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); map.pop(); }
  return { norm, map };
}
function finishBlock(parts, extra = {}) {
  // parts: [{ node, pre }] — pre = text that is not in the node (a space for a <br> / a new line)
  let raw = '';
  const segs = [];
  for (const p of parts) {
    raw += p.pre || '';
    const rawStart = raw.length;
    raw += p.node.nodeValue;
    segs.push({ node: p.node, rawStart, rawEnd: raw.length });
  }
  const { norm, map } = normalize(raw);
  return { raw, norm, map, segs, ...extra };
}
const SKIP = 'script,style,noscript,template,head,svg,textarea,select,option,iframe,object,[hidden],[aria-hidden="true"][class*="sr-only"]';
/** the blocks of an HTML document: the text nodes of one block-level element (inline elements do not start a new block); invisible text is left out */
export function collectBlocks(doc, root, opts = {}) {
  const win = doc.defaultView;
  const disp = new Map();
  const display = (el) => { let d = disp.get(el); if (d === undefined) { try { const cs = win.getComputedStyle(el); d = cs.display === 'none' || cs.visibility === 'hidden' ? 'none' : cs.display; } catch (_) { d = 'block'; } disp.set(el, d); } return d; };
  const isInline = (d) => d === 'inline' || d === 'contents' || d.startsWith('ruby');
  const blockOf = (node) => {                            // → the block element, or null when the text is invisible
    for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      const d = display(el);
      if (d === 'none' && !opts.loose) return null;        // loose: the text of elements a page hides until its scripts show them is taken too
      if (!isInline(d === 'none' ? 'block' : d)) return el;
    }
    return root;
  };
  const blocks = new Map();
  const walker = doc.createTreeWalker(root, 1 | 4);       // elements and text
  const pendingBr = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) { if (n.tagName === 'BR' && n.parentElement) pendingBr.add(n.parentElement); continue; }
    const el = n.parentElement;
    if (!el || el.closest(SKIP)) continue;
    const b = blockOf(n);
    if (!b) continue;
    let rec = blocks.get(b);
    if (!rec) { rec = { el: b, parts: [] }; blocks.set(b, rec); }
    // a citation number in a superscript ("steatosis.<sup>44</sup> LXRα …") is not text of the sentence: left out, so that MedScan sees "steatosis. LXRα" and starts a new sentence
    // (with "steatosis.44 LXRα" the two sentences were one for it, and the triples crossed the border)
    const sup = el.closest('sup');
    if (sup && /^[\s\d,;.\-‐-―\[\]()]+$/.test(sup.textContent || '')) { rec.afterCite = true; continue; }
    const last = rec.parts[rec.parts.length - 1];
    let pre = '';
    if (last && (pendingBr.has(el) || rec.afterCite) && !/\s$/.test(last.node.nodeValue) && !/^\s/.test(n.nodeValue)) pre = ' ';
    rec.afterCite = false;
    pendingBr.delete(el);
    rec.parts.push({ node: n, pre });
  }
  // text in a table (cells, captions): entities are marked up, but no relations are looked for in it (noRel)
  return [...blocks.values()].map(r => finishBlock(r.parts, { el: r.el, noRel: !!(r.el.closest && r.el.closest('table')) })).filter(b => /[A-Za-z]{2}/.test(b.norm));
}
/** the blocks of rendered PDF pages: the spans of a page's text layer grouped into paragraphs by their position (a new paragraph after a bigger gap or a jump back up) */
export function collectPdfBlocks(root) {
  const blocks = [];
  for (const layer of Array.from(root.querySelectorAll('.textLayer'))) {
    const spans = Array.from(layer.querySelectorAll('span')).filter(s => !s.classList.contains('markedContent') && s.firstChild && s.firstChild.nodeType === 3 && !s.classList.contains('nlp-seg'));
    let cur = null, prev = null;
    const flush = () => { if (cur && cur.length) blocks.push(finishBlock(cur, { el: layer })); cur = null; };
    for (const sp of spans) {
      const r = sp.getBoundingClientRect();
      const h = Math.max(r.height, 4);
      let pre = '';
      if (!prev) { flush(); cur = []; }
      else {
        const sameLine = Math.abs(r.top - prev.top) < h * 0.5;
        const nextLine = r.top > prev.top + h * 0.5 && r.top - prev.bottom < h * 0.9;
        if (!sameLine && !nextLine) { flush(); cur = []; }
        else {
          const lastTxt = cur[cur.length - 1].node.nodeValue;
          if (!/\s$/.test(lastTxt) && !/^\s/.test(sp.firstChild.nodeValue)) pre = (!sameLine && /-$/.test(lastTxt)) ? '' : ' ';
        }
      }
      cur.push({ node: sp.firstChild, pre });
      prev = r;
    }
    flush();
  }
  return blocks.filter(b => /[A-Za-z]{2}/.test(b.norm));
}

// ── the document as MSXML ──────────────────────────────────────────────────────────────────────────────────────
const xmlEsc = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** the blocks as an MSXML document, one <section> per block with uri "info:reader/<block index>" (the TextRef of the results says which block a sentence / relation is in) */
export function buildMsxml(blocks, title = 'Reader document', opts = {}) {
  const parts = ['<batch>'];
  blocks.forEach((b, i) => {
    if (!b.norm) return;
    if (opts.noTables && b.noRel) return;                 // the relation pipeline does not see the text of tables (the block index stays the same)
    parts.push(` <section uri="info:reader/${i}" type="body">`, `  <attr name="Title" value="${xmlEsc(title).slice(0, 200)}" />`, `  <text>${xmlEsc(b.norm)}</text>`, ' </section>');
  });
  parts.push('</batch>');
  return parts.join('\n');
}
/** the block index in a TextRef ("info:reader/12#body:1") */
export const blockOfTextRef = (ref) => { const m = /info:reader\/(\d+)/.exec(String(ref || '')); return m ? Number(m[1]) : -1; };


// ── where things are ───────────────────────────────────────────────────────────────────────────────────────────
const findFrom = (text, needle, from) => (needle ? text.indexOf(needle, from) : -1);
/** the range [a, b) of a sentence in the chunk text: found by its first and last words (the output may differ in the middle: text modifications such as "(SCC) " removed) */
function locateSentence(text, plain, from) {
  const p = plain.trim();
  if (p.length < 8) return null;
  let a = -1;
  for (const n of [48, 24, 12]) { const head = p.slice(0, n); a = findFrom(text, head, from); if (a >= 0) break; }
  let b = -1;
  for (const n of [48, 24, 12]) { const tail = p.slice(-n); const at = findFrom(text, tail, Math.max(a, from)); if (at >= 0) { b = at + tail.length; break; } }
  if (a < 0 && b < 0) return null;
  if (a < 0) a = Math.max(0, b - p.length);
  if (b < 0 || b < a) b = Math.min(text.length, a + p.length);
  return [a, b];
}
/** [start, end) of an entity's text in the chunk text from `from`: exactly, or with a parenthesis in between that the pipeline removed ("carcinoma (SCC) of the lung") */
// whole: the text must stand as a word of its own (no letter or digit right before / after it) — for an abbreviation ("FCR" is not in "FCRs" or "cFCR"); always case-sensitive
const isWordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
function findSurface(text, surface, from, whole = false) {
  if (whole) {
    for (let at = text.indexOf(surface, from); at >= 0; at = text.indexOf(surface, at + 1)) {
      if (!isWordChar(text[at - 1]) && !isWordChar(text[at + surface.length])) return [at, at + surface.length];
    }
    return null;
  }
  const at = text.indexOf(surface, from);
  if (at >= 0) return [at, at + surface.length];
  const words = surface.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(words.map(esc).join('\\s+(?:\\([^)]{1,40}\\)\\s+)?'), 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}
/** the sentences of a medscan -O1 output: [{ bi (block), plain, ents }] — a record is "mref / TextRef / … / msrc" lines, msrc is the marked-up sentence */
export function parseO1(out) {
  const res = [];
  let bi = -1, mods = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (line.startsWith('TextRef\t')) bi = blockOfTextRef(line.slice(8));
    else if (line.startsWith('mref\t')) { bi = -1; mods = []; }
    else if (line.startsWith('TextMods\t')) mods.push(...parseTextMods(line.slice(9)));
    else if (line.startsWith('msrc\t')) { const s = parseMsrc(line.slice(5)); res.push({ bi, plain: s.plain, ents: s.ents, mods }); }
  }
  return res;
}
/**
 * The text modifications MedScan made in a sentence before it marked it up (TextMods): local de-abbreviations and removed text, as in
 *   TextMods	19: 'FCR ' -> 'Fear of cancer recurrence ' 65: '(FCR) ' -> ''
 * → [{ pos, orig, repl }] (the text on the page, the text MedScan read)
 */
export function parseTextMods(value) {
  const out = [];
  const re = /(\d+):\s*'((?:[^'\\]|\\.)*)'\s*->\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(String(value || ''))) !== null) out.push({ pos: Number(m[1]), orig: m[2], repl: m[3] });
  return out;
}
/** a text as MedScan read it → as it is on the page: the replaced texts (FCR → Fear of cancer recurrence) put back */
export function reverseMods(text, mods) {
  let t = String(text || '');
  for (const m of mods || []) {
    const o = m.orig.trim(), r = m.repl.trim();
    if (o && r && o !== r && t.includes(r)) t = t.split(r).join(o);
  }
  return t;
}
/**
 * where the parts of a triple are in its sentence [rng) of a block: the entities of NP1 / NP2 (their text on the page) and the predicate (the verb of the pseudo-sentence is a
 * lemma — "increase" — the page has "increased": found by its stem). → [{ a, b, role: 'np1' | 'np2' | 'pred' }]
 * (the words of NP1 / NP2 that are not entities are not marked: the triple is written in the order of the pseudo-sentence, not of the page)
 */
function tripleMarks(norm, rng, mods, t) {
  const marks = [];
  const lim = rng[1] + 2;
  const entsOf = (side, role, from) => {
    const re = /ID\{([^=}]*)=([^}]*)\}/g;
    let m;
    while ((m = re.exec(side)) !== null) {
      const onPage = reverseMods(m[2], mods);
      const f = findSurface(norm, onPage, from, onPage !== m[2]) || (onPage !== m[2] ? findSurface(norm, m[2], from) : null);
      if (f && f[1] <= lim) marks.push({ a: f[0], b: f[1], role });
    }
  };
  entsOf(t.np1, 'np1', rng[0]);
  const after1 = marks.length ? marks[0].b : rng[0];
  entsOf(t.np2, 'np2', after1);
  if (!marks.some(x => x.role === 'np2')) entsOf(t.np2, 'np2', rng[0]);
  let stem = String(t.pred || '').toLowerCase();
  if (stem.length > 4) stem = stem.replace(/(e|y)$/, '');
  if (stem.length >= 3) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\p{L}]*', 'giu');
    const text = norm.slice(0, rng[1]);
    const hits = [];
    for (re.lastIndex = rng[0]; ;) {
      const m = re.exec(text);
      if (!m) break;
      if (!marks.some(x => m.index < x.b && x.a < m.index + m[0].length)) hits.push([m.index, m.index + m[0].length]);
    }
    const h = hits.find(x => x[0] >= after1) || hits[0];
    if (h) marks.push({ a: h[0], b: h[1], role: 'pred' });
  }
  return marks;
}
/**
 * where the entities and the relation sentences are in the blocks.
 * results: [{ o1 (medscan -O1 output of a cartridge), rnefParts: [{ xml }] }]
 * → { ents: [{ bi, a, b, ent }], sents: [{ bi, a, b, rel, key }], seenEnts: Map(key → { type }), seenRels: Map(key → rel) }  (a, b: offsets in the block's norm text)
 */
export function alignBlocks(blocks, results) {
  const ents = [], sents = [], trips = [], seenEnts = new Map(), seenRels = new Map(), seenTrips = new Map();
  for (const res of results) {
    // entities: the sentences of a block come in text order, each entity is searched from the end of the previous one
    const cursor = new Map();
    for (const s of parseO1(res.o1)) {
      for (const e of s.ents) { if (!seenEnts.has(e.key)) seenEnts.set(e.key, { type: e.type, n: 0 }); seenEnts.get(e.key).n++; }       // n: how often the entity occurs in the markup of the whole document
      const b = blocks[s.bi];
      if (!b) continue;
      const from = cursor.get(s.bi) || 0;
      // the sentence and its entities as they are on the page: a local de-abbreviation of MedScan (TextMods) is taken back (the entity "Fear of cancer recurrence" is "FCR" there)
      const rng = locateSentence(b.norm, reverseMods(s.plain, s.mods), from) || locateSentence(b.norm, s.plain, from);
      let pos = rng ? rng[0] : from;
      const limit = rng ? rng[1] : b.norm.length;
      for (const e of s.ents) {
        const onPage = reverseMods(e.surface, s.mods);
        const f = findSurface(b.norm, onPage, pos, onPage !== e.surface) || (onPage !== e.surface ? findSurface(b.norm, e.surface, pos) : null);       // an abbreviation: a whole word, case-sensitive
        if (!f || f[1] > limit + 2) continue;
        const text = b.norm.slice(f[0], f[1]);
        ents.push({ bi: s.bi, a: f[0], b: f[1], sa: rng ? rng[0] : undefined, sb: rng ? rng[1] : undefined, ent: text !== e.surface && onPage !== e.surface ? { ...e, abbrev: text, expansion: e.surface } : e });
        pos = f[1];
      }
      cursor.set(s.bi, rng ? rng[1] : pos);
    }
    // relations: the sentence each was found in (its block comes from the TextRef; without one every block is searched)
    for (const part of res.rnefParts || []) {
      for (const rel of parseRelations(part.xml)) {
        const plain = parseMsrc(rel.msrc).plain;
        const key = relationKey(rel, plain);
        if (!seenRels.has(key)) seenRels.set(key, rel);
        const onPage = reverseMods(plain, rel.mods);
        const find = (norm) => locateSentence(norm, onPage, 0) || (onPage !== plain ? locateSentence(norm, plain, 0) : null);
        let bi = blockOfTextRef(rel.textRef), rng = bi >= 0 && blocks[bi] ? find(blocks[bi].norm) : null;
        if (!rng) for (let k = 0; k < blocks.length && !rng; k++) { rng = find(blocks[k].norm); if (rng) bi = k; }
        if (rng) sents.push({ bi, a: rng[0], b: rng[1], rel, key });
      }
    }
    // triples: the sentences of the ConceptScan output that have some (res.cs, see readerTriples in main.js), and the parts of each in its sentence
    for (const rec of parseTriples(res.cs)) {
      const onPage = reverseMods(rec.plain, rec.mods);
      const find = (norm) => locateSentence(norm, onPage, 0) || (onPage !== rec.plain ? locateSentence(norm, rec.plain, 0) : null);
      let bi = rec.bi, rng = bi >= 0 && blocks[bi] ? find(blocks[bi].norm) : null;
      if (!rng && bi < 0) for (let k = 0; k < blocks.length && !rng; k++) { rng = find(blocks[k].norm); if (rng) bi = k; }
      if (!rng) continue;
      const marks = [];
      for (const t of rec.triples) { if (!seenTrips.has(t.key)) seenTrips.set(t.key, t); marks.push(...tripleMarks(blocks[bi].norm, rng, rec.mods, t).map(x => ({ ...x, tk: t.key }))); }       // tk: the triple a mark belongs to
      trips.push({ bi, a: rng[0], b: rng[1], triples: rec.triples, marks });
    }
  }
  return { ents, sents, trips, seenEnts, seenRels, seenTrips };
}


// ── Resolve pronouns (coreference) ──────────────────────────────────────────────────────────────
// A pronoun (it, its, they, them, their) in a sentence of the document points back to an entity marked up in the sentences before it. For each pronoun the LLM is asked which of those entities it is
// (corefPrompt); the answers (resolveReplies) give the sentence with the pronoun replaced by the name ("its deletion" -> "NR4A1's deletion"). The relations of the document are then found in the
// RESOLVED text, the page keeps the original words: the positions found in the resolved text are put back onto the page (alignWithCoref), and the pronoun is shown as a pill (applyAnnotations).
const PRONOUN_RE = /(?<![\p{L}\p{N}_'’-])(its|their|they|them|it)(?![\p{L}\p{N}_-])/giu;
const PLEONASTIC_RE = /^\s+(?:is|was|seems?|appears?|remains?|has been|have been|may be|can be|could be|would be|should be|becomes?|became)\s+(?:[\p{L}\p{N}-]+\s+){0,3}(?:that|to|whether|if)(?![\p{L}\p{N}])/iu;
export const DEFAULT_COREF_PROMPT = [
  'Preceding sentences:',
  '${context}',
  'Sentence: ${sentence}',
  'Pronoun: "${pronoun}"',
  'Entities: ${candidates}',
  'Which of the entities does the pronoun "${pronoun}" in the sentence refer to? Answer with one of the listed entities, copied exactly, or "none" (for example when "it" has no antecedent in the text).',
].join('\n');
/** the pronouns of the document that have an entity before them: [{ bi, a, b (page offsets), word, sentence, context: [text of the n sentences before], cands: [{ name, key }] }] — o1 = the medscan -O1 output (the entities of every sentence) */
export function findPronouns(blocks, o1, { n = 1 } = {}) {
  const cursor = new Map();
  const located = [];
  for (const s of parseO1(o1)) {
    const b = blocks[s.bi];
    if (!b || b.noRel) { located.push(null); continue; }              // (no pronouns are resolved in tables)
    const from = cursor.get(s.bi) || 0;
    const rng = locateSentence(b.norm, reverseMods(s.plain, s.mods), from) || locateSentence(b.norm, s.plain, from);
    let pos = rng ? rng[0] : from;
    const ents = [];
    for (const e of s.ents) {
      const onPage = reverseMods(e.surface, s.mods);
      const f = findSurface(b.norm, onPage, pos, onPage !== e.surface) || (onPage !== e.surface ? findSurface(b.norm, e.surface, pos) : null);
      if (!f || (rng && f[1] > rng[1] + 2)) continue;
      ents.push({ name: b.norm.slice(f[0], f[1]), key: e.key, a: f[0], b: f[1] });
      pos = f[1];
    }
    cursor.set(s.bi, rng ? rng[1] : pos);
    located.push(rng ? { bi: s.bi, a: rng[0], b: rng[1], text: b.norm.slice(rng[0], rng[1]), ents } : null);
  }
  const out = [];
  located.forEach((L, k) => {
    if (!L) return;
    const before = located.slice(Math.max(0, k - n), k).filter(Boolean);
    PRONOUN_RE.lastIndex = 0;
    for (let m = PRONOUN_RE.exec(L.text); m; m = PRONOUN_RE.exec(L.text)) {
      if (/^it$/i.test(m[0]) && PLEONASTIC_RE.test(L.text.slice(m.index + m[0].length, m.index + m[0].length + 80))) continue;       // "it" of "it is known that ...": no entity behind it, no question
      const pa = L.a + m.index, pb = pa + m[0].length;
      const seen = new Set(), cands = [];
      const here = L.ents.filter(e => e.b <= pa);                       // the entities of this sentence before the pronoun
      const prev = here.length ? [] : before;                           // some: the pronoun most certainly refers to one of them - only this sentence is asked about, the sentences before would only confuse the model
      for (const x of [...prev.flatMap(q => q.ents), ...here]) {          // else the entities of the sentences before
        const id = x.name.toLowerCase();
        if (seen.has(id)) { const i = cands.findIndex(c => c.name.toLowerCase() === id); if (i >= 0) cands.push(cands.splice(i, 1)[0]); continue; }       // a name that comes again moves to the end (the nearest)
        seen.add(id); cands.push({ name: x.name, key: x.key });
      }
      if (cands.length) out.push({ bi: L.bi, a: pa, b: pb, word: m[0], sentence: L.text, context: prev.map(q => q.text), cands });
    }
  });
  // the pronouns of the document that were NOT asked about, with the reason (out.skipped): the sentence was not located on the page, or no entity stands before the pronoun
  const asked = new Set(out.map(p => p.bi + ':' + p.a));
  out.skipped = [];
  blocks.forEach((b, bi) => {
    PRONOUN_RE.lastIndex = 0;
    for (let m = PRONOUN_RE.exec(b.norm); m; m = PRONOUN_RE.exec(b.norm)) {
      if (asked.has(bi + ':' + m.index)) continue;
      if (/^it$/i.test(m[0]) && PLEONASTIC_RE.test(b.norm.slice(m.index + m[0].length, m.index + m[0].length + 80))) continue;
      const L = located.find(x => x && x.bi === bi && x.a <= m.index && m.index < x.b);
      out.skipped.push({ bi, a: m.index, word: m[0], sentence: L ? L.text : b.norm.slice(Math.max(0, m.index - 120), m.index + 120), reason: L ? 'no entity is marked up before the pronoun (in its sentence or the ' + n + ' before)' : 'the sentence of the pronoun could not be located on the page (no MedScan sentence matches it)' });
    }
  });
  return out;
}
/** the question for one pronoun: the template (default DEFAULT_COREF_PROMPT) with ${context} ${sentence} ${pronoun} ${candidates} replaced */
export function corefPrompt(template, p) {
  const vals = { context: p.context.length ? p.context.join('\n') : '(none)', sentence: p.sentence, pronoun: p.word, candidates: JSON.stringify(p.cands.map(c => c.name)) };
  let t = template || DEFAULT_COREF_PROMPT;
  for (const [k, v] of Object.entries(vals)) t = t.split('${' + k + '}').join(v);
  return t.trim();
}
const wordsOf = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const inside = (a, b) => { if (!a.length) return false; for (let i = 0; i + a.length <= b.length; i++) { let ok = true; for (let j = 0; j < a.length; j++) if (b[i + j] !== a[j]) { ok = false; break; } if (ok) return true; } return false; };
/** the candidate a reply names: the reply is a name (ignoring case, quotes, punctuation), else holds exactly one name (the longest when the others are inside it); null = "none" / no or several names */
export function matchReferent(reply, cands) {
  const rw = wordsOf(reply);
  if (!rw.length || (rw.length === 1 && rw[0] === 'none')) return null;
  const same = cands.find(c => { const w = wordsOf(c.name); return w.length === rw.length && w.every((x, i) => x === rw[i]); });
  if (same) return same;
  let hit = cands.filter(c => inside(wordsOf(c.name), rw));
  if (hit.length > 1) { hit = hit.sort((x, y) => wordsOf(y.name).length - wordsOf(x.name).length); if (!hit.slice(1).every(c => inside(wordsOf(c.name), wordsOf(hit[0].name)))) return null; hit = hit.slice(0, 1); }
  return hit.length === 1 ? hit[0] : null;
}
/** its / their -> "NR4A1's", it / they / them -> "NR4A1" */
export const replacementFor = (word, name) => (/^(its|their)$/i.test(word) ? name + "'s" : name);
/**
 * the answers of the LLM (replies[i] for found[i]) -> { corefs: [{ bi, a, b, word, name, repl, ck }], rblocks } — rblocks = the blocks with the pronouns replaced in their text (norm) and reps
 * (where, for putting positions back); null when nothing was resolved
 */
export function resolveReplies(blocks, found, replies) {
  const corefs = [];
  found.forEach((p, i) => {
    const hit = matchReferent(replies[i], p.cands);
    if (hit) corefs.push({ bi: p.bi, a: p.a, b: p.b, word: p.word, name: hit.name, repl: replacementFor(p.word, hit.name), ck: hit.key });
  });
  if (!corefs.length) return null;
  const byBlock = new Map();
  for (const c of corefs) { if (!byBlock.has(c.bi)) byBlock.set(c.bi, []); byBlock.get(c.bi).push(c); }
  const rblocks = blocks.map((b, bi) => {
    const list = byBlock.get(bi);
    if (!list) return b;
    list.sort((x, y) => x.a - y.a);
    let norm = '', last = 0, delta = 0;
    const reps = [];
    for (const c of list) {
      if (c.a < last) continue;
      norm += b.norm.slice(last, c.a);
      const ns = norm.length;
      norm += c.repl;
      reps.push({ a: c.a, b: c.b, ns, ne: norm.length });
      last = c.b;
    }
    norm += b.norm.slice(last);
    return { ...b, norm, reps };
  });
  return { corefs, rblocks };
}
/** a position of the resolved text of a block -> the page: a position inside a replaced name is the start / the end of the pronoun */
function mapBack(reps, x, isEnd) {
  let delta = 0;
  for (const r of reps) {
    if (isEnd ? x <= r.ns : x < r.ns) break;
    if (x < r.ne) return isEnd ? r.b : r.a;
    delta += (r.ne - r.ns) - (r.b - r.a);
  }
  return x - delta;
}
/**
 * alignBlocks for a document whose relations were found in the RESOLVED text (coref = resolveReplies(...)): the entities of the markup (results with o1) are aligned with the page,
 * the sentences / triples of the other results with the resolved blocks and then put back onto the page
 */
export function alignWithCoref(blocks, coref, results) {
  if (!coref) return alignBlocks(blocks, results);
  const A = alignBlocks(blocks, results.filter(r => r.o1));
  const B = alignBlocks(coref.rblocks, results.filter(r => !r.o1));
  const back = (bi, a, b) => { const reps = coref.rblocks[bi] && coref.rblocks[bi].reps; return reps ? { a: mapBack(reps, a, false), b: mapBack(reps, b, true) } : { a, b }; };
  const sents = B.sents.map(s => ({ ...s, ...back(s.bi, s.a, s.b) }));
  const trips = B.trips.map(t => ({ ...t, ...back(t.bi, t.a, t.b), marks: (t.marks || []).map(m => ({ ...m, ...back(t.bi, m.a, m.b) })) }));
  return { ents: A.ents, sents, trips, seenEnts: A.seenEnts, seenRels: B.seenRels, seenTrips: B.seenTrips };
}

/** non-overlapping entities (the longest first); sentences of one block merged where they overlap, their relations de-duplicated */
/** a sentence of the result: { bi, a, b, rels: asserted relations (RNEF of the control rules), trips: the triples extracted from it (ConceptScan), marks: where their NP1 / predicate / NP2 are } */
export function finishAnnotations(ents, sents, trips = []) {
  const e2 = [];
  for (const e of [...ents].sort((x, y) => x.bi - y.bi || x.a - y.a || (y.b - y.a) - (x.b - x.a))) {
    const l = e2[e2.length - 1];
    if (l && l.bi === e.bi && e.a < l.b) continue;
    e2.push(e);
  }
  const s2 = [];
  const all = [...sents.map(s => ({ ...s, kind: 'r' })), ...trips.map(t => ({ ...t, kind: 't' }))].sort((x, y) => x.bi - y.bi || x.a - y.a);
  for (const s of all) {
    let l = s2[s2.length - 1];
    if (l && l.bi === s.bi && s.a < l.b) l.b = Math.max(l.b, s.b);
    else { l = { bi: s.bi, a: s.a, b: s.b, rels: [], trips: [], marks: [] }; s2.push(l); }
    if (s.kind === 'r') { if (!l.rels.some(r => r.key === s.key)) l.rels.push({ key: s.key, rel: s.rel }); }
    else { for (const t of s.triples) if (!l.trips.some(x => x.key === t.key)) l.trips.push(t); l.marks.push(...s.marks); }
  }
  return { ents: e2, sents: s2 };
}

// ── highlights in the DOM ──────────────────────────────────────────────────────────────────────────────────────
/** puts the entity highlights (span.nlp-ent, colour in --rgb, data-e = index in ents) and the sentence underlines (span.nlp-sent, data-s = index in sents) into the text nodes → undo() */
// opts.badges: an empty span after the last text of a sentence with triples / relations — its ::after shows "[2 triples · 1 asserted]" (no text of the document is added)
export function applyAnnotations(doc, blocks, ents, sents, opts = {}) {
  const undo = [];
  const byBlock = new Map();
  const slot = (bi) => { if (!byBlock.has(bi)) byBlock.set(bi, { e: [], s: [], c: [] }); return byBlock.get(bi); };
  ents.forEach((e, i) => slot(e.bi).e.push({ ...e, i }));
  sents.forEach((s, i) => slot(s.bi).s.push({ ...s, i }));
  (opts.coref || []).forEach(c => slot(c.bi).c.push(c));                    // the pronouns that were resolved
  for (const [bi, { e, s, c }] of byBlock) {
    const block = blocks[bi];
    if (!block) continue;
    const marks = s.flatMap(x => x.marks || []);
    const cuts = new Set([0, block.norm.length]);
    for (const x of [...e, ...s, ...marks, ...c]) { cuts.add(Math.max(0, x.a)); cuts.add(Math.min(block.norm.length, x.b)); }
    const pts = [...cuts].sort((x, y) => x - y);
    const pieces = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const lo = pts[k], hi = pts[k + 1];
      const ent = e.find(x => x.a <= lo && hi <= x.b), sen = s.find(x => x.a <= lo && hi <= x.b), cor = c.find(x => x.a <= lo && hi <= x.b);
      const rawLo = k === 0 ? 0 : block.map[lo], rawHi = hi >= block.norm.length ? block.raw.length : block.map[hi];
      const cover = sen ? marks.filter(x => x.a <= lo && hi <= x.b) : [];
      // roles: np1 / np2 / pred of the asserted ('a-') and of the unasserted ('u-') triples this text is a part of
      const roles = [...new Set(cover.map(x => { const t = sen.trips.find(y => y.key === x.tk); return (t && t.asserted ? 'a-' : 'u-') + x.role; }))];
      // trs: the triples (indexes in sen.trips) this text is a part of — the tooltip shows only those
      const trs = sen ? [...new Set(cover.map(x => sen.trips.findIndex(t => t.key === x.tk)).filter(i => i >= 0))] : [];
      pieces.push({ lo, hi, rawLo, rawHi, ent, sen, cor, roles, trs });
    }
    for (const seg of block.segs) {
      const node = seg.node;
      if (!node.parentNode) continue;
      const bits = [];
      let any = false;
      for (const p of pieces) {
        const lo = Math.max(p.rawLo, seg.rawStart), hi = Math.min(p.rawHi, seg.rawEnd);
        if (hi <= lo) continue;
        const text = node.nodeValue.slice(lo - seg.rawStart, hi - seg.rawStart);
        if (p.ent || p.sen || p.cor) any = true;
        // s0 / s1: the first / the last piece of the sentence (the piece starts / ends in this text node)
        bits.push({ text, ent: p.ent, sen: p.sen, cor: p.cor, roles: p.roles, trs: p.trs, s0: !!p.sen && p.lo === p.sen.a && lo === p.rawLo, s1: !!p.sen && p.hi === p.sen.b && hi === p.rawHi });
      }
      if (!any) continue;
      const frag = doc.createDocumentFragment();
      for (const b of bits) {
        if (!b.ent && !b.sen && !b.cor) { frag.appendChild(doc.createTextNode(b.text)); continue; }
        const sp = doc.createElement('span');
        sp.className = 'nlp-seg' + (b.ent ? ' nlp-ent' : '') + (b.sen ? ' nlp-sent' : '')
          + (b.sen && b.sen.rels.length ? ' nlp-r' : '') + (b.sen && b.sen.trips.some(t => t.asserted) ? ' nlp-ta' : '') + (b.sen && b.sen.trips.some(t => !t.asserted) ? ' nlp-tu' : '') + (b.s0 ? ' nlp-s0' : '') + (b.roles || []).map(r => ' nlp-' + r).join('');
        if (b.ent) {
          const rgb = rgbOf(b.ent.ent.type);
          sp.dataset.e = String(b.ent.i); sp.style.setProperty('--rgb', rgb.join(','));
          sp.classList.add((0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.55 ? 'nlp-light' : 'nlp-dark');      // a light / dark colour: gets a thin outline in the "Color font" mode where the background needs it
        }
        if (b.sen) sp.dataset.s = String(b.sen.i);
        if (b.trs && b.trs.length) sp.dataset.tr = b.trs.join(',');
        sp.textContent = b.text;
        if (b.cor) {                                                          // a resolved pronoun: the name (resolved-text) and the word of the author (original-text); the view mode of the page shows one or both
          sp.classList.add('nlp-coref');
          sp.dataset.original = b.text; sp.dataset.name = b.cor.name; if (b.cor.ck) sp.dataset.ck = b.cor.ck;
          sp.textContent = '';
          const rs = doc.createElement('span'); rs.className = 'resolved-text'; rs.textContent = b.cor.repl;
          const os = doc.createElement('span'); os.className = 'original-text'; os.textContent = b.text;
          sp.appendChild(rs); sp.appendChild(os);
        } else if (b.ent && b.ent.ent.key) sp.dataset.ck = b.ent.ent.key;       // the mentions of one entity share data-ck: hovering over one shows the others
        frag.appendChild(sp);
        if (b.s1 && opts.badges !== false && b.sen.trips.length) {
          const bd = doc.createElement('span');
          bd.className = 'nlp-seg nlp-badge'; bd.dataset.s = String(b.sen.i);
          // the counts; the text of the badge (which of them are shown) is made by the screen from the buttons of the Visualization tab (badgeText)
          bd.dataset.na = String(b.sen.trips.filter(t => t.asserted).length); bd.dataset.nu = String(b.sen.trips.filter(t => !t.asserted).length); bd.dataset.nr = String(b.sen.rels.length);
          frag.appendChild(bd);
        }
      }
      const inserted = Array.from(frag.childNodes);
      node.parentNode.replaceChild(frag, node);
      undo.push({ orig: node, inserted });
    }
  }
  return () => {
    for (const u of undo) {
      const first = u.inserted[0];
      if (first && first.parentNode) { first.parentNode.insertBefore(u.orig, first); u.inserted.forEach(n => n.parentNode && n.parentNode.removeChild(n)); }
    }
  };
}

/** the text of a badge after a sentence ([2 asserted triples · 1 unasserted triple · 3 relations]): the counts of the sentence for what the buttons of the Visualization tab show; f = { asr, una, rel } */
export function badgeText(el, f) {
  const na = Number(el.dataset.na) || 0, nu = Number(el.dataset.nu) || 0, nr = Number(el.dataset.nr) || 0;
  const parts = [];
  if (f.asr && na) parts.push(na + (na === 1 ? ' asserted triple' : ' asserted triples'));
  if (f.una && nu) parts.push(nu + (nu === 1 ? ' unasserted triple' : ' unasserted triples'));
  if (parts.length && f.rel && nr) parts.push(nr + (nr === 1 ? ' relation' : ' relations'));
  el.dataset.bd = parts.length ? '[' + parts.join(' · ') + ']' : '';
}

/** the style of the highlights; classes nlp-hl / nlp-rel on an ancestor (the <html> of the page, the root of the PDF pages) switch the entity highlights / the relation underlines on */
export const READER_CSS = `
/* resolved pronouns: a pill with the name (the word of the author is the title / a second part, by the view: nlp-cor-orig = original text, nlp-cor-res = resolved (default), nlp-cor-aud = both).
   Dotted underline, no background fill: the fills are those of the entities and of the triples */
.nlp-coref { border-bottom: 1.5px dotted #0d9488; border-radius: 3px; padding: 0 2px; cursor: pointer; position: relative; font-style: italic; }
.nlp-coref .original-text { display: none; }
.nlp-cor-orig .nlp-coref { border-bottom: none; padding: 0; font-style: normal; cursor: default; }
.nlp-cor-orig .nlp-coref .resolved-text { display: none; }
.nlp-cor-orig .nlp-coref .original-text { display: inline; }
.nlp-cor-res .nlp-coref:hover::after { content: 'Originally: "' attr(data-original) '"'; position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); background: #1e293b; color: #fff; font: 0.75rem system-ui, sans-serif; font-style: normal; padding: 2px 6px; border-radius: 4px; white-space: nowrap; z-index: 10; }
.nlp-cor-aud .nlp-coref .original-text { display: inline; text-decoration: line-through; color: #94a3b8 !important; margin-right: 4px; font-size: 0.9em; }
.nlp-cor-aud .nlp-coref .resolved-text { font-weight: 600; color: #0f766e !important; }
.nlp-coref.nlp-flip .resolved-text { display: none; } .nlp-coref.nlp-flip .original-text { display: inline; text-decoration: line-through; color: #94a3b8 !important; }
.nlp-chain { outline: 2px solid rgba(13, 148, 136, 0.55); outline-offset: 1px; border-radius: 3px; background: rgba(13, 148, 136, 0.14); }
/* classes on the root: nlp-hl (markup shown) / nlp-font (mode "Color font", else "Highlight") / nlp-rel (relation underlines) / nlp-bg-light|gray|dark (page background) */
.nlp-hl:not(.nlp-font) .nlp-ent { background: rgba(var(--rgb), 0.4); border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.nlp-hl.nlp-font .nlp-ent { color: rgb(var(--rgb)) !important; font-weight: 700; }
.nlp-hl.nlp-font:not(.nlp-bg-dark):not(.nlp-bg-gray) .nlp-ent.nlp-light { -webkit-text-stroke: 0.5px rgba(0,0,0,0.6); paint-order: stroke fill; }
.nlp-hl.nlp-font.nlp-bg-dark .nlp-ent.nlp-dark, .nlp-hl.nlp-font.nlp-bg-gray .nlp-ent.nlp-dark { -webkit-text-stroke: 0.5px rgba(255,255,255,0.8); paint-order: stroke fill; }
.nlp-rel .nlp-sent.nlp-r { text-decoration: underline wavy #7b1fa2; text-decoration-thickness: 1.6px; text-underline-offset: 3px; text-decoration-skip-ink: none; }
/* the triples of the sentences: classes nlp-asr (asserted triples shown) / nlp-una (unasserted triples shown) on the root. Asserted = the rules asserted a relation from them,
   unasserted = they did not. NP1 (blue) / NP2 (teal) / predicate (gray) are marked by lines under them: a solid line (box-shadow: they stack where one entity is NP1 of a triple
   and NP2 of another, and do not move the text) for an asserted triple, a dotted one (a border: it does not change the height of the line) for an unasserted one */
.nlp-asr .nlp-a-np1 { box-shadow: inset 0 -3px 0 0 #2563eb; }
.nlp-asr .nlp-a-np2 { box-shadow: inset 0 -3px 0 0 #0d9488; }
.nlp-asr .nlp-a-np1.nlp-a-np2 { box-shadow: inset 0 -3px 0 0 #2563eb, inset 0 -6px 0 0 #0d9488; }
.nlp-asr .nlp-a-pred { box-shadow: inset 0 -2px 0 0 #64748b; }
.nlp-una .nlp-u-np1 { border-bottom: 2px dotted #2563eb; }
.nlp-una .nlp-u-np2 { border-bottom: 2px dotted #0d9488; }
.nlp-una .nlp-u-np1.nlp-u-np2 { border-bottom: 2px dotted #2563eb; border-top: 2px dotted #0d9488; }
.nlp-una .nlp-u-pred { border-bottom: 2px dotted #64748b; }
/* the mark at the start of a sentence: dotted blue = unasserted triples, dashed purple = relations, solid blue = asserted triples (blue over purple when it has relations too) */
.nlp-una .nlp-s0.nlp-tu { border-left: 2px dotted #2563eb; padding-left: 6px; }
.nlp-rel .nlp-s0.nlp-r { border-left: 2px dashed #9333ea; padding-left: 6px; }
.nlp-asr .nlp-s0.nlp-ta { border-left: 2px solid #2563eb; padding-left: 6px; }
.nlp-asr.nlp-rel .nlp-s0.nlp-ta.nlp-r { border-left: 2px solid; border-image: linear-gradient(to bottom, #2563eb 50%, #9333ea 50%) 1; padding-left: 6px; }
/* the mark is a thin bar: its hover area is made bigger (an invisible box over the mark and the height of the line) so that the card of the sentence opens when the mouse is near it */
.nlp-una .nlp-s0.nlp-tu, .nlp-rel .nlp-s0.nlp-r, .nlp-asr .nlp-s0.nlp-ta { position: relative; }
.nlp-una .nlp-s0.nlp-tu::before, .nlp-rel .nlp-s0.nlp-r::before, .nlp-asr .nlp-s0.nlp-ta::before { content: ''; position: absolute; left: -2px; width: 9px; top: -9px; bottom: -9px; }
.nlp-badge { display: none; cursor: help; }
.nlp-asr .nlp-badge, .nlp-una .nlp-badge { display: inline; }
.nlp-badge[data-bd=""] { display: none !important; }
.nlp-asr .nlp-badge::after, .nlp-una .nlp-badge::after { content: attr(data-bd); margin-left: 4px; padding: 0 6px; border: 1px solid #2563eb; border-radius: 999px; background: #dbeafe; color: #1e3a8a; font: 600 0.72em/1.4 system-ui, sans-serif; white-space: nowrap; vertical-align: 0.1em; }
.nlp-bg-dark.nlp-asr .nlp-a-np1, .nlp-bg-gray.nlp-asr .nlp-a-np1 { box-shadow: inset 0 -3px 0 0 #7cb4ff; }
.nlp-bg-dark.nlp-asr .nlp-a-np2, .nlp-bg-gray.nlp-asr .nlp-a-np2 { box-shadow: inset 0 -3px 0 0 #4fd1c5; }
.nlp-bg-dark.nlp-asr .nlp-a-np1.nlp-a-np2, .nlp-bg-gray.nlp-asr .nlp-a-np1.nlp-a-np2 { box-shadow: inset 0 -3px 0 0 #7cb4ff, inset 0 -6px 0 0 #4fd1c5; }
.nlp-bg-dark.nlp-asr .nlp-a-pred, .nlp-bg-gray.nlp-asr .nlp-a-pred { box-shadow: inset 0 -2px 0 0 #cbd5e1; }
.nlp-bg-dark.nlp-una .nlp-u-np1, .nlp-bg-gray.nlp-una .nlp-u-np1 { border-bottom-color: #7cb4ff; }
.nlp-bg-dark.nlp-una .nlp-u-np2, .nlp-bg-gray.nlp-una .nlp-u-np2 { border-bottom-color: #4fd1c5; }
.nlp-bg-dark.nlp-una .nlp-u-np1.nlp-u-np2, .nlp-bg-gray.nlp-una .nlp-u-np1.nlp-u-np2 { border-bottom-color: #7cb4ff; border-top-color: #4fd1c5; }
.nlp-bg-dark.nlp-una .nlp-u-pred, .nlp-bg-gray.nlp-una .nlp-u-pred { border-bottom-color: #cbd5e1; }
.nlp-seg { cursor: default; }
.nlp-seg.nlp-badge { cursor: help; }
.nlp-bg-light, .nlp-bg-light body { background: #e4e4e4 !important; }
.nlp-bg-light *:not(.nlp-ent) { color: #1a1a1a !important; background-color: transparent !important; }
.nlp-bg-gray, .nlp-bg-gray body { background: #8d8d8d !important; }
.nlp-bg-gray *:not(.nlp-ent) { color: #101010 !important; background-color: transparent !important; }
.nlp-bg-dark, .nlp-bg-dark body { background: #1f1f28 !important; }
.nlp-bg-dark *:not(.nlp-ent) { color: #e6e6ee !important; background-color: transparent !important; }
`;


// ── tables for the Results viewer: the sentences with an entity type, the sentences with relations ──────────────
const clip = (t, n = 1500) => (t.length > n ? t.slice(0, n) + ' …' : t);
export const ENTITY_COLUMNS = [
  { key: 'sentence', label: 'Sentence', width: 90 }, { key: 'entities', label: 'Entities', width: 40 },
  { key: 'ids', label: 'Elsevier NLP IDs', width: 26, hidden: true }, { key: 'occ', label: 'Doc Occ', width: 10 }, { key: 'markup', label: 'Sentence with markup', width: 90 },
];
export const RELATION_COLUMNS = [
  { key: 'sentence', label: 'Sentence', width: 90 }, { key: 'regulator', label: 'Regulator', width: 34 }, { key: 'type', label: 'Relation type', width: 22 },
  { key: 'effect', label: 'Effect', width: 11 }, { key: 'target', label: 'Target', width: 34 }, { key: 'properties', label: 'Properties', width: 34 },
  { key: 'symbolic', label: 'Symbolic form', width: 70 }, { key: 'paragraph', label: 'Paragraph', width: 11 }, { key: 'markup', label: 'Sentence with markup', width: 90 },
];
// the filters of the table, like those of the Results viewer for an RNEF file: multi = choose values of a field of the rows, text = words in the fields
export const RELATION_FILTERS = [
  { kind: 'multi', label: 'Relation Type', field: 'type' }, { kind: 'text', label: 'Node (Assertion)', fields: ['regulator', 'target'], placeholder: 'Node name…' }, { kind: 'multi', label: 'Node Type', field: 'nodeTypes' },
];
export const ENTITY_FILTERS = [
  { kind: 'multi', label: 'Entity Type', field: 'entityTypes' }, { kind: 'text', label: 'Entity', fields: ['entities'], placeholder: 'Entity name…' },
];
const typesOfLabels = (labels) => [...new Set((labels || []).map(l => String(l).split(':(')[0]).filter(Boolean))];
// the colours of the entities of a relation in its sentence — the same as when an RNEF file is opened in the Results viewer
const ROLE_COLORS = { dir: { n1: '#f38ba8', n2: '#a6e3a1' }, indir: { n1: '#cba6f7', n2: '#fab387' }, both: '#f9e2af', other: '#9399b2' };
const decodeUrn = (s) => String(s || '').replace(/%20/g, ' ').replace(/%2c/gi, ',').replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/%3a/gi, ':').replace(/%2f/gi, '/');
/** the NLP IDs of the nodes of a relation (urns[i] → ID by the URN map of ObjectNames.tab; urn:agi-llid:N is N) */
function idsOfUrns(urns, urnMap) {
  const ids = new Set();
  for (const u0 of urns || []) {
    const u = decodeUrn(u0);
    const id = urnMap && urnMap.get(u);
    if (id != null) ids.add(String(id));
    const m = /^urn:agi-llid:(\d+)$/i.exec(u);
    if (m) ids.add(m[1]);
  }
  return ids;
}
/** the text of the sentence [sa, sb) of a block cut at the entities inside it: [{ text, ent? }] */
function sentencePieces(blocks, ents, bi, sa, sb) {
  const b = blocks[bi];
  if (!b) return [];
  const from = sa != null && sb != null && sb > sa ? sa : 0, to = sa != null && sb != null && sb > sa ? sb : b.norm.length;
  const inside = ents.filter(e => e.bi === bi && e.a >= from && e.b <= to).sort((x, y) => x.a - y.a);
  const out = [];
  let pos = from;
  for (const e of inside) {
    if (e.a < pos) continue;
    if (e.a > pos) out.push({ text: b.norm.slice(pos, e.a) });
    out.push({ text: b.norm.slice(e.a, e.b), ent: e.ent });
    pos = e.b;
  }
  if (pos < to) out.push({ text: b.norm.slice(pos, to) });
  return out;
}
/** the coloured segments of the sentence written as markup: an entity segment is shown as ID{ids=text}, in the colour it has in the sentence */
const withMarkup = (pieces, segs) => segs.map((g, i) => (pieces[i].ent ? { ...g, text: 'ID{' + pieces[i].ent.ids.join(',') + '=' + g.text + '}' } : g));
/** "the sentence with ID{ids=text}" for the entities in it */
const markupOf = (pieces) => pieces.map(p => (p.ent ? 'ID{' + p.ent.ids.join(',') + '=' + p.text + '}' : p.text)).join('');
/** one row per sentence that has entities of `type` (every type when type is empty): the sentence (sentenceSegs: its entities coloured by type), its entities, their IDs */
// counts: Map(entity key → how often it occurs in the markup of the whole document, from alignBlocks) — the column "Doc Occ" (like N1 Occ of the RNEF viewer)
export function entityRows(blocks, ents, type, counts = null) {
  const groups = new Map();
  for (const e of ents) {
    if (type && e.ent.type !== type) continue;
    const key = e.bi + ':' + (e.sa != null ? e.sa : -1);
    let g = groups.get(key);
    if (!g) { g = { bi: e.bi, a: e.a, sa: e.sa, sb: e.sb, items: [] }; groups.set(key, g); }
    g.items.push(e);
  }
  return [...groups.values()].sort((x, y) => x.bi - y.bi || x.a - y.a).map(g => {
    const pieces = sentencePieces(blocks, ents, g.bi, g.sa, g.sb);
    const items = [...new Map(g.items.map(e => [e.ent.key, { key: e.ent.key, name: blocks[e.bi].norm.slice(e.a, e.b), type: e.ent.type, ids: String(e.ent.key).split(',').filter(Boolean), expansion: e.ent.expansion || '', count: (counts && counts.get(e.ent.key)) || ents.filter(x => x.ent.key === e.ent.key).length }])).values()];
    const shown = items.map(it => (type ? '' : it.type + ': ') + it.name + (it.expansion ? ' (= ' + it.expansion + ')' : ''));
    const ids = items.map(it => it.key);
    const sentenceSegs = pieces.map(p => (p.ent ? (!type || p.ent.type === type ? { text: p.text, rgb: rgbOf(p.ent.type) } : { text: p.text, dim: true }) : { text: p.text }));
    return {
      sentence: pieces.map(p => p.text).join(''), markup: markupOf(pieces), entities: shown.join('; '), ids: ids.join('; '), occ: items.map(it => it.count).join('; '), paragraph: g.bi + 1, entityTypes: [...new Set(g.items.map(e => e.ent.type))],
      // the entities as the Results viewer shows a node: name, type, NLP IDs (clickable)
      entityItems: items,
      // the entities of the chosen type in their colour (a highlight), the others of the sentence dimmed
      sentenceSegs, markupSegs: withMarkup(pieces, sentenceSegs),
    };
  });
}
/** one row per relation and sentence: sentence (its entities coloured as in the Results viewer: regulator red, target green, the others dimmed), regulator, type, effect, target, properties, symbolic form */
export function relationRows(blocks, sents, type = '', ents = [], urnMap = null) {
  const rows = [];
  for (const s of [...sents].sort((x, y) => x.bi - y.bi || x.a - y.a)) {
    const pieces = sentencePieces(blocks, ents, s.bi, s.a, s.b);
    for (const { rel } of s.rels) {
      if (type && rel.type !== type) continue;
      const directed = !!(rel.regs.length || rel.tgts.length);
      const n1 = idsOfUrns(directed ? rel.regUrns : rel.bothUrns.slice(0, 1), urnMap), n2 = idsOfUrns(directed ? rel.tgtUrns : rel.bothUrns.slice(1), urnMap);
      const c = directed ? ROLE_COLORS.dir : ROLE_COLORS.indir;
      const has = (e, set) => e.ids.some(id => set.has(String(id).trim()));
      const sentenceSegs = pieces.map(p => {
        if (!p.ent) return { text: p.text };
        const a = has(p.ent, n1), b = has(p.ent, n2);
        return { text: p.text, color: a && b ? ROLE_COLORS.both : a ? c.n1 : b ? c.n2 : ROLE_COLORS.other, bold: a || b, dim: !a && !b };
      });
      rows.push({
        sentence: clip(pieces.map(p => p.text).join('')), markup: clip(markupOf(pieces), 3000),
        regulator: directed ? rel.regs.join(' + ') : rel.both.join(' | '), type: rel.type, effect: rel.effect || '', target: directed ? rel.tgts.join(' + ') : '',
        properties: rel.props.map(([k, v]) => k + ': ' + v).join('; '), symbolic: relationText(rel), paragraph: s.bi + 1, nodeTypes: typesOfLabels([...rel.regs, ...rel.tgts, ...rel.both]), sentenceSegs, markupSegs: withMarkup(pieces, sentenceSegs),
      });
    }
  }
  return rows;
}

/** the entities of one side of a triple ("ID{ids=text} agonist …") → [{ type, ids (the real ids), text }] */
function sideEntities(side) {
  const out = [];
  const re = /ID\{([^=}]*)=([^}]*)\}/g;
  let m;
  while ((m = re.exec(side)) !== null) { const e = entityOfIds(m[1].split(',').map(s => s.trim())); out.push({ type: e.type, ids: e.key.split(',').filter(Boolean), text: m[2] }); }
  return out;
}
/**
 * The triples of the document, one item for every sentence a triple is in (uniqueTriples: one for every distinct triple), each with the entity-type pairs of its NP1 → NP2 and whether the rules asserted a relation from it:
 * [{ key, tag, np1, pred, np2 (plain text), pairs: ['Protein → Disease', …], asserted, bi, a, b (its first sentence) }]
 * A triple is asserted when a relation of its sentence joins an entity of its NP1 and an entity of its NP2 (by NLP ID — the nodes of the relations come by their URN, urnMap),
 * in either direction: a passive sentence has the regulator on the other side. The pairs are ordered (the triple's own direction); one triple counts once for every pair
 * of types it has (NP1 with two entities of one type and NP2 with one: one pair). A triple with no entity on a side has no pair ('no entity pair').
 */
export function markAsserted(sents, urnMap) {
  for (const s of sents) {
    if (!s.trips || !s.trips.length) continue;
    const nodes = s.rels.map(({ rel }) => {
      const R = idsOfUrns(rel.regUrns, urnMap), T = idsOfUrns(rel.tgtUrns, urnMap), B = idsOfUrns(rel.bothUrns, urnMap);
      return { from: new Set([...R, ...B]), to: new Set([...T, ...B]) };
    });
    for (const t of s.trips) {
      const n1 = sideEntities(t.np1), n2 = sideEntities(t.np2);
      const has = (ents, set) => ents.some(e => e.ids.some(id => set.has(id)));
      t.asserted = nodes.some(r => (has(n1, r.from) && has(n2, r.to)) || (has(n1, r.to) && has(n2, r.from)));      // (in this sentence)
      t.pairs = [...new Set(n1.flatMap(a => n2.map(b => a.type + ' → ' + b.type)))];
    }
  }
}
/** the triples of the sentences (markAsserted done) as items: one for every sentence a triple is in */
export function tripleItems(sents) {
  const items = [];
  for (const s of sents) for (const t of s.trips || []) items.push({ key: t.key, tag: t.tag, np1: stripIds(t.np1), pred: t.pred, np2: stripIds(t.np2), np1Raw: t.np1, np2Raw: t.np2, pairs: t.pairs && t.pairs.length ? t.pairs : ['no entity pair'], asserted: !!t.asserted, bi: s.bi, a: s.a, b: s.b });
  return items;
}
// the colours of the triples in the Results viewer: the entities as the second node of a non-directional relation (orange), the predicate of an asserted triple green
const TRIPLE_ENT_COLOR = ROLE_COLORS.indir.n2, TRIPLE_PRED_COLOR = '#a6e3a1';
/** one side of a triple ("ID{ids=text} agonist …") as coloured segments: [{ text, color?, bold? }] — the entities in orange */
function sideSegs(raw) {
  const out = [];
  const re = /ID\{([^=}]*)=([^}]*)\}/g;
  const plain = (t) => { const x = t.replace(/\s+/g, ' '); if (x) out.push({ text: x }); };
  let last = 0, m;
  while ((m = re.exec(raw)) !== null) { plain(raw.slice(last, m.index)); out.push({ text: m[2], color: TRIPLE_ENT_COLOR, bold: true }); last = m.index + m[0].length; }
  plain(raw.slice(last));
  return out;
}
/** the coloured parts of a row of the triples table (item of tripleItems): the sentence with the entities of the triple, NP1 / NP2 with their entities (orange), the predicate of an asserted triple (green) */
export function tripleRowSegs(blocks, ents, it) {
  const sideEnts = [...sideEntities(it.np1Raw), ...sideEntities(it.np2Raw)];
  const ids = new Set(sideEnts.flatMap(e => e.ids));
  // the entities of the triple in its sentence: those the Standard markup has (by NLP ID) and — the triple comes from the cartridge that found it, which may mark up what the Standard one does not
  // ("platelets") — its entity names found in the text of the sentence
  const pieces = sentencePieces(blocks, ents, it.bi, it.a, it.b);
  const text = pieces.map(p => p.text).join('');
  const ranges = [];
  let pos = 0;
  for (const p of pieces) { if (p.ent && p.ent.ids.some(id => ids.has(String(id).trim()))) ranges.push([pos, pos + p.text.length]); pos += p.text.length; }
  for (const surf of new Set(sideEnts.map(e => e.text.trim()).filter(Boolean))) {
    for (let from = 0; ;) { const f = findSurface(text, surf, from, true); if (!f) break; ranges.push(f); from = f[1]; }
  }
  const merged = [];
  for (const r of ranges.sort((x, y) => x[0] - y[0] || y[1] - x[1])) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
  const sentenceSegs = [];
  let at = 0;
  for (const [x, y] of merged) { if (x > at) sentenceSegs.push({ text: text.slice(at, x) }); sentenceSegs.push({ text: text.slice(x, y), color: TRIPLE_ENT_COLOR, bold: true }); at = y; }
  if (at < text.length) sentenceSegs.push({ text: text.slice(at) });
  return { sentenceSegs, np1Segs: sideSegs(it.np1Raw), np2Segs: sideSegs(it.np2Raw), ...(it.asserted ? { predicateSegs: [{ text: it.pred, color: TRIPLE_PRED_COLOR, bold: true }] } : {}) };
}
/** one item per distinct triple (its first sentence); asserted when it is asserted in any sentence it occurs in */
export function uniqueTriples(items) {
  const m = new Map();
  for (const it of items) { const o = m.get(it.key); if (!o) m.set(it.key, { ...it }); else if (it.asserted) o.asserted = true; }
  return [...m.values()];
}

/**
 * the relations in the form the Results viewer shows an RNEF file in (Relation Type, Node 1, Node 2 with type and clickable NLP IDs, occurrences, the coloured sentence):
 * [{ type, isDirect, node1, node1Type, node1Urn, node1Ids, node2 …, doi, pmid, msrc (the sentence with ID{ids=text}), extra: { effect, props, symbolic, paragraph } }]
 * a directional relation is Regulator → Target (one record per pair); a non-directional one is Node 1 — Node 2.
 */
export function relationRecords(blocks, sents, ents, urnMap, type = '') {
  const out = [];
  const node = (label, urn) => {
    const m = /^([^:]*):\((.*)\)$/.exec(String(label || ''));
    return { name: m ? m[2] : String(label || ''), type: m ? m[1] : '', urn: decodeUrn(urn), ids: [...idsOfUrns([urn], urnMap)] };
  };
  for (const s of [...sents].sort((x, y) => x.bi - y.bi || x.a - y.a)) {
    const pieces = sentencePieces(blocks, ents, s.bi, s.a, s.b);
    const msrc = markupOf(pieces);
    for (const { rel } of s.rels) {
      if (type && rel.type !== type) continue;
      const directed = !!(rel.regs.length || rel.tgts.length);
      const A = (directed ? rel.regs.map((l, i) => [l, rel.regUrns[i]]) : rel.both.slice(0, 1).map((l, i) => [l, rel.bothUrns[i]]));
      const B = (directed ? rel.tgts.map((l, i) => [l, rel.tgtUrns[i]]) : rel.both.slice(1).map((l, i) => [l, rel.bothUrns[i + 1]]));
      const extra = { effect: rel.effect || '', properties: rel.props.map(([k, v]) => k + ': ' + v).join('; '), symbolic: relationText(rel), paragraph: s.bi + 1 };
      for (const a of A.length ? A : [null]) for (const b of B.length ? B : [null]) {
        const n1 = a ? node(a[0], a[1]) : { name: '', type: '', urn: '', ids: [] }, n2 = b ? node(b[0], b[1]) : { name: '', type: '', urn: '', ids: [] };
        out.push({ type: rel.type, isDirect: directed, node1: n1.name, node1Type: n1.type, node1Urn: n1.urn, node1Ids: n1.ids, node2: n2.name, node2Type: n2.type, node2Urn: n2.urn, node2Ids: n2.ids, doi: '', pmid: '', msrc, extra });
      }
    }
  }
  return out;
}
