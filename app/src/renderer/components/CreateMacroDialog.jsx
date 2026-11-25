import React, { useEffect, useState } from 'react';
import FloatingDialog from './FloatingDialog';

// "Create macro": a new $MACRO goes into one of the cartridge's macro files. The files the pattern being edited already includes come first.
// A file directly in grdata is common to all cartridges (each has its own copy): "Add to all cartridges" appends the macro to the copy of every cartridge.
// editName: edit that existing macro instead (name and file are fixed, the definition is read from the file; "all cartridges" changes the copies that still have the same definition)
export default function CreateMacroDialog({ api, cartPath, cartName, patternText, relationName, initialBody = '', hasSelection = false, editName = '', standalone = false, onAdded, onClose }) {
  const [name, setName] = useState('$');
  const [body, setBody] = useState(initialBody || '[ ]');
  const [files, setFiles] = useState(null);
  const [file, setFile] = useState('');
  const [all, setAll] = useState(true);
  const [putIn, setPutIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [orig, setOrig] = useState(null);                       // edit: { body, file, topLevel }
  const [newName, setNewName] = useState(null);                 // edit: the name typed in the Rename row (null = row closed)

  useEffect(() => {
    let live = true;
    if (editName) {
      api.macroInfo({ cartPath, name: editName }).then(r => {
        if (!live) return;
        if (r.ok === false) { setError(r.error); setFiles([]); return; }
        setName(r.info.name); setBody(r.info.body); setFile(r.info.file); setOrig(r.info); setFiles([]);
      }).catch(e => { if (live) { setError(e.message); setFiles([]); } });
      return () => { live = false; };
    }
    api.macroFiles({ cartPath, text: patternText, relationName }).then(r => {
      if (!live) return;
      if (r.ok === false) { setError(r.error); setFiles([]); return; }
      const list = r.files || [];
      setFiles(list);
      const first = list.find(f => f.included && f.topLevel) || list.find(f => f.included) || list[0];
      if (first) setFile(first.file);
    }).catch(e => { if (live) { setError(e.message); setFiles([]); } });
    return () => { live = false; };
  }, []);

  // spell-check of the definition: the words are separated by white space, a comma / semicolon outside double quotes is a typo
  const outsideQuotes = (t) => t.split('"').filter((_, i) => i % 2 === 0).join(' ');
  const commas = /[,;]/.test(outsideQuotes(body));
  const fixCommas = () => setBody(body.split('"').map((p, i) => (i % 2 === 0 ? p.replace(/[,;]+/g, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']') : p)).join('"'));
  const picked = (files || []).find(f => f.file === file);
  const topLevel = editName ? !!orig?.topLevel : !!picked?.topLevel;

  const add = async () => {
    setBusy(true); setError(null);
    try {
      const r = editName
        ? await api.editMacro({ cartPath, file, name, body: body.trim(), original: orig?.body, allCartridges: all && topLevel })
        : await api.addMacro({ cartPath, file, name: name.trim(), body: body.trim(), allCartridges: all && topLevel });
      if (r.ok === false) throw new Error(r.error);
      setDone(r.result);
      onAdded(name.trim(), editName || standalone ? false : putIn, !!editName);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const rename = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.renameMacro({ cartPath, file, name, newName: newName.trim(), allCartridges: all && topLevel });
      if (r.ok === false) throw new Error(r.error);
      setDone(r.result);
      onAdded(name, false, true, newName.trim());
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <FloatingDialog title={editName ? 'Edit macro ' + editName : 'Create macro'} width={680} dock="left">
      <div style={{ padding: 12, fontSize: 12 }}>
        {done ? <>
          <div style={{ color: 'var(--success, #a6e3a1)', marginBottom: 6 }}>✓ <code>{done.name}</code> {done.renamed ? <>renamed to <code>{done.newName}</code> (definition and {done.added.reduce((n, a) => n + (a.uses || 0), 0)} use{done.added.reduce((n, a) => n + (a.uses || 0), 0) !== 1 ? 's' : ''}) in</> : editName ? 'changed in' : 'added to'} <code>{done.file}</code> of {done.added.length} cartridge{done.added.length !== 1 ? 's' : ''}: {done.added.map(a => a.cartridge).join(', ')}.</div>
          {done.unchanged?.length > 0 && <div className="text-xs text-muted" style={{ marginBottom: 6 }}>Nothing to do in: {done.unchanged.map((s, i) => <span key={i}>{i > 0 && '; '}<b>{s.cartridge}</b> ({s.reason})</span>)}.</div>}
          {done.skipped.length > 0 && <div style={{ color: 'var(--warning, #e8a000)', marginBottom: 6 }}>Left unchanged — they differ: {done.skipped.map((s, i) => <div key={i}><b>{s.cartridge}</b> — {s.reason}</div>)}</div>}
          <div className="text-xs text-muted" style={{ marginBottom: 8 }}>A copy of each changed file is kept in <code>_relation_backups</code> (that of its cartridge; the master copy's backup is in this cartridge's folder, under <code>bin</code>).</div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>
        </> : <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <label style={{ width: 90 }}>Macro name</label>
            <input className="form-control" autoFocus={!editName} readOnly={!!editName} style={{ flex: 1, fontFamily: 'monospace', opacity: editName ? 0.7 : 1 }} value={name} onChange={e => setName(e.target.value.replace(/\s/g, ''))} placeholder="$NOT_CONTRACTED" />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
            <label style={{ width: 90, paddingTop: 4 }}>Definition</label>
            <textarea className="form-control" style={{ flex: 1, fontFamily: 'monospace', minHeight: 60 }} spellCheck={false} value={body} onChange={e => setBody(e.target.value)}
              placeholder={'[word "two words" $OTHER_MACRO stem~]'} />
          </div>
          {commas && <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', margin: '-4px 0 8px 98px', color: 'var(--danger, #f38ba8)' }}>
            <span style={{ flex: 1 }}>⚠ Words are separated by white space, not by commas / semicolons: <code>[word1 word2 "two words"]</code>.</span>
            <button type="button" className="btn btn-sm btn-secondary" style={{ padding: '1px 8px' }} onClick={fixCommas}>Fix</button>
          </div>}
          {editName ? <div style={{ marginBottom: 8 }}>Defined in <code>{orig ? orig.file : '…'}</code>{orig?.copies > 1 ? <span className="text-xs text-muted"> (also defined in {orig.copies - 1} other file{orig.copies > 2 ? 's' : ''} of this cartridge — only this one is changed)</span> : null}</div> : <>
          <div style={{ marginBottom: 4 }}>Add it to this file{files === null ? ' (loading…)' : ''}:</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8 }}>
            {(files || []).map(f => (
              <label key={f.file} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 8px', cursor: 'pointer', background: f.file === file ? 'var(--surface-dim, rgba(255,255,255,.06))' : 'transparent' }}>
                <input type="radio" name="macro-file" checked={f.file === file} onChange={() => setFile(f.file)} />
                <code>{f.file}</code>
                <span className="text-xs text-muted">{f.macros} macros{f.included ? ' · included by this pattern' : ''}{f.topLevel ? ' · common (top level of grdata)' : ''}</span>
              </label>
            ))}
            {files && !files.length && <div className="text-muted" style={{ padding: 8 }}>No macro file found in this cartridge.</div>}
          </div></>}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, opacity: topLevel ? 1 : 0.5 }}>
            <input type="checkbox" checked={all && topLevel} disabled={!topLevel} onChange={e => setAll(e.target.checked)} />
            {editName ? 'Change it in all cartridges' : 'Add to all cartridges'} <span className="text-xs text-muted">{topLevel ? (editName ? '(the same file of every other cartridge and the master copy in MEDSCAN\bin is changed too, where the macro still has the old definition)' : '(the same file of every other cartridge and the master copy in MEDSCAN\bin gets the macro too)') : '(only for a file directly in grdata)'}</span>
          </label>
          {!editName && !standalone && <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={putIn} onChange={e => setPutIn(e.target.checked)} />
            {hasSelection ? <>Replace the selected text in the pattern with the macro name</> : <>Insert the macro name into the pattern at the cursor</>}
          </label>}
          {editName && newName !== null && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <label style={{ width: 90 }}>New name</label>
            <input className="form-control" autoFocus style={{ flex: 1, fontFamily: 'monospace' }} value={newName} onChange={e => setNewName(e.target.value.replace(/\s/g, ''))} placeholder="$NEW_NAME" />
            <button className="btn btn-sm btn-primary" disabled={busy || newName.trim().length < 2 || newName.trim() === name || !orig} title="Renames the definition and every use of it in the macro and pattern files (all cartridges when the box above is checked)" onClick={rename}>{busy ? 'Renaming…' : 'Rename'}</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setNewName(null)}>Cancel rename</button>
          </div>}
          {error && <div className="text-danger" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-primary" disabled={busy || commas || !file || name.trim().length < 2 || !body.trim() || (editName && !orig)} onClick={add}>{busy ? (editName ? 'Saving…' : 'Adding…') : (editName ? 'Save' : 'Add')}</button>
            {editName && newName === null && <button className="btn btn-sm btn-secondary" disabled={busy || !orig} title="Give the macro another name: its definition and all its uses are renamed" onClick={() => setNewName(name)}>Rename…</button>}
            <button className="btn btn-sm btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        </>}
      </div>
    </FloatingDialog>
  );
}
