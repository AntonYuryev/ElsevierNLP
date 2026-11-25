import React, { useMemo, useState } from 'react';
import FloatingDialog from './FloatingDialog';
import { PATTERN_SYNTAX } from '../utils/patternSyntax';

// "Help" of the pattern editors: the msgrep notation as "symbol — brief explanation" (utils/patternSyntax.js), with a filter box.
// It floats beside the editor, so a symbol can be looked up while the pattern is being typed.
export default function PatternHelpDialog({ onClose }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const w = q.trim().toLowerCase();
    if (!w) return PATTERN_SYNTAX;
    return PATTERN_SYNTAX.map(g => ({ ...g, items: g.items.filter(([sym, text]) => sym.toLowerCase().includes(w) || text.toLowerCase().includes(w) || g.title.toLowerCase().includes(w)) }))
      .filter(g => g.items.length);
  }, [q]);

  return (
    <FloatingDialog title="Pattern notation (msgrep)" width={620} dock="right">
      <div style={{ padding: 12, fontSize: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input className="form-control" autoFocus style={{ flex: 1 }} value={q} placeholder="filter, e.g. repeat, ~, @.  or  optional" onChange={e => setQ(e.target.value)} />
          <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
        </div>
        <div style={{ maxHeight: '68vh', overflowY: 'auto' }}>
          {!groups.length && <div className="text-muted">Nothing matches “{q}”.</div>}
          {groups.map(g => (
            <div key={g.title} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 700, padding: '3px 0', borderBottom: '1px solid var(--border)', marginBottom: 3 }}>{g.title}</div>
              {g.items.map(([sym, text]) => (
                <div key={sym} style={{ display: 'flex', gap: 10, padding: '2px 0', alignItems: 'baseline' }}>
                  <code style={{ flex: '0 0 40%', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontWeight: 700, color: 'var(--accent-hover)' }}>{sym}</code>
                  <span style={{ flex: 1 }}>{text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="text-xs text-muted" style={{ marginTop: 6 }}>Full manual: TestData\MSGrep.docx. The spell-check under the editing box checks this notation.</div>
      </div>
    </FloatingDialog>
  );
}
