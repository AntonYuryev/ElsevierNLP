'use strict';
/**
 * New relation type creation for a MedScan cartridge (Patterns screen → "New relation").
 *
 * Files touched (per FRD):
 *   CARTRIDGE\ctrltype.ini            [ControlType-Roles]  Name=in,out | Name=in-out,in-out
 *   CARTRIDGE\grdata\<Rel>\<Rel>_wordsets.msgrep   macro dictionaries (#include of macro source files + custom #define)
 *   CARTRIDGE\grdata\<Rel>\Patterns4sent\patterns4sent.msgrep   #define &SET(@regulator, @target)( p1 | p2 … )
 *   CARTRIDGE\grdata\<Rel>\Patterns4sent\Rules.msgrep       CONTROL { out=%tar(...) in=%reg(...) ControlType="<Rel>" } : &SET(%reg, %tar);
 *   CARTRIDGE\ttkconf.ini             [commands] del_<pre> / comp_<pre>  (+ pat_* task list)
 *   CARTRIDGE\locscan.ini             [output] <rel>=${MSGREP} … and  allpats=$(…+<rel>)
 * The cartridge's *.ini files are generated from bin\*.ini + *.ini.delta at (re)install, so every ini edit
 * is applied to the .ini AND to its .delta (when present) — otherwise a reinstall would drop the relation.
 * Every modified file is backed up first; a failed compile rolls everything back.
 */
const fs = require('fs');
const path = require('path');

let lemmatizer = null;
try { lemmatizer = require('wink-lemmatizer'); } catch { /* optional: suffix rules only */ }

// The shared tokenizer (ES module, same `pluralize` singularisation as the Dictionary panel) — loaded in the background; stems fall back to suffix rules until it is ready
let stemPlural = null;
import(require('url').pathToFileURL(path.join(__dirname, '../shared/tokenizer.js')).href).then(m => { stemPlural = m.stemPlural; }).catch(() => { /* optional */ });
const { spawn } = require('child_process');

const SKIP_DIRS = new Set(['msdata', 'xfdata', 'csdata', 'rgdata', 'rrdata', 'DictionaryBackup', '_relation_backups', 'node_modules']);
const BUILTIN_MACROS = new Set(['$WORD', '$PUNCT', '$NUM']);   // used throughout the cartridges but never #defined
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// ───────────────────────────── small file / ini helpers ─────────────────────────────
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readText = (p) => fs.readFileSync(p, 'utf8');
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : (t.includes('\n') ? '\n' : '\r\n'));
const splitLines = (t) => t.split(/\r?\n/);

function sectionRange(lines, section) {
  const head = `[${section}]`;
  const start = lines.findIndex(l => l.trim() === head);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  return { start, end };
}
function iniGet(text, section, key) {
  const lines = splitLines(text);
  const r = sectionRange(lines, section);
  if (!r) return null;
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(.*)$');
  for (let i = r.start + 1; i < r.end; i++) { const m = lines[i].match(re); if (m) return m[1].trim(); }
  return null;
}
function iniAppend(text, section, newLines) {
  const eol = eolOf(text), lines = splitLines(text);
  const r = sectionRange(lines, section);
  if (!r) { while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); lines.push('', `[${section}]`, ...newLines, ''); }
  else { let at = r.end; while (at > r.start + 1 && lines[at - 1].trim() === '') at--; lines.splice(at, 0, ...newLines); }
  return lines.join(eol);
}
function iniReplaceKey(text, section, key, fn) {
  const eol = eolOf(text), lines = splitLines(text);
  const r = sectionRange(lines, section);
  if (!r) return text;
  const re = new RegExp('^(\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*)(.*)$');
  for (let i = r.start + 1; i < r.end; i++) { const m = lines[i].match(re); if (m) { lines[i] = m[1] + fn(m[2]); return lines.join(eol); } }
  return text;
}
const ctrlRolesLine = (name, directional, spaced) =>
  `${name}${spaced ? ' = ' : '='}${directional ? 'in,out' : 'in-out,in-out'}`;

// ───────────────────────────── backup / rollback session ─────────────────────────────
const sessions = new Map();   // "<cart>|<rel>" → Session (survives between the wizard's IPC calls)
class Session {
  constructor(cart, rel) {
    this.cart = cart; this.rel = rel;
    this.dir = path.join(cart, '_relation_backups', new Date().toISOString().replace(/[:.]/g, '-') + '_' + rel);
    this.backed = new Set(); this.created = [];
  }
  backup(file) {
    if (this.backed.has(file)) return;
    this.backed.add(file);
    if (exists(file)) {
      const dest = path.join(this.dir, path.relative(this.cart, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
    } else this.created.push(file);
  }
  write(file, content) {
    this.backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  rollback() {
    for (const file of this.backed) {
      const bak = path.join(this.dir, path.relative(this.cart, file));
      try {
        if (this.created.includes(file)) fs.rmSync(file, { force: true });
        else if (exists(bak)) fs.copyFileSync(bak, file);
      } catch { /* best effort */ }
    }
  }
}
function getSession(cart, rel) {
  const k = `${cart}|${rel}`;
  if (!sessions.has(k)) sessions.set(k, new Session(cart, rel));
  return sessions.get(k);
}

// ───────────────────────────── text scanning helpers ─────────────────────────────
/** Blank out comments (keeps every index/line/column intact). Handles "…" strings and short '…' literals. */
function stripComments(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') i++; i++; continue; }
    if (c === "'") { const m = text.slice(i).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length; continue; } i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let k = i; k < stop; k++) if (text[k] !== '\n' && text[k] !== '\r') out[k] = ' ';
      i = stop; continue;
    }
    i++;
  }
  return out.join('');
}
const lineCol = (text, idx) => {
  let line = 1, col = 1;
  for (let i = 0; i < idx && i < text.length; i++) { if (text[i] === '\n') { line++; col = 1; } else col++; }
  return { line, col };
};
/** Index of the bracket matching text[open] (quotes skipped), or -1. */
function findMatching(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') i++; i++; continue; }
    if (c === "'") { const m = text.slice(i).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length; continue; } }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
    i++;
  }
  return -1;
}
/** All "#define NAME …" in (comment-stripped) text: { name, start, end, text, body }. */
function extractDefines(text) {
  const out = [];
  const re = /(^|\n)[ \t]*#define[ \t]+([$&@][A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const name = m[2];
    let i = re.lastIndex;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    let end;
    if (text[i] === '(' && name.startsWith('&')) {            // &NAME(params)( body )   — params group then body group
      const p = findMatching(text, i);
      let j = p < 0 ? -1 : p + 1;
      while (j >= 0 && j < text.length && /\s/.test(text[j])) j++;
      const b = (j >= 0 && text[j] === '(') ? findMatching(text, j) : -1;
      end = b >= 0 ? b + 1 : (p >= 0 ? p + 1 : text.indexOf('\n', i));
    } else if (text[i] === '[' || text[i] === '(') {          // $NAME [ … ]  /  $NAME ( … )
      const b = findMatching(text, i);
      end = b >= 0 ? b + 1 : text.indexOf('\n', i);
    } else {                                                   // single-line definition
      end = text.indexOf('\n', i);
    }
    if (end < 0) end = text.length;
    out.push({ name, start, end, text: text.slice(start, end), body: text.slice(re.lastIndex, end) });
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out;
}
const macroTokens = (text) => {
  const found = new Set();
  for (const m of text.matchAll(/(?<![\w])([$&@][A-Za-z_]\w*)/g)) found.add(m[1]);
  return found;
};

// ───────────────────────────── cartridge information ─────────────────────────────
function listMsgrepFiles(cartPath) {
  const files = [];
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (/\.msgrep$/i.test(e.name)) files.push(p);
    }
  })(cartPath);
  return files;
}

function readNodeTypes(cartPath) {
  const f = path.join(cartPath, 'nodetype.ini');
  if (!exists(f)) throw new Error('nodetype.ini not found in the cartridge folder.');
  const lines = splitLines(readText(f));
  const types = new Set();
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1]; continue; }
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim(), val = line.slice(eq + 1).trim();
    if (section === 'URN-NodeType' && val) types.add(val);                                        // urn:agi-cas:=SmallMol
    if ((section === 'NodeType-MSIDRange' || section === 'NodeType-IsFrame') && key && !/^User\d+$/i.test(key)) types.add(key);
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

// The cartridges extract some control types under other names than GraphExplorer shows after the import.
// Relation types that mean the same (UnknownRegulation = Regulation, ExpressionControl = Expression): the ONE table is shared/relationTypes.js (an ES module, loaded like tokenizer.js);
// until it is loaded the relations are taken as they are.
let GE_NAMES = {}, aliasGroup = (n) => [String(n || '').toLowerCase()], folderName = (rel) => rel;
import(require('url').pathToFileURL(path.join(__dirname, '../shared/relationTypes.js')).href).then(m => { GE_NAMES = m.GRAPH_EXPLORER_NAMES; aliasGroup = m.aliasGroup; folderName = m.folderName; }).catch(() => { /* optional */ });
// CONTROL property names the cartridges write, as GraphExplorer shows them after the import: { <ControlType>: { <cartridge property>: <GraphExplorer name> } }
const PROP_GE_NAMES = { QuantitativeChange: { QuantitativeType: 'ChangeType' }, ProtModification: { ModificationType: 'Mechanism' } };
// Control types that MedScan knows itself: used in Rules.msgrep (ControlType="…") but not listed in ctrltype.ini [ControlType-Roles].
const BUILTIN_ROLES = { Binding: 'in-out,in-out', PromoterBinding: 'in,out' };

/** ControlType="<name>" values used by the cartridge's rules */
function usedControlTypes(cartPath) {
  const found = new Set();
  for (const f of listMsgrepFiles(cartPath)) {
    let t; try { t = readText(f); } catch { continue; }
    if (!/ControlType/i.test(t)) continue;
    for (const m of stripComments(t).matchAll(/ControlType\s*=\s*"([^"]+)"/gi)) found.add(m[1]);
  }
  return found;
}

function getInfo(cartPath) {
  const ctrl = path.join(cartPath, 'ctrltype.ini');
  const ttk  = path.join(cartPath, 'ttkconf.ini');
  const relations = {};
  if (exists(ctrl)) {
    const lines = splitLines(readText(ctrl));
    const r = sectionRange(lines, 'ControlType-Roles');
    if (r) for (let i = r.start + 1; i < r.end; i++) {
      const m = lines[i].match(/^\s*([^=;#\s][^=]*?)\s*=\s*(.+?)\s*$/);
      if (m) relations[m[1]] = m[2].replace(/\s+/g, '');
    }
  }
  const prefixes = [];
  if (exists(ttk)) for (const m of readText(ttk).matchAll(/^\s*(?:del|comp)_([A-Za-z0-9]+)\s*=/gm)) prefixes.push(m[1]);
  const builtin = [];
  // every cartridge produces UnknownRegulation (GraphExplorer: Regulation), also when its rules do not mention it
  for (const n of new Set([...usedControlTypes(cartPath), 'UnknownRegulation'])) {
    if (Object.keys(relations).some(k => k.toLowerCase() === n.toLowerCase())) continue;
    relations[n] = BUILTIN_ROLES[n] || 'in,out';
    builtin.push(n);
  }
  return { nodeTypes: readNodeTypes(cartPath), relations, builtin, aliases: GE_NAMES, usedPrefixes: [...new Set(prefixes)] };
}

// ───────────────────────────── ttkconf command prefix (del_<prefix> / comp_<prefix>) ─────────────────────────────
/**
 * The prefix is decided by the app, not typed in at the start: a relation that already has a compile command for
 * grdata/<Rel>/Patterns4sent keeps that prefix (new patterns of that relation are compiled by it); otherwise a new unique
 * one is derived from the name (first 3 letters, + a number when taken).
 */
/**
 * $ACT patterns need conceptscan output (-Icsout), all others tagged sentences (-Imsout): they are never kept in the same
 * folder and are compiled into different batches.
 *   msout: grdata/<Rel>/Patterns4sent patterns4sent.msgrep   <rel>.grbatch      output command <rel>     (-Imsout)
 *   csout: grdata/<Rel>/Patterns4cs   patterns4cs.msgrep  <rel>_cs.grbatch   output command <rel>_cs  (-Icsout)
 */
// A node type in a rule's in = / out = list can be written as the start of its MedScan ID range (6000000 = Tissue): every list read from a rule goes through typeTok.
// The table of ranges is shared/entityTypes.js (an ES module, loaded like tokenizer.js above; until it is loaded a number stays a number).
let typeTok = (x) => x;
let frameTypeOf = (t) => t;                                                                        // shared/entityTypes.js: Complex / FunctionalClass → Protein (the type a frame is written with)
let typeListHas = (list, t) => (list || []).some(y => String(y).toLowerCase() === String(t).toLowerCase());
import(require('url').pathToFileURL(path.join(__dirname, '../shared/entityTypes.js')).href).then(m => { typeTok = m.nodeTypeOfId; frameTypeOf = m.frameTypeOf; typeListHas = m.typeListHas; }).catch(() => { /* optional */ });
function layoutFor(rel, mode) {
  const cs = mode === 'csout';
  const lower = folderName(rel).toLowerCase();
  return {
    mode: cs ? 'csout' : 'msout',
    dirName: cs ? 'Patterns4cs' : 'Patterns4sent',
    patFileName: cs ? 'patterns4cs.msgrep' : 'patterns4sent.msgrep',
    batch: lower + (cs ? '_cs' : ''),
    outName: lower + (cs ? '_cs' : ''),
  };
}

function resolvePrefix(cartPath, rel, mode = 'msout') {
  const ttk = path.join(cartPath, 'ttkconf.ini');
  const text = exists(ttk) ? readText(ttk) : '';
  const lay = layoutFor(rel, mode);
  const target = `grdata/${folderName(rel)}/${lay.dirName}`.toLowerCase();
  for (const m of text.matchAll(/^\s*comp_([A-Za-z0-9]+)\s*=(.*)$/gm)) {
    if (m[2].replace(/\\/g, '/').toLowerCase().includes(target)) return { prefix: m[1], existing: true };
  }
  const used = new Set([...text.matchAll(/^\s*(?:del|comp)_([A-Za-z0-9]+)\s*=/gm)].map(m => m[1].toLowerCase()));
  const base = (folderName(rel).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 3) || 'rel') + (mode === 'csout' ? 'cs' : '');
  let p = base, n = 2;
  while (used.has(p)) p = base + n++;
  return { prefix: p, existing: false };
}

// ───────────────────────────── existing relation: regulators / targets already in use ─────────────────────────────
/**
 * Scans every *.msgrep of the cartridge for CONTROL { in=… out=… ControlType="<name>" } blocks and returns the node
 * types used as regulators (in) and targets (out). Types that occur on BOTH sides across the blocks are returned in
 * 'both' (they cannot be preselected on one side — FR 3.4).
 */
function readRelationEntities(cartPath, name) {
  const want = String(name || '').toLowerCase();
  const names = aliasGroup(want);
  const reg = new Set(), tgt = new Set();
  const sources = [];
  const typesOf = (s) => s.split(/[\s,]+/).map(typeTok).filter(x => /^[A-Za-z][A-Za-z0-9_]*$/.test(x));
  for (const f of listMsgrepFiles(cartPath)) {
    let t; try { t = stripComments(readText(f)); } catch { continue; }
    if (!/ControlType/i.test(t)) continue;
    const re = /\bCONTROL\b\s*\{/g;
    let m, hit = false;
    while ((m = re.exec(t)) !== null) {
      const open = t.indexOf('{', m.index);
      const close = findMatching(t, open);
      if (close < 0) continue;
      const body = t.slice(open + 1, close);
      const ct = body.match(/ControlType\s*=\s*"([^"]+)"/i);
      if (!ct || !names.includes(ct[1].toLowerCase())) continue;
      const inM = body.match(/\bin\s*=\s*%\w+\s*\(([^)]*)\)/i);
      const outM = body.match(/\bout\s*=\s*%\w+\s*\(([^)]*)\)/i);
      if (inM) typesOf(inM[1]).forEach(x => reg.add(x));
      if (outM) typesOf(outM[1]).forEach(x => tgt.add(x));
      hit = true;
      re.lastIndex = close;
    }
    if (hit) sources.push(path.relative(cartPath, f));
  }
  const both = [...reg].filter(x => tgt.has(x));
  return {
    regulators: [...reg].filter(x => !tgt.has(x)).sort((a, c) => a.localeCompare(c)),
    targets:    [...tgt].filter(x => !reg.has(x)).sort((a, c) => a.localeCompare(c)),
    both: both.sort((a, c) => a.localeCompare(c)),
    sources,
  };
}

// ───────────────────────────── Step 2: declare the relation type ─────────────────────────────
function declareRelation(cartPath, { name, directional }) {
  if (!NAME_RE.test(name || '')) throw new Error('Relation name must start with a letter and contain only letters, digits and underscores.');
  const info = getInfo(cartPath);
  const wanted = directional ? 'in,out' : 'in-out,in-out';
  const existing = Object.entries(info.relations).find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing[1] !== wanted)
      throw new Error(`Relation "${existing[0]}" already exists with roles ${existing[1]}; the Directional setting must match (${existing[1] === 'in,out' ? 'directional' : 'non-directional'}).`);
    return { written: false, line: `${existing[0]}=${existing[1]}`, existed: true };
  }
  const sess = getSession(cartPath, name);
  const files = [path.join(cartPath, 'ctrltype.ini'), path.join(cartPath, 'ctrltype.ini.delta')].filter(exists);
  if (!files.length) throw new Error('ctrltype.ini not found in the cartridge folder.');
  for (const f of files) {
    const text = readText(f);
    const spaced = /^\s*\w[^=\n]*\s=\s/m.test(text) && f.endsWith('.delta');
    sess.write(f, iniAppend(text, 'ControlType-Roles', [ctrlRolesLine(name, directional, spaced)]));
  }
  return { written: true, line: ctrlRolesLine(name, directional, false), existed: false };
}

/** Wizard cancelled before any pattern was generated → take the declaration back out. */
function revertDeclaration(cartPath, name) {
  const relDir = path.join(cartPath, 'grdata', folderName(name));
  if (exists(relDir)) return { reverted: false, reason: 'relation folder already exists' };
  const re = new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'mi');
  let reverted = false;
  for (const f of [path.join(cartPath, 'ctrltype.ini'), path.join(cartPath, 'ctrltype.ini.delta')].filter(exists)) {
    const text = readText(f);
    if (re.test(text)) { fs.writeFileSync(f, text.replace(re, '').replace(/(\r?\n){3,}/g, '$1$1'), 'utf8'); reverted = true; }
  }
  sessions.delete(`${cartPath}|${name}`);
  return { reverted };
}

