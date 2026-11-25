import React, { useState, useEffect, useRef, useMemo } from 'react';
import ResultsTable from '../components/ResultsTable';
import MultiSelect from '../components/MultiSelect';

// ── DOI / PMID extractors from TextRef attribute ──────────────────────────────
// TextRef formats:
//   info:doi/{doi}#{sentenceRef}
//   info:pmid/{pmid}#{sentenceRef}
function doiFromTextRef(textRef) {
  if (!textRef) return '';
  const m = textRef.match(/^info:doi\/([^#\s]+)/i);
  return m ? m[1] : '';
}
function pmidFromTextRef(textRef) {
  if (!textRef) return '';
  const m = textRef.match(/^info:pmid\/([^#\s]+)/i);
  return m ? m[1] : '';
}

// ── Sentence segments (built lazily for the rows on screen) ────────────────────
// The RNEF file itself is parsed by the main process (src/main/rnefParser.js — streaming, no DOM).
// Rows arrive with the raw msrc string; the coloured segments are computed only for visible rows.
const parseMsrcIds = (msrc) => {
  const entries = [];
  const re = /ID\{([^=}]+)=([^}]+)\}/g;
  let m;
  while ((m = re.exec(msrc)) !== null) {
    const ids = [...new Set(m[1].split(',').map(s => s.trim()).filter(Boolean))];
    entries.push({ ids, alias: m[2].trim(), start: m.index, end: m.index + m[0].length });
  }
  return entries;
};

const buildSegments = (msrc, msrcEntries, node1Ids, node2Ids) => {
  const n1Ids = new Set(node1Ids);
  const n2Ids = new Set(node2Ids);
  const segments = [];
  let pos = 0;
  for (const entry of msrcEntries) {
    if (entry.start > pos) {
      const plain = msrc.slice(pos, entry.start)
        .replace(/GLOSSARY\{[^}]+\}/g, '').replace(/CONTEXT\{[^}]+\}/g, '');
      if (plain) segments.push({ text: plain, role: 'text' });
    }
    const hasN1 = entry.ids.some(id => n1Ids.has(id));
    const hasN2 = entry.ids.some(id => n2Ids.has(id));
    let role = 'other';
    if (hasN1 && hasN2) role = 'both';
    else if (hasN1) role = 'node1';
    else if (hasN2) role = 'node2';
    segments.push({ text: entry.alias, role, ids: entry.ids });
    pos = entry.end;
  }
  if (pos < msrc.length) {
    const plain = msrc.slice(pos)
      .replace(/GLOSSARY\{[^}]+\}/g, '').replace(/CONTEXT\{[^}]+\}/g, '');
    if (plain) segments.push({ text: plain, role: 'text' });
  }
  return segments;
};

const _segCache = new WeakMap();
function getSegments(rel) {
  if (!rel.msrc) return [];
  let segs = _segCache.get(rel);
  if (!segs) {
    segs = buildSegments(rel.msrc, parseMsrcIds(rel.msrc), rel.node1Ids || [], rel.node2Ids || []);
    _segCache.set(rel, segs);
  }
  return segs;
}

// ── Colors ────────────────────────────────────────────────────────────────────
// Directional: node1=regulator(red), node2=target(green)
// Non-directional: node1=purple, node2=orange
const NODE1_COLOR_DIR    = '#f38ba8'; // red   – regulator
const NODE2_COLOR_DIR    = '#a6e3a1'; // green – target
const NODE1_COLOR_INDIR  = '#cba6f7'; // purple
const NODE2_COLOR_INDIR  = '#fab387'; // orange

function getColors(isDirect) {
  return isDirect
    ? { n1: NODE1_COLOR_DIR, n2: NODE2_COLOR_DIR }
    : { n1: NODE1_COLOR_INDIR, n2: NODE2_COLOR_INDIR };
}

// ── Sentence renderer ─────────────────────────────────────────────────────────
function ColoredSentence({ segments, isDirect }) {
  const { n1, n2 } = getColors(isDirect);
  return (
    <span style={{ fontSize: 11, lineHeight: 1.6 }}>
      {segments.map((seg, i) => {
        if (seg.role === 'text')  return <span key={i}>{seg.text}</span>;
        if (seg.role === 'other') return <span key={i} style={{ color: 'var(--text-dim)' }}>{seg.text}</span>;
        if (seg.role === 'node1') return <strong key={i} style={{ color: n1 }}>{seg.text}</strong>;
        if (seg.role === 'node2') return <strong key={i} style={{ color: n2 }}>{seg.text}</strong>;
        if (seg.role === 'both')  return <strong key={i} style={{ color: '#f9e2af' }}>{seg.text}</strong>;
        return <span key={i}>{seg.text}</span>;
      })}
    </span>
  );
}

