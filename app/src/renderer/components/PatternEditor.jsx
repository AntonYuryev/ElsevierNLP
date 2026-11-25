import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import useMacroTip from './useMacroTip';
import { applyFixes } from '../utils/patternLint';

// Shared by the pattern editors — "New relation / Design pattern" (RelationWizard) and the msgrep file editor (FileEditorDialog):
//   MacroTextarea  the editing box: macro tooltips, VS-Code-like brackets, wavy underlines (marks), right-click "Edit macro"
//   LintIssues     the list of spell-check problems with Fix / Fix all
//   lintMarks      the underline marks of the spell-check problems
// New editing rules go to utils/patternLint.js (RULES): every editor that uses these picks them up.

/** The wavy-underline marks of the spell-check problems: [{ index, length }] */
export const lintMarks = (lint) => lint.map(l => ({ index: l.fix.index, length: l.fix.length }));

/** The spell-check problems under an editing box; setText gets an updater function (t => fixed text). */
export function LintIssues({ text, lint, setText }) {
  if (!lint.length) return null;
  return (
    <div style={{ marginTop: 6, padding: '5px 8px', border: '1px solid var(--warning, #e8a000)', borderRadius: 6, fontSize: 12, color: 'var(--warning, #e8a000)' }}>
      {lint.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: i < lint.length - 1 ? 4 : 0 }}>
          <span style={{ flex: 1 }}>⚠ <b>Line {it.line}, column {it.column}</b>{' '}(<code>{text.slice(Math.max(0, it.index - 24), it.index)}</code><code style={{ color: 'var(--danger, #f38ba8)', fontWeight: 700, textDecoration: 'underline wavy' }}>{text.slice(it.index, it.index + 7).split(/\s/)[0] || '.'}</code>) — {it.message}</span>
          <button type="button" className="btn btn-sm btn-secondary" style={{ padding: '1px 8px' }} onClick={() => setText(t => applyFixes(t, [it]))} hidden={it.fix.replacement == null}>Fix</button>
        </div>
      ))}
      {lint.filter(l => l.fix.replacement != null).length > 1 && <div style={{ textAlign: 'right', marginTop: 4 }}><button type="button" className="btn btn-sm btn-secondary" style={{ padding: '1px 8px' }} onClick={() => setText(t => applyFixes(t))}>Fix all ({lint.filter(l => l.fix.replacement != null).length})</button></div>}
    </div>
  );
}