// ───────────────────────────── Step 4: pattern validation ─────────────────────────────
// Every .msgrep file is parsed once and kept in memory (like the dictionary schema); an entry is reused while the file's modification time and size
// are unchanged, so edits made in the app or outside it are picked up on the next lookup (the folder walk and a stat per file are all it costs).
const msgrepCache = new Map();     // file → { key, raw, defs: [{ name, body, start, end }], includes: [absolute paths] } | null (unreadable)
function parsedMsgrep(f) {
  let st; try { st = fs.statSync(f); } catch { msgrepCache.delete(f); return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = msgrepCache.get(f);
  if (hit && hit.key === key) return hit;
  let raw; try { raw = readText(f); } catch { return null; }
  const t = stripComments(raw);
  const rec = { key, raw, defs: extractDefines(t), includes: [...t.matchAll(/#include\s+"([^"]+)"/g)].map(m => path.resolve(path.dirname(f), m[1])) };
  msgrepCache.set(f, rec);
  return rec;
}
/** Parse (and so cache) every macro file of the given cartridges — called when the Patterns / Pipeline screen opens. → number of files */
function warmMacros(cartPaths) {
  let n = 0;
  for (const c of cartPaths || []) for (const f of listMsgrepFiles(c)) if (parsedMsgrep(f)) n++;
  return n;
}
function buildMacroIndex(cartPath) {
  const files = listMsgrepFiles(cartPath);
  const defs = new Map();          // name → { file, body, raw }[]
  const fileOwn = new Map();       // file → Set(names defined in that file itself)
  const fileIncludes = new Map();  // file → [absolute paths it #includes]
  for (const f of files) {
    const p = parsedMsgrep(f);
    if (!p) continue;
    const own = new Set();
    for (const d of p.defs) {
      own.add(d.name);
      if (!defs.has(d.name)) defs.set(d.name, []);
      defs.get(d.name).push({ file: f, body: d.body, raw: p.raw.slice(d.start, d.end) });
    }
    fileOwn.set(f, own);
    fileIncludes.set(f, p.includes);
  }
  return { files, defs, fileOwn, fileIncludes };
}
function preferred(entries, cartPath) {
  // prefer the shallowest file (grdata\DictionaryMacros.msgrep before grdata\ce\…)
  return [...entries].sort((a, b) =>
    path.relative(cartPath, a.file).split(path.sep).length - path.relative(cartPath, b.file).split(path.sep).length)[0];
}
/** A file plus everything it #includes (transitively). */
function closureOf(idx, file, acc = new Set()) {
  if (acc.has(file)) return acc;
  acc.add(file);
  for (const inc of (idx.fileIncludes.get(file) || [])) closureOf(idx, inc, acc);
  return acc;
}
const namesOfFiles = (idx, files) => { const n = new Set(); for (const f of files) for (const x of (idx.fileOwn.get(f) || [])) n.add(x); return n; };
const depthOf = (cartPath, f) => path.relative(cartPath, f).split(path.sep).length;

/**
 * Decide how the needed macros reach the relation's wordsets file WITHOUT redefinition errors
 * (MedScan refuses "wordset macro redefinition"): whole source files are #included only when none of the
 * names they (and their own #includes) define is already defined; a macro whose file would clash is copied
 * into the wordsets file as a plain #define instead.
 * @param needed Set<string> macro names that must be defined
 * @param ws     { defined:Set, closure:Set }  what the existing wordsets file already provides
 */
function planMacros(cartPath, idx, needed, ws) {
  const defined = new Set(ws.defined);
  const closure = new Set(ws.closure);
  const remaining = new Set([...needed].filter(n => !defined.has(n)));
  const include = [];
  while (remaining.size) {
    let best = null, bestScore = 0, bestNew = null;
    for (const f of idx.files) {
      if (closure.has(f)) continue;
      const fresh = [...closureOf(idx, f)].filter(x => !closure.has(x));
      const names = namesOfFiles(idx, fresh);
      let clash = false; for (const n of names) if (defined.has(n)) { clash = true; break; }
      if (clash) continue;
      let score = 0; for (const n of remaining) if (names.has(n)) score++;
      if (score === 0) continue;
      if (score > bestScore || (score === bestScore && depthOf(cartPath, f) < depthOf(cartPath, best))) { best = f; bestScore = score; bestNew = { fresh, names }; }
    }
    if (!best) break;
    include.push(best);
    bestNew.fresh.forEach(x => closure.add(x));
    bestNew.names.forEach(n => { defined.add(n); remaining.delete(n); });
  }
  const inline = [];
  for (const n of remaining) {
    const e = preferred(idx.defs.get(n), cartPath);
    inline.push({ name: n, file: e.file, text: e.raw });
    defined.add(n);
  }
  return { include, inline };
}
/** What an existing <Rel>_wordsets.msgrep already provides. */
function wordsetsState(idx, wordsetsFile, relDir) {
  const st = { defined: new Set(), closure: new Set() };
  if (!exists(wordsetsFile)) return st;
  const t = stripComments(readText(wordsetsFile));
  for (const m of t.matchAll(/#include\s+"([^"]+)"/g)) closureOf(idx, path.resolve(relDir, m[1]), st.closure);
  for (const n of namesOfFiles(idx, st.closure)) st.defined.add(n);
  for (const d of extractDefines(t)) st.defined.add(d.name);
  return st;
}

/** Syntax / grammar of the grep notation: brackets, quantifiers, alternation, symbols. */
function checkSyntax(text) {
  const errors = [], warnings = [];
  const add = (arr, idx, message) => { const { line, col } = lineCol(text, idx); arr.push({ line, col, message }); };
  const stack = [];           // { ch, idx }
  const closeOf = { '(': ')', '[': ']', '{': '}' };
  let i = 0, prevSig = '', prevIdx = -1;     // previous significant character
  const isStartOfElement = () => prevSig === '' || prevSig === '(' || prevSig === '|';
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      const close = text.indexOf('"', i + 1), nl = text.indexOf('\n', i + 1);
      if (close < 0 || (nl >= 0 && nl < close)) { add(errors, i, 'Unterminated quoted phrase ("…").'); i++; prevSig = '"'; continue; }
      i = close + 1; prevSig = '"'; prevIdx = close; continue;
    }
    if (c === "'") { const m = text.slice(i).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length; prevSig = "'"; continue; } }
    const inBracket = stack.length && stack[stack.length - 1].ch === '[';
    const inBrace   = stack.length && stack[stack.length - 1].ch === '{';
    if (inBrace) {
      if (c === '}') {
        const open = stack.pop();
        const body = text.slice(open.idx + 1, i);
        if (!/^\s*\d+\s*(,\s*\d*\s*)?$/.test(body)) add(errors, open.idx, `Invalid quantifier {${body}} — expected {n}, {n,m} or {n,}.`);
        prevSig = '}'; prevIdx = i; i++; continue;
      }
      if (!/[\d,\s]/.test(c)) { add(errors, i, `Unexpected "${c}" inside a {…} quantifier.`); }
      i++; continue;
    }
    if (closeOf[c]) {
      // {n,m} repeats the element before it: a word, "phrase", (group), [set], or the "any word" token @.  (prevSig '@')
      if (c === '{' && !/[)\]}*+?\w"'$@]/.test(prevSig || ' ')) add(errors, i, 'Quantifier {…} with nothing to repeat.');
      stack.push({ ch: c, idx: i }); prevSig = c; prevIdx = i; i++;
      if (c === '[' && text[i] === '^') i++;      // negated set [^ … ]
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      if (!top) { add(errors, i, `Unmatched "${c}".`); i++; prevSig = c; continue; }
      if (closeOf[top.ch] !== c) {
        add(errors, i, `"${c}" does not match "${top.ch}" opened at line ${lineCol(text, top.idx).line}, column ${lineCol(text, top.idx).col}.`);
        stack.pop(); i++; prevSig = c; continue;
      }
      stack.pop();
      const inner = text.slice(top.idx + 1, i);
      if (!inner.replace(/^\^/, '').trim()) add(errors, top.idx, c === ')' ? 'Empty group "()".' : 'Empty word set "[]".');
      if (c === ')' && prevSig === '|') add(errors, prevIdx, 'Alternation "|" with nothing after it before ")".');
      prevSig = c; prevIdx = i; i++; continue;
    }
    if (c === '|') {
      if (!inBracket) {
        if (isStartOfElement()) add(errors, i, prevSig === '|' ? 'Double "||" — empty alternative.' : 'Alternation "|" with nothing before it.');
      }
      prevSig = '|'; prevIdx = i; i++; continue;
    }
    if (c === ';') {
      if (!inBracket) add(errors, i, '";" ends a statement — it must not appear inside a pattern (it would close the &SET definition early). Remove it.');
      prevSig = ';'; prevIdx = i; i++; continue;
    }
    if (c === '*' || c === '+' || c === '?') {
      if (!inBracket && isStartOfElement()) add(errors, i, `Quantifier "${c}" with nothing to repeat.`);
      prevSig = c; prevIdx = i; i++; continue;
    }
    if (c === '@') {
      const n = text[i + 1];
      if (n === '^' || n === '$' || n === '.') { i += 2; prevSig = '@'; prevIdx = i - 1; continue; }
      if (/[A-Za-z_]/.test(n || '')) { const m = text.slice(i).match(/^@[A-Za-z_]\w*/); i += m[0].length; prevSig = 'w'; prevIdx = i - 1; continue; }
      add(errors, i, 'Invalid "@" — expected @name, @^, @$ or @.'); i++; prevSig = '@'; continue;
    }
    if (c === '$' || c === '&') {
      const m = text.slice(i).match(/^[$&][A-Za-z_]\w*/);
      if (m) { i += m[0].length; prevSig = 'w'; prevIdx = i - 1; continue; }
      add(errors, i, `Invalid "${c}" — expected ${c}NAME.`); i++; prevSig = c; continue;
    }
    if (c === '^') {
      if (!(text[i - 1] === '[' )) add(warnings, i, 'Unexpected "^" (negation is only valid as "[^ … ]" or "@^").');
      i++; prevSig = '^'; continue;
    }
    prevSig = 'w'; prevIdx = i; i++;
  }
  for (const s of stack) add(errors, s.idx, `Unclosed "${s.ch}" — missing "${closeOf[s.ch]}".`);
  if (prevSig === '|') add(errors, prevIdx, 'The pattern ends with "|" — empty last alternative.');
  return { errors, warnings };
}

/**
 * Validate the wizard's pattern text (FR 4.2): macros, entity naming (@regulator/@target), syntax.
 * @returns {{ok:boolean, errors:{kind,message,line?,col?}[], warnings:[], missingMacros:string[], badEntities:string[],
 *             macroFiles:string[], foundMacros:{name,file}[], customDefines:{name,text}[], body:string, hasAct:boolean}}
 */
/** @in = @regulator, @out = @target (the names the CONTROL rules of the cartridge's own sets use: in = regulator, out = target). Accepted as alternatives of @regulator / @target
 *  when a pattern is checked, tested and stored (the stored set has the parameters @regulator, @target). Left alone when the text defines a macro with @in/@out parameters. */
function entityAliases(text) {
  if (/#define[ \t]+[&$@]\w+[ \t]*\([^)]*@(in|out)\b/.test(text || '')) return text;
  return String(text || '').replace(/@(in|out)\b/g, (m, k) => (k === 'in' ? '@regulator' : '@target'));
}

function validatePattern(cartPath, { text, relationName, setName }) {
  text = entityAliases(text);
  const errors = [], warnings = [];
  const out = (extra = {}) => ({ ok: errors.length === 0, errors, warnings, missingMacros: [], badEntities: [], macroFiles: [], inlineMacros: [], foundMacros: [], customDefines: [], body: '', hasAct: false, ...extra });
  if (!text || !text.trim()) { errors.push({ kind: 'general', message: 'The pattern text is empty.' }); return out(); }
  if (setName && !NAME_RE.test(setName)) errors.push({ kind: 'general', message: 'Pattern set name must start with a letter and contain only letters, digits and underscores.' });

  const stripped = stripComments(text);
  const userDefs = extractDefines(stripped);
  // body = text without the #define blocks (blanked, so line numbers stay right)
  let bodyChars = stripped.split('');
  for (const d of userDefs) for (let k = d.start; k < d.end; k++) if (bodyChars[k] !== '\n' && bodyChars[k] !== '\r') bodyChars[k] = ' ';
  let bodyStripped = bodyChars.join('');
  let trailingSemi = -1;
  bodyStripped = bodyStripped.replace(/;(\s*)$/, (m, ws, off) => { trailingSemi = off; return ' ' + ws; });
  if (trailingSemi >= 0) {
    const lc = lineCol(text, trailingSemi);
    warnings.push({ kind: 'syntax', line: lc.line, col: lc.col, message: 'Trailing ";" removed — it terminates a statement in Rules.msgrep, it is not part of a pattern.' });
  }
  const body = bodyStripped.trim();
  if (!body) { errors.push({ kind: 'general', message: 'The text contains only #define blocks — no extraction pattern.' }); return out({ customDefines: userDefs.map(d => ({ name: d.name, text: d.text })) }); }

  // ── FR 4.2.3 syntax of the pattern body and of each user macro ──
  const syn = checkSyntax(bodyStripped);
  syn.errors.forEach(e => errors.push({ kind: 'syntax', ...e }));
  syn.warnings.forEach(w => warnings.push({ kind: 'syntax', ...w }));
  for (const d of userDefs) {
    const s = checkSyntax(d.text);
    s.errors.forEach(e => errors.push({ kind: 'syntax', line: lineCol(stripped, d.start).line + e.line - 1, col: e.col, message: `In ${d.name}: ${e.message}` }));
  }

  // ── FR 4.2.2 entity naming ──
  const macroIndex = buildMacroIndex(cartPath);
  const { files, defs } = macroIndex;
  const userDefined = new Set(userDefs.map(d => d.name));
  const used = macroTokens(stripped.replace(/#define[ \t]+[$&@][A-Za-z_]\w*/g, ' '));
  const badEntities = [];
  const typos = [];     // @NAME that is undefined, while $NAME / &NAME exists → almost certainly the wrong prefix
  const findDef = (n) => [...defs.keys(), ...userDefined].find(k => k === n) || (BUILTIN_MACROS.has(n) ? n : undefined);
  for (const t of used) {
    if (!t.startsWith('@')) continue;
    if (t === '@regulator' || t === '@target') continue;
    if (defs.has(t) || userDefined.has(t)) continue;      // a real @macro (e.g. @increased_count)
    const base = t.slice(1);
    const alt = ['$', '&'].map(pre => pre + base).map(n => findDef(n)).find(Boolean)
             || ['$', '&'].map(pre => pre + base.toLowerCase()).map(n => findDef(n)).find(Boolean);
    if (alt) { typos.push({ used: t, alt }); continue; }
    badEntities.push(t);
  }
  for (const ty of typos) {
    const where = defs.has(ty.alt) ? path.relative(cartPath, preferred(defs.get(ty.alt), cartPath).file)
                : BUILTIN_MACROS.has(ty.alt) ? 'MedScan, built in' : 'your #define';
    errors.push({ kind: 'macro', message: `${ty.used} is not defined. Did you mean ${ty.alt} (defined in ${where})? ` +
      '"@" is only for @regulator, @target and @-macros; word sets are used as $NAME.' });
  }
  for (const m of bodyStripped.matchAll(/(?<![\w])%[a-z]\b/g)) badEntities.push(m[0]);
  const hasReg = /@regulator\b/.test(bodyStripped), hasTgt = /@target\b/.test(bodyStripped);
  if (badEntities.length) {
    const names = [...new Set(badEntities)].join(', ');
    if (hasReg && hasTgt) {
      // The entities are named correctly; the unknown @-token is an @-macro nobody defined (not an entity name).
      errors.push({ kind: 'macro', message: `${names} ${badEntities.length > 1 ? 'are' : 'is'} not defined. Your entities are fine (@regulator / @target) — ` +
        'this is an @-macro: define it with #define in the editor (or remove it).' });
    } else {
      errors.push({ kind: 'entity', message: `Entity names must be @regulator and @target. Rename: ${names}.` });
    }
  }
  if (!hasReg) errors.push({ kind: 'entity', message: 'The pattern does not use @regulator.' });
  if (!hasTgt) errors.push({ kind: 'entity', message: 'The pattern does not use @target.' });

  // ── user macros must not redefine an existing one ──
  for (const d of userDefs) if (defs.has(d.name)) {
    const where = path.relative(cartPath, preferred(defs.get(d.name), cartPath).file);
    errors.push({ kind: 'macro', message: `${d.name} is already defined in ${where} — remove your #define to reuse it, or give it another name.` });
  }

  // ── FR 4.2.1 macros: every $/&/@ macro must exist in a *.msgrep of the cartridge, or be defined in the text ──
  const missing = [];
  const foundMacros = [];
  const needed = new Set();
  const seen = new Set();
  const queue = [];
  for (const t of used) {
    if (t === '@regulator' || t === '@target' || BUILTIN_MACROS.has(t) || userDefined.has(t)) continue;
    if (t.startsWith('@') && !defs.has(t)) continue;           // already reported as a bad entity name
    queue.push(t);
  }
  while (queue.length) {
    const t = queue.shift();
    if (seen.has(t)) continue; seen.add(t);
    const entries = defs.get(t);
    if (!entries) { if (!missing.includes(t)) missing.push(t); continue; }
    const pick = preferred(entries, cartPath);
    foundMacros.push({ name: t, file: path.relative(cartPath, pick.file) });
    needed.add(t);
    // macros used inside that macro's body must be reachable too
    for (const dep of macroTokens(pick.body)) {
      if (dep === t || BUILTIN_MACROS.has(dep) || seen.has(dep) || userDefined.has(dep)) continue;
      if (defs.has(dep)) queue.push(dep);
    }
  }
  if (missing.length) errors.push({ kind: 'macro', message: `Undefined macro(s): ${missing.join(', ')}. Define each with #define in the editor, or use an existing one.` });

  const idx = { files, defs, fileOwn: macroIndex.fileOwn, fileIncludes: macroIndex.fileIncludes };
  const relDir = path.join(cartPath, 'grdata', folderName(relationName || '_none_'));
  const plan = planMacros(cartPath, idx, needed, wordsetsState(idx, path.join(relDir, `${folderName(relationName || '_none_')}_wordsets.msgrep`), relDir));
  const hasAct = ACT_RE.test(stripped);
  return out({
    missingMacros: missing, badEntities: [...new Set(badEntities)], foundMacros, hasAct,
    ttk: resolvePrefix(cartPath, relationName || 'rel', hasAct ? 'csout' : 'msout'),
    macroFiles: plan.include.map(f => path.relative(cartPath, f)),
    inlineMacros: plan.inline.map(x => ({ name: x.name, from: path.relative(cartPath, x.file), text: x.text })),
    customDefines: userDefs.map(d => ({ name: d.name, text: d.text })),
    body: body,
  });
}

// ───────────────────────────── Step 5: generate / update the msgrep files ─────────────────────────────
function orderMacroFiles(cartPath, files) {
  // files providing macros that other files use come first
  const abs = files.map(f => path.join(cartPath, f));
  const provides = new Map(), uses = new Map();
  for (const f of abs) {
    let t = ''; try { t = stripComments(readText(f)); } catch { }
    const defs = extractDefines(t);
    provides.set(f, new Set(defs.map(d => d.name)));
    uses.set(f, macroTokens(defs.map(d => d.body).join('\n')));
  }
  const ordered = [], left = new Set(abs);
  while (left.size) {
    let picked = null;
    for (const f of left) {
      const deps = [...left].filter(o => o !== f && [...uses.get(f)].some(u => provides.get(o).has(u) && !provides.get(f).has(u)));
      if (!deps.length) { picked = f; break; }
    }
    if (!picked) picked = [...left].sort()[0];      // cycle: stable fallback
    ordered.push(picked); left.delete(picked);
  }
  return ordered.map(f => path.relative(cartPath, f));
}

/** Rebuild a pattern-set body as 'alt1 | alt2 | …': stray top-level ';' (and empty alternatives left by them) disappear. */
function normalizeSetBody(raw, stripped, eol) {
  const cuts = [];
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '"') { i++; while (i < stripped.length && stripped[i] !== '"' && stripped[i] !== '\n') i++; continue; }
    if (c === "'") { const m = stripped.slice(i).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length - 1; continue; } }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === '|' || c === ';')) cuts.push(i);
  }
  const segs = [];
  let prev = 0;
  for (const k of [...cuts, stripped.length]) {
    if (stripped.slice(prev, k).trim()) segs.push(raw.slice(prev, k).trim());
    prev = k + 1;
  }
  return segs.join(`${eol}|${eol}`);
}

// A ConceptScan pattern matches the "&" between the parts of a pseudo-sentence: written as $ACT or as the literal & ("&", '&', [&]); &NAME is a set reference, not a literal
const ACT_RE = /\$ACT\b|(?<![\w&])&(?![A-Za-z_])/;
function setMode(body) { return ACT_RE.test(body) ? 'csout' : 'msout'; }

/** In/out node-type signatures of the CONTROL rules that apply &set (Rules.msgrep text, comments stripped). */
function rulesUsingSet(rulesText, set) {
  const out = [];
  const t = stripComments(rulesText || '');
  const re = /\bCONTROL\b\s*\{/g;
  let m;
  const typesOf = (s) => s.split(/[\s,]+/).map(typeTok).filter(x => /^[A-Za-z][A-Za-z0-9_]*$/.test(x)).map(x => x.toLowerCase()).sort();
  while ((m = re.exec(t)) !== null) {
    const open = t.indexOf('{', m.index);
    const close = findMatching(t, open);
    if (close < 0) continue;
    const body = t.slice(open + 1, close);
    const tail = t.slice(close + 1).match(/^\s*:\s*&(\w+)\s*\(/);
    re.lastIndex = close;
    if (!tail || tail[1].toLowerCase() !== set.toLowerCase()) continue;
    const inM = body.match(/\bin\s*=\s*%\w+\s*\(([^)]*)\)/i), outM = body.match(/\bout\s*=\s*%\w+\s*\(([^)]*)\)/i);
    const props = {};                                                                 // the quoted properties of the rule (Effect = "positive" ...), not its ControlType
    for (const pm of body.matchAll(/\b(\w+)\s*=\s*"([^"]*)"/g)) if (pm[1].toLowerCase() !== 'controltype') props[pm[1].toLowerCase()] = pm[2].toLowerCase();
    out.push({ regs: typesOf(inM ? inM[1] : ''), tgts: typesOf(outM ? outM[1] : ''), props });
  }
  return out;
}