// ── Node cell renderer ────────────────────────────────────────────────────────
function NodeCell({ name, nodeType, urn, ids, color, onIdClick }) {
  if (!name) return <td>—</td>;
  return (
    <td title={urn || ids.join(', ')}>
      <div style={{ color, fontWeight: 600 }}>{name}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
        <span style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, padding: '1px 5px', marginRight: 4 }}>
          {nodeType}
        </span>
        {ids.map(id => (
          <span key={id}
            onClick={e => { e.stopPropagation(); onIdClick && onIdClick(id); }}
            style={{ color, opacity: 0.85, cursor: 'pointer', textDecoration: 'underline dotted',
                     marginRight: 4 }}
            title="Click to look up dictionary record">
            ID:{id}
          </span>
        ))}
      </div>
      {urn && (
        <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2, opacity: 0.7,
                      maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={urn}>
          {urn}
        </div>
      )}
    </td>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
const PAGE_SIZE = 200;

export default function ResultsScreen({ initialFiles = [], onNodeIdClick, tableData = null, memory = null, onBackFromTable, onCloseTable }) {
  const [fromReader, setFromReader] = useState(null);             // relations handed over by the Reader (not an RNEF file): { title, subtitle, relations, fileName }
  const [files, setFiles] = useState(initialFiles);
  const [selectedFile, setSelectedFile] = useState(null);
  const [relations, setRelations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [parseProgress, setParseProgress] = useState(null); // 0-100 while an RNEF file is being read
  const [error, setError] = useState(null);
  const [filterTypes,    setFilterTypes]    = useState([]);   // array of selected relation types
  const [filterNode,     setFilterNode]     = useState('');
  const [filterNodeTypes,setFilterNodeTypes]= useState([]);  // array of selected node types
  const [expandedRow, setExpandedRow] = useState(null);
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState(null);   // 'type'|'node1'|'n1occ'|'node2'|'n2occ'|'docid'
  const [sortDir, setSortDir] = useState('asc');  // 'asc'|'desc'

  // Column widths (px) — user-resizable
  const [colWidths, setColWidths] = useState({ type: 160, node1: 200, node2: 200, n1occ: 60, n2occ: 60, docid: 200, sentence: 480 });
  const resizingRef = useRef(null); // { key, startX, startW }

  const startResize = (e, key) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[key];
    const minW = key === 'sentence' ? 120 : key === 'n1occ' || key === 'n2occ' ? 40 : 80;
    resizingRef.current = { key, startX, startW };
    const onMove = (ev) => {
      if (!resizingRef.current) return;
      // Read ref values synchronously — do NOT access ref inside the updater fn
      const dx = ev.clientX - startX;
      const newW = Math.max(minW, startW + dx);
      setColWidths(prev => ({ ...prev, [key]: newW }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizingRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (initialFiles.length > 0 && !selectedFile) loadFile(initialFiles[0]);
  }, [initialFiles]);

  // the relations of the Reader: shown with the viewer of an RNEF file
  useEffect(() => {
    if (!memory) return;
    setSelectedFile(null); setRelations(memory.relations); setLoading(false); setError(null); setExpandedRow(null); setPage(0);
    setFilterTypes([]); setFilterNode(''); setFilterNodeTypes([]); setSortCol(null); setFromReader(memory);
  }, [memory && memory.seq]);

  const loadFile = async (filePath) => {
    setFromReader(null);
    setSelectedFile(filePath);
    setLoading(true);
    setError(null);
    setRelations([]);
    setExpandedRow(null);
    setPage(0);
    setParseProgress(null);
    const offProgress = window.api.rnef.onParseProgress(p => setParseProgress(Math.round(100 * p.done / Math.max(1, p.total))));
    const result = await window.api.rnef.parse(filePath);
    offProgress();
    setParseProgress(null);
    setLoading(false);
    if (result.ok) setRelations(result.relations);
    else setError(result.error);
  };

  const handleAddFile = async () => {
    // Start in the folder of the last opened RNEF file (stored in the app settings → survives restarts);
    // first time, fall back to the NLP Runner output folder where the .rnef files are written.
    const s = await window.api.settings.get();
    const startDir = s?.lastRnefDir || s?.lastOutputDir || '';
    const f = await window.api.dialog.openFile({
      filters: [{ name: 'RNEF XML', extensions: ['rnef', 'xml'] }, { name: 'All', extensions: ['*'] }],
      ...(startDir ? { defaultPath: startDir } : {}),
    });
    if (f) window.api.settings.set({ lastRnefDir: f.replace(/[\\/][^\\/]*$/, '') });
    if (f && !files.includes(f)) { setFiles(prev => [...prev, f]); loadFile(f); }
  };

  const [exporting,     setExporting]     = useState(false);
  const [exportingRnef, setExportingRnef] = useState(false);

  const handleExportExcel = async () => {
    if (!filtered.length) return;
    setExporting(true);
    const defaultName = selectedFile
      ? selectedFile.replace(/\.[^.]+$/, '') + '.xlsx'
      : (fromReader && fromReader.fileName) || 'relations.xlsx';
    const result = await window.api.rnef.exportExcel({ relations: filtered.map(r => ({ ...r, segments: getSegments(r) })), defaultName });
    setExporting(false);
    if (result.ok) window.api.shell.openFile(result.filePath);
  };

  const handleExportRnef = async () => {
    if (!selectedFile) return;
    setExportingRnef(true);
    const defaultName = selectedFile.replace(/(\.[^.]+)$/, '_filtered$1');
    const result = await window.api.rnef.exportRnef({
      filePath:        selectedFile,
      filterTypes,
      filterNode,
      filterNodeTypes,
      defaultName,
    });
    setExportingRnef(false);
    if (result.ok) window.api.shell.openFile(result.filePath);
  };

  const relTypes  = useMemo(() => [...new Set(relations.map(r => r.type).filter(Boolean))].sort(), [relations]);
  const nodeTypes = useMemo(() => [...new Set(relations.flatMap(r => [r.node1Type, r.node2Type]).filter(Boolean))].sort(), [relations]);

  // Count occurrences separately: as Node 1 (regulator) and as Node 2 (target)
  const [occ1Map, occ2Map] = useMemo(() => {
    const m1 = new Map(), m2 = new Map();
    for (const r of relations) {
      if (r.node1) m1.set(r.node1, (m1.get(r.node1) || 0) + 1);
      if (r.node2) m2.set(r.node2, (m2.get(r.node2) || 0) + 1);
    }
    return [m1, m2];
  }, [relations]);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    setPage(0);
    const fnLc = filterNode.toLowerCase();
    const arr = relations.filter(r => {
      const typeMatch     = filterTypes.length === 0     || filterTypes.includes(r.type);
      const nodeMatch     = !fnLc || r.node1.toLowerCase().includes(fnLc) || r.node2.toLowerCase().includes(fnLc);
      const nodeTypeMatch = filterNodeTypes.length === 0 || filterNodeTypes.includes(r.node1Type) || filterNodeTypes.includes(r.node2Type);
      return typeMatch && nodeMatch && nodeTypeMatch;
    });
    if (!sortCol) return arr;
    const dir = sortDir === 'asc' ? 1 : -1;
    const getVal = (r) => {
      if (sortCol === 'type')  return r.type  || '';
      if (sortCol === 'node1') return r.node1 || '';
      if (sortCol === 'n1occ') return occ1Map.get(r.node1) || 0;
      if (sortCol === 'node2') return r.node2 || '';
      if (sortCol === 'n2occ') return occ2Map.get(r.node2) || 0;
      if (sortCol === 'docid') return r.doi || r.pmid || '';
      return '';
    };
    return [...arr].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === 'number') return (va - vb) * dir;
      return va.localeCompare(vb) * dir;
    });
  }, [relations, filterTypes, filterNode, filterNodeTypes, sortCol, sortDir, occ1Map, occ2Map]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows   = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // a table handed over by another screen (the sentences of the Reader) instead of an RNEF file
  if (tableData) return <ResultsTable key={tableData.seq} table={tableData} onBack={onBackFromTable} onClose={onCloseTable} onNodeIdClick={onNodeIdClick} />;

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Results Viewer</h1>
        <div className="flex gap-8">
          {fromReader && <button className="btn btn-secondary" onClick={onBackFromTable} title="Back to the document">← Reader</button>}
          {filtered.length > 0 && (
            <button className="btn btn-secondary" onClick={handleExportExcel} disabled={exporting}>
              {exporting ? <><span className="spinner" /> Exporting…</> : '⬇ Export to Excel'}
            </button>
          )}
          {selectedFile && (
            <button className="btn btn-secondary" onClick={handleExportRnef} disabled={exportingRnef}
              title="Filter the source RNEF file and save a new RNEF with only matching relations">
              {exportingRnef ? <><span className="spinner" /> Exporting…</> : '⬇ Export to RNEF'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleAddFile}>+ Open RNEF File</button>
        </div>
      </div>

      {files.length === 0 && !fromReader ? (
        <div className="empty-state">
          <div className="empty-state-icon">📊</div>
          <div>No result files loaded.</div>
          <div className="text-sm mt-8">Run Elsevier NLP or open an existing RNEF XML file.</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={handleAddFile}>Open RNEF File</button>
        </div>
      ) : (
        <>
          {fromReader && (
            <div className="card" style={{ marginBottom: 12 }}>
              <b style={{ fontSize: 14 }}>{fromReader.title}</b> <span className="text-muted text-sm">{fromReader.subtitle}</span>
            </div>
          )}
          {files.length > 1 && (
            <div className="form-group">
              <label>Result File</label>
              <select className="form-control" value={selectedFile || ''} onChange={e => loadFile(e.target.value)}>
                {files.map(f => <option key={f} value={f}>{f.split(/[\\/]/).pop()}</option>)}
              </select>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Filter by Relation Type</label>
              <MultiSelect label="Relation type" options={relTypes} selected={filterTypes} onChange={setFilterTypes} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Filter by Node (Assertion)</label>
              <input className="form-control" value={filterNode} onChange={e => setFilterNode(e.target.value)}
                placeholder="Node name…" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Filter by Node Type</label>
              <MultiSelect label="Node type" options={nodeTypes} selected={filterNodeTypes} onChange={setFilterNodeTypes} />
            </div>
          </div>

          {/* Legend */}
          <div className="flex gap-12 items-center mb-8 text-xs" style={{ color: 'var(--muted)' }}>
            <span style={{ color: NODE1_COLOR_DIR }}>■ Regulator (directional)</span>
            <span style={{ color: NODE2_COLOR_DIR }}>■ Target (directional)</span>
            <span style={{ color: NODE1_COLOR_INDIR }}>■ Node 1 (non-directional, A–Z)</span>
            <span style={{ color: NODE2_COLOR_INDIR }}>■ Node 2 (non-directional)</span>
          </div>

          {/* Stats + pagination */}
          <div className="flex gap-12 items-center mb-8 text-sm text-muted" style={{ flexWrap: 'wrap' }}>
            {loading && <><span className="spinner" /> Parsing…{parseProgress != null ? ` ${parseProgress}%` : ''}</>}
            {!loading && <>
              <span className="badge badge-accent">{filtered.length} relations</span>
              {(filterTypes.length > 0 || filterNode || filterNodeTypes.length > 0) ? ` (filtered from ${relations.length})` : ''}
              {filtered.length > 0 && (
                <span style={{ fontSize: 11, opacity: 0.65 }}>
                  · rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length} ({PAGE_SIZE}/page)
                </span>
              )}
            </>}
            {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
            {totalPages > 1 && (
              <div className="flex gap-8 items-center" style={{ marginLeft: 'auto' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setPage(0)}        disabled={page === 0}>«</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => p-1)} disabled={page === 0}>‹</button>
                <span style={{ whiteSpace: 'nowrap' }}>Page {page + 1} of {totalPages}</span>
                <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => p+1)} disabled={page >= totalPages - 1}>›</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>»</button>
                <span style={{ whiteSpace: 'nowrap', marginLeft: 4 }}>Go to:</span>
                <input
                  type="number" min={1} max={totalPages}
                  defaultValue={page + 1}
                  key={page}
                  style={{ width: 52, padding: '2px 6px', fontSize: 12,
                           background: 'var(--surface)', border: '1px solid var(--border)',
                           borderRadius: 'var(--radius)', color: 'var(--text)', textAlign: 'center' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n)) setPage(Math.max(0, Math.min(totalPages - 1, n - 1)));
                    }
                  }}
                  onBlur={e => {
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n)) setPage(Math.max(0, Math.min(totalPages - 1, n - 1)));
                  }}
                />
              </div>
            )}
          </div>

          {!loading && filtered.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 240px)', overflowX: 'auto' }}>
              <table className="data-table" style={{ tableLayout: 'fixed', width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
                <colgroup>
                  <col style={{ width: colWidths.type }} />
                  <col style={{ width: colWidths.node1 }} />
                  <col style={{ width: colWidths.node2 }} />
                  <col style={{ width: colWidths.n1occ }} />
                  <col style={{ width: colWidths.n2occ }} />
                  <col style={{ width: colWidths.docid }} />
                  <col style={{ width: colWidths.sentence }} />
                </colgroup>
                <thead>
                  <tr>
                    {[
                      { col: 'type',     key: 'type',     label: 'Relation Type'  },
                      { col: 'node1',    key: 'node1',    label: 'Node 1'         },
                      { col: 'node2',    key: 'node2',    label: 'Node 2'         },
                      { col: 'n1occ',    key: 'n1occ',    label: 'N1 Occ'         },
                      { col: 'n2occ',    key: 'n2occ',    label: 'N2 Occ'         },
                      { col: 'docid',    key: 'docid',    label: 'Doc ID'         },
                      { col: null,       key: 'sentence', label: 'Source Sentence'},
                    ].map(({ col, key, label }) => (
                      <th key={label}
                        style={{ position: 'relative', cursor: col ? 'pointer' : 'default',
                                 userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}
                        onClick={() => col && handleSort(col)}
                      >
                        {label}
                        {col && sortCol === col && (
                          <span style={{ marginLeft: 4, opacity: 0.7 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                        )}
                        {/* Resize handle */}
                        <span
                          style={{
                            position: 'absolute', right: 0, top: 0, bottom: 0, width: 6,
                            cursor: 'col-resize', zIndex: 2,
                            background: 'transparent',
                          }}
                          onMouseDown={e => startResize(e, key)}
                          onClick={e => e.stopPropagation()}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    const globalIdx = page * PAGE_SIZE + i;
                    const { n1, n2 } = getColors(r.isDirect);
                    const isExpanded = expandedRow === globalIdx;
                    return (
                      <React.Fragment key={globalIdx}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedRow(isExpanded ? null : globalIdx)}>
                        <td style={{ overflow: 'hidden' }}>
                          <span className="badge badge-accent">{r.type || '—'}</span>
                          {r.isDirect
                            ? <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>directional</div>
                            : <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>non-directional</div>
                          }
                        </td>
                        <NodeCell name={r.node1} nodeType={r.node1Type} urn={r.node1Urn} ids={r.node1Ids} color={n1} onIdClick={onNodeIdClick} />
                        <NodeCell name={r.node2} nodeType={r.node2Type} urn={r.node2Urn} ids={r.node2Ids} color={n2} onIdClick={onNodeIdClick} />
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12, color: n1, whiteSpace: 'nowrap', overflow: 'hidden' }}
                            title={`"${r.node1}" is regulator in ${occ1Map.get(r.node1) || 0} relation(s)`}>
                          {occ1Map.get(r.node1) || 0}
                        </td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12, color: n2, whiteSpace: 'nowrap', overflow: 'hidden' }}
                            title={`"${r.node2}" is target in ${occ2Map.get(r.node2) || 0} relation(s)`}>
                          {occ2Map.get(r.node2) || 0}
                        </td>
                        <td className="mono text-xs" style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>
                          {r.doi
                            ? <a href="#" style={{ color: 'var(--accent)' }} title={r.doi}
                                onClick={e => { e.preventDefault(); e.stopPropagation(); window.api.shell.openExternal(`https://doi.org/${r.doi}`); }}>{r.doi}</a>
                            : r.pmid
                              ? <a href="#" style={{ color: 'var(--accent)' }} title={`PMID: ${r.pmid}`}
                                  onClick={e => { e.preventDefault(); e.stopPropagation(); window.api.shell.openExternal(`https://pubmed.ncbi.nlm.nih.gov/${r.pmid}`); }}>{r.pmid}</a>
                              : '—'}
                        </td>
                        <td style={{ overflow: 'hidden' }}>
                          {r.msrc
                            ? <ColoredSentence segments={getSegments(r)} isDirect={r.isDirect} />
                            : <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>—</span>
                          }
                        </td>
                      </tr>
                      {isExpanded && r.extra && (
                        <tr><td colSpan={7} style={{ background: 'rgba(255,255,255,0.03)', fontSize: 12 }}>
                          <div><b>Symbolic form:</b> <span className="mono">{r.extra.symbolic}</span></div>
                          <div><b>Effect:</b> {r.extra.effect || '—'} &nbsp; <b>Properties:</b> {r.extra.properties || '—'} &nbsp; <b>Paragraph:</b> {r.extra.paragraph}</div>
                        </td></tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!loading && filtered.length === 0 && relations.length > 0 && (
            <div className="alert alert-info">No relations match the current filters.</div>
          )}
          {!loading && relations.length === 0 && !error && (
            <div className="alert alert-warning">No relations found in this RNEF file.</div>
          )}
        </>
      )}
    </div>
  );
}
