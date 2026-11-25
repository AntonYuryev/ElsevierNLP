import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Hover tooltip for the macros of a pattern ($NAME / @NAME / &NAME): the definition, with every macro it uses unwound on a line of its own
// ("$EFFECTIVE: word1, word2 …"), level by level. @regulator / @target (also @out / @in) show the entity type and the entity names.
export default function useMacroTip({ cartPath, regNames = [], tgtNames = [], regType = '', tgtType = '', source = '' }) {
  const defs = useRef({});                         // name → definition text (or '' when unknown)
  const asked = useRef({});                        // name → when it was looked up (an unknown name is looked up again after a moment: the macro may have been created since)
  const mine = useRef(new Set());                  // macros defined by #define in the edited text itself
  const [tip, setTip] = useState(null);            // { name, x, y }
  const [, bump] = useState(0);
  const ROLE = ['@regulator', '@target', '@in', '@out'];

  // macros the user defined in the pattern text (#define $NAME body) are known without a lookup and always current
  const local = {};
  for (const m of String(source).matchAll(/^[ \t]*#define[ \t]+(\$[A-Za-z_]\w*)[ \t]+([^\r\n]*)$/gm)) local[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  for (const n of mine.current) if (!(n in local)) { delete defs.current[n]; delete asked.current[n]; mine.current.delete(n); }
  for (const n of Object.keys(local)) { defs.current[n] = local[n]; mine.current.add(n); }

  const hover = async (name, x, y) => {
    setTip({ name, x, y });
    if (ROLE.includes(name)) return;
    if (name in defs.current && !(defs.current[name] === '' && Date.now() - (asked.current[name] || 0) > 2000)) return;
    asked.current[name] = Date.now();
    defs.current[name] = null;                     // requested
    const seen = new Set();
    let level = [name];
    while (level.length && seen.size < 40) {
      level.forEach(n => seen.add(n));
      const need = level.filter(n => n === name || !(n in defs.current));
      need.forEach(n => { if (n !== name) defs.current[n] = null; });
      const r = need.length ? await window.api.relation.macroDefs({ cartPath, file: cartPath + '\\ctrltype.ini', names: need, max: 1500 }) : null;
      need.forEach(n => { defs.current[n] = (r && r.ok && r.defs && r.defs[n]) || ''; });
      level = [...new Set(level.flatMap(n => String(defs.current[n] || '').match(/\$[A-Za-z_]\w*/g) || []))].filter(n => !seen.has(n));
    }
    bump(n => n + 1);
  };

  const unwound = (name) => {
    const seen = new Set([name]), lines = [];
    let level = [name];
    while (level.length && lines.length < 40) {
      const next = [];
      for (const n of level) {
        for (const ref of String(defs.current[n] || '').match(/\$[A-Za-z_]\w*/g) || []) {
          if (seen.has(ref)) continue;
          seen.add(ref); next.push(ref);
          const d = defs.current[ref];
          lines.push(d === undefined || d === null ? `${ref}: loading…` : d ? `${ref}: ${d.replace(/[\[\]]/g, ' ').trim().split(/\s+/).join(', ')}` : `${ref}: not defined in this cartridge`);
        }
      }
      level = next;
    }
    return lines.length ? '\n' + lines.join('\n') : '';
  };

  const named = (what, names) => (names && names.length ? `${what} (${names.join(', ')})` : what);       // "the regulator entity (buprenorphine)"
  const isReg = (n) => n === '@regulator' || n === '@out';
  const isTgt = (n) => n === '@target' || n === '@in';
  const typeOf = (n) => (isReg(n) ? regType : isTgt(n) ? tgtType : '');
  const text = tip && (isReg(tip.name) ? named('the regulator entity', regNames) : isTgt(tip.name) ? named('the target entity', tgtNames)
    : defs.current[tip.name] === undefined || defs.current[tip.name] === null ? 'loading…'
    : defs.current[tip.name] ? defs.current[tip.name] + unwound(tip.name) : 'no definition found in this cartridge (a macro defined in the pattern itself, or a typo)');

  // rendered into document.body: inside a dialog (transform / animation) "fixed" would be relative to the dialog, not the window, and the tip would land away from the pointer
  const el = useRef(null);
  // starts at the pointer; once drawn, shifted left only as far as its real width needs to stay inside the window
  useLayoutEffect(() => {
    if (!tip || !el.current) return;
    el.current.style.left = Math.max(12, Math.min(tip.x + 14, window.innerWidth - el.current.offsetWidth - 12)) + 'px';
  });
  const box = tip && createPortal(
    // wide, so that a big macro is short; on the roomier side of the pointer (below or above it), never taller than that room
    <div ref={el} style={{ position: 'fixed', width: 'max-content', maxWidth: Math.min(1100, window.innerWidth - 24), overflow: 'hidden',
                  left: Math.max(12, Math.min(tip.x + 14, window.innerWidth - 24)),
                  ...(tip.y > window.innerHeight / 2 ? { bottom: window.innerHeight - tip.y + 14, maxHeight: tip.y - 26 } : { top: tip.y + 18, maxHeight: window.innerHeight - tip.y - 30 }),
                  zIndex: 20000, pointerEvents: 'none',
                  background: 'var(--surface-dim, #1e1e2e)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                  fontSize: 12, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: '0 4px 14px rgba(0,0,0,.4)' }}>
      <b>{tip.name}{typeOf(tip.name) ? ` (${typeOf(tip.name)})` : ''}</b>{'\n'}{text}
    </div>,
    document.body
  );
  return { tip, setTip, hover, box };
}

/** Read-only pattern text whose macros show the tooltip on hover. */
export function MacroPre({ text, style, ...tipProps }) {
  const { setTip, hover, box } = useMacroTip(tipProps);
  return (
    <pre style={style} onMouseLeave={() => setTip(null)}>
      {String(text).split(/([$@&][A-Za-z_]\w*)/).map((p, i) => (i % 2 ? <span key={i} onMouseMove={e => hover(p, e.clientX, e.clientY)}>{p}</span> : p))}
      {box}
    </pre>
  );
}
