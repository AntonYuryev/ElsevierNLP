import React, { useEffect, useMemo, useState } from 'react';

// In-app file picker (replaces the native Open dialog, which cannot be resized and
// covered the whole window). Navigates folders, filters by extension, and reports the
// folder it ended in via onClose(lastDir) so callers can remember it permanently.
//
// Props:
//   startDir     initial folder (falls back to Downloads/Home if missing)
//   extensions   e.g. ['.txt', '.tsv']  (user can switch to "All files")
//   onSelect(filePath, dir)   file chosen
//   onCancel(dir)             closed without choosing — dir is the last folder visited
export default function FilePickerModal({ title = 'Open file', startDir, extensions = [], onSelect, onCancel }) {
  const [dir, setDir]         = useState(null);
  const [parent, setParent]   = useState(null);
  const [entries, setEntries] = useState([]);
  const [pathText, setPathText] = useState('');
  const [error, setError]     = useState(null);
  const [places, setPlaces]   = useState({ places: [], drives: [] });
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(extensions.length === 0);
  const [filter, setFilter]   = useState('');

  const load = async (target) => {
    const res = await window.api.fs.listDirDetailed(target);
    if (!res.ok) { setError(res.error); return false; }
    setError(null); setDir(res.dir); setParent(res.parent); setEntries(res.entries);
    setPathText(res.dir); setSelected(null);
    return true;
  };

  useEffect(() => {
    (async () => {
      const qp = await window.api.fs.quickPlaces();
      setPlaces(qp);
      const fallback = qp.places.find(p => p.label === 'Downloads')?.path || qp.places[0]?.path || 'C:\\';
      if (!(startDir && await load(startDir))) { setError(null); await load(fallback); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return entries
      .filter(e => e.isDir || showAll || extensions.some(x => e.name.toLowerCase().endsWith(x)))
      .filter(e => !f || e.name.toLowerCase().includes(f))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
  }, [entries, showAll, filter, extensions]);

  const join = (d, n) => d.replace(/[\\/]+$/, '') + '\\' + n;
  const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const open = (e) => e.isDir ? load(join(dir, e.name)) : onSelect(join(dir, e.name), dir);
  const cancel = () => onCancel?.(dir);

  return (
    <div className="modal-backdrop" style={{ zIndex: 10000 }} onClick={cancel}>
      <div className="modal" style={{ width: 760, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{title}</div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button className="btn btn-secondary" disabled={!parent} onClick={() => parent && load(parent)} title="Up one folder">⬆</button>
          <input className="form-control" style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }} value={pathText}
            onChange={e => setPathText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(pathText); }} />
          <button className="btn btn-secondary" onClick={() => load(pathText)}>Go</button>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ width: 130, flexShrink: 0, fontSize: 12, borderRight: '1px solid var(--border)', paddingRight: 8, maxHeight: 320, overflowY: 'auto' }}>
            {[...places.places, ...places.drives].map(p => (
              <div key={p.path} style={{ padding: '3px 4px', cursor: 'pointer', borderRadius: 3 }}
                   className="nav-item" onClick={() => load(p.path)}>
                {p.label.endsWith(':\\') ? '💽' : '📁'} {p.label}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
              <input className="form-control" style={{ flex: 1, padding: '2px 6px' }} placeholder="Filter by name…"
                value={filter} onChange={e => setFilter(e.target.value)} />
              {extensions.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
                  All files
                </label>
              )}
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 4, height: 280, overflowY: 'auto', fontSize: 13 }}>
              {visible.length === 0 && <div className="text-muted" style={{ padding: 12 }}>{error || 'No matching files or folders.'}</div>}
              {visible.map(e => (
                <div key={e.name}
                  onClick={() => setSelected(e.name)}
                  onDoubleClick={() => open(e)}
                  style={{ display: 'flex', gap: 8, padding: '3px 8px', cursor: 'pointer',
                           background: selected === e.name ? 'rgba(122,162,247,0.28)' : undefined }}>
                  <span>{e.isDir ? '📁' : '📄'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  {!e.isDir && <span className="text-muted" style={{ fontSize: 11 }}>{fmtSize(e.size)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {error && visible.length > 0 && <div className="text-xs" style={{ color: 'var(--danger, red)', marginTop: 6 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={cancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!selected}
            onClick={() => { const e = entries.find(x => x.name === selected); if (e) open(e); }}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
