// Spell-check of a msgrep pattern: house rules for mistakes that msgrep rejects (or silently misreads) and that a generic
// grep validator would not know — msgrep's notation differs from grep's. Add a rule to RULES when a new kind of mistake turns up.
//   rule = { id, message, find(code) → [{ index, length, replacement }] }   code = the text with comments and quoted strings blanked out
//   replacement = null: the mistake is reported but has no automatic fix (no Fix button). The notation itself is listed in utils/patternSyntax.js (the Help dialog).

const RULES = [
  {
    id: 'bare-dot',
    message: 'A bare "." is not msgrep syntax ("illegal wordset element"). Any single token is written "@." — e.g. @.{0,3} for up to 3 arbitrary tokens, @.* for any number.',
    find(code) {
      const out = [];
      // "." (a wildcard) right after whitespace, "(", "|", "[" , "]" or ")" and followed by a quantifier: .{0,3}  .*  .+  .?
      const re = /(^|[\s(|[\])])\.(?=[{*+?])/g;
      let m;
      while ((m = re.exec(code)) !== null) out.push({ index: m.index + m[1].length, length: 1, replacement: '@.' });
      return out;
    },
  },
  {
    id: 'quantifier-period',
    message: 'A repeat count is written {n,m} with a COMMA — {0.2} is not a range. Forms: {n}, {n,m}, {n,}.',
    find(code) {
      const out = [];
      const re = /\{\s*(\d+)\s*\.\s*(\d+)\s*\}/g;
      let m;
      while ((m = re.exec(code)) !== null) out.push({ index: m.index, length: m[0].length, replacement: '{' + m[1] + ',' + m[2] + '}' });
      return out;
    },
  },
  {
    id: 'quantifier-order',
    message: 'In a repeat count {n,m} the minimum n must not be larger than the maximum m.',
    find(code) {
      const out = [];
      const re = /\{(\d+),(\d+)\}/g;
      let m;
      while ((m = re.exec(code)) !== null) if (Number(m[1]) > Number(m[2])) out.push({ index: m.index, length: m[0].length, replacement: null });
      return out;
    },
  },
  {
    id: 'wordset-separator',
    message: 'Words in a wordset [ … ] are separated by white space — not by commas or "|" (alternatives with "|" belong in a group ( … | … )). Composite words go in double quotes.',
    find(code) {
      const out = [];
      const re = /\[([^\[\]]*)\]/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        const base = m.index + 1;
        for (let k = 0; k < m[1].length; k++) if (m[1][k] === ',' || m[1][k] === '|') out.push({ index: base + k, length: 1, replacement: ' ' });
      }
      return out;
    },
  },
  {
    id: 'bare-start-end',
    message: 'Start / end of the sentence are written "@^" and "@$" — a lone "^" or "$" is not a pattern element ("^" only negates a wordset: [^ word …]).',
    find(code) {
      const out = [];
      const re = /(^|[\s(|])([\^$])(?=[\s)|?*+{]|$)/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        const at = m.index + m[1].length;
        if (m[2] === '^' && /\[\s*$/.test(code.slice(0, at))) continue;          // "[ ^ word …]": the negation of a wordset, white space allowed
        out.push({ index: at, length: 1, replacement: '@' + m[2] });
      }
      return out;
    },
  },
  {
    id: 'punctuation-quote',
    message: 'A punctuation mark is written as ONE character in single quotes, e.g. \',\' or \'-\'. Words and multi-word terms go in double quotes ("transcription factor") or bare.',
    find(code, raw) {
      const out = [];
      const re = /'([^'\n]*)'/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m[1].length !== 1 && !/^\s+$/.test(m[1])) out.push({ index: m.index, length: m[0].length, replacement: null });
      }
      return out;
    },
  },
  {
    id: 'repeated-variable',
    message: 'A markup variable (%name) must occur exactly once in every alternative: it must not be repeated with ? * + or {n,m}, nor sit inside a ( … ) group that is repeated.',
    find(code) {
      const out = [];
      // is a repeat operator (? * + {n} {n,} {,m} {n,m}) written at position i?
      const rep = (i) => '?*+'.includes(code[i] || ' ') || (code[i] === '{' && /^\{\s*\d*\s*,?\s*\d*\s*\}/.test(code.slice(i)) && /^\{\s*[\d,]/.test(code.slice(i)));
      const re = /%\w+(\([^)]*\))?/g;                                           // %a, or the declaration %a(Protein)
      let m;
      while ((m = re.exec(code)) !== null) if (!m[1] && rep(m.index + m[0].length)) out.push({ index: m.index, length: m[0].length, replacement: null });
      // a repeated ( … ) group that contains a variable (the (Type) of a declaration is not a group)
      const stack = [];
      for (let i = 0; i < code.length; i++) {
        if (code[i] === '(') stack.push(i);
        else if (code[i] === ')' && stack.length) {
          const open = stack.pop();
          if (!rep(i + 1) || /%\w+$/.test(code.slice(0, open))) continue;
          const v = /%\w+/.exec(code.slice(open, i));
          if (v) out.push({ index: open + v.index, length: v[0].length, replacement: null });
        }
      }
      return out;
    },
  },
  {
    id: 'define-variable',
    message: 'A #define must not contain markup variables (%name): pass them in as parameters of a &function(@a, @b) and use them in the pattern that calls it.',
    find(code) {
      const out = [];
      const re = /#define\s+[$@&]\w+/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        let i = m.index + m[0].length;
        const skipTo = (open, close) => { let d = 0; for (let k = i; k < code.length; k++) { if (code[k] === open) d++; else if (code[k] === close && --d === 0) return k + 1; } return code.length; };
        while (/\s/.test(code[i] || '')) i++;
        if (m[0].includes('&') && code[i] === '(') { i = skipTo('(', ')'); while (/\s/.test(code[i] || '')) i++; }          // the parameter list
        const open = code[i];
        if (open !== '(' && open !== '[') continue;
        const end = skipTo(open, open === '(' ? ')' : ']');
        const body = code.slice(i, end);
        const v = /%\w+/.exec(body);
        if (v) out.push({ index: i + v.index, length: v[0].length, replacement: null });
      }
      return out;
    },
  },
  {
    id: 'unbalanced',
    message: 'Unbalanced bracket: every ( [ { needs its closing ) ] } (and vice versa).',
    find(code) {
      const out = [], stack = [], pair = { ')': '(', ']': '[', '}': '{' };
      for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if ('([{'.includes(c)) stack.push({ c, i });
        else if (')]}'.includes(c)) {
          if (stack.length && stack[stack.length - 1].c === pair[c]) stack.pop();
          else return [{ index: i, length: 1, replacement: null }];                // the first problem only: fixing it often clears the rest
        }
      }
      if (stack.length) out.push({ index: stack[stack.length - 1].i, length: 1, replacement: null });   // the innermost bracket that is never closed
      return out;
    },
  },
];