// Pattern editor: hovering a macro ($NAME / @NAME / &NAME) shows its definition. A textarea cannot style or hit-test single words,
// so an invisible copy of the text sits underneath it (same font, wrapping and scroll) and the word under the mouse is looked up there.
const EDIT_FONT ={ fontFamily: 'Consolas, monospace', fontSize: 12.5, lineHeight: '18px', padding: 8, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflowY: 'scroll', border: '1px solid transparent' };
export default function MacroTextarea({ height = 260, onEditMacro, taRef, cartPath, value, onChange, placeholder, marks = [], regNames = [], tgtNames = [], regType = "", tgtType = "" }) {
  const mirror = useRef(null);
  const { tip, setTip, hover, box } = useMacroTip({ cartPath, regNames, tgtNames, regType, tgtType, source: value });
  // the text cut at the spell-check marks: [{ t, mark }] — a marked piece is drawn with a red wavy underline
  const pieces = [];
  { let at = 0; for (const m of [...marks].sort((a, b) => a.index - b.index)) { if (m.index > at) pieces.push({ t: value.slice(at, m.index) }); pieces.push({ t: value.slice(m.index, m.index + m.length), mark: true }); at = m.index + m.length; } pieces.push({ t: value.slice(at) }); }

  // right-click on a $macro (or with a $macro selected): our menu with "Edit macro"; anywhere else the browser's own menu stays
  const [menu, setMenu] = useState(null);                    // { x, y, name }
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [menu]);
  const onContext = (e) => {
    if (!onEditMacro) return;
    const el = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.dataset && n.dataset.macro);
    const t = e.currentTarget, sel = t.value.slice(t.selectionStart, t.selectionEnd).trim();
    const name = /^[$][A-Za-z_]\w*$/.test(sel) ? sel : (el && el.dataset.macro.startsWith('$') ? el.dataset.macro : '');
    if (!name) return;
    e.preventDefault(); setTip(null);
    setMenu({ x: e.clientX, y: e.clientY, name });
  };

  const onMove = (e) => {
    const el = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.dataset && n.dataset.macro);
    if (!el) { if (tip) setTip(null); return; }
    hover(el.dataset.macro, e.clientX, e.clientY);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height, resize: 'vertical', overflow: 'hidden' }}>
      <div ref={mirror} aria-hidden="true" style={{ ...EDIT_FONT, position: 'absolute', inset: 0, overflow: 'hidden', overflowY: 'scroll', color: 'transparent', background: 'var(--surface)', borderRadius: 6, borderColor: 'var(--border)' }}>
        {pieces.map((pc, k) => pc.mark
          ? <span key={'m' + k} style={{ background: 'rgba(243,139,168,0.35)', textDecoration: 'underline wavy #f38ba8', textUnderlineOffset: 3 }}>{pc.t}</span>
          : pc.t.split(/([$@&][A-Za-z_]\w*)/).map((p, i) => (i % 2 ? <span key={k + '-' + i} data-macro={p}>{p}</span> : p)))}{'\n'}
      </div>
      <textarea ref={taRef} value={value} spellCheck={false} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onScroll={e => { if (mirror.current) mirror.current.scrollTop = e.target.scrollTop; }}
        onKeyDown={e => {
          // brackets like in VS Code: ( [ { " are closed as they are typed, typing the closing character steps over it, Backspace inside an empty pair removes both,
          // and with text selected the pair is put around the selection (which stays selected)
          const el = e.currentTarget;
          if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
          const CLOSE = { '(': ')', '[': ']', '{': '}', '"': '"' };
          const a = el.selectionStart, b = el.selectionEnd, v = el.value;
          // execCommand keeps the undo history; without it the text is set directly
          const put = (s, from, to) => {
            e.preventDefault(); el.focus();
            if (!document.execCommand('insertText', false, s)) onChange(v.slice(0, a) + s + v.slice(b));
            requestAnimationFrame(() => el.setSelectionRange(from, to));
          };
          if (CLOSE[e.key] && a !== b) { const inner = v.slice(a, b); put(e.key + inner + CLOSE[e.key], a + 1, a + 1 + inner.length); return; }
          if (a !== b) return;
          if (Object.values(CLOSE).includes(e.key) && v[a] === e.key) { e.preventDefault(); el.setSelectionRange(a + 1, a + 1); return; }
          if (CLOSE[e.key]) {
            const prev = v[a - 1] || '', next = v[a] || '';
            if (e.key === '"' && /\w/.test(prev)) return;                       // a quote right behind a word (haven"t) is just a quote
            if (next && !/[\s)\]}"';:.,]/.test(next)) return;                    // only close in front of white space / a closing character / the end
            put(e.key + CLOSE[e.key], a + 1, a + 1);
            return;
          }
          if (e.key === 'Backspace' && a > 0 && CLOSE[v[a - 1]] && v[a] === CLOSE[v[a - 1]]) {
            e.preventDefault(); el.setSelectionRange(a - 1, a + 1);
            if (!document.execCommand('delete')) onChange(v.slice(0, a - 1) + v.slice(a + 1));
          }
        }}
        onContextMenu={onContext} onMouseMove={onMove} onMouseLeave={() => setTip(null)}
        style={{ ...EDIT_FONT, position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'transparent', color: 'var(--text)', borderColor: 'var(--border)', borderRadius: 6, resize: 'none' }} />
      {box}
      {menu && createPortal(
        <div onMouseDown={e => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 50), zIndex: 30000, minWidth: 170, padding: 4,
                      background: 'var(--surface, #1e1e2e)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,.45)', fontSize: 13 }}>
          <div role="menuitem" style={{ padding: '5px 12px', cursor: 'pointer', borderRadius: 4 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent, #7c6af7)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = ''; }}
            onClick={() => { const n = menu.name; setMenu(null); onEditMacro(n); }}>Edit macro <code>{menu.name}</code>…</div>
        </div>, document.body)}
    </div>
  );
}
