import { codeOnly } from './patternLint';
import { nodeTypeOfId as typeTok } from '../../shared/entityTypes';

// The parts of a .msgrep file the file editor offers to focus on:
//   control  CONTROL { … } [CONTROL { … } …] : <pattern> ;   one rule (several frames sharing one pattern are one rule)
//   set      #define &NAME(@in, @out)( p1 | p2 … );          one pattern set
// → [{ kind, label, detail, start, end, line, body: { start, end } | null }] in file order (body = the patterns inside the set / after the ":" of the rule) (start / end index the text; end is after the closing ;)

/** index of the bracket that closes the one at `open` (code has comments and quoted text blanked out); -1 when there is none */
function closeOf(code, open) {
  const o = code[open], c = { '(': ')', '[': ']', '{': '}' }[o];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

/**
 * The symbolic relation of one CONTROL frame: (in types) -[ControlType; other properties]-<effect>> (out types), e.g.
 *   (Disease, CellProcess) -[UnknownRegulation]-+> (Protein, SmallMol)
 * The arrow head is +> (positive), -| (negative), ?> (unknown) or > (no Effect property); BiomarkerType, ChangeType, Mechanism, QuantitativeType … (every other
 * property of the frame) go into the brackets after the ControlType.
 */
export function symbolic(f) {
  const p = f.props || {};
  const ct = p.ControlType || 'CONTROL';
  // the arrow head: +> positive, -| negative, ?> unknown, > no Effect property
  const eff = p.Effect ? ({ positive: '+>', negative: '-|', unknown: '?>' }[String(p.Effect).toLowerCase()] ?? p.Effect + '>') : '>';
  const rest = Object.entries(p).filter(([k]) => !/^(ControlType|Effect)$/i.test(k)).map(([k, v]) => k + '=' + v);
  const list = (a) => '(' + (a.length ? a.join(', ') : '?') + ')';
  return list(f.in) + ' -[' + [ct, ...rest].join('; ') + ']-' + eff + ' ' + list(f.out);
}

export function parseSections(text) {
  const t = String(text || '');
  const code = codeOnly(t);
  const lineAt = (i) => t.slice(0, i).split('\n').length;
  const out = [];

  // pattern sets
  const setRe = /#define[ \t]+&([A-Za-z_]\w*)[ \t]*\(/g;
  let m;
  while ((m = setRe.exec(code)) !== null) {
    const p = closeOf(code, m.index + m[0].length - 1);
    if (p < 0) continue;
    let j = p + 1;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '(') continue;                                   // a plain macro with parameters, not a pattern set
    const b = closeOf(code, j);
    if (b < 0) continue;
    let end = b + 1;
    const semi = /^\s*;/.exec(code.slice(end));
    if (semi) end += semi[0].length;
    else {
      // an extra ")" in the last pattern closes the set's body early and leaves a stray ")" before the ";" ("…{5}))" newline ");"): the set still ends at that ";", and it is shown up to it,
      // exactly as it is in the file
      const tail = /^[\s)]*;/.exec(code.slice(end));
      if (tail) end += tail[0].length;
    }
    const alts = code.slice(j + 1, b).split('|').filter(s => s.trim()).length;
    out.push({ kind: 'set', label: '&' + m[1], detail: alts + ' pattern' + (alts !== 1 ? 's' : ''), start: m.index, end, line: lineAt(m.index), body: { start: j + 1, end: b } });
    setRe.lastIndex = end;
  }

  // CONTROL rules
  const ctlRe = /\bCONTROL\b\s*\{/g;
  while ((m = ctlRe.exec(code)) !== null) {
    const start = m.index, bodies = [];
    let at = start, ok = true;
    for (;;) {                                                       // CONTROL { } CONTROL { } … : pattern ;
      const open = code.indexOf('{', at), close = closeOf(code, open);
      if (close < 0) { ok = false; break; }
      bodies.push(t.slice(open + 1, close));
      let j = close + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (/^CONTROL\b/.test(code.slice(j))) { at = j; continue; }
      at = j; break;
    }
    if (!ok) continue;
    let end = at;
    if (code[at] === ':') {                                          // the pattern, up to the ; outside brackets
      let depth = 0, i = at + 1;
      for (; i < code.length; i++) {
        const c = code[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ';' && depth <= 0) { i++; break; }
      }
      end = Math.min(i, code.length);
    }
    const prop = (b, k) => (b.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1];
    const types = (b, k) => { const x = b.match(new RegExp('\\b' + k + '\\s*=\\s*%\\w+\\s*\\(([^)]*)\\)', 'i')); return x ? x[1].split(/[\s,]+/).filter(Boolean).map(typeTok).join(',') : ''; };
    const cts = [...new Set(bodies.map(b => prop(b, 'ControlType')).filter(Boolean))];
    const eff = [...new Set(bodies.map(b => prop(b, 'Effect')).filter(Boolean))];
    const first = bodies.find(b => types(b, 'in') && types(b, 'out')) || bodies[0];
    const call = (t.slice(at, end).match(/&([A-Za-z_]\w*)\s*\(/) || [])[1];
    const calls = [...new Set([...t.slice(at, end).matchAll(/&([A-Za-z_]\w*)\s*\(/g)].map(x => '&' + x[1]))];     // the pattern sets the rule calls
    // every frame of the rule as its symbolic relation (see symbolic())
    const frames = bodies.map(b => {
      const props = {};
      for (const x of b.matchAll(/\b(\w+)\s*=\s*"([^"]*)"/g)) props[x[1]] = x[2];
      const ty = (k) => { const x = b.match(new RegExp('\\b' + k + '\\s*=\\s*%\\w+\\s*\\(([^)]*)\\)', 'i')); return x ? x[1].split(/[\s,]+/).filter(Boolean).map(typeTok) : []; };
      return { in: ty('in'), out: ty('out'), props };
    });
    out.push({
      kind: 'control', frames, calls, symbolic: frames.map(symbolic).join('  ·  '),
      label: (cts.join(' + ') || 'CONTROL') + (eff.length ? ' (' + eff.join('/') + ')' : ''),
      detail: [types(first, 'in') && types(first, 'out') ? types(first, 'in') + ' → ' + types(first, 'out') : '', call ? '&' + call : ''].filter(Boolean).join(' · '),
      start, end, line: lineAt(start),
      body: code[at] === ':' ? { start: at + 1, end: code[end - 1] === ';' ? end - 1 : end } : null,      // the pattern written after the ":" (null when the rule has none)
    });
    ctlRe.lastIndex = Math.max(end, ctlRe.lastIndex);
  }
  return out.sort((a, b) => a.start - b.start);
}