/**
 * A pattern set is bound to ONE regulator/target type signature by its CONTROL rule. If &set already exists and its
 * rules use other node types, the new pattern must not join it (it would then also fire for those types): the next free
 * name SET_2, SET_3, … is used instead (an earlier one with exactly the same signature is reused).
 */
function resolveSetName(cartPath, rel, set, regulators, targets, mode, props = []) {
  const lay = layoutFor(rel, mode);
  const patDir = path.join(cartPath, 'grdata', folderName(rel), lay.dirName);
  const pf = path.join(patDir, lay.patFileName);
  if (!exists(pf)) return set;
  const patterns = stripComments(readText(pf));
  const rf = path.join(patDir, 'Rules.msgrep');
  const rules = exists(rf) ? readText(rf) : '';
  const key = (a) => [...a].map(x => x.toLowerCase()).sort().join(',');
  const want = `${key(regulators)}|${key(targets)}`;
  const wantProps = Object.fromEntries(props.map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()]));       // the CONTROL properties of the new rule (Effect ...)
  const sameProps = (u) => { const a = Object.keys(u.props || {}), b = Object.keys(wantProps); return a.length === b.length && b.every(k => u.props[k] === wantProps[k]); };
  for (let n = 1; n < 1000; n++) {
    const cand = n === 1 ? set : `${set}_${n}`;
    const defined = new RegExp(`#define[ \\t]+&${cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\(`).test(patterns);
    if (!defined) return cand;
    const used = rulesUsingSet(rules, cand);
    // a set is bound to ONE frame: the same node types AND the same properties (a pattern for Effect = negative never joins the set of Effect = positive)
    if (!used.length || used.some(u => `${u.regs.join(',')}|${u.tgts.join(',')}` === want && sameProps(u))) return cand;
  }
  throw new Error('Too many pattern sets with the same base name.');
}

/**
 * Append an alternative ("|") to the existing definition of &set in a patterns text. null when &set is not defined there.
 * { text, dup }: dup = the alternative was already part of the set (the set is only cleaned up).
 */
function appendToSetText(pText, set, bodyText, plainBody, pEol, fileLabel) {
  const strippedP = stripComments(pText);
  const defRe = new RegExp(`#define[ \\t]+&${set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\(`);
  const dm = defRe.exec(strippedP);
  if (!dm) return null;
  const paramsOpen = strippedP.indexOf('(', dm.index + dm[0].length - 1);
  const paramsClose = findMatching(strippedP, paramsOpen);
  let j = paramsClose + 1;
  while (j < strippedP.length && /\s/.test(strippedP[j])) j++;
  if (strippedP[j] !== '(') throw new Error(`Cannot parse the existing definition of &${set} in ${fileLabel}.`);
  const close = findMatching(strippedP, j);
  if (close < 0) throw new Error(`The existing definition of &${set} in ${fileLabel} has unbalanced brackets.`);
  const existingBody = strippedP.slice(j + 1, close);
  // clean the previous version first: a leftover ";" (or empty "|" alternative) must not stay in the middle of the set
  const cleaned = normalizeSetBody(pText.slice(j + 1, close), existingBody, pEol);
  const head = pText.slice(0, j + 1), tail = pText.slice(close);
  if (cleaned.replace(/\s+/g, ' ').includes(plainBody.replace(/\s+/g, ' ').trim())) return { text: head + pEol + cleaned + pEol + tail, dup: true };
  return { text: head + pEol + (cleaned ? cleaned + pEol + '|' + pEol : '') + bodyText + pEol + tail, dup: false };
}

/** msgrep can only build output terms for node types listed in [NodeType-IsFrame]; add the missing ones (nodetype.ini + .delta). */
function ensureFrames(cartPath, types, sess, note) {
  const frameAdded = [];
  for (const f of [path.join(cartPath, 'nodetype.ini'), path.join(cartPath, 'nodetype.ini.delta')].filter(exists)) {
    let t = readText(f);
    const spaced = f.endsWith('.delta') && /^\s*\w[^=\n]*\s=\s/m.test(t);
    const missing = [...new Set(types)].filter(x => iniGet(t, 'NodeType-IsFrame', x) === null);
    if (!missing.length) continue;
    t = iniAppend(t, 'NodeType-IsFrame', missing.map(x => `${x}${spaced ? ' = ' : '='}1`));
    sess.write(f, t);
    note(f, 'updated');
    for (const x of missing) if (!frameAdded.includes(x)) frameAdded.push(x);
  }
  return frameAdded;
}

