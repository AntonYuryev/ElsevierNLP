import { typeListHas } from '../../shared/entityTypes';

// Decisions the app makes itself (no LLM): which existing frame takes a pattern, and which words a pattern needs next to a macro.

// Which existing CONTROL frame / pattern set can take the new pattern? Decided here, not by the LLM:
//  1. same ControlType (the candidates are those of the relation), the frame must extract EXACTLY the required CONTROL properties
//     (a frame without one of them, or with another value / an extra property, cannot be re-used);
//  2. its in = (…) list must already contain the regulator type and its out = (…) list the target type (a rule is never extended);
//     the closest frame = the one with the fewest other types;
//  3. its pattern set must be of the same kind as the new pattern: $ACT (ConceptScan) or not.
// Nothing fits → null: the pattern gets a new folder with its own pattern files.
// Do the regulator / target types fit the frame's in / out lists? A non-directional relation (row.directional === false) has no real regulator and target:
// the pattern covers both orders, so the frame may also list them the other way round (swap: @regulator then binds to the frame's @out variable).
// → { ok, swap, addR, addT } (addR / addT: the types the frame lacks, for the orientation that fits best)
export function frameFit(c, regs, tgts, directional = true) {
  const low = (x) => String(x).toLowerCase();
  const lack = (want, have) => want.filter(x => !typeListHas(have, x));                  // a frame's Protein also covers Complex, FunctionalClass
  const straight = { addR: lack(regs, c.regs), addT: lack(tgts, c.tgts) };
  const swapped = { addR: lack(regs, c.tgts), addT: lack(tgts, c.regs) };
  const n = (o) => o.addR.length + o.addT.length;
  if (n(straight) === 0) return { ok: true, swap: false, ...straight };
  if (!directional && n(swapped) === 0) return { ok: true, swap: true, ...swapped };
  return { ok: false, swap: false, ...straight };
}
export function chooseFrame(candidates, row, pattern) {
  const low = (x) => String(x).toLowerCase();
  const has = (list, x) => typeListHas(list, x);
  const wantMode = /[$]ACT(?![A-Za-z0-9_])|(?<![\w&])&(?![A-Za-z_])/.test(pattern.replace(/^\s*#define.*$/gm, '')) ? 'csout' : 'msout';
  const want =Object.entries(row.props || {}).filter(([, v]) => String(v).trim());
  // no Effect given = Effect "unknown" (the neutral frame) when the relation's frames have an Effect at all
  if (!want.some(([k]) => low(k) === 'effect') && candidates.some(c => Object.keys(c.props || {}).some(k => low(k) === 'effect'))) want.push(['Effect', 'unknown']);
  const why = [];
  const ok = [];
  for (const c of candidates) {
    const have = Object.entries(c.props || {});
    if (have.length !== want.length || !want.every(([k, v]) => have.some(([k2, v2]) => low(k2) === low(k) && low(v2) === low(v)))) { why.push('&' + c.set + ': other properties'); continue; }
    const fit = frameFit(c, [row.regulator], [row.target], row.directional !== false);
    if (!fit.ok) { why.push('&' + c.set + ': @in/@out do not include ' + [!has(c.regs, row.regulator) && row.regulator + ' as regulator', !has(c.tgts, row.target) && row.target + ' as target'].filter(Boolean).join(', ') + (row.directional === false ? ' (non-directional: the other order does not fit either)' : '')); continue; }
    if (c.mode !== wantMode) { why.push('&' + c.set + ': ' + (wantMode === 'csout' ? 'sentence-level patterns' : 'ConceptScan patterns')); continue; }
    ok.push({ c, extra: c.regs.length + c.tgts.length });
  }
  ok.sort((a, b) => a.extra - b.extra);
  if (!ok.length) return { id: null, reason: 'no existing frame with the properties ' + (want.map(([k, v]) => k + '=' + v).join(', ') || '(none)') + ' and ' + (wantMode === 'csout' ? '$ACT (ConceptScan)' : 'sentence-level') + ' patterns' + ' — a new folder is created', why: why.join('\n') };
  const best = ok[0];
  return { id: best.c.id, reason: 'closest frame with the same properties and ' + (wantMode === 'csout' ? 'ConceptScan (-Icsout)' : 'sentence-level') + ' patterns' + ' (its rule already allows the node types)' };
}
// Words written next to a macro in the same [...] group that the macro does not contain (directly or through the macros it uses):
// the user should consider adding them to the macro. defs = { '$NAME': 'definition text' } (the used macros and the ones they use).
export function macroGaps(pattern, defs) {
  const stems = (name) => {
    const seen = new Set(), out = [];
    const walk = (n) => {
      if (seen.has(n) || !(n in defs)) return; seen.add(n);
      for (const t of String(defs[n]).split(/[\s\[\]()|{}*+?,]+/).filter(Boolean)) {
        if (/^[$@]/.test(t)) walk(t.replace(/[^$@\w].*$/, '')); else out.push(t.replace(/^['"^]+|['"]+$/g, '').toLowerCase());
      }
    };
    walk(name);
    return out;
  };
  const covers = (list, w) => { const base = w.replace(/~$/, ''); return list.some(t => t === w || t === base || (t.endsWith('~') && base.startsWith(t.slice(0, -1))) || (w.endsWith('~') && t.startsWith(base))); };
  const hints = [];
  for (const m of pattern.matchAll(/\[([^\]\[]*)\]/g)) {
    if (m[1].trim().startsWith('^')) continue;
    const toks = m[1].split(/\s+/).filter(Boolean);
    const macros = toks.filter(t => /^\$[A-Za-z_]\w*$/.test(t) && t !== '$ACT');
    const words = toks.filter(t => /^[A-Za-z][\w-]*~?$/.test(t));
    if (!macros.length || !words.length) continue;
    const have = macros.flatMap(stems);
    for (const w of words) if (!covers(have, w.toLowerCase()) && !hints.some(h => h.word === w && h.macros.join() === macros.join())) hints.push({ word: w.replace(/~$/, ''), macros });
  }
  return hints;
}


// The matcher binds @regulator / @target to the CLOSEST marked-up entity of the required node type, so a pair (regulator, target) can be
// extracted from a pseudo-sentence only when no other entity of either type stands between the two.
// entityTypes = { 'ids': ['NodeType', …] } from suggestContext. Returns the extractable pairs [{ regulator, target }] (entity texts) of one line.
export function neighbourPairs(line, entityTypes, regType, tgtType) {
  const ents = [];
  for (const m of String(line || '').matchAll(/ID\{([\d,\s]+)=([^}]*)\}/g)) {
    const types = entityTypes[m[1].replace(/\s+/g, '')] || [];
    if (types.length) ents.push({ text: m[2].trim(), types });
  }
  const isT = (e, t) => e.types.includes(t);
  const out = [];
  for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
    if (i === j) continue;
    if (!isT(ents[i], regType) || !isT(ents[j], tgtType)) continue;
    const [a, b] = i < j ? [i, j] : [j, i];
    let blocked = false;
    for (let k = a + 1; k < b; k++) if (isT(ents[k], regType) || isT(ents[k], tgtType)) { blocked = true; break; }
    if (!blocked) out.push({ regulator: ents[i].text, target: ents[j].text });
  }
  return out;
}

// What the pattern has to walk over in a ConceptScan pseudo-sentence: the tokens between the regulator and the target entity (every word,
// every "&" and every other ID{…} is ONE token). Shown to the LLM because it kept leaving the "&" out (a gap like [^$ACT]{0,4} cannot cross it).
export function tokenWalk(line, entityTypes, regType, tgtType) {
  const toks = String(line || '').split(/\s+/).filter(Boolean);
  const typesOf = (t) => { const m = t.match(/^ID\{([\d,\s]+)=/); return m ? entityTypes[m[1].replace(/\s+/g, '')] || [] : []; };
  let best = null;
  toks.forEach((a, i) => toks.forEach((b, j) => {
    if (i === j || !typesOf(a).includes(regType) || !typesOf(b).includes(tgtType)) return;
    if (!best || Math.abs(i - j) < Math.abs(best[0] - best[1])) best = [i, j];
  }));
  if (!best) return '';
  const [i, j] = best;
  const between = toks.slice(Math.min(i, j) + 1, Math.max(i, j));
  const shown = between.map((t, k) => (t === '&' ? '& ← $ACT' : t.startsWith('ID{') ? 'ID{…}' : t) + ` (${k + 1})`);
  return `Token walk (${i < j ? '@regulator first' : '@target first'}): ${i < j ? '@regulator' : '@target'} | ${shown.join(' | ') || '(nothing)'} | ${i < j ? '@target' : '@regulator'}\nThe pattern must account for EVERY token in this order: ${between.includes('&') ? 'the "&" is token ' + (between.indexOf('&') + 1) + ' and must be matched by $ACT exactly there; ' : ''}tokens you do not need are bridged with @.{0,N} (N ≥ their count), never with [^$ACT]{…} across the "&".`;
}

// The name of the folder / batch of a relation's patterns (UnknownRegulation → Regulation): the table of synonymous relation types is shared/relationTypes.js
export { folderName } from '../../shared/relationTypes';
