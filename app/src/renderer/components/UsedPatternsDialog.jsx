import React, { useState } from 'react';
import FloatingDialog from './FloatingDialog';
import FileEditorDialog from './FileEditorDialog';
import { MacroPre } from './useMacroTip';
import { nodeTypeOfId as typeTok } from '../../shared/entityTypes';

// ── "Open pattern": the patterns of a pattern folder that produced the relations (read-only) ──
// the entity types of the frame (in / out lists of its CONTROL) and the entities of the relations found, for the @regulator / @target tooltips
const roleInfo = (m, res, names) => {
  const list = (k) => { const x = String(m.control || '').match(new RegExp('\\b' + k + '\\s*=\\s*\\S+?\\(([^)]*)\\)')); return x ? x[1].split(/[\s,]+/).filter(Boolean).map(typeTok) : []; };
  const inT = list('in'), outT = list('out');
  const ct = (String(m.control || '').match(/ControlType\s*=\s*"([^"]*)"/) || [])[1];
  const rels = (res.relations || []).filter(r => r.type === ct && (!r.inType || inT.includes(r.inType)) && (!r.outType || outT.includes(r.outType)));
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  return { regType: inT.join(' / '), tgtType: outT.join(' / '),
    regNames: names?.regNames || uniq(rels.map(r => r.inName)), tgtNames: names?.tgtNames || uniq(rels.map(r => r.outName)) };
};

export default function UsedPatternsDialog({ res, folder, title, onClose, cartPath, names }) {
  const box = { margin: 0, padding: 8, background: 'var(--bg-input, #1e1e2e)', borderRadius: 6, whiteSpace: 'pre-wrap', userSelect: 'text' };
  const bad = res.ok === false;
  // Edit: this read-only dialog is replaced by the editor of the file that holds the pattern set, opened on that set; closing the editor closes everything
  const [editing, setEditing] = useState(null);                  // { file (inside the cartridge), set }
  if (editing && cartPath) {
    const cartName = cartPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/\.bin$/i, '');
    return <FileEditorDialog cartPath={cartPath} cartName={cartName} file={editing.file} initialSet={editing.set} onClose={onClose} />;
  }
  return (
    <FloatingDialog title={title || `Pattern of ${folder} (read-only)`} width={900} dock="left">
      <div style={{ fontSize: 12 }}>
        {(bad || !res.matches?.length) && <div className={bad ? 'text-danger' : 'text-muted'} style={{ whiteSpace: 'pre-wrap' }}>{res.error || res.message || 'No pattern found.'}</div>}
        {(res.matches || []).map((m, k) => (
          <div key={k} style={{ marginBottom: 14 }}>
            <div className="text-xs text-muted" style={{ marginBottom: 3 }}>{m.folder ? <>Folder <code>{m.folder}</code> — </> : null}CONTROL frame — <code>{m.controlFile}</code>, line {m.controlLine}</div>
            <pre style={{ ...box, marginBottom: 8 }}>{m.control}</pre>
            <div className="text-xs text-muted" style={{ marginBottom: 3, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>Pattern set <code>{m.set}</code> — <code>{m.patternsFile}</code>, line {m.setLine}; the matching pattern is <b>#{m.index}</b> of {m.of}</span>
              {cartPath && m.patternsFile && <button type="button" className="btn btn-sm btn-primary" style={{ padding: '1px 12px' }} title="Close this read-only view and edit the pattern set in the pattern editor"
                onClick={() => setEditing({ file: String(m.patternsFile).replace(/^[^\\/]+[\\/]/, ''), set: m.set })}>Edit</button>}
            </div>
            {cartPath ? <MacroPre cartPath={cartPath} text={m.alt} style={{ ...box, border: '1px solid #a6e3a1', color: '#a6e3a1' }} {...roleInfo(m, res, names)} />
              : <pre style={{ ...box, border: '1px solid #a6e3a1', color: '#a6e3a1' }}>{m.alt}</pre>}
            <details style={{ marginTop: 6 }}>
              <summary className="text-xs text-muted" style={{ cursor: 'pointer' }}>All {m.of} patterns of {m.set}</summary>
              <pre style={{ ...box, marginTop: 4, maxHeight: '40vh', overflow: 'auto' }}>{m.alts.map((a, i) => (i + 1 === m.index ? '▶ ' : '  ') + '#' + (i + 1) + '  ' + a.replace(/\s+/g, ' ')).join('\n\n')}</pre>
            </details>
          </div>
        ))}
        {res.tested > 0 && <div className="text-xs text-muted">{res.tested} pattern(s) of the matching frames were tried one by one on the pipeline input.</div>}
        <div style={{ marginTop: 10, textAlign: 'right' }}><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </FloatingDialog>
  );
}