function generateFiles(cartPath, opts) {
  if (opts.placement) return generateInExistingSet(cartPath, opts);
  const { relationName: rel, setName, regulators, targets, patternText } = opts;
  const cloneProps = Object.entries(opts.cloneProps || {}).filter(([k, v]) => /^\w+$/.test(k) && !/["\r\n]/.test(String(v)));
  if (!NAME_RE.test(rel || '')) throw new Error('Invalid relation name.');
  if (!regulators?.length || !targets?.length) throw new Error('Select at least one regulator and one target node type.');
  const requestedSet = setName && setName.trim() ? setName.trim() : rel.toUpperCase();
  const newMode = setMode(stripComments(patternText || ''));
  const lay = layoutFor(rel, newMode);
  const set = resolveSetName(cartPath, rel, requestedSet, regulators, targets, newMode, cloneProps);

  const v = validatePattern(cartPath, { text: patternText, relationName: rel, setName: set });
  if (!v.ok) throw new Error('The pattern did not pass validation:\n' + v.errors.map(e => '• ' + e.message).join('\n'));

  const sess = getSession(cartPath, rel);
  const fol = folderName(rel);                                                // the relation's folder name (UnknownRegulation → Regulation)
  const relDir = path.join(cartPath, 'grdata', fol);
  const patDir = path.join(relDir, lay.dirName);
  fs.mkdirSync(patDir, { recursive: true });                                  // FR 5.1
  const wordsetsFile = path.join(relDir, `${fol}_wordsets.msgrep`);
  const patternsFile = path.join(patDir, lay.patFileName);
  const rulesFile = path.join(patDir, 'Rules.msgrep');
  const patternsInclude = lay.patFileName;
  const results = [];
  const note = (file, action) => results.push({ file: path.relative(cartPath, file), action });
  let patternsText = exists(patternsFile) ? readText(patternsFile) : null;

  // ── FR 5.2 wordsets: includes of the macro source files + the user's custom macros ──
  const eolNew = '\r\n';
  const incFiles = orderMacroFiles(cartPath, v.macroFiles);
  const relFromRelDir = (f) => path.relative(relDir, path.join(cartPath, f)).split(path.sep).join('/');
  let wsText = exists(wordsetsFile) ? readText(wordsetsFile) : null;
  const wsEol = wsText ? eolOf(wsText) : eolNew;
  if (!wsText) wsText = `// ${rel} — macro dictionaries (generated by NLPmanager)`;
  const addedIncludes = [];
  for (const f of incFiles) {
    const inc = relFromRelDir(f);
    if (!new RegExp(`#include\\s+"${inc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(wsText)) {
      wsText += `${wsEol}#include "${inc}"`; addedIncludes.push(inc);
    }
  }
  const existingDefs = new Map(extractDefines(stripComments(wsText)).map(d => [d.name, d.text.replace(/\s+/g, ' ').trim()]));
  // macros whose source file could not be #included without a redefinition clash are copied in as plain definitions
  const inlined = [];
  for (const im of v.inlineMacros) {
    if (existingDefs.has(im.name)) continue;
    wsText += `${wsEol}${wsEol}// from ${im.from.split(path.sep).join('/')}${wsEol}${im.text.trim().replace(/\r?\n/g, wsEol)}`;
    inlined.push(im.name);
  }
  for (const d of v.customDefines) {
    const norm = d.text.replace(/\s+/g, ' ').trim();
    if (existingDefs.has(d.name)) {
      if (existingDefs.get(d.name) !== norm) throw new Error(`${d.name} is already defined (differently) in ${fol}_wordsets.msgrep.`);
      continue;
    }
    wsText += `${wsEol}${wsEol}${d.text.trim().replace(/\r?\n/g, wsEol)}`;
  }
  wsText = wsText.replace(/\s*$/, '') + wsEol;
  const wsBefore = exists(wordsetsFile) ? readText(wordsetsFile) : null;
  if (wsBefore !== wsText) { sess.write(wordsetsFile, wsText); note(wordsetsFile, wsBefore === null ? 'created' : 'updated'); } else note(wordsetsFile, 'unchanged');

  // ── FR 5.3 patterns4sent.msgrep ──
  const pEol = patternsText ? eolOf(patternsText) : eolNew;
  const bodyText = v.body.replace(/\r?\n/g, pEol);
  const incLine = `#include "../${fol}_wordsets.msgrep"`;
  let pText = patternsText ?? `// ${rel} — extraction patterns (generated by NLPmanager)${pEol}`;
  if (!new RegExp(`#include\\s+"\\.\\./${fol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_wordsets\\.msgrep"`, 'i').test(pText)) {
    pText = pText.replace(/\s*$/, '') + pEol + incLine + pEol;
  }
  let setAction;
  const ap = appendToSetText(pText, set, bodyText, v.body, pEol, lay.patFileName);
  if (ap) {
    pText = ap.text;
    setAction = ap.dup && pText === patternsText ? 'unchanged' : 'updated';          // existing pattern set: new alternative appended with "|"  (FR 5.3)
  } else {
    pText = pText.replace(/\s*$/, '') + `${pEol}${pEol}#define &${set}(@regulator, @target)(${pEol}${bodyText}${pEol});${pEol}`;
    setAction = 'created';
  }
  const pBefore = patternsText;
  if (pBefore !== pText) { sess.write(patternsFile, pText); note(patternsFile, pBefore === null ? 'created' : 'updated'); } else note(patternsFile, 'unchanged');

  // ── FR 5.4 Rules.msgrep ──
  const ctl = (eol) => [
    'CONTROL', '{',
    ` out  = %tar(${targets.join(', ')})`,
    ` in = %reg(${regulators.join(', ')})`,
    ` ControlType = "${rel}"`,
    ...cloneProps.map(([k, v]) => ` ${k} = "${v}"`),
    `} : &${set}(%reg, %tar);`,
  ].join(eol);
  let rText = exists(rulesFile) ? readText(rulesFile) : null;
  const rEol = rText ? eolOf(rText) : eolNew;
  const block = ctl(rEol);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const incRe = new RegExp(`#include\\s+"${patternsInclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
  if (rText === null) rText = `#include "${patternsInclude}"${rEol}${rEol}`;
  else if (!incRe.test(rText)) rText = `#include "${patternsInclude}"${rEol}${rEol}` + rText;
  const rBefore = exists(rulesFile) ? readText(rulesFile) : null;
  if (!norm(stripComments(rText)).includes(norm(block))) rText = rText.replace(/\s*$/, '') + rEol + rEol + block + rEol;
  if (rBefore !== rText) { sess.write(rulesFile, rText); note(rulesFile, rBefore === null ? 'created' : 'updated'); } else note(rulesFile, 'unchanged');

  // ── msgrep can only build output terms for node types listed in [NodeType-IsFrame]; add the missing ones ──
  const frameAdded = ensureFrames(cartPath, [...regulators, ...targets], sess, note);

  return { set, requestedSet, frameAdded, setRenamed: set !== requestedSet, setAction, mode: newMode, files: results, addedIncludes, inlined, relDir: path.relative(cartPath, relDir) };
}

// ───────────────────────────── "Suggest pattern": add to a pattern set that already exists in the cartridge ─────────────────────────────
/** CONTROL { … ControlType="<rel>" … } : &SET(…); blocks of a (comment-stripped) text: { ordinal, open, close, body, set }. */
function controlBlocksOf(t, want) {
  const out = [];
  const names = aliasGroup(want);
  const re = /\bCONTROL\b\s*\{/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const open = t.indexOf('{', m.index);
    const close = findMatching(t, open);
    if (close < 0) continue;
    re.lastIndex = close;
    const body = t.slice(open + 1, close);
    const ct = body.match(/ControlType\s*=\s*"([^"]+)"/i);
    if (!ct || !names.includes(ct[1].toLowerCase())) continue;
    const tail = t.slice(close + 1).match(/^\s*:\s*&(\w+)\s*\(([^)]*)\)/);
    if (!tail) continue;
    out.push({ ordinal: out.length, open, close, body, set: tail[1], args: tail[2].split(',').map(x => x.trim().replace(/^%/, '')) });
  }
  return out;
}
const dirKey = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
const typesIn = (s) => String(s || '').split(/[\s,]+/).map(typeTok).filter(x => /^[A-Za-z][A-Za-z0-9_]*$/.test(x));
const listOf = (body, key) => { const m = body.match(new RegExp(`\\b${key}\\s*=\\s*%\\w+\\s*\\(([^)]*)\\)`, 'i')); return m ? typesIn(m[1]) : []; };

/** folder (grdata/…) → ttkconf command prefix that compiles it (comp_<prefix>=…-H<folder> -B<batch>) */
function compileCommands(cartPath) {
  const map = new Map();
  const wild = [];       // comp_cs_*=${MSGREP} -Hgrdata/cs/$* -B$*.grbatch  → folder grdata/cs/p3 is compiled by comp_cs_p3 (batch p3.grbatch)
  for (const f of ['ttkconf.ini', 'ttkconf.ini.delta'].map(x => path.join(cartPath, x)).filter(exists)) {
    for (const m of readText(f).matchAll(/^\s*comp_([A-Za-z0-9_]*)(\*?)\s*=\s*(.*)$/gm)) {
      const h = m[3].match(/-H\s*(\S+)/), b = m[3].match(/-B\s*(\S+)/);
      if (!h) continue;
      if (m[2] === '*' || m[3].includes('$*')) {
        if (m[2] === '*' && h[1].includes('$*')) {
          const re = new RegExp('^' + dirKey(h[1]).split('$*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$');
          wild.push({ re, prefix: m[1], batch: b ? b[1] : null });
        }
        continue;
      }
      if (!map.has(dirKey(h[1]))) map.set(dirKey(h[1]), { prefix: m[1], batch: b ? b[1] : null });
    }
  }
  const get = map.get.bind(map);
  map.get = (dir) => {
    const hit = get(dir);
    if (hit) return hit;
    for (const w of wild) { const mm = w.re.exec(dir); if (mm) return { prefix: w.prefix + mm[1], batch: w.batch ? w.batch.split('$*').join(mm[1]) : null }; }
    return undefined;
  };
  return map;
}
/** folder → msgrep input mode of its output command in locscan.ini */
function outputModes(cartPath) {
  const map = new Map();
  for (const f of ['locscan.ini', 'locscan.ini.delta'].map(x => path.join(cartPath, x)).filter(exists)) {
    for (const line of splitLines(readText(f))) {
      const i = line.match(/-I\s*(msout|csout)/i), h = line.match(/-H\s*(\S+)/);
      // an msgrep rule without -I reads msout (msgrep: "-I ifmt Input format (msout or csout); defaults to msout")
      const rule = i || /\$\{MSGREP\}|\bmsgrep\b/i.test(line);
      if (rule && h && !map.has(dirKey(h[1]))) map.set(dirKey(h[1]), i ? i[1].toLowerCase() : 'msout');
    }
  }
  return map;
}

/** The pattern folders (as dirKey) whose output command belongs to allpats = $(…) of locscan.ini — the ones the pipeline's pattern step runs. */
function pipelineDirs(cartPath) {
  const cmds = new Map();
  let all = '';
  for (const f of ['locscan.ini', 'locscan.ini.delta'].map(x => path.join(cartPath, x)).filter(exists)) {
    for (const line of splitLines(readText(f))) {
      const m = line.match(/^\s*([\w.+-]+)\s*=(.*)$/);
      if (!m) continue;
      if (/^allpats$/i.test(m[1])) all = m[2]; else if (!cmds.has(m[1])) cmds.set(m[1], m[2]);
    }
  }
  const names = all.replace(/^\s*\$\(/, '').replace(/\)\s*$/, '').split('+').map(s => s.split(':')[0].trim()).filter(Boolean);
  const dirs = new Set();
  for (const n of names) { const h = (cmds.get(n) || '').match(/-H\s*(\S+)/); if (h) dirs.add(dirKey(h[1])); }
  return dirs;
}

/**
 * The pattern sets of relation <rel> that already exist in the cartridge, wherever they live: one entry per CONTROL
 * rule that applies a &SET. Only sets whose folder is compiled by a ttkconf command are returned (they can be rebuilt).
 * [{ id, ruleFile, ordinal, set, setFile, props, regs, tgts, mode, prefix, sample }]
 */
function findExistingSets(cartPath, rel) {
  const want = String(rel || '').toLowerCase();
  const idx = buildMacroIndex(cartPath);
  const cmds = compileCommands(cartPath), modes = outputModes(cartPath);
  const out = [];
  for (const f of idx.files) {
    let raw; try { raw = readText(f); } catch { continue; }
    if (!/ControlType/i.test(raw)) continue;
    const blocks = controlBlocksOf(stripComments(raw), want);
    if (!blocks.length) continue;
    const dir = dirKey(path.relative(cartPath, path.dirname(f)));
    const cmd = cmds.get(dir);
    if (!cmd) continue;
    const reach = closureOf(idx, path.resolve(f));
    for (const b of blocks) {
      const entries = (idx.defs.get('&' + b.set) || []);
      const e = entries.find(x => reach.has(path.resolve(x.file))) || (entries.length ? preferred(entries, cartPath) : null);
      if (!e) continue;
      const props = {};
      for (const m of b.body.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)) if (!/^ControlType$/i.test(m[1])) props[m[1]] = m[2];
      // the set's own parameter names (e.g. &INCREASED_ABUNDANCE(@in, @out)) — which one receives the regulator, which the target
      const pm = e.raw.match(/#define[ \t]+&\w+[ \t]*\(([^)]*)\)/);
      const params = pm ? pm[1].split(',').map(x => x.trim()) : [];
      const varOf = (key) => { const m = b.body.match(new RegExp('\\b' + key + '\\s*=\\s*%(\\w+)\\s*\\(', 'i')); return m ? m[1] : null; };
      const paramReg = params[b.args.indexOf(varOf('in'))], paramTgt = params[b.args.indexOf(varOf('out'))];
      if (!paramReg || !paramTgt || paramReg === paramTgt) continue;
      const sample = e.body.replace(/\s+/g, ' ').trim();
      const rel2 = path.relative(cartPath, f);
      out.push({
        id: `${rel2}#${b.ordinal}`, ruleFile: rel2, ordinal: b.ordinal, set: b.set, setFile: path.relative(cartPath, e.file), props,
        regs: listOf(b.body, 'in'), tgts: listOf(b.body, 'out'), paramReg, paramTgt,
        mode: modes.get(dir) || (ACT_RE.test(stripComments(e.body)) ? 'csout' : 'msout'), prefix: cmd.prefix, sample: sample.slice(0, 260),
      });
    }
  }
  return out;
}

/** Read-only view of an existing set: the CONTROL frame (with its file) and the pattern set it applies. */
function viewExistingSet(cartPath, rel, id) {
  const cand = findExistingSets(cartPath, rel).find(c => c.id === id);
  if (!cand) throw new Error('The pattern set no longer exists.');
  const ruleRaw = readText(path.join(cartPath, cand.ruleFile));
  const b = controlBlocksOf(stripComments(ruleRaw), String(rel).toLowerCase())[cand.ordinal];
  if (!b) throw new Error('The CONTROL rule was not found any more.');
  const start = ruleRaw.lastIndexOf('CONTROL', b.open);
  const end = ruleRaw.indexOf(';', b.close);
  const idx = buildMacroIndex(cartPath);
  const setFile = path.join(cartPath, cand.setFile);
  const e = (idx.defs.get('&' + cand.set) || []).find(x => path.resolve(x.file) === path.resolve(setFile));
  return {
    set: cand.set, ruleFile: cand.ruleFile, setFile: cand.setFile, mode: cand.mode,
    frame: ruleRaw.slice(start, end >= 0 ? end + 1 : b.close + 1).replace(/\r\n/g, '\n'),
    patterns: e ? e.raw.replace(/\r\n/g, '\n') : '',
  };
}

/** The pattern sets of relation <rel> in the OTHER cartridges (siblings of this one): [{ cartridge, path, sets }] — only cartridges that have some. */
function otherCartridgeSets(cartPath, rel) {
  const out = [];
  const parent = path.dirname(cartPath);
  for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
    const p = path.join(parent, d.name);
    if (!d.isDirectory() || d.name.length <= 4 || !d.name.toLowerCase().endsWith('.bin') || path.resolve(p) === path.resolve(cartPath) || !exists(path.join(p, 'nodetype.ini'))) continue;
    try { const sets = findExistingSets(p, rel); if (sets.length) out.push({ cartridge: d.name.slice(0, -4), path: p, sets }); } catch { /* unreadable cartridge */ }
  }
  return out;
}

/** Add node types to the in = %x(…) / out = %x(…) lists of one CONTROL rule. */
function extendRuleTypes(raw, rel, ordinal, regulators, targets) {
  const t = stripComments(raw);
  const b = controlBlocksOf(t, String(rel).toLowerCase())[ordinal];
  if (!b) throw new Error('The CONTROL rule of the chosen pattern set was not found any more.');
  const has = (list, x) => typeListHas(list, x);                    // a frame's Protein also takes a Complex / FunctionalClass (the same test as frameFit of the wizard and the other checks here)
  const regs = listOf(b.body, 'in'), tgts = listOf(b.body, 'out');
  const addRegs = regulators.filter(x => !has(regs, x)), addTgts = targets.filter(x => !has(tgts, x));
  // a type already allowed on its own side needs no change (a rule may have the same type on both sides, e.g. in = Protein, SmallMol / out = SmallMol)
  if (addRegs.length || addTgts.length) throw new Error(`The rule of &${b.set} does not allow ${[...addRegs.map(x => x + ' as regulator (in)'), ...addTgts.map(x => x + ' as target (out)')].join(', ')} — a rule is never extended: choose a set whose rule allows them or create a new one.`);
  const clash = [...addRegs.filter(x => has(tgts, x)), ...addTgts.filter(x => has(regs, x))];
  if (clash.length) throw new Error(`The rule of &${b.set} uses ${[...new Set(clash)].join(', ')} on the other side (regulator/target) — choose another set or create a new one.`);
  const edits = [];
  for (const [key, add] of [['in', addRegs], ['out', addTgts]]) {
    if (!add.length) continue;
    const m = new RegExp(`\\b${key}\\s*=\\s*%\\w+\\s*\\(([^)]*)\\)`, 'i').exec(b.body);
    if (!m) throw new Error(`Cannot find "${key} = %x(…)" in the rule of &${b.set}.`);
    const inner = m[1], sep = inner.includes(',') ? ', ' : ' ';
    const pos = b.open + 1 + m.index + m[0].lastIndexOf('(') + 1;
    edits.push({ pos, len: inner.length, text: inner.replace(/\s+$/, '') + (inner.trim() ? sep : '') + add.join(sep) });
  }
  let text = raw;
  for (const e of edits.sort((x, y) => y.pos - x.pos)) text = text.slice(0, e.pos) + e.text + text.slice(e.pos + e.len);
  return { text, addRegs, addTgts };
}

function generateInExistingSet(cartPath, opts) {
  const { relationName: rel, regulators, targets, patternText, placement } = opts;
  if (!NAME_RE.test(rel || '')) throw new Error('Invalid relation name.');
  if (!regulators?.length || !targets?.length) throw new Error('Select at least one regulator and one target node type.');
  const cand = findExistingSets(cartPath, rel).find(c => c.id === placement.id);
  if (!cand) throw new Error('The chosen pattern set no longer exists (or its folder has no compile command).');
  const newMode = setMode(stripComments(patternText || ''));
  if (newMode !== cand.mode) throw new Error(newMode === 'csout'
    ? `&${cand.set} holds sentence-level patterns (-Imsout): a $ACT (ConceptScan) pattern cannot join it; it gets its own set in a Patterns4cs folder.`
    : `&${cand.set} holds ConceptScan patterns (-Icsout): a pattern without $ACT cannot join it.`);
  const v = validatePattern(cartPath, { text: patternText, relationName: rel, setName: cand.set });
  if (!v.ok) throw new Error('The pattern did not pass validation:\n' + v.errors.map(e => '• ' + e.message).join('\n'));

  const sess = getSession(cartPath, rel);
  const results = [];
  const note = (file, action, detail) => results.push({ file: path.relative(cartPath, file), action, detail });
  const setFile = path.join(cartPath, cand.setFile), ruleFile = path.join(cartPath, cand.ruleFile);

  // ── the set definition: macros it needs, then the new alternative appended with "|" ──
  let pText = readText(setFile);
  const eol = eolOf(pText);
  const idx = buildMacroIndex(cartPath);
  const reach = closureOf(idx, path.resolve(setFile), closureOf(idx, path.resolve(ruleFile)));   // the set is compiled in the context of its Rules file
  const addedIncludes = [], inlined = [];
  let pre = '';
  for (const f of orderMacroFiles(cartPath, v.macroFiles)) {
    const abs = path.resolve(cartPath, f);
    if (reach.has(abs)) continue;
    const inc = path.relative(path.dirname(setFile), abs).split(path.sep).join('/');
    pre += `#include "${inc}"${eol}`; addedIncludes.push(inc);
  }
  const have = new Set(extractDefines(stripComments(pText)).map(d => d.name));
  for (const im of v.inlineMacros) if (!have.has(im.name)) { pre += `${im.text.trim().replace(/\r?\n/g, eol)}${eol}${eol}`; inlined.push(im.name); }
  for (const d of v.customDefines) if (!have.has(d.name)) pre += `${d.text.trim().replace(/\r?\n/g, eol)}${eol}${eol}`;
  const plain = v.body.replace(/@(regulator|target)\b/g, (m) => ((m === '@regulator') !== !!placement.swap ? cand.paramReg : cand.paramTgt));   // swap: a non-directional relation whose types fit the frame the other way round
  const bodyText = plain.replace(/\r?\n/g, eol);
  const ap = appendToSetText(pText, cand.set, bodyText, plain, eol, path.basename(setFile));
  if (!ap) throw new Error(`&${cand.set} is not defined in ${cand.setFile}.`);
  let newText = ap.text;
  if (pre) {                                                                   // includes / macros go in front of the set definition
    const at = newText.search(new RegExp(`#define[ \\t]+&${cand.set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\(`));
    newText = newText.slice(0, at) + pre + newText.slice(at);
  }
  const setChanged = newText !== pText;
  if (setChanged) sess.write(setFile, newText);

  // ── the rule: allow the new regulator / target types ──
  const rRaw = readText(ruleFile);
  const ext = extendRuleTypes(rRaw, rel, cand.ordinal, placement.swap ? targets : regulators, placement.swap ? regulators : targets);
  const ruleChanged = ext.text !== rRaw;
  if (ruleChanged) sess.write(ruleFile, ext.text);
  // one row per file: the pattern set and the CONTROL frame may live in the same file
  if (path.resolve(setFile) === path.resolve(ruleFile)) {
    note(setFile, setChanged || ruleChanged ? 'updated' : 'unchanged',
      `pattern added to &${cand.set}${ruleChanged ? '; CONTROL frame node types extended' : '; the CONTROL frame (in the same file) is unchanged'}`);
  } else {
    note(setFile, setChanged ? 'updated' : 'unchanged', `pattern set &${cand.set}`);
    note(ruleFile, ruleChanged ? 'updated' : 'unchanged', ruleChanged ? 'CONTROL frame: node types extended' : 'CONTROL frame: unchanged');
  }

  const frameAdded = ensureFrames(cartPath, [...regulators, ...targets], sess, note);
  return {
    set: cand.set, requestedSet: cand.set, frameAdded, setRenamed: false, setAction: ap.dup && newText === pText ? 'unchanged' : 'updated', mode: cand.mode,
    files: results, addedIncludes, inlined, relDir: path.dirname(cand.ruleFile), placement: { id: cand.id, set: cand.set, prefix: cand.prefix },
    ruleExtended: { regulators: ext.addRegs, targets: ext.addTgts },
  };
}

async function compileExistingSet(cartPath, { relationName: rel, placement }) {
  const cand = findExistingSets(cartPath, rel).find(c => c.id === placement.id);
  if (!cand) throw new Error('The chosen pattern set no longer exists.');
  const ttkExe = path.join(cartPath, 'ttkconf.exe');
  if (!exists(ttkExe)) throw new Error('ttkconf.exe not found in the cartridge folder.');
  const sess = getSession(cartPath, rel);
  const cmd = compileCommands(cartPath).get(dirKey(path.dirname(cand.ruleFile)));
  const log = [];
  const del = await run(`"${ttkExe}" del_${cand.prefix}`, cartPath);
  log.push(`ttkconf del_${cand.prefix} → exit ${del.code}`);
  const logName = `comp_${cand.prefix}.log`;
  const comp = await run(`"${ttkExe}" comp_${cand.prefix} 2>"${logName}"`, cartPath);
  log.push(`ttkconf comp_${cand.prefix} → exit ${comp.code}`);
  let compLog = ''; try { compLog = readText(path.join(cartPath, logName)); } catch { }
  const batch = cmd?.batch ? path.join(cartPath, cmd.batch) : null;
  if (comp.code !== 0 || (batch && !exists(batch))) {
    sess.rollback();
    sessions.delete(`${cartPath}|${rel}`);
    return { ok: false, log, compLog: (compLog + '\n' + comp.out + '\n' + comp.err).trim(),
             error: `Compilation failed (exit ${comp.code}${batch && !exists(batch) ? `, ${cmd.batch} was not produced` : ''}). All changes were rolled back.` };
  }
  log.push(`${cand.prefix}: the output command of this folder already exists in locscan.ini — nothing to register`);
  sessions.delete(`${cartPath}|${rel}`);
  return { ok: true, prefix: cand.prefix, log, compLog: compLog.trim(), backupDir: path.relative(cartPath, sess.dir) };
}

// ───────────────────────────── Pattern File Editor: open / check / save one .msgrep file ─────────────────────────────
function msgrepPath(cartPath, file) {
  const rel = path.normalize(String(file || '')).replace(/^[\\/]+/, '');
  if (path.isAbsolute(rel) || rel.startsWith('..') || !/\.msgrep$/i.test(rel)) throw new Error('Only .msgrep files inside the cartridge can be edited here.');
  const abs = path.join(cartPath, rel);
  return { rel, abs };
}
/** → { text (line ends as \n), eol, mtime } */
function readMsgrepFile(cartPath, file) {
  const { abs } = msgrepPath(cartPath, file);
  const raw = readText(abs);
  return { text: raw.replace(/\r\n/g, '\n'), eol: eolOf(raw), mtime: fs.statSync(abs).mtimeMs };
}
/** Saves the edited text (original line ends restored); a copy of the file goes to _relation_backups first. A file that changed on disk since it was opened is not overwritten unless force. */
function saveMsgrepFile(cartPath, { file, text, eol, mtime, force }) {
  const { rel, abs } = msgrepPath(cartPath, file);
  if (!force && mtime != null && exists(abs) && Math.abs(fs.statSync(abs).mtimeMs - mtime) > 1) throw new Error('CHANGED_ON_DISK');
  const bk = path.join(cartPath, '_relation_backups', new Date().toISOString().replace(/[:.]/g, '-') + '_EditFile', rel);
  fs.mkdirSync(path.dirname(bk), { recursive: true });
  if (exists(abs)) fs.copyFileSync(abs, bk);
  fs.writeFileSync(abs, String(text).replace(/\r?\n/g, eol || '\r\n'));
  return { mtime: fs.statSync(abs).mtimeMs, backup: path.relative(cartPath, bk) };
}
/**
 * Where are the pattern sets (#define &NAME(params)( … )) that the rules of a file call? The file itself and everything it #includes come first (what msgrep sees),
 * then every other .msgrep of the cartridge. → { "&NAME": [{ file (relative to the cartridge, / separators), line, inFile (the file is the one asked about), included }] }
 */
function findSetDefs(cartPath, file, names) {
  const { abs } = msgrepPath(cartPath, file);
  const rel = (f) => path.relative(cartPath, f).split(path.sep).join('/');
  const files = listMsgrepFiles(cartPath);
  const cache = new Map();
  const load = (f) => {
    if (cache.has(f)) return cache.get(f);
    let raw = ''; try { raw = readText(f); } catch { }
    const text = stripComments(raw);
    const rec = { text, defs: extractDefines(text).filter(d => d.name.startsWith('&')), includes: [...text.matchAll(/#include\s+"([^"]+)"/g)].map(m => path.resolve(path.dirname(f), m[1])) };
    cache.set(f, rec);
    return rec;
  };
  const reach = new Set();
  (function go(x) { if (reach.has(x) || !exists(x)) return; reach.add(x); load(x).includes.forEach(go); })(path.resolve(abs));
  const out = {};
  for (const raw of names || []) {
    const name = String(raw).startsWith('&') ? String(raw) : '&' + raw;
    const hits = [];
    for (const f of files) {
      const rec = load(f);
      for (const d of rec.defs) {
        if (d.name.toLowerCase() !== name.toLowerCase() || !setBodyRange(rec.text, d)) continue;       // a pattern set: &NAME(params)( body )
        const rf = path.resolve(f);
        hits.push({ file: rel(f), line: lineCol(rec.text, d.start).line, inFile: rf === path.resolve(abs), included: reach.has(rf) });
      }
    }
    hits.sort((a, b) => (b.inFile - a.inFile) || (b.included - a.included));
    out[name] = hits;
  }
  return out;
}
/**
 * The rules check of a file being edited: its folder is copied next to itself (same depth, so relative #includes still resolve) with the edited text in place of the
 * file, and msgrep compiles that copy (nothing is kept). → { ok, errors: [{ file, line, message }] (of the edited file), others: [..] (other files), warnings: [..], general: [..], seconds }
 */
async function checkMsgrepFile(cartPath, { file, text, extra }) {
  const { abs } = msgrepPath(cartPath, file);
  const exe = path.join(cartPath, 'msgrep.exe');
  if (!exists(exe)) throw new Error('msgrep.exe not found in the cartridge folder.');
  const dir = path.dirname(abs), id = `_nlpm_chk_${Date.now()}`, tmp = path.join(path.dirname(dir), id);
  const t0 = Date.now();
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const n of fs.readdirSync(dir)) if (/\.msgrep$/i.test(n) && n.toLowerCase() !== path.basename(abs).toLowerCase()) fs.copyFileSync(path.join(dir, n), path.join(tmp, n));
    fs.writeFileSync(path.join(tmp, path.basename(abs)), String(text).replace(/\r?\n/g, '\r\n'));
    // edited text of OTHER files of the same folder (the pattern sets the rules call): compiled in place of what is on disk
    for (const x of extra || []) {
      const xa = msgrepPath(cartPath, x.file).abs;
      if (path.dirname(xa) === dir && path.basename(xa).toLowerCase() !== path.basename(abs).toLowerCase()) fs.writeFileSync(path.join(tmp, path.basename(xa)), String(x.text).replace(/\r?\n/g, '\r\n'));
    }
    const hrel = path.relative(cartPath, tmp).split(path.sep).join('/');
    const r = await run(`"${exe}" -w -H${hrel} -B${id}.grbatch < NUL`, cartPath);
    const errors = [], others = [], warnings = [], general = [];
    const me = path.basename(abs).toLowerCase();
    for (const line of `${r.err}\n${r.out}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      const m = line.match(/^(?:.*[\\/])?([^\s:\\/]+\.msgrep):(\d+):\s*(.*)$/i);
      if (m) { (m[1].toLowerCase() === me ? errors : others).push({ file: m[1], line: Number(m[2]), message: m[3] }); continue; }
      if (/^warning:/i.test(line)) warnings.push(line.replace(/^warning:\s*/i, ''));
      else if (/error|exception|cannot|not defined|aborting/i.test(line)) general.push(line);
    }
    const made = exists(path.join(cartPath, id + '.grbatch'));
    return { ok: r.code === 0 && made && !errors.length, errors, others, warnings: [...new Set(warnings)], general: [...new Set(general)].filter(g => !/aborting execution/i.test(g)), seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.join(cartPath, id + '.grbatch'), { force: true }); } catch { /* temp files */ }
  }
}

/**
 * Pattern File Editor → right-click a folder → Compile: every pattern folder at or below <relDir> that a ttkconf comp_<prefix> command compiles is recompiled.
 * ttkconf (msgrep) refuses to build over an existing .grbatch, so the batch is moved aside first (put back when the compile fails). A folder inside a compiled
 * folder (no command of its own) compiles its nearest compiled ancestor. → { ok, jobs: [{ prefix, batch, folders, ok, message }] }
 */
/**
 * Which of the compile jobs use one of the pattern sets (&NAME) — in the rules of their folders, or through another set that calls it? A set defined in a shared file
 * (grdata/cs/AllPatterns.msgrep) is included by many pattern folders, but only the batches whose rules call it change when it is edited. A job whose files cannot be read is kept.
 */
function jobsUsingSets(cartPath, jobs, names) {
  const cache = new Map();
  const load = (f) => {
    if (cache.has(f)) return cache.get(f);
    let text = ''; try { text = stripComments(readText(f)); } catch { throw new Error('unreadable ' + f); }
    const rec = { text, defs: extractDefines(text), includes: [...text.matchAll(/#include\s+"([^"]+)"/g)].map(m => path.resolve(path.dirname(f), m[1])) };
    cache.set(f, rec);
    return rec;
  };
  const token = (n) => new RegExp('(?<![\\w])' + n.replace(/[$&@]/g, c => '\\' + c) + '(?![\\w])', 'i');
  return jobs.filter(job => {
    try {
      const reach = new Set();
      const go = (f) => { if (reach.has(f) || !exists(f)) return; reach.add(f); load(f).includes.forEach(go); };
      for (const fo of job.folders) { const d = path.join(cartPath, fo); for (const n of fs.readdirSync(d)) if (/\.msgrep$/i.test(n)) go(path.resolve(d, n)); }
      const recs = [...reach].map(load);
      const closure = new Set((names || []).map(n => String(n).toLowerCase()));
      for (let grew = true; grew;) {                                      // a set that calls a set of the closure is in it too
        grew = false;
        for (const r of recs) for (const d of r.defs) {
          const nm = d.name.toLowerCase();
          if (closure.has(nm) || !d.name.startsWith('&')) continue;
          if ([...closure].some(c => token(c).test(d.body))) { closure.add(nm); grew = true; }
        }
      }
      return recs.some(r => {                                             // the text outside the definitions: the rules
        let t = r.text;
        for (const d of [...r.defs].sort((a, b) => b.start - a.start)) t = t.slice(0, d.start) + ' '.repeat(d.end - d.start) + t.slice(d.end);
        return [...closure].some(c => token(c).test(t));
      });
    } catch { return true; }
  });
}

async function compileFolder(cartPath, relDir, opts = {}) {
  const rel = path.normalize(String(relDir || '')).replace(/^[\\/]+/, '');
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('The folder must be inside the cartridge.');
  const abs = path.join(cartPath, rel);
  if (!exists(abs)) throw new Error(rel + ' does not exist.');
  const ttkExe = path.join(cartPath, 'ttkconf.exe');
  if (!exists(ttkExe)) throw new Error('ttkconf.exe not found in the cartridge folder.');
  const cmds = compileCommands(cartPath);
  const jobs = new Map();
  const add = (dir) => {
    const c = cmds.get(dirKey(dir));
    if (!c) return false;
    if (!jobs.has(c.prefix)) jobs.set(c.prefix, { prefix: c.prefix, batch: c.batch, folders: [] });
    jobs.get(c.prefix).folders.push(dir.split(path.sep).join('/'));
    return true;
  };
  // a brand-new pattern folder: no ttkconf command compiles it (nor an ancestor), and a .msgrep file directly in it holds CONTROL rules
  // (folders of macros / pattern libraries that Rules files include are not pattern folders)
  const fresh = [];
  const hasCommandAbove = (rd) => { for (let up = rd; up && up !== '.' && up !== path.dirname(up); up = path.dirname(up)) if (cmds.get(dirKey(up))) return true; return false; };
  (function walk(d) {
    const rd = path.relative(cartPath, d);
    if (!add(rd) && rd && !hasCommandAbove(rd)) {
      let own = []; try { own = fs.readdirSync(d).filter(n => /\.msgrep$/i.test(n)).map(n => path.join(d, n)); } catch { }
      const texts = own.map(p => { try { return stripComments(readText(p)); } catch { return ''; } });
      if (texts.some(t => /\bCONTROL\b\s*\{/.test(t))) fresh.push({ rel: rd.split(path.sep).join('/'), mode: texts.some(t => ACT_RE.test(t)) ? 'csout' : 'msout' });
    }
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('_nlpm_test_') && e.name !== '_relation_backups') walk(path.join(d, e.name));
  })(abs);
  if (!jobs.size && !fresh.length) {                  // nothing at or below: the nearest compiled ancestor
    for (let up = path.dirname(rel); up && up !== '.' && up !== path.dirname(up); up = path.dirname(up)) if (add(up)) break;
  }
  if (!jobs.size && !fresh.length) throw new Error('No ttkconf compile command (comp_…) is defined for ' + rel + ' or the folders in it, and it holds no pattern folder (a .msgrep file with CONTROL rules) to register — nothing to compile.');
  if (opts.onlyUsing && opts.onlyUsing.length) {                       // a pattern set of a shared file was edited: only the batches whose rules call it
    const keep = jobsUsingSets(cartPath, [...jobs.values()], opts.onlyUsing);
    for (const k of [...jobs.keys()]) if (!keep.some(j => j.prefix === k)) jobs.delete(k);
    fresh.length = 0;
  }
  if (opts.dryRun) return { ok: true, plan: [...jobs.values()].map(j => ({ prefix: j.prefix, batch: j.batch, folders: j.folders })), fresh: fresh.map(f => { const n = freshNames(cartPath, f); return { rel: f.rel, prefix: n.prefix, batch: n.batch + '.grbatch' }; }) };   // what would be compiled (a new folder: with the names it would get)
  const out = [];
  for (const j of jobs.values()) out.push(await compileJob(cartPath, ttkExe, j));
  for (const nf of fresh) out.push(await registerAndCompileFolder(cartPath, nf, ttkExe));
  return { ok: out.every(x => x.ok), jobs: out };
}

/**
 * "Recompile": every pattern folder (every ttkconf comp_<prefix> command that builds a .grbatch from a folder under grdata) of every given cartridge is rebuilt, several at once.
 * (needed after DictionaryMacros.msgrep changed.) The jobs of all cartridges go into one pool of `concurrency` workers — ttkconf / msgrep runs of different folders do not interfere.
 * progress({ type: 'plan' | 'start' | 'done', … }); cancel.cancelled stops new jobs from starting. New (unregistered) folders are not touched.
 * → { ok, total, done, failed, cancelled, seconds, results: [{ cartridge, prefix, batch, ok, message }] }
 */
async function recompileAll(cartPaths, { concurrency, progress = () => {}, cancel = {}, dryRun = false } = {}) {
  const os = require('os');
  const n = Math.max(1, Math.min(12, concurrency || Math.max(2, os.cpus().length - 1)));
  const tasks = [], skipped = [];
  for (const cartPath of cartPaths) {
    const cart = path.basename(cartPath);
    try {
      if (!exists(path.join(cartPath, 'grdata'))) continue;
      const exe = path.join(cartPath, 'ttkconf.exe');
      if (!exists(exe)) { skipped.push({ cartridge: cart, reason: 'no ttkconf.exe' }); continue; }
      const plan = await compileFolder(cartPath, 'grdata', { dryRun: true });
      for (const j of plan.plan) tasks.push({ cartPath, cart, exe, job: { prefix: j.prefix, batch: j.batch, folders: j.folders } });
    } catch (e) { if (!/nothing to compile/.test(e.message)) skipped.push({ cartridge: cart, reason: e.message }); }
  }
  if (dryRun) { const by = {}; for (const t of tasks) by[t.cart] = (by[t.cart] || 0) + 1; return { total: tasks.length, byCartridge: by, skipped, concurrency: n }; }
  const results = [];
  const t0 = Date.now();
  progress({ type: 'plan', total: tasks.length, concurrency: n, cartridges: [...new Set(tasks.map(t => t.cart))], skipped });
  let next = 0, done = 0;
  const worker = async () => {
    while (!cancel.cancelled) {
      const t = tasks[next++];
      if (!t) return;
      progress({ type: 'start', cartridge: t.cart, prefix: t.job.prefix, batch: t.job.batch });
      const r = await compileJob(t.cartPath, t.exe, t.job);
      const rec = { cartridge: t.cart, prefix: r.prefix, batch: r.batch, ok: r.ok, message: r.message };
      results.push(rec);
      progress({ type: 'done', ...rec, done: ++done, total: tasks.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return { ok: results.every(r => r.ok) && !cancel.cancelled, total: tasks.length, done, failed: results.filter(r => !r.ok).length, cancelled: !!cancel.cancelled, skipped, seconds: Math.round((Date.now() - t0) / 100) / 10, results };
}

/** Rebuild the batch of one compile job { prefix, batch, folders }: the old .grbatch is set aside (ttkconf refuses to build over it) and put back when the compile fails. → the job with { ok, message } */
async function compileJob(cartPath, ttkExe, j) {
  const os = require('os');
  const batchFile = j.batch ? path.join(cartPath, j.batch) : null, aside = batchFile ? batchFile + '.nlpm_old' : null;
  const logFile = path.join(os.tmpdir(), `nlpm_comp_${j.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);   // parallel jobs of different cartridges can share a prefix
  try {
    if (batchFile && exists(batchFile)) { try { fs.rmSync(aside, { force: true }); } catch { } fs.renameSync(batchFile, aside); }
    const r = await run(`"${ttkExe}" comp_${j.prefix} 2>"${logFile}"`, cartPath);
    let log = ''; try { log = readText(logFile).trim(); } catch { }
    const made = !batchFile || exists(batchFile);
    if (r.code !== 0 || !made) {
      if (aside && exists(aside)) { try { fs.rmSync(batchFile, { force: true }); } catch { } fs.renameSync(aside, batchFile); }
      const msg = `exit ${r.code}${made ? '' : ', ' + j.batch + ' was not produced'}; the previous ${j.batch || 'batch'} was kept` + ((log || r.err || r.out) ? ': ' + (log || r.err || r.out).trim().split(/\r?\n/).slice(-4).join(' | ') : '');
      return ({ ...j, ok: false, message: msg });
    } else {
      if (aside) { try { fs.rmSync(aside, { force: true }); } catch { } }
      return ({ ...j, ok: true, message: log ? log.split(/\r?\n/).slice(-2).join(' | ') : '' });
    }
  } catch (e) {
    if (aside && exists(aside) && !exists(batchFile)) { try { fs.renameSync(aside, batchFile); } catch { } }
    return ({ ...j, ok: false, message: e.message });
  } finally { try { fs.rmSync(logFile, { force: true }); } catch { } }

}

/**
 * A pattern folder that nothing compiles yet is set up like step 5 / 6 of "New relation": ttkconf.ini (+ .delta) gets del_/comp_<prefix> and the pat_* task,
 * the folder is compiled, then locscan.ini (+ .delta) gets the output command and the allpats entry. The names are made up from the folder name and are
 * unique in the cartridge. Any failure restores the ini files. → the job record of compileFolder (with registered: true)
 */
/** The names a new pattern folder would get: { word, prefix, batch } (batch without .grbatch; the output command has the batch's name) */
function freshNames(cartPath, nf) {
  const ttkFiles = ['ttkconf.ini', 'ttkconf.ini.delta'].map(x => path.join(cartPath, x)).filter(exists);
  const locFiles = ['locscan.ini', 'locscan.ini.delta'].map(x => path.join(cartPath, x)).filter(exists);
  const allTtk = ttkFiles.map(readText).join('\n'), allLoc = locFiles.map(readText).join('\n');
  const usedPrefix = new Set([...allTtk.matchAll(/^\s*(?:del|comp)_([A-Za-z0-9_]+)\s*=/gm)].map(m => m[1].toLowerCase()));
  const usedBatch = new Set([...allTtk.matchAll(/-B\s*(\S+?)\.grbatch/gi)].map(m => m[1].toLowerCase()));
  const usedOut = new Set([...allLoc.matchAll(/^\s*([A-Za-z0-9_]+)\s*=/gm)].map(m => m[1].toLowerCase()));
  for (const fn of fs.readdirSync(cartPath)) { const m = /^(.+)\.grbatch$/i.exec(fn); if (m) usedBatch.add(m[1].toLowerCase()); }
  const word = path.basename(nf.rel).toLowerCase().replace(/[^a-z0-9]/g, '') || 'patterns';
  const pick = (base, used) => { let p = base, n = 2; while (used.has(p)) p = base + n++; return p; };
  const csTag = nf.mode === 'csout' && !/cs$/.test(word);
  return { word, prefix: pick(word.slice(0, 6) + (csTag ? 'cs' : ''), usedPrefix), batch: pick(word + (csTag ? '_cs' : ''), new Set([...usedBatch, ...usedOut])) };
}
async function registerAndCompileFolder(cartPath, nf, ttkExe) {
  const ttkFiles = ['ttkconf.ini', 'ttkconf.ini.delta'].map(x => path.join(cartPath, x)).filter(exists);
  const locFiles = ['locscan.ini', 'locscan.ini.delta'].map(x => path.join(cartPath, x)).filter(exists);
  const { word, prefix, batch } = freshNames(cartPath, nf);
  const outName = batch;
  const key = 'folder_' + word;
  const sess = getSession(cartPath, key);
  const rec = { prefix, batch: batch + '.grbatch', folders: [nf.rel], registered: true };
  const undo = () => { try { sess.rollback(); } catch { } sessions.delete(`${cartPath}|${key}`); };
  try {
    for (const f of ttkFiles) {
      let t = readText(f);
      const eq = f.endsWith('.delta') && /^\s*\w[^=\n]*\s=\s/m.test(t) ? ' = ' : '=';
      if (iniGet(t, 'commands', 'comp_' + prefix) === null) {
        t = iniAppend(t, 'commands', [`del_${prefix}${eq}rm -f ${batch}.grbatch`, `comp_${prefix}${eq}\${MSGREP} -H${nf.rel} -B${batch}.grbatch <\${devnull} >\${devnull}`]);
      }
      t = iniReplaceKey(t, 'tasks', 'pat_*', (v) => (v.includes(`$*_${prefix}`) ? v : v.replace(/(,\$\*_prgl)?\s*$/, (m) => `,$*_${prefix}${m}`)));
      sess.write(f, t);
    }
    const batchFile = path.join(cartPath, batch + '.grbatch');
    const logFile = path.join(require('os').tmpdir(), `nlpm_comp_${prefix}_${Date.now()}.log`);
    const r = await run(`"${ttkExe}" comp_${prefix} 2>"${logFile}"`, cartPath);
    let clog = ''; try { clog = readText(logFile).trim(); } catch { } try { fs.rmSync(logFile, { force: true }); } catch { }
    if (r.code !== 0 || !exists(batchFile)) {
      undo();
      const why = (clog || r.err || r.out || '').trim().split(/\r?\n/).slice(-4).join(' | ');
      return { ...rec, ok: false, message: `registered as comp_${prefix}, but the compile failed (exit ${r.code}${exists(batchFile) ? '' : ', ' + batch + '.grbatch was not produced'}) — ttkconf.ini / locscan.ini restored` + (why ? ': ' + why : '') };
    }
    for (const f of locFiles) {
      let t = readText(f);
      const spaced = f.endsWith('.delta') && /^\s*\w[^=\n]*\s=\s/m.test(t);
      if (iniGet(t, 'output', outName) === null) t = iniAppend(t, 'output', [`${outName}${spaced ? ' = ' : '='}\${MSGREP} -I${nf.mode} -H ${nf.rel} -b ${batch}.grbatch | \${XF2RN}`]);
      t = iniReplaceKey(t, 'output', 'allpats', (v) => {
        const m = v.match(/^(\$\()(.*)(\)\s*)$/);
        if (!m) return v;
        return m[2].split('+').map(x => x.trim()).includes(outName) ? v : `${m[1]}${m[2]}+${outName}${m[3]}`;
      });
      sess.write(f, t);
    }
    sessions.delete(`${cartPath}|${key}`);
    return { ...rec, ok: true, message: `new pattern folder registered (${nf.mode}): comp_${prefix} → ${batch}.grbatch, output command "${outName}" added to allpats` };
  } catch (e) {
    undo();
    return { ...rec, ok: false, message: e.message + ' — ini files restored' };
  }
}

// ───────────────────────────── "Suggest pattern": try the pattern on the real markup ─────────────────────────────
/**
 * Compiles the pattern in a temporary folder of the cartridge (grdata/_nlpm_test_*), runs msgrep on the given ConceptScan output
 * (-Icsout; patterns without $ACT need the tagged-sentence output: markupMs) and counts the output terms. Nothing is kept.
 * { ok, terms, mode, message?, skipped?, stderr }
 */
function testPattern(cartPath, { pattern, markup, markupMs, relationName, regulators, targets, license, compileOnly }) {
  const { spawnSync } = require('child_process');
  const v = validatePattern(cartPath, { text: pattern, relationName, setName: 'NLPMTEST' });
  if (!v.ok) return { ok: false, stage: 'validate', message: v.errors.map(e => e.message).join('; ') };
  const mode = v.hasAct || setMode(stripComments(pattern)) === 'csout' ? 'csout' : 'msout';
  // the tagged sentence (msout) is the mref/msrc part of the ConceptScan output: the lines before the "<" pseudo-sentences
  const msFromCs = String(markup || '').split(/\r?\n/).filter(l => /^(mref|msrc)\t/.test(l)).join('\r\n') + '\r\n\r\n';
  const input = mode === 'csout' ? markup : (markupMs || (/^msrc\t/m.test(msFromCs) ? msFromCs : ''));
  if (!input && !compileOnly) return { ok: true, skipped: true, mode, message: `no ${mode} text available to test this pattern` };
  const nt = readText(path.join(cartPath, 'nodetype.ini'));
  const notFrame = [...regulators, ...targets].filter(x => iniGet(nt, 'NodeType-IsFrame', x) !== '1');
  if (notFrame.length && !compileOnly) return { ok: true, skipped: true, mode, message: `${notFrame.join(', ')} not in [NodeType-IsFrame] yet — msgrep cannot output terms for it` };

  const id = `_nlpm_test_${Date.now()}`;
  const dir = path.join(cartPath, 'grdata', id), batch = `${id}.grbatch`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const srcFiles = [...new Set([...v.macroFiles, ...v.foundMacros.map(m => m.file).filter(Boolean)])];   // the test folder has no wordsets file: include every macro file the pattern needs
    const inc = orderMacroFiles(cartPath, srcFiles).map(f => `#include "${path.relative(dir, path.join(cartPath, f)).split(path.sep).join('/')}"`);
    const pre = [...v.inlineMacros.map(m => m.text.trim()), ...v.customDefines.map(d => d.text.trim())];
    fs.writeFileSync(path.join(dir, 'p.msgrep'), [...inc, ...pre, `#define &NLPMTEST(@regulator, @target)(`, v.body, `);`, ''].join('\r\n'));
    fs.writeFileSync(path.join(dir, 'Rules.msgrep'), [`#include "p.msgrep"`, '', 'CONTROL', '{', ` out = %tar(${targets.join(', ')})`, ` in = %reg(${regulators.join(', ')})`, ` ControlType = "${relationName}"`, '} : &NLPMTEST(%reg, %tar);', ''].join('\r\n'));
    const exe = path.join(cartPath, 'msgrep.exe');
    const c = spawnSync(exe, ['-w', `-H${path.posix.join('grdata', id)}`, `-B${batch}`], { cwd: cartPath, input: '', encoding: 'utf8', maxBuffer: 1 << 26 });
    const cmsg = `${c.stderr || ''}\n${c.stdout || ''}`.split(/\r?\n/).filter(l => /error|cannot|unexpected|undefined|not defined|syntax/i.test(l)).slice(0, 4).join(' | ');
    if (c.status !== 0 || !exists(path.join(cartPath, batch))) return { ok: false, stage: 'compile', message: cmsg || `msgrep compile failed (exit ${c.status}): ` + `${c.stderr || ''}\n${c.stdout || ''}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-6).join(' | ') };
    if (compileOnly) return { ok: true, compiled: true, mode };
    const r = spawnSync(exe, [`-t${license || ''}`, `-I${mode}`, '-H', path.posix.join('grdata', id), '-b', batch], { cwd: cartPath, input, encoding: 'utf8', maxBuffer: 1 << 26 });
    const n = (String(r.stderr || '').match(/(\d+)\s+output terms/) || [])[1];
    return { ok: true, terms: n === undefined ? 0 : Number(n), mode, stderr: String(r.stderr || '').split(/\r?\n/).slice(-4).join(' ').trim() };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(cartPath, batch), { force: true }); } catch { /* temp files */ }
  }
}

// ───────────────────────────── "Patterns for relations": which patterns extract a relation type ─────────────────────────────
/** Relation types declared in ctrltype.ini of the given cartridges: [{ name, cartridges: [...] }]. */
function listRelationTypes(carts) {
  const map = new Map();
  for (const c of carts) {
    let rel; try { rel = getInfo(c.path).relations; } catch { continue; }
    for (const r of Object.keys(rel)) {
      const key = r.toLowerCase();
      if (!map.has(key)) map.set(key, { name: r, alias: GE_NAMES[r] || null, cartridges: [] });
      map.get(key).cartridges.push(c.name);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** { paramsOpen, body: [open, close] } of "&NAME(params)( body )" or null. */
function setBodyRange(text, d) {
  const i = text.indexOf('(', d.start + d.name.length);
  if (i < 0) return null;
  const p = findMatching(text, i);
  if (p < 0) return null;
  let j = p + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] !== '(') return null;
  const b = findMatching(text, j);
  return b < 0 ? null : { open: j, close: b };
}

/** Split pattern text at top-level '|' into individual patterns (one outer "( … )" group is unwrapped first). */
function splitAlternatives(text) {
  const split = (t) => {
    const parts = [];
    let depth = 0, prev = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"') { i++; while (i < t.length && t[i] !== '"' && t[i] !== '\n') i++; continue; }
      if (c === "'") { const m = t.slice(i).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length - 1; continue; } }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && c === '|') { parts.push(t.slice(prev, i)); prev = i + 1; }
    }
    parts.push(t.slice(prev));
    return parts.map(x => x.trim()).filter(Boolean);
  };
  let t = text.trim();
  let parts = split(t);
  if (parts.length === 1 && t[0] === '(' && findMatching(t, 0) === t.length - 1) parts = split(t.slice(1, -1));
  return parts;
}

function countAlternatives(text, open, close) {
  let depth = 0, n = 1;
  for (let i = open + 1; i < close; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < close && text[i] !== '"' && text[i] !== '\n') i++; continue; }
    if (c === "'") { const m = text.slice(i, close).match(/^'[^'\n]{0,20}'/); if (m) { i += m[0].length - 1; continue; } }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '|') n++;
  }
  return n;
}

/**
 * Scans every *.msgrep of every cartridge for CONTROL { … ControlType="<rel>" } declarations and resolves the patterns
 * each one applies (the &SET definitions it calls, followed through nested &SET calls, and an inline pattern after ':').
 * One row per (declaration, file holding its patterns).
 */
function findRelationPatterns(carts, relationName, full = false) {
  const want = String(relationName || '').toLowerCase();
  const rows = [];
  for (const cart of carts) {
    const files = listMsgrepFiles(cart.path);
    const info = new Map();                                    // file → { text (comments stripped), defs, includes }
    const defsByName = new Map();                              // &NAME → [{ file, d, range }]
    const load = (f) => {
      if (info.has(f)) return info.get(f);
      let raw = ''; try { raw = readText(f); } catch { }
      const text = stripComments(raw);
      const defs = extractDefines(text).filter(d => d.name.startsWith('&'));
      const includes = [...text.matchAll(/#include\s+"([^"]+)"/g)].map(m => path.resolve(path.dirname(f), m[1]));
      const rec = { text, defs, includes };
      info.set(f, rec);
      return rec;
    };
    for (const f of files) {
      const rec = load(f);
      for (const d of rec.defs) {
        const range = setBodyRange(rec.text, d);
        if (!defsByName.has(d.name)) defsByName.set(d.name, []);
        defsByName.get(d.name).push({ file: f, d, range });
      }
    }
    const closure = (f) => {
      const seen = new Set();
      (function go(x) { if (seen.has(x) || !exists(x)) return; seen.add(x); load(x).includes.forEach(go); })(f);
      return seen;
    };
    const rel = (f) => path.join(path.basename(cart.path), path.relative(cart.path, f));   // starts with the cartridge folder

    for (const f of files) {
      const rec = load(f);
      if (!/ControlType/i.test(rec.text)) continue;
      const t = rec.text;
      // the groups of CONTROL blocks written one right after the other (they share the pattern after the last): start of the first block, end of the last one
      const groupOf = new Map();
      { const rx = /\bCONTROL\b\s*\{/g; let g = null, mm;
        while ((mm = rx.exec(t)) !== null) {
          const o = t.indexOf('{', mm.index), c = findMatching(t, o);
          if (c < 0) break;
          rx.lastIndex = c;
          if (g && /^\s*$/.test(t.slice(g.end, mm.index))) g.end = c + 1; else g = { start: mm.index, end: c + 1 };
          groupOf.set(mm.index, g);
        } }
      const re = /\bCONTROL\b\s*\{/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        const open = t.indexOf('{', m.index);
        const close = findMatching(t, open);
        if (close < 0) continue;
        re.lastIndex = close;
        const body = t.slice(open + 1, close);
        const ct = body.match(/ControlType\s*=\s*"([^"]+)"/i);
        if (!ct || !aliasGroup(want).includes(ct[1].toLowerCase())) continue;
        // expression after "}" ":" … ";"
        let i = close + 1;
        while (i < t.length && /\s/.test(t[i])) i++;
        // CONTROL { … } CONTROL { … } : pattern ; — frames written one after the other share the pattern after the LAST of them, so every one of them has that pattern
        let ci = i, shared = false;
        while (/^CONTROL\b/.test(t.slice(ci, ci + 8))) { const o2 = t.indexOf('{', ci), c2 = findMatching(t, o2); if (c2 < 0) break; ci = c2 + 1; while (ci < t.length && /\s/.test(t[ci])) ci++; shared = true; }
        let expr = '';
        if (t[ci] === ':') {
          let k = ci + 1, depth = 0;
          for (; k < t.length; k++) {
            const c = t[k];
            if (c === '"') { k++; while (k < t.length && t[k] !== '"' && t[k] !== '\n') k++; continue; }
            if (c === "'") { const mm = t.slice(k).match(/^'[^'\n]{0,20}'/); if (mm) { k += mm[0].length - 1; continue; } }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') depth--;
            else if (c === ';' && depth <= 0) break;
          }
          expr = t.slice(ci + 1, k).trim();
        }
        const declHead = `CONTROL { ${body.trim().replace(/\s+/g, ' ')} }`;
        const role = (key) => { const mm = body.match(new RegExp('\\b' + key + '\\s*=\\s*%(\\w+)\\s*\\(([^)]*)\\)', 'i')); return mm ? { var: '%' + mm[1], types: mm[2].split(/[\s,]+/).filter(Boolean).map(typeTok) } : null; };
        const grp = groupOf.get(m.index);
        const control = { cartridge: cart.name, control: declHead, expr, chainText: grp ? t.slice(grp.start, grp.end) : declHead, chainKey: rel(f) + '#' + (grp ? grp.start : m.index), sharedPattern: !!(shared && expr), controlFile: rel(f), controlLine: lineCol(t, m.index).line, roles: { in: role('in'), out: role('out') } };

        // patterns: &SETs called by the rule (and, recursively, by those sets); anything else in the expression is inline
        const reach = closure(f);
        const perFile = new Map();                              // file → { sets: [{name, alternatives, text, line}], inline }
        const bucket = (file) => { if (!perFile.has(file)) perFile.set(file, { sets: [], inline: null }); return perFile.get(file); };
        const done = new Set();
        const resolve = (exprText, depth) => {
          for (const sm of exprText.matchAll(/&([A-Za-z_]\w*)/g)) {
            const name = '&' + sm[1];
            const cands = defsByName.get(name) || [];
            const picked = cands.filter(c => reach.has(c.file));
            for (const c of (picked.length ? picked : cands)) {
              const key = name + '|' + c.file;
              if (done.has(key)) continue;
              done.add(key);
              const r = info.get(c.file);
              const text = c.range ? r.text.slice(c.range.open + 1, c.range.close).trim() : c.d.text;
              const po = c.range ? r.text.indexOf('(', c.d.start + c.d.name.length) : -1;
              bucket(c.file).sets.push({
                name,
                params: po >= 0 ? r.text.slice(po + 1, findMatching(r.text, po)).trim() : '',
                alternatives: c.range ? countAlternatives(r.text, c.range.open, c.range.close) : 1,
                text,
                line: lineCol(r.text, c.d.start).line,
              });
              if (depth < 6) resolve(text, depth + 1);
            }
          }
        };
        resolve(expr, 0);
        const inlineText = expr.replace(/&[A-Za-z_]\w*\s*\([^()]*\)/g, '').replace(/[\s()|]+/g, ' ').trim();
        if (expr && (!perFile.size || inlineText)) bucket(f).inline = expr;
        // only a plain &SET call stays in the declaration; an old-style rule keeps just CONTROL { … } and its pattern goes to the patterns column
        if (!perFile.get(f)?.inline && expr) control.control = `${declHead} : ${expr.replace(/\s+/g, ' ')};`;
        if (!perFile.size) bucket(f);
        const MAX_ALTS = full ? Infinity : 80, MAX_LEN = full ? Infinity : 1500;
        const alts = (x) => splitAlternatives(x).slice(0, MAX_ALTS).map(a => (a.length > MAX_LEN ? a.slice(0, MAX_LEN) + ' …' : a));
        for (const [pf, b] of perFile) rows.push({ ...control, patternsFile: rel(pf),
          patternSets: b.sets.map(x => ({ name: x.name, params: x.params, alternatives: x.alternatives, line: x.line, alts: alts(x.text) })),
          inlinePattern: b.inline ? { alternatives: splitAlternatives(b.inline).length, alts: alts(b.inline) } : null });
      }
    }
  }
  return rows;
}

/**
 * Node types that are not IsFrame in this cartridge, and the other cartridges where ALL the given types are IsFrame
 * (msgrep can only output relations for IsFrame node types).
 */
function frameCheck(cartPath, types, carts) {
  const frames = (p) => {
    const f = path.join(p, 'nodetype.ini');
    if (!exists(f)) return new Set();
    const t = readText(f);
    return new Set([...new Set(types)].filter(x => iniGet(t, 'NodeType-IsFrame', x) === '1'));
  };
  const want = [...new Set(types)];
  const here = frames(cartPath);
  const missing = want.filter(x => !here.has(x));
  const others = [];
  if (missing.length) {
    for (const c of carts || []) {
      if (path.resolve(c.path) === path.resolve(cartPath)) continue;
      const fr = frames(c.path);
      if (want.every(x => fr.has(x))) others.push({ name: c.name, path: c.path });
    }
  }
  return { missing, others };
}

/** Definitions ($WORDSET / @macro) of the given names as seen from a pattern file (its #include closure first), shortened. */
function macroDefinitions(cartPath, file, names, max = 420) {
  const files = listMsgrepFiles(cartPath);
  const load = (f) => {
    const p = parsedMsgrep(f);
    return p ? { defs: p.defs.filter(d => !d.name.startsWith('&')), includes: p.includes } : { defs: [], includes: [] };
  };
  const reach = new Set();
  (function go(x) { if (reach.has(x) || !exists(x)) return; reach.add(x); load(x).includes.forEach(go); })(path.resolve(file));
  const out = {};
  const want = new Set(names);
  for (const pass of [[...reach], files]) {
    for (const f of pass) {
      for (const d of load(f).defs) {
        if (want.has(d.name) && !(d.name in out)) out[d.name] = d.body.replace(/\s+/g, ' ').trim().slice(0, max);
      }
    }
  }
  return out;
}

/**
 * Macros of the cartridge that contain a word: every $MACRO whose body has a word (quotes and "~" ignored) equal to / starting with / containing the query
 * (a macro whose NAME contains the query is listed too). Macros that include one of the hits through another macro come with "via".
 * [{ name, words: [matching words], rank, body, file, via }]
 */
function findMacrosWith(cartPath, query, max = 60, exact = false) {   // exact: only macros that have the word itself (lower or lower~), not lowering / lowest, no name or nested hits
  const q = String(query || '').toLowerCase().replace(/["~]/g, '').trim();
  if (q.length < 2) return [];
  const idx = buildMacroIndex(cartPath);
  const all = [];
  for (const [name, entries] of idx.defs) {
    if (name.startsWith('&') || name === '$ACT') continue;
    const e = preferred(entries, cartPath);
    all.push({ name, body: e.body.replace(/\s+/g, ' ').trim(), file: path.relative(cartPath, e.file) });
  }
  const direct = new Map();
  for (const m of all) {
    const toks = m.body.match(/"[^"]*"|[^\s\[\]]+/g) || [];
    const words = [], seen = new Set();
    let rank = !exact && m.name.toLowerCase().includes(q) ? 3 : 9;
    for (const t of toks) {
      if (/^[$@&^]/.test(t)) continue;
      const w = t.replace(/"/g, '').replace(/~$/, '').toLowerCase();
      if (exact ? w !== q : !w.includes(q)) continue;
      rank = Math.min(rank, w === q ? 0 : w.startsWith(q) ? 1 : 2);
      if (!seen.has(t)) { seen.add(t); words.push(t); }
    }
    if (words.length || rank < 9) direct.set(m.name, { name: m.name, words, rank, body: m.body.slice(0, 600), file: m.file, via: null });
  }
  const out = [...direct.values()];
  if (exact) return out.sort((a, b) => a.body.length - b.body.length || a.name.localeCompare(b.name)).slice(0, max);
  // macros that reach a hit through other macros (one or more levels): shown after the direct ones
  const uses = new Map(all.map(m => [m.name, [...new Set(m.body.match(/\$[A-Za-z_]\w*/g) || [])]]));
  const via = new Map();
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const m of all) {
      if (direct.has(m.name) || via.has(m.name)) continue;
      const hit = (uses.get(m.name) || []).find(u => direct.has(u) || via.has(u));
      if (hit) { via.set(m.name, hit); grew = true; }
    }
    if (!grew) break;
  }
  for (const m of all) if (via.has(m.name)) out.push({ name: m.name, words: [], rank: 20, body: m.body.slice(0, 600), file: m.file, via: via.get(m.name) });
  out.sort((a, b) => a.rank - b.rank || a.body.length - b.body.length || a.name.localeCompare(b.name));
  return out.slice(0, max);
}

// ───────────────────────────── "Create macro": a new $MACRO in one of the cartridge's macro files (and, for a top-level grdata file, in the other cartridges) ─────────────────────────────
const normRel = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** The files a new macro can go to: every msgrep file of the cartridge that defines $macros; "included" = the file the pattern being edited already includes. */
function macroFileCandidates(cartPath, text, relationName) {
  const idx = buildMacroIndex(cartPath);
  const included = new Set();
  try { for (const f of validatePattern(cartPath, { text: text || '', relationName: relationName || '', setName: '' }).macroFiles || []) included.add(normRel(f)); } catch { /* the list works without it */ }
  const out = [];
  for (const [f, names] of idx.fileOwn) {
    const n = [...names].filter(x => x.startsWith('$')).length;
    if (!n) continue;
    const rel = path.relative(cartPath, f);
    out.push({ file: rel, macros: n, included: included.has(normRel(rel)), topLevel: normRel(path.dirname(rel)) === 'grdata' });
  }
  out.sort((a, b) => (b.included - a.included) || (b.topLevel - a.topLevel) || (b.macros - a.macros) || a.file.localeCompare(b.file));
  return out;
}

/** the cartridges next to this one (folders with a nodetype.ini) */
function siblingCartridges(cartPath) {
  const parent = path.dirname(cartPath), out = [];
  try {
    for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
      const p = path.join(parent, d.name);
      if (d.isDirectory() && d.name.toLowerCase() !== 'bin' && path.resolve(p) !== path.resolve(cartPath) && exists(path.join(p, 'nodetype.ini'))) out.push(p);   // MEDSCAN\bin is the master copy, handled separately (it has a nodetype.ini too)
    }
  } catch { /* no siblings */ }
  return out;
}

/**
 * Append "#define $NAME  [body]" to <file> of the cartridge (a backup of the file goes to _relation_backups first). With allCartridges and a file directly in grdata,
 * the same definition is appended to the same file of every other cartridge that has it and does not define the name yet.
 * → { ok, name, file, added: [{ cartridge, file }], skipped: [{ cartridge, reason }] }
 */
function addMacro(cartPath, { file, name, body, allCartridges }) {
  name = String(name || '').trim(); body = String(body || '').trim();
  if (!/^\$[A-Za-z_]\w*$/.test(name)) throw new Error('A macro name starts with $ and has letters, digits and underscores, e.g. $NOT_CONTRACTED.');
  if (!/^\[[\s\S]*\]$/.test(body)) throw new Error('The definition must be a word set in square brackets: [word "two words" $OTHER_MACRO word~].');
  const bare = body.replace(/"[^"]*"/g, '""');
  if ((body.match(/"/g) || []).length % 2) throw new Error('A double quote is not closed in the definition.');
  if ((bare.match(/\[/g) || []).length !== (bare.match(/\]/g) || []).length) throw new Error('Square brackets in the definition are not balanced.');
  checkSeparators(bare);
  if (!/\.msgrep$/i.test(String(file || ''))) throw new Error('Choose the .msgrep file the macro goes to.');
  const rel = path.normalize(String(file));
  if (path.isAbsolute(rel) || rel.startsWith('..')) throw new Error('The file must be inside the cartridge.');
  const target = path.join(cartPath, rel);
  if (!exists(target)) throw new Error(rel + ' does not exist in this cartridge.');
  const idx = buildMacroIndex(cartPath);
  if (idx.defs.has(name)) throw new Error(name + ' is already defined (' + path.relative(cartPath, preferred(idx.defs.get(name), cartPath).file) + ').');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '_Macro_' + name.slice(1);
  const append = (root, f, backupRoot = root, tag = '') => {
    const t = readText(f), eol = eolOf(t);
    const bk = path.join(backupRoot, '_relation_backups', stamp, tag, path.relative(root, f));
    fs.mkdirSync(path.dirname(bk), { recursive: true }); fs.copyFileSync(f, bk);
    fs.writeFileSync(f, t + (/\n$/.test(t) ? '' : eol) + eol + '#define ' + name + '  ' + body + eol);
  };
  append(cartPath, target);
  const added = [{ cartridge: path.basename(cartPath), file: rel }], skipped = [], unchanged = [];
  if (allCartridges && normRel(path.dirname(rel)) === 'grdata') {
    // the master copy (MEDSCAN\bin) is not a cartridge: it gets the macro too; its backup is kept in this cartridge's backup folder, not in the master
    const master = path.join(path.dirname(cartPath), 'bin');
    for (const p of [...siblingCartridges(cartPath), ...(exists(path.join(master, rel)) ? [master] : [])]) {
      const isMaster = p === master;
      const cn = isMaster ? 'bin (master copy)' : path.basename(p), f = path.join(p, rel);
      try {
        if (!exists(f)) { unchanged.push({ cartridge: cn, reason: 'has no ' + rel }); continue; }
        const other = buildMacroIndex(p);
        if (other.defs.has(name)) {
          const e = preferred(other.defs.get(name), p), same = String(e.body).replace(/\s+/g, ' ').trim() === body.replace(/\s+/g, ' ').trim();
          (same ? unchanged : skipped).push({ cartridge: cn, reason: same ? 'already has this definition' : name + ' is already defined differently: ' + String(e.body).replace(/\s+/g, ' ').trim().slice(0, 120) + ' (' + path.relative(p, e.file) + ') — nothing changed' });
          continue;
        }
        append(p, f, isMaster ? cartPath : p, isMaster ? 'bin' : ''); added.push({ cartridge: cn, file: rel });
      } catch (e) { skipped.push({ cartridge: cn, reason: e.message }); }
    }
  }
  return { ok: true, name, file: rel, added, skipped, unchanged };
}

/**
 * Where each found macro is defined: this cartridge first, then the other cartridges and the master copy (MEDSCAN\bin).
 * macros: [{ name, ... }] (findMacrosWith results) → the same objects with where: [{ cartridge, files: [rel…], same }]  (same = the definition equals this cartridge's)
 */
/**
 * How many words a macro accepts: { total, direct } — total counts the distinct words (a quoted phrase is one word) of the macro and of every macro it uses (to any depth),
 * direct only those written in its own definition. Macros that are not defined in the cartridge add nothing.
 */
function macroWordCount(idx, cartPath, name) {
  const TOKENS = /"[^"]*"|[^\s\[\]]+/g, IS_MACRO = /^\$[A-Za-z_]\w*$/;
  const plain = (t) => t.replace(/^"|"$/g, '').toLowerCase();
  const words = (n, seen, acc) => {
    const entries = idx.defs.get(n);
    if (!entries || !entries.length || seen.has(n)) return;
    seen.add(n);
    for (const t of preferred(entries, cartPath).body.match(TOKENS) || []) {
      if (IS_MACRO.test(t)) { if (t !== '$ACT') words(t, seen, acc); }
      else acc.add(plain(t));
    }
  };
  const total = new Set(), direct = new Set();
  words(name, new Set(), total);
  const own = idx.defs.get(name);
  for (const t of (own && own.length ? preferred(own, cartPath).body : '').match(TOKENS) || []) if (!IS_MACRO.test(t)) direct.add(plain(t));
  return { total: total.size, direct: direct.size };
}

function macroLocations(cartPath, macros) {
  const squash = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const master = path.join(path.dirname(cartPath), 'bin');
  const carts = [{ name: path.basename(cartPath), p: cartPath }, ...siblingCartridges(cartPath).map(p => ({ name: path.basename(p), p })), ...(exists(path.join(master, 'nodetype.ini')) && path.resolve(master) !== path.resolve(cartPath) ? [{ name: 'bin (master copy)', p: master }] : [])];
  const idxs = carts.map(c => ({ ...c, idx: buildMacroIndex(c.p) }));
  const own = idxs[0].idx;
  for (const m of macros) {
    const wc = macroWordCount(own, cartPath, m.name);
    m.wordCount = wc.total; m.directWords = wc.direct;
    const mine = own.defs.get(m.name);
    const myBody = mine && mine.length ? squash(preferred(mine, cartPath).body) : null;
    m.where = [];
    for (const c of idxs) {
      const entries = c.idx.defs.get(m.name);
      if (!entries || !entries.length) continue;
      m.where.push({ cartridge: c.name, files: entries.map(e => path.relative(c.p, e.file)).sort(), same: myBody === null || squash(preferred(entries, c.p).body) === myBody });
    }
  }
  return macros;
}

/** The definition of an existing $macro of the cartridge (for "Edit macro"): { name, body, file, topLevel, copies }. */
function macroInfo(cartPath, name) {
  const idx = buildMacroIndex(cartPath);
  const entries = idx.defs.get(String(name));
  if (!entries || !entries.length) throw new Error(name + ' is not defined in a macro file of this cartridge (it may be a macro written in the pattern itself).');
  const e = preferred(entries, cartPath), rel = path.relative(cartPath, e.file);
  return { name, body: String(e.body).trim(), file: rel, topLevel: normRel(path.dirname(rel)) === 'grdata', copies: entries.length };
}

// the words of a word set are separated by white space: a comma (or semicolon) outside double quotes is a typo (the list was written like prose)
function checkSeparators(bare) {
  if (/[,;]/.test(bare)) throw new Error('Words in a macro are separated by white space, not by commas or semicolons: [word1 word2 "two words"]. Remove the "," / ";" (a phrase that really contains one goes in double quotes).');
}
const checkMacroBody = (body) => {
  if (!/^\[[\s\S]*\]$/.test(body)) throw new Error('The definition must be a word set in square brackets: [word "two words" $OTHER_MACRO word~].');
  const bare = body.replace(/"[^"]*"/g, '""');
  if ((body.match(/"/g) || []).length % 2) throw new Error('A double quote is not closed in the definition.');
  if ((bare.match(/\[/g) || []).length !== (bare.match(/\]/g) || []).length) throw new Error('Square brackets in the definition are not balanced.');
  checkSeparators(bare);
};

/**
 * Replace the definition of $NAME in <file> of the cartridge (backup first). With allCartridges and a file directly in grdata, the same file of every other cartridge and
 * the master copy (MEDSCAN\bin) is changed too — but only where the macro still has the definition it had here before (a copy that differs is left alone and reported).
 * → { ok, name, file, added: [{ cartridge, file }], skipped: [{ cartridge, reason }] }   (added = changed)
 */
function editMacro(cartPath, { file, name, body, original, allCartridges }) {
  name = String(name || '').trim(); body = String(body || '').trim();
  checkMacroBody(body);
  const squash = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const rel = path.normalize(String(file || ''));
  if (path.isAbsolute(rel) || rel.startsWith('..') || !/\.msgrep$/i.test(rel)) throw new Error('The macro file is not valid.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '_EditMacro_' + name.slice(1);
  const rewrite = (root, f, backupRoot, tag, expectOld) => {
    const raw = readText(f);
    const d = extractDefines(stripComments(raw)).find(x => x.name === name);
    if (!d) return 'not defined in ' + rel;
    if (squash(d.body) === squash(body)) return { same: true };                    // nothing to do: it already has the new definition (e.g. the file is shared with a cartridge changed before)
    if (expectOld != null && squash(d.body) !== squash(expectOld)) return 'has a different definition: ' + squash(d.body).slice(0, 120);
    const eol = eolOf(raw), nb = body.replace(/\r?\n/g, eol);
    const bk = path.join(backupRoot, '_relation_backups', stamp, tag, path.relative(root, f));
    fs.mkdirSync(path.dirname(bk), { recursive: true }); fs.copyFileSync(f, bk);
    fs.writeFileSync(f, raw.slice(0, d.start) + '#define ' + name + '  ' + nb + raw.slice(d.end));
    return null;
  };
  const target = path.join(cartPath, rel);
  if (!exists(target)) throw new Error(rel + ' does not exist in this cartridge.');
  const why = rewrite(cartPath, target, cartPath, '', null);
  if (why) throw new Error(name + ' ' + why);
  const added = [{ cartridge: path.basename(cartPath), file: rel }], skipped = [], unchanged = [];
  if (allCartridges && normRel(path.dirname(rel)) === 'grdata') {
    const master = path.join(path.dirname(cartPath), 'bin');
    for (const p of [...siblingCartridges(cartPath), ...(exists(path.join(master, rel)) ? [master] : [])]) {
      const isMaster = p === master, cn = isMaster ? 'bin (master copy)' : path.basename(p), f = path.join(p, rel);
      try {
        if (!exists(f)) { unchanged.push({ cartridge: cn, reason: 'has no ' + rel }); continue; }
        const w = rewrite(p, f, isMaster ? cartPath : p, isMaster ? 'bin' : '', original);
        if (w && w.same) unchanged.push({ cartridge: cn, reason: 'already has this definition' });
        else if (w) skipped.push({ cartridge: cn, reason: name + ' ' + w + ' — nothing changed' }); else added.push({ cartridge: cn, file: rel });
      } catch (e) { skipped.push({ cartridge: cn, reason: e.message }); }
    }
  }
  return { ok: true, name, file: rel, added, skipped, unchanged, edited: true };
}

/**
 * Rename the macro $OLD to $NEW: its #define in <file> and every use of it in the .msgrep files of the cartridge (whole word: $RISK does not touch $RISKY), backups first.
 * With allCartridges and a file directly in grdata the same is done in every other cartridge and the master copy (MEDSCAN\bin) that defines $OLD in that file.
 * A cartridge that already defines $NEW is left alone (nothing is merged). → { ok, name, newName, file, added: [{ cartridge, file, files, uses }], skipped, unchanged }
 */
function renameMacro(cartPath, { file, name, newName, allCartridges }) {
  name = String(name || '').trim(); newName = String(newName || '').trim();
  if (!/^\$[A-Za-z_]\w*$/.test(newName)) throw new Error('A macro name starts with $ and has letters, digits and underscores, e.g. $NOT_CONTRACTED.');
  if (newName === name) throw new Error('The new name is the same as the old one.');
  if (newName === '$ACT') throw new Error('$ACT is reserved.');
  const rel = path.normalize(String(file || ''));
  if (path.isAbsolute(rel) || rel.startsWith('..') || !/\.msgrep$/i.test(rel)) throw new Error('The macro file is not valid.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '_RenameMacro_' + name.slice(1);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const useRe = new RegExp(esc(name) + '(?![A-Za-z0-9_])', 'g');
  // → null (renamed; { files, uses }), or a reason string
  const doRename = (root, backupRoot, tag) => {
    const idx = buildMacroIndex(root);
    if (idx.defs.has(newName)) return idx.defs.has(name) ? newName + ' is already defined there' : { same: true };
    const own = (idx.defs.get(name) || []).find(e => path.resolve(e.file) === path.resolve(path.join(root, rel)));
    if (!own) return name + ' is not defined in ' + rel;
    let files = 0, uses = 0;
    for (const f of idx.files) {
      let raw; try { raw = readText(f); } catch { continue; }
      const n = (raw.match(useRe) || []).length;
      if (!n) continue;
      const bk = path.join(backupRoot, '_relation_backups', stamp, tag, path.relative(root, f));
      fs.mkdirSync(path.dirname(bk), { recursive: true }); fs.copyFileSync(f, bk);
      fs.writeFileSync(f, raw.replace(useRe, newName));
      files++; uses += n;
    }
    return { files, uses };
  };
  const target = path.join(cartPath, rel);
  if (!exists(target)) throw new Error(rel + ' does not exist in this cartridge.');
  const first = doRename(cartPath, cartPath, '');
  if (typeof first === 'string') throw new Error(first);
  if (first.same) throw new Error(newName + ' is already defined in this cartridge.');
  const added = [{ cartridge: path.basename(cartPath), file: rel, ...first }], skipped = [], unchanged = [];
  if (allCartridges && normRel(path.dirname(rel)) === 'grdata') {
    const master = path.join(path.dirname(cartPath), 'bin');
    for (const p of [...siblingCartridges(cartPath), ...(exists(path.join(master, rel)) ? [master] : [])]) {
      const isMaster = p === master, cn = isMaster ? 'bin (master copy)' : path.basename(p);
      try {
        if (!exists(path.join(p, rel))) { unchanged.push({ cartridge: cn, reason: 'has no ' + rel }); continue; }
        const w = doRename(p, isMaster ? cartPath : p, isMaster ? 'bin' : '');
        if (w.same) unchanged.push({ cartridge: cn, reason: 'already has ' + newName });
        else if (typeof w === 'string') skipped.push({ cartridge: cn, reason: w + ' — nothing changed' });
        else added.push({ cartridge: cn, file: rel, ...w });
      } catch (e) { skipped.push({ cartridge: cn, reason: e.message }); }
    }
  }
  return { ok: true, name, newName, file: rel, added, skipped, unchanged, renamed: true };
}

/** Literal words of the patterns' word sets that a (small) macro of the cartridge already covers are replaced by the macro; bigger macros are only suggested (see macroFix.js). */
function fixMacroPatterns(cartPath, patterns, glued = []) {
  const idx = buildMacroIndex(cartPath);
  const macros = [];
  for (const [name, entries] of idx.defs) {
    if (name.startsWith('&')) continue;
    macros.push({ name, body: preferred(entries, cartPath).body.replace(/\s+/g, ' ').trim() });
  }
  return require('./macroFix').fixMacros(macros, patterns, glued);
}

const sibCache = new Map();
function siblingProps(p) { const hit = sibCache.get(p); if (hit && Date.now() - hit.t < 120000) return hit.v; const v = relationProps(p); sibCache.set(p, { t: Date.now(), v }); return v; }

/** CONTROL properties used by the rules of each relation type: { <ControlType>: { <Property>: [values…] } } */
function relationProps(cartPath) {
  const out = {};
  for (const f of listMsgrepFiles(cartPath)) {
    let t; try { t = readText(f); } catch { continue; }
    if (!/ControlType/i.test(t)) continue;
    const st = stripComments(t);
    const re = /\bCONTROL\b\s*\{/g;
    let m;
    while ((m = re.exec(st)) !== null) {
      const open = st.indexOf('{', m.index), close = findMatching(st, open);
      if (close < 0) continue;
      re.lastIndex = close;
      const body = st.slice(open + 1, close);
      const ct = body.match(/ControlType\s*=\s*"([^"]+)"/i);
      if (!ct) continue;
      const rel = out[ct[1]] || (out[ct[1]] = {});
      for (const p of body.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)) {
        if (/^ControlType$/i.test(p[1])) continue;
        const list = rel[p[1]] || (rel[p[1]] = []);
        if (!list.includes(p[2])) list.push(p[2]);
      }
    }
  }
  return out;
}

/**
 * Every macro of the cartridge (all .msgrep files in it), most useful first for a pattern of `relation`:
 * macros that share a word / stem with the sentence come first; among them the macros defined NEARER to the relation's
 * pattern files (same folder > parent folder > grdata\DictionaryMacros.msgrep) weigh more.
 */
function rankMacros(cartPath, sentenceText, relation) {
  // MedScan semantics: a macro word WITH a trailing "~" accepts word variants (stem match); a word WITHOUT "~" matches only as the full word, whatever its length
  const stem = (w) => {
    if (stemPlural) w = stemPlural(w);                                                              // plurals: the Dictionary panel's `pluralize` rules
    else for (const suf of ['ies', 'es', 's']) if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break; }
    if (lemmatizer) {                                                                               // verbs / adjectives → dictionary form (had → have, producing → produce, lower → low)
      const v = lemmatizer.verb(w), a = lemmatizer.adjective(w);
      if (v !== w) return v;
      if (a !== w) return a;
    }
    for (const suf of ['ations', 'ation', 'ings', 'ing', 'ied', 'ed', 'ly']) if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
    return w;
  };
  const stemEq = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const words = new Set(String(sentenceText || '').toLowerCase().match(/[a-z]+/g) || []);
  const stems = [...words].map(stem);
  const bodyHits = (body) => {
    let n = 0;
    for (const m of body.toLowerCase().matchAll(/(?<![$@&\w])([a-z]+)(~?)/g)) {
      if (m[2] ? stems.some(s => stemEq(s, stem(m[1]))) : words.has(m[1])) n++;
    }
    return n;
  };
  // folders of the files the new pattern will live next to: those of the relation's existing rules / sets, else grdata\<relation>
  const comps = (f) => path.relative(cartPath, path.dirname(f)).split(path.sep).filter(Boolean);
  const targets = [];
  if (relation) {
    try { for (const s of findExistingSets(cartPath, relation)) for (const f of [s.ruleFile, s.setFile]) if (f) targets.push(comps(path.isAbsolute(f) ? f : path.join(cartPath, f))); } catch { /* optional */ }
    if (!targets.length) { const d = path.join(cartPath, 'grdata', relation); if (exists(d)) targets.push(['grdata', relation]); }
  }
  const nearness = (f) => {
    const c = comps(f); let best = 0;
    for (const t of targets) { let n = 0; while (n < c.length && n < t.length && c[n].toLowerCase() === t[n].toLowerCase()) n++; if (n > best) best = n; }
    return best;
  };
  const idx = buildMacroIndex(cartPath);
  const macros = [];
  for (const [name, entries] of idx.defs) {
    if (name.startsWith('&')) continue;
    const e = targets.length ? [...entries].sort((a, b) => nearness(b.file) - nearness(a.file) || depthOf(cartPath, a.file) - depthOf(cartPath, b.file))[0] : preferred(entries, cartPath);
    const body = e.body.replace(/\s+/g, ' ').trim();
    let hit = bodyHits(body);
    for (const t of name.toLowerCase().match(/[a-z]+/g) || []) if (words.has(t)) hit += 3;
    const near = targets.length ? nearness(e.file) : 0;
    macros.push({ name, body: body.slice(0, 110), hit, near, score: hit + 3 * near, depth: depthOf(cartPath, e.file) });
  }
  macros.sort((a, b) => (b.hit > 0) - (a.hit > 0) || b.score - a.score || a.depth - b.depth || a.name.localeCompare(b.name));
  return macros;
}

/** The macro list as the prompt wants it: ONLY macros whose name or definition contains a word / stem of the sentence (the others cannot match it and just cost tokens). */
function macroPrompt(cartPath, sentenceText, relation, top = 200) {
  const macros = rankMacros(cartPath, sentenceText, relation).filter(m => m.hit > 0);
  return { macros: macros.slice(0, top).map(({ name, body }) => ({ name, body })), macroNames: [], total: macros.length };
}

/**
 * Context for "Suggest pattern" (Pipeline): the relation types declared in the cartridge, the IsFrame node types that occur
 * in the sentence markup (node type = MSID / 1,000,000, see [NodeType-MSIDRange]) and the macros the cartridge offers
 * (those whose body mentions words of the sentence first).
 */
function suggestContext(cartPath, markup, sentenceText) {
  const nt = readText(path.join(cartPath, 'nodetype.ini'));
  const lines = splitLines(nt);
  const rangeOf = new Map();                                      // number → type
  const rs = sectionRange(lines, 'NodeType-MSIDRange');
  if (rs) for (const l of lines.slice(rs.start + 1, rs.end)) {
    const m = l.match(/^\s*([A-Za-z]\w*)\s*=\s*(\d+)\s*$/);
    if (m && !/^User\d+$/i.test(m[1])) rangeOf.set(Number(m[2]), m[1]);
  }
  const isFrame = (t) => iniGet(nt, 'NodeType-IsFrame', t) === '1';
  const found = new Map();                                        // type → Set(texts)
  const entityTypes = {};                                         // 'ids' as written in ID{ids=text} → its IsFrame node types
  for (const m of String(markup || '').matchAll(/ID\{([\d,\s]+)=([^}]*)\}/g)) {
    for (const idStr of m[1].split(',')) {
      const id = Number(idStr.trim());
      if (!id) continue;
      const t = rangeOf.get(Math.floor(id / 1e6));
      if (!t || !isFrame(t)) continue;
      const key = m[1].replace(/\s+/g, '');
      if (!(entityTypes[key] || (entityTypes[key] = [])).includes(t)) entityTypes[key].push(t);
      if (!found.has(t)) found.set(t, new Set());
      found.get(t).add(m[2].trim());
    }
  }
  const info = getInfo(cartPath), relations = info.relations;
  const usage = {};                                              // direction the cartridge's existing rules give each relation type
  for (const r of Object.keys(relations)) { try { const e = readRelationEntities(cartPath, r); usage[r] = { regulators: [...e.regulators, ...e.both], targets: [...e.targets, ...e.both] }; } catch { usage[r] = { regulators: [], targets: [] }; } }
  // A frame written with Protein also takes Complex and FunctionalClass entities (msgrep treats them as one family): such an entity is always offered as Protein, the type the frames are written with
  // (the sentence's markup keeps its own type; the frame / rule that extracts the relation is the Protein one).
  const fam = (t) => { const f = frameTypeOf(t); return f !== t && isFrame(f) ? f : t; };
  for (const k of Object.keys(entityTypes)) entityTypes[k] = [...new Set(entityTypes[k].map(fam))];
  const merged = new Map();
  for (const [type, set] of found) { const t = fam(type); if (!merged.has(t)) merged.set(t, new Set()); for (const x of set) merged.get(t).add(x); }
  const types = [...merged].map(([type, set]) => ({ type, examples: [...set].slice(0, 3) }));
  // property vocabulary: this cartridge's rules first; for relation types it has no rules for, what the sibling cartridges use
  const props = relationProps(cartPath);
  try {
    const parent = path.dirname(cartPath);
    for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
      const p = path.join(parent, d.name);
      if (!d.isDirectory() || path.resolve(p) === path.resolve(cartPath) || !exists(path.join(p, 'nodetype.ini'))) continue;
      const other = siblingProps(p);
      for (const [rel, kv] of Object.entries(other)) {
        const mine = props[rel] || (props[rel] = {});
        for (const [k, vals] of Object.entries(kv)) {
          if (!mine[k]) mine[k] = [...vals];
          else if (k !== 'Effect') for (const v of vals) if (!mine[k].includes(v)) mine[k].push(v);
        }
      }
    }
  } catch { /* siblings are optional */ }
  for (const kv of Object.values(props)) if (kv.Effect) kv.Effect = ['positive', 'negative', 'unknown'];   // closed vocabulary
  return { relations, aliases: GE_NAMES, propAliases: PROP_GE_NAMES, usage, props, types, entityTypes, ...macroPrompt(cartPath, sentenceText, null) };
}

// ───────────────────────────── Step 6: register + compile ─────────────────────────────
function run(cmd, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { shell: true, cwd, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ code: -1, out, err: err + e.message }));
    p.on('close', code => resolve({ code, out, err }));
  });
}

async function compileRelation(cartPath, opts) {
  if (opts.placement) return compileExistingSet(cartPath, opts);
  const { relationName: rel, prefix: requestedPrefix, mode } = opts;
  const cs = mode === 'csout';
  const decided = resolvePrefix(cartPath, rel, cs ? 'csout' : 'msout');
  const prefix = decided.existing ? decided.prefix : requestedPrefix;     // never register a second batch for the same relation
  if (!/^[a-z0-9]+$/.test(prefix || '')) throw new Error('Command prefix must be lower-case letters/digits.');
  const sess = getSession(cartPath, rel);
  const lay = layoutFor(rel, cs ? 'csout' : 'msout');
  const patDirName = lay.dirName;
  const lower = lay.batch;
  const outName = lay.outName;
  const log = [];
  const ttkExe = path.join(cartPath, 'ttkconf.exe');
  if (!exists(ttkExe)) throw new Error('ttkconf.exe not found in the cartridge folder.');

  // FR 6.2 — ttkconf.ini (and .delta): commands for the new relation, once
  for (const f of [path.join(cartPath, 'ttkconf.ini'), path.join(cartPath, 'ttkconf.ini.delta')].filter(exists)) {
    let t = readText(f);
    const spaced = f.endsWith('.delta') && /^\s*\w[^=\n]*\s=\s/m.test(t);
    const eq = spaced ? ' = ' : '=';
    if (iniGet(t, 'commands', `comp_${prefix}`) === null) {
      t = iniAppend(t, 'commands', [
        `del_${prefix}${eq}rm -f ${lower}.grbatch`,
        `comp_${prefix}${eq}\${MSGREP} -Hgrdata/${folderName(rel)}/${patDirName} -B${lower}.grbatch <\${devnull} >\${devnull}`,
      ]);
      log.push(`${path.basename(f)}: added del_${prefix} / comp_${prefix}`);
    }
    // also include it in the "pat_*" task so recompile-all / install keep the new batch up to date
    t = iniReplaceKey(t, 'tasks', 'pat_*',(v) => (v.includes(`$*_${prefix}`) ? v : v.replace(/(,\$\*_prgl)?\s*$/, (m) => `,$*_${prefix}${m}`)));
    sess.write(f, t);
  }

  // FR 6.1 / 6.3 — compile
  const del = await run(`"${ttkExe}" del_${prefix}`, cartPath);
  log.push(`ttkconf del_${prefix} → exit ${del.code}`);
  const logName = `comp_${prefix}.log`;
  const comp = await run(`"${ttkExe}" comp_${prefix} 2>"${logName}"`, cartPath);
  log.push(`ttkconf comp_${prefix} → exit ${comp.code}`);
  let compLog = '';
  try { compLog = readText(path.join(cartPath, logName)); } catch { }
  const grbatch = path.join(cartPath, `${lower}.grbatch`);
  const compiled = comp.code === 0 && exists(grbatch);
  if (!compiled) {
    sess.rollback();
    sessions.delete(`${cartPath}|${rel}`);
    return { ok: false, log, compLog: (compLog + '\n' + comp.out + '\n' + comp.err).trim(),
             error: `Compilation failed (exit ${comp.code}${exists(grbatch) ? '' : `, ${lower}.grbatch was not produced`}). All changes were rolled back.` };
  }

  // FR 6.4 — locscan.ini (and .delta): output command + add to allpats
  const outLine = (spaced) => `${outName}${spaced ? ' = ' : '='}\${MSGREP} -I${mode} -H grdata/${folderName(rel)}/${patDirName} -b ${lower}.grbatch | \${XF2RN}`;
  for (const f of [path.join(cartPath, 'locscan.ini'), path.join(cartPath, 'locscan.ini.delta')].filter(exists)) {
    let t = readText(f);
    const spaced = f.endsWith('.delta') && /^\s*\w[^=\n]*\s=\s/m.test(t);
    if (iniGet(t, 'output', outName) === null) { t = iniAppend(t, 'output', [outLine(spaced)]); log.push(`${path.basename(f)}: added output command "${outName}"`); }
    t = iniReplaceKey(t, 'output', 'allpats', (v) => {
      const m = v.match(/^(\$\()(.*)(\)\s*)$/);
      if (!m) return v;
      return m[2].split('+').map(s => s.trim()).includes(outName) ? v : `${m[1]}${m[2]}+${outName}${m[3]}`;
    });
    sess.write(f, t);
  }
  log.push(`locscan.ini: ${outName} added to allpats`);
  sessions.delete(`${cartPath}|${rel}`);
  return { ok: true, prefix, log, compLog: compLog.trim(), backupDir: path.relative(cartPath, sess.dir) };
}


// ───────────────────────────── Pipeline: "Open pattern" — which pattern of an output folder produced the relations ─────────────────────────────
/** The relations of an xf2rn result (RNEF XML): [{ type, props, inType, outType }] */
function relationsOfRnef(xml) {
  const types = new Map(), names = new Map();
  for (const n of String(xml || '').matchAll(/<node\b[^>]*\blocal_id="([^"]+)"[^>]*>([\s\S]*?)<\/node>/g)) {
    const t = n[2].match(/name="NodeType"\s+value="([^"]*)"/);
    if (t) types.set(n[1], t[1]);
    const nm = n[2].match(/name="Name"\s+value="([^"]*)"/);
    if (nm) names.set(n[1], nm[1]);
  }
  const out = [];
  for (const c of String(xml || '').matchAll(/<control\b[^>]*>([\s\S]*?)<\/control>/g)) {
    const props = {};
    for (const a of c[1].matchAll(/<attr\s+name="([^"]+)"\s+value="([^"]*)"/g)) props[a[1]] = a[2];
    const ref = (k) => { const m = c[1].match(new RegExp('<link\\s+type="' + k + '"\\s+ref="([^"]+)"')); return m ? m[1] : ''; };
    const link = (k) => types.get(ref(k)) || '';
    if (props.ControlType) out.push({ type: props.ControlType, props, inType: link('in'), outType: link('out'), inName: names.get(ref('in')) || '', outName: names.get(ref('out')) || '' });
  }
  return out;
}

/**
 * msgrep names the rule that matched a sentence (-d <file> -D H writes "Match of rule N"), but not its source. So: the relations of
 * the pattern step are read from its XML; every pattern of the output folder's frames that can produce such a relation is put into a
 * temporary folder as ONE rule of its own (same frame, one alternative per rule); msgrep runs on the step's input and the rule
 * numbers that matched say which alternatives did it.
 * { ok, relations, matches: [{ control, controlFile, controlLine, patternsFile, set, setLine, params, index, of, alts, alt }], tested, message? }
 */
function findUsedPatterns(cartPath, { outputName, csout, msout, xml, license }) {
  const { spawnSync } = require('child_process');
  let cmd = '';
  for (const f of ['locscan.ini', 'locscan.ini.delta'].map(x => path.join(cartPath, x)).filter(exists)) {
    const m = readText(f).match(new RegExp('^\\s*' + String(outputName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=(.*)$', 'mi'));
    if (m) { cmd = m[1]; break; }
  }
  const mode = (cmd.match(/-I\s*(msout|csout)/i) || [])[1]?.toLowerCase();
  const hdir = (cmd.match(/-H\s*(\S+)/) || [])[1];
  if (!mode || !hdir) return { ok: false, message: `The output command "${outputName}" was not found in locscan.ini (or it has no -H folder).` };
  const input = mode === 'csout' ? csout : msout;
  if (!input) return { ok: false, message: `No ${mode} text of the pipeline is available.` };
  const rels = relationsOfRnef(xml);
  if (!rels.length) return { ok: false, message: 'This pattern step produced no relations.' };

  // frames of the folder (the files its rules reach through #include), per relation type of the result
  const dirAbs = path.resolve(cartPath, hdir);
  const reach = new Set();
  const go = (x) => { x = path.resolve(x); if (reach.has(x) || !exists(x)) return; reach.add(x); let t = ''; try { t = stripComments(readText(x)); } catch { return; } for (const m of t.matchAll(/#include\s+"([^"]+)"/g)) go(path.resolve(path.dirname(x), m[1])); };
  if (exists(dirAbs)) for (const f of fs.readdirSync(dirAbs)) if (/\.msgrep$/i.test(f)) go(path.join(dirAbs, f));
  const abs = (rel) => path.join(path.dirname(cartPath), rel);
  const cart = [{ name: path.basename(cartPath), path: cartPath }];
  const has = (list, x) => list.some(y => String(y).toLowerCase() === String(x).toLowerCase());
  const cands = [];
  for (const t of [...new Set(rels.map(r => r.type))]) {
    for (const row of findRelationPatterns(cart, t, true)) {
      if (!reach.has(path.resolve(abs(row.controlFile)))) continue;
      const props = {};
      for (const p of row.control.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) if (!/^ControlType$/i.test(p[1])) props[p[1]] = p[2];
      const rs = rels.filter(r => r.type === t && Object.entries(props).every(([k, v]) => String(r.props[k] || '').toLowerCase() === v.toLowerCase())
        && (!row.roles.in || !r.inType || typeListHas(row.roles.in.types, r.inType)) && (!row.roles.out || !r.outType || typeListHas(row.roles.out.types, r.outType)));   // a frame's Protein also takes a Complex / FunctionalClass relation (shared/entityTypes.js)
      if (rs.length) cands.push({ row, props, t });
    }
  }
  if (!cands.length) return { ok: true, relations: rels, matches: [], tested: 0, message: 'No frame of this pattern folder matches the relations found (their patterns may be written inline in an old-style rule).' };

  return searchAlternatives(cartPath, cands, mode, input, license, rels);
}

/** Every pattern alternative of the candidate frames (cands: [{ row, props, t }]) as ONE rule of a temporary folder, msgrep -d on `input` → the alternatives that matched. */
function searchAlternatives(cartPath, cands, mode, input, license, rels) {
  const abs = (rel) => path.join(path.dirname(cartPath), rel);
  const { spawnSync } = require('child_process');
  const list = [];
  const rules = [], defs = [];
  for (const c of cands) {
    const calls = [...String(c.row.expr || '').matchAll(/&([A-Za-z_]\w*)\s*\(([^)]*)\)/g)].map(m => ({ name: '&' + m[1], args: m[2] }));       // a frame can call its set in both directions
    const roleText = (k) => (c.row.roles[k] ? `${k} = ${c.row.roles[k].var}(${c.row.roles[k].types.join(', ')})` : '');
    const propText = Object.entries(c.props).map(([k, v]) => `${k} = "${v}"`).join('\n');
    for (const set of c.row.patternSets) {
      const mine = calls.filter(k => k.name.toLowerCase() === String(set.name).toLowerCase());
      const variants = mine.length ? mine : calls.slice(0, 1);                     // a set reached through another set: the first call
      if (!variants.length) continue;
      set.alts.forEach((alt, i) => variants.forEach((call) => {
        const n = list.length;
        list.push({ row: c.row, set, alt, i, args: call.args });
        defs.push(`#define &NLPMU${n}(${set.params || '@in, @out'}) (\n${alt}\n);`);
        rules.push(`CONTROL\n{\n${roleText('in')}\n${roleText('out')}\nControlType = "${c.t}"\n${propText}\n} : &NLPMU${n}(${call.args});`);
      }));
    }
  }
  // patterns written in the rule file itself (old style, e.g. the triple rule CONTROL {…} CONTROL {…} CONTROL {…} : %a … %c … %t ;): the group of CONTROL blocks is tested as ONE rule,
  // once per alternative of its pattern, written as it stands (its variables %a %c %t …); the macros it uses come with the includes of its rule file
  const seenGroups = new Set();
  for (const c of cands) {
    if (!c.row.inlinePattern || !c.row.chainText || seenGroups.has(c.row.chainKey)) continue;
    seenGroups.add(c.row.chainKey);
    const alts = c.row.inlinePattern.alts;
    alts.forEach((alt, i) => {
      list.push({ row: c.row, set: { name: '(pattern written in the rule)', params: '', line: c.row.controlLine, alts }, alt, i, inline: true });
      rules.push(`${c.row.chainText}\n: ${alt};`);
    });
  }
  if (!list.length) return { ok: true, relations: rels, matches: [], tested: 0, message: 'The matching frames have no pattern sets to search.' };
  const id = `_nlpm_find_${Date.now()}`;
  const dir = path.join(cartPath, 'grdata', id), batch = `${id}.grbatch`, dbg = path.join(dir, 'dbg.html');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = [...new Set(cands.flatMap(c => c.row.patternSets.map(() => abs(c.row.patternsFile))))];
    // the includes of the rule files of the frames (macro files …) come first, in their own order: the patterns file alone may rely on macros its Rules file brings in
    const ctxFiles = [];
    for (const c of cands) {
      const rf = abs(c.row.controlFile);
      let t = ''; try { t = stripComments(readText(rf)); } catch { continue; }
      for (const m of t.matchAll(/#include\s+"([^"]+)"/g)) { const f = path.resolve(path.dirname(rf), m[1]); if (exists(f) && !ctxFiles.includes(f)) ctxFiles.push(f); }
    }
    const all = [...ctxFiles, ...files.map(f => path.resolve(f)).filter(f => !ctxFiles.includes(f))];
    const inc = all.map(f => `#include "${path.relative(dir, f).split(path.sep).join('/')}"`);
    fs.writeFileSync(path.join(dir, 'Rules.msgrep'), [...inc, '', ...defs, '', ...rules, ''].join('\r\n'));
    const exe = path.join(cartPath, 'msgrep.exe');
    const c = spawnSync(exe, ['-w', `-H${path.posix.join('grdata', id)}`, `-B${batch}`], { cwd: cartPath, input: '', encoding: 'utf8', maxBuffer: 1 << 26 });
    if (c.status !== 0 || !exists(path.join(cartPath, batch))) return { ok: false, message: 'Could not compile the patterns for the search: ' + `${c.stderr || ''}\n${c.stdout || ''}`.split(/\r?\n/).map(l => l.trim()).filter(l => /error|cannot|unexpected|undefined|not defined|missing|duplicate|syntax|expected|file open/i.test(l) && !/^warning/i.test(l)).slice(0, 4).join(' | ') || `${c.stderr || ''}\n${c.stdout || ''}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-4).join(' | ') };
    spawnSync(exe, [`-t${license || ''}`, `-I${mode}`, '-H', path.posix.join('grdata', id), '-b', batch, '-d', dbg, '-D', 'H'], { cwd: cartPath, input, encoding: 'utf8', maxBuffer: 1 << 26 });
    const html = exists(dbg) ? readText(dbg) : '';
    const hit = [...new Set([...html.matchAll(/Match of rule (\d+)/g)].map(m => Number(m[1])))];
    // rule numbers count from 0 in the order the rules were written above
    const matches = hit.filter(n => list[n]).map(n => {
      const x = list[n];
      // the matching alternative as the wizard edits it: the set's own parameter names (@in / @out …) become @regulator / @target (the rule's `in` is the regulator)
      let wizardAlt = x.alt;
      try {
        const params = (Array.isArray(x.set.params) ? x.set.params : String(x.set.params || '').split(',')).map(s => String(s).trim()).filter(Boolean);
        const args = (x.args != null ? String(x.args) : ((String(x.row.expr || '').match(/\(([^)]*)\)/) || [])[1] || '')).split(',').map(s => s.trim().replace(/^%/, ''));
        const varOf = (k) => (String(x.row.control).match(new RegExp('\\b' + k + '\\s*=\\s*%(\\w+)')) || [])[1];
        const pReg = params[args.indexOf(varOf('in'))], pTgt = params[args.indexOf(varOf('out'))];
        if (pReg && pTgt && pReg !== pTgt) {
          const rx = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g');
          wizardAlt = String(x.alt).replace(rx(pReg), '\u0001R').replace(rx(pTgt), '\u0001T').replace(/\u0001R/g, '@regulator').replace(/\u0001T/g, '@target');
        }
      } catch { /* the plain alternative is shown */ }
      return { wizardAlt, control: x.inline ? x.row.chainText : x.row.control.replace(/\s*:\s*&[\s\S]*$/, '') + ' : ' + (x.row.expr || '').replace(/\s+/g, ' ') + ';', controlFile: x.row.controlFile, controlLine: x.row.controlLine,
        patternsFile: x.row.patternsFile, set: x.set.name, setLine: x.set.line, params: x.set.params, index: x.i + 1, of: x.set.alts.length, alts: x.set.alts, alt: x.alt };
    });
    return { ok: true, relations: rels, matches, tested: list.length, message: matches.length ? '' : 'None of the patterns of this folder\'s frames matches the pipeline input on its own (the relation may come from several rules, or from an inline pattern).' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(cartPath, batch), { force: true }); } catch { /* temp files */ }
  }
}

/**
 * "Is the suggested relation already extracted by the existing patterns?" Every frame of the relation type with the same CONTROL properties
 * whose in / out lists contain the regulator and target type is searched in its own folder (the folder of its Rules file, if an output command
 * of locscan.ini reads it) with the input that command uses.
 * { ok, matches: [{ folder, mode, control, controlFile, controlLine, patternsFile, set, setLine, params, index, of, alts, alt }], tested, message? }
 */
function findExtracting(cartPath, { markup, markupMs, relation, props, regulator, target, license }) {
  const modes = outputModes(cartPath);
  const cart = [{ name: path.basename(cartPath), path: cartPath }];
  const has = (list, x) => list.some(y => String(y).toLowerCase() === String(x).toLowerCase());
  const want = Object.entries(props || {}).filter(([, v]) => String(v).trim());
  const byFolder = new Map();
  for (const row of findRelationPatterns(cart, relation, true)) {
    const frameProps = {};
    for (const p of row.control.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) if (!/^ControlType$/i.test(p[1])) frameProps[p[1]] = p[2];
    const have = Object.entries(frameProps);
    if (have.length !== want.length || !want.every(([k, v]) => have.some(([k2, v2]) => k2.toLowerCase() === k.toLowerCase() && v2.toLowerCase() === String(v).toLowerCase()))) continue;
    if (!typeListHas(row.roles.in?.types || [], regulator) || !typeListHas(row.roles.out?.types || [], target)) continue;
    const dir = dirKey(path.dirname(row.controlFile).split(path.sep).slice(1).join('/'));
    const mode = modes.get(dir);
    if (!mode) continue;
    if (!byFolder.has(dir)) byFolder.set(dir, { mode, cands: [] });
    byFolder.get(dir).cands.push({ row, props: frameProps, t: relation });
  }
  const piped = pipelineDirs(cartPath);
  const msFromCs = String(markup || '').split(/\r?\n/).filter(l => /^(mref|msrc)\t/.test(l)).join('\r\n') + '\r\n\r\n';
  const matches = [];
  let tested = 0, message = '';
  for (const [dir, g] of byFolder) {
    const input = g.mode === 'csout' ? markup : (markupMs || (/^msrc\t/m.test(msFromCs) ? msFromCs : ''));   // markupMs = the real MedScan output that the pipeline's -Imsout folders read
    if (!input) continue;
    const r = searchAlternatives(cartPath, g.cands, g.mode, input, license, []);
    if (!r.ok) { message = r.message; continue; }
    tested += r.tested || 0;
    for (const m of r.matches || []) matches.push({ ...m, folder: dir, mode: g.mode, inPipeline: piped.has(dir) });
  }
  return { ok: true, matches, tested, message };
}

/** The pattern folders of a cartridge (as written after -H in locscan.ini, e.g. grdata/ce/p2cs) whose CONTROL frames take this relation: same relation type and properties, regulator and target type in the in / out lists. */
function frameFolders(cartPath, { relation, props, regulator, target }) {
  const modes = outputModes(cartPath);
  const has = (list, x) => list.some(y => String(y).toLowerCase() === String(x).toLowerCase());
  const want = Object.entries(props || {}).filter(([, v]) => String(v).trim());
  const out = new Map(), spare = new Map(), other = new Map();
  for (const row of findRelationPatterns([{ name: path.basename(cartPath), path: cartPath }], relation, true)) {
    const frameProps = {};
    for (const p of row.control.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) if (!/^ControlType$/i.test(p[1])) frameProps[p[1]] = p[2];
    const have = Object.entries(frameProps);
    if (!typeListHas(row.roles.in?.types || [], regulator) || !typeListHas(row.roles.out?.types || [], target)) continue;
    const dir = path.dirname(row.controlFile).split(path.sep).slice(1).join('/');
    const same = have.length === want.length && want.every(([k, v]) => have.some(([k2, v2]) => k2.toLowerCase() === k.toLowerCase() && v2.toLowerCase() === String(v).toLowerCase()));
    (same ? (modes.has(dirKey(dir)) ? out : spare) : other).set(dirKey(dir), dir);          // folders that no output command reads are only a fallback
  }
  // exact: frames with the very properties; other: frames of the relation that allow the pair but have other properties (a new frame would be needed)
  return { exact: [...(out.size ? out : spare).values()], other: [...other.values()] };
}

/**
 * Does this cartridge extract this kind of relation? Only the relation type, the node types and the direction are compared — not the properties
 * (Effect …), not the kind of the patterns. Directional relation: a frame of the relation type whose in list has the regulator type and whose out list
 * has the target type; non-directional: both types in the in-out lists of a frame. → the pattern folders of those frames (as after -H in locscan.ini).
 */
function pairFolders(cartPath, relation, regulator, target) {
  const has = (list, x) => list.some(y => String(y).toLowerCase() === String(x).toLowerCase());
  const out = new Map();
  for (const row of findRelationPatterns([{ name: path.basename(cartPath), path: cartPath }], relation)) {
    let ok;
    if (row.roles.in || row.roles.out) ok = typeListHas(row.roles.in?.types || [], regulator) && typeListHas(row.roles.out?.types || [], target);
    else {
      const lists = [...row.control.matchAll(/in-out\s*=\s*%\w+\s*\(([^)]*)\)/gi)].map(m => m[1].split(/[\s,]+/).filter(Boolean).map(typeTok));
      ok = lists.some(l => has(l, regulator)) && lists.some(l => has(l, target));
    }
    if (!ok) continue;
    const dir = path.dirname(row.controlFile).split(path.sep).slice(1).join('/');
    out.set(dirKey(dir), dir);
  }
  return [...out.values()];
}

/** { current: [folders in this cartridge], others: [{ cartridge, path, folders }] } — the other cartridges are searched only when this one has no frame
 *  for the relation; they must declare the same relation type with the same direction. */
function relationMatches(cartPath, { relation, regulator, target }) {
  const current = pairFolders(cartPath, relation, regulator, target);
  if (current.length) return { current, others: [] };
  const find = (rels) => Object.keys(rels).find(k => k.toLowerCase() === String(relation).toLowerCase());
  const mine = getInfo(cartPath).relations, myKey = find(mine);
  const others = [];
  const parent = path.dirname(cartPath);
  for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
    const p = path.join(parent, d.name);
    if (!d.isDirectory() || d.name.length <= 4 || !d.name.toLowerCase().endsWith('.bin') || path.resolve(p) === path.resolve(cartPath) || !exists(path.join(p, 'nodetype.ini'))) continue;
    try {
      const theirs = getInfo(p).relations, key = find(theirs);
      if (!key || (myKey && theirs[key] !== mine[myKey])) continue;                    // not declared there, or another direction
      const folders = pairFolders(p, key, regulator, target);
      if (folders.length) others.push({ cartridge: d.name.slice(0, -4), path: p, folders });
    } catch { /* unreadable cartridge */ }
  }
  return { current, others };
}

module.exports = { fixMacroPatterns, pipelineDirs, relationMatches, pairFolders, frameFolders, findExtracting, findUsedPatterns, viewExistingSet, otherCartridgeSets, macroPrompt, testPattern, findExistingSets, suggestContext, frameCheck, macroDefinitions, warmMacros, findMacrosWith, macroFileCandidates, addMacro, macroInfo, editMacro, renameMacro, searchAlternatives, recompileAll, readMsgrepFile, saveMsgrepFile, checkMsgrepFile, findSetDefs, macroLocations, compileFolder, listRelationTypes, findRelationPatterns, getInfo, readNodeTypes, readRelationEntities, declareRelation, revertDeclaration, validatePattern, generateFiles, compileRelation };