/** The text with // comments and "…" / '…' strings blanked out (same length), so rules do not fire inside them. */
export function codeOnly(text, keep = '') {                   // keep: quote characters whose strings stay readable, e.g. "'"
  const t = String(text || '');
  const blank = (s) => s.replace(/[^\n]/g, ' ');            // same length, line breaks kept
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '/' && t[i + 1] === '/') { const e = t.indexOf('\n', i); const end = e < 0 ? t.length : e; out += ' '.repeat(end - i); i = end; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); const end = e < 0 ? t.length : e + 2; out += blank(t.slice(i, end)); i = end; continue; }   // /* block comment */ (not nested)
    if (c === '"' || c === "'") {
      const e = t.indexOf(c, i + 1);
      const end = e < 0 ? t.length : e + 1;
      out += keep.includes(c) ? t.slice(i, end) : blank(t.slice(i, end)); i = end; continue;
    }
    out += c; i++;
  }
  return out;
}

/** → [{ rule, message, index, line, column, text, fix: { index, length, replacement } }] */
export function lintPattern(text) {
  const t = String(text || '');
  const code = codeOnly(t);
  const withStrings = codeOnly(t, "'");                        // comments and "…" blanked, '…' kept (rules about the quoted punctuation itself)
  const issues = [];
  for (const r of RULES) {
    for (const f of r.find(code, withStrings)) {
      const before = t.slice(0, f.index);
      const line = before.split('\n').length, column = f.index - before.lastIndexOf('\n');
      const lineText = t.split('\n')[line - 1] || '';
      issues.push({ rule: r.id, message: r.message, index: f.index, line, column, text: lineText.trim().slice(0, 90), fix: f });
    }
  }
  return issues.sort((a, b) => a.index - b.index);
}

/** Apply the fixes of the given issues (all of them by default). */
export function applyFixes(text, issues = lintPattern(text)) {
  let t = String(text || '');
  for (const f of [...issues].map(i => i.fix).filter(f => f.replacement != null).sort((a, b) => b.index - a.index)) t = t.slice(0, f.index) + f.replacement + t.slice(f.index + f.length);
  return t;
}
