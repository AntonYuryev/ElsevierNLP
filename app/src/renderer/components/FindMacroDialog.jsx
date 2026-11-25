import React, { useEffect, useRef, useState } from 'react';
import FloatingDialog from './FloatingDialog';
import CreateMacroDialog from './CreateMacroDialog';

// "Find macro": type a word, see every macro of the cartridge that contains it (the word itself first, then words that start with / contain it,
// then macros whose name has it, then macros that reach a hit through another macro). "Insert" puts $NAME into the pattern at the cursor.
export default function FindMacroDialog({ api, cartPath, cartName, initial = '', onInsert, onClose }) {
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState(null);
  const [exact, setExact] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editName, setEditName] = useState('');                // the macro open in the Edit macro dialog
  const [ver, setVer] = useState(0);                            // bumped after an edit: the list is searched again
  const seq = useRef(0);

  useEffect(() => {
    const word = q.trim();
    if (word.length < 2) { setRes(null); return; }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      const r = await api.findMacros({ cartPath, query: word, max: 60, exact }).catch(e => ({ ok: false, error: e.message }));
      if (mine !== seq.current) return;
      setRes(r.ok === false ? { error: r.error } : { list: r.macros || [] });
      setBusy(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, cartPath, exact, ver]);

  const mark = (text, word) => {
    const i = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
    return i < 0 ? text : <>{text.slice(0, i)}<b style={{ color: 'var(--accent-hover)' }}>{text.slice(i, i + word.length)}</b>{text.slice(i + word.length)}</>;
  };
  const word = q.trim();

  return (
    <>
    <FloatingDialog title="Find macro" width={620} dock="left">
      <div style={{ padding: 12, fontSize: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input className="form-control" autoFocus style={{ flex: 1, fontFamily: 'monospace' }} value={q} placeholder="a word, e.g. relate"
            onChange={e => setQ(e.target.value)} />
          <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }} title="Only macros that contain this very word (lower or lower~), not words that merely start with or contain it (lowering, lowest)">
          <input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} /> Exact <span className="text-xs text-muted">(the word itself, with or without ~)</span>
        </label>
        {busy && <div className="text-xs text-muted">searching…</div>}
        {res?.error && <div className="text-danger">{res.error}</div>}
        {res?.list && !res.list.length && <div className="text-muted">No macro of this cartridge contains “{word}”. Write the word in the pattern itself, e.g. <code>[{word}~]</code> for a stem match.</div>}
        {res?.list?.length > 0 && <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {res.list.map(m => (
            <div key={m.name} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <code style={{ fontWeight: 700 }}>{m.name}</code>
                {m.wordCount != null && <span className="text-xs" style={{ marginLeft: 6, padding: '0 6px', borderRadius: 8, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}
                  title={m.directWords !== m.wordCount ? m.wordCount + ' distinct words in total, counting the macros it uses; ' + m.directWords + ' are written in its own definition' : m.wordCount + ' distinct words'}>
                  {m.wordCount.toLocaleString()} word{m.wordCount !== 1 ? 's' : ''}{m.directWords !== m.wordCount ? ' (' + m.directWords + ' own)' : ''}
                </span>}
                <span className="text-xs text-muted"> {m.via ? `— includes ${m.via}` : m.words.length ? '— word: ' : '— name contains it'}</span>
                {m.words.map((w, i) => <code key={i} style={{ marginRight: 6 }}>{mark(w, word)}</code>)}
                <div className="text-xs text-muted" style={{ fontFamily: 'monospace', whiteSpace: 'normal', overflowWrap: 'anywhere' }} title={m.file}>{m.body.length > 220 ? m.body.slice(0, 220) + ' …' : m.body}</div>
                <div className="text-xs" style={{ marginTop: 2 }}>
                  <span className="text-muted">File: </span><code>{m.file}</code>
                  {(m.where || []).length > 0 && <>
                    <span className="text-muted"> · in {m.where.length} cartridge{m.where.length !== 1 ? 's' : ''}: </span>
                    {m.where.map((w, i) => {
                      const other = w.files.filter(f => f !== m.file);
                      return <span key={w.cartridge} style={w.same ? undefined : { color: 'var(--warning, #e8a000)' }} title={w.same ? w.files.join('\n') : 'different definition — ' + w.files.join('\n')}>
                        {i > 0 && ', '}{w.cartridge.replace(/\.bin$/i, '')}{!w.same && ' (differs)'}{other.length > 0 && <span className="text-muted"> [{other.map(f => f.split(/[\\/]/).pop()).join(', ')}]</span>}
                      </span>;
                    })}
                  </>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button className="btn btn-sm btn-secondary" style={{ padding: '1px 8px' }} onClick={() => (onInsert ? onInsert(m.name) : navigator.clipboard?.writeText(m.name))} title={onInsert ? undefined : 'Copy the macro name to the clipboard'}>{onInsert ? 'Insert' : 'Copy'}</button>
              <button className="btn btn-sm btn-secondary" style={{ padding: '1px 8px' }} title="Open this macro in the Edit macro dialog" onClick={() => setEditName(m.name)}>Edit</button>
              </div>
            </div>
          ))}
        </div>}
        {onInsert ? <div className="text-xs text-muted" style={{ marginTop: 8 }}>Insert puts the macro name into the pattern at the cursor — use it as <code>$NAME</code> alone or inside a word set <code>[$A $B word~]</code>.</div> : <div className="text-xs text-muted" style={{ marginTop: 8 }}>Copy puts the macro name on the clipboard.</div>}
      </div>
    </FloatingDialog>
    {editName && <CreateMacroDialog api={api} cartPath={cartPath} cartName={cartName} patternText="" relationName="" editName={editName} onAdded={() => setVer(v => v + 1)} onClose={() => setEditName('')} />}
    </>
  );
}
